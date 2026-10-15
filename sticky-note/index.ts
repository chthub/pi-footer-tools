import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { loadStickyNoteConfig } from "./config.ts";
import { resolveConfigPath } from "../config-path.ts";
import { scrollToPrompt } from "./navigation.ts";
import {
  NOTE_ENTRY, cleanNote, cleanPrompt, findAnchor, formatTime, isTaskPrompt, messageText, renderView, replay, userPrompts,
  type NoteOp, type NoteState, type Prompt, type View,
} from "./core.ts";

const WIDGET_KEY = "footer-tools.sticky-note";
const SHORTCUT = "alt+m";
const SUBCOMMANDS = ["clear", "undo", "pin", "task", "jump"];
const PIN_CHOICES = 12;

export interface StickyNoteOptions { configPath?: string }

/** Clickable widget; reads the shared view on every render so clicks need no re-mount. */
class StickyNoteView implements Component {
  private taskRows = 0;
  private rows = 0;
  constructor(
    private readonly view: View,
    private readonly theme: Theme,
    private readonly jumpToPrompt: () => void,
    private readonly editNote: () => void,
  ) {}

  render(width: number): string[] {
    const { lines, taskRows } = renderView(this.view, width, {
      label: text => this.theme.fg("dim", text),
      body: text => this.theme.fg("text", text),
    });
    this.taskRows = taskRows;
    this.rows = lines.length;
    return lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click" || event.button !== "left" || event.y < 0 || event.y >= this.rows) return undefined;
    // Task rows jump to their source prompt; note rows open the note editor.
    if (event.y < this.taskRows) this.jumpToPrompt();
    else this.editNote();
    return { handled: true, render: true };
  }

  invalidate() {}
}

/**
 * Pinned above the editor: the latest non-acknowledgement prompt (click to jump to its source)
 * and a free-form note (click to edit).
 * Note edits are custom entries, so they follow /tree branches and never enter model context.
 */
export function registerStickyNote(pi: ExtensionAPI, options: StickyNoteOptions = {}) {
  const config = loadStickyNoteConfig(options.configPath ?? resolveConfigPath());
  if (config.state === "invalid") {
    let warned = false;
    pi.on("session_start", (_event, ctx) => {
      if (warned || ctx.mode !== "tui") return;
      warned = true;
      ctx.ui.notify("Sticky note: stickyNote in config.json is unreadable or malformed; feature is off.", "warning");
    });
  }
  if (!config.enabled) return;

  const view: View = { note: "", expanded: false };
  let state: NoteState = { note: "", history: [] };
  let prompts: Prompt[] = [];
  let mounted: TUI | undefined;
  /** Latest TUI context, so a click can locate its source prompt or open the note editor. */
  let uiCtx: ExtensionContext | undefined;
  let editing = false;

  const anchorKey = (prompt: Prompt | undefined) => prompt && `${prompt.timestamp ?? ""}:${prompt.text}`;

  function setAnchor(anchor: Prompt | undefined) {
    // A new task folds again; re-reading the same prompt after it is persisted keeps the fold state.
    if (anchorKey(anchor) !== anchorKey(view.anchor)) view.expanded = false;
    view.anchor = anchor;
  }

  function show(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    uiCtx = ctx;
    const visible = view.anchor !== undefined || view.note.trim() !== "";
    if (visible && mounted) {
      // The mounted widget reads `view` on every render; content changed in place.
      mounted.requestRender();
    } else if (visible) {
      ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
        mounted = tui;
        return new StickyNoteView(view, theme,
          () => { if (uiCtx) jump(uiCtx); },
          () => { if (uiCtx) void edit(uiCtx); });
      });
    } else if (mounted) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      mounted = undefined;
    }
  }

  function rebuild(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    const branch = ctx.sessionManager.getBranch();
    state = replay(branch);
    prompts = userPrompts(branch);
    view.note = state.note;
    setAnchor(findAnchor(prompts, state.pinnedId));
    show(ctx);
  }

  function jump(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    if (!view.anchor) {
      ctx.ui.notify("当前没有任务行", "info");
      return;
    }
    const result = mounted ? scrollToPrompt(mounted, view.anchor, ctx.sessionManager.getBranch()) : "unsupported";
    if (result === "unsupported") ctx.ui.notify("当前界面不支持定位 prompt；请使用兼容的 Pi fullscreen 模式。", "warning");
    else if (result === "pending") ctx.ui.notify("这条 prompt 尚未保存，请稍后再试。", "info");
    else if (result === "missing") ctx.ui.notify("暂时无法安全定位对应 prompt：原文可能已被压缩，或对话仍在更新，请稍后再试。未改变会话或分支。", "warning");
  }

  function record(op: NoteOp, ctx: ExtensionContext) {
    pi.appendEntry<NoteOp>(NOTE_ENTRY, op);
    rebuild(ctx);
  }

  function setNote(text: string, ctx: ExtensionContext) {
    const next = cleanNote(text);
    if (next === state.note) return;
    record({ op: "set", text: next }, ctx);
    if (!next) ctx.ui.notify("备忘已删除；/note undo 可恢复", "info");
  }

  async function edit(ctx: ExtensionContext) {
    if (ctx.mode !== "tui" || editing) return;
    editing = true;
    try {
      const result = await ctx.ui.editor("备忘（清空后保存 = 删除）", state.note);
      if (result !== undefined) setNote(result, ctx);
    } finally { editing = false; }
  }

  async function pin(ctx: ExtensionContext) {
    const recent = prompts.filter(prompt => prompt.id).slice(-PIN_CHOICES).reverse();
    if (!recent.length) {
      ctx.ui.notify("当前分支还没有 prompt", "warning");
      return;
    }
    const AUTO = "自动：最近一条不是确认语的 prompt";
    const labels = recent.map(prompt => {
      const flat = prompt.text.replace(/\s+/g, " ");
      const time = formatTime(prompt.timestamp);
      return `${time ? `${time}  ` : ""}${flat.length > 70 ? `${flat.slice(0, 70)}…` : flat}`;
    });
    const choice = await ctx.ui.select("任务行显示哪条 prompt", [AUTO, ...labels]);
    if (choice === undefined) return;
    if (choice === AUTO) {
      if (state.pinnedId) record({ op: "unpin" }, ctx);
      return;
    }
    const picked = recent[labels.indexOf(choice)];
    if (picked?.id && picked.id !== state.pinnedId) record({ op: "pin", entryId: picked.id }, ctx);
  }

  pi.registerShortcut(SHORTCUT, {
    description: "Edit the sticky note above the editor",
    handler: ctx => edit(ctx),
  });

  pi.registerCommand("note", {
    description: "Sticky note: /note [text|clear|undo|pin|task|jump]; jump scrolls to the displayed task prompt",
    getArgumentCompletions: (prefix) => {
      const options = SUBCOMMANDS.filter(value => value.startsWith(prefix));
      return options.length ? options.map(value => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;
      const text = args.trim();
      if (!text) return edit(ctx);
      if (text === "clear") return setNote("", ctx);
      if (text === "undo") {
        if (!state.history.length) ctx.ui.notify("没有可撤销的备忘修改", "info");
        else record({ op: "undo" }, ctx);
        return;
      }
      if (text === "pin") return pin(ctx);
      if (text === "jump") return jump(ctx);
      if (text === "task") {
        if (!view.anchor) ctx.ui.notify("当前没有任务行", "info");
        else {
          view.expanded = !view.expanded;
          show(ctx);
        }
        return;
      }
      setNote(args, ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => rebuild(ctx));
  pi.on("session_tree", (_event, ctx) => rebuild(ctx));
  // message_end runs before the message is persisted: show it now, pick up its entry id later.
  pi.on("message_end", (event, ctx) => {
    if (ctx.mode !== "tui" || event.message.role !== "user" || state.pinnedId) return;
    const text = cleanPrompt(messageText(event.message.content));
    if (!isTaskPrompt(text)) return;
    setAnchor({ text, timestamp: event.message.timestamp });
    show(ctx);
  });
  pi.on("agent_end", (_event, ctx) => rebuild(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "tui" && mounted) ctx.ui.setWidget(WIDGET_KEY, undefined);
    mounted = undefined;
    uiCtx = undefined;
    view.anchor = undefined;
    view.note = "";
    view.expanded = false;
    state = { note: "", history: [] };
    prompts = [];
  });
}
