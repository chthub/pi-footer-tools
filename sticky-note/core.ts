import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Custom entry type; entries follow the active branch and never reach model context. */
export const NOTE_ENTRY = "footer-tools.sticky-note";
/** Fixed acknowledgement lexicon, compared after normalization; anything else counts as a task. */
export const ACK_WORDS: ReadonlySet<string> = new Set([
  "继续", "同意", "可以", "确认", "批准", "同意继续", "继续下一步", "继续执行", "继续推进", "继续做", "自行继续推进", "接着",
  "好", "好的", "行", "嗯", "对", "是的", "没问题",
  "ok", "okay", "yes", "y", "go", "goahead", "continue", "proceed", "lgtm",
]);
/** Leading and trailing particles stripped before the lookup, longest first. */
const ACK_PREFIXES = ["那你", "行啊", "好的", "那", "你", "行", "好", "嗯"];
const ACK_SUFFIXES = ["一下", "吧", "啊", "呀", "了"];

export type NoteOp =
  | { op: "set"; text: string }
  | { op: "undo" }
  | { op: "pin"; entryId: string }
  | { op: "unpin" };

export interface Prompt {
  /** Session entry id; absent for a just-sent message that is not persisted yet. */
  id?: string;
  text: string;
  timestamp?: number;
}

export interface NoteState {
  note: string;
  /** Earlier note texts, oldest first; `undo` pops back to the last one. */
  history: string[];
  pinnedId?: string;
}

interface BranchEntry {
  type: string;
  id?: string;
  customType?: string;
  data?: unknown;
  message?: { role?: string; content?: unknown; timestamp?: number };
}

const SKILL_BLOCK = /^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;
// An unterminated fence runs to the end of the prompt.
const FENCE = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)(?:\n\1[ \t]*(?=\n|$)|(?![\s\S]))/gm;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Text blocks of a user message; images and other parts are ignored. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null && part.type === "text" && typeof part.text === "string")
    .map(part => part.text)
    .join("\n");
}

/** What the user actually wrote: skill bodies and fenced pastes are folded, terminal controls dropped. */
export function cleanPrompt(raw: string): string {
  let text = stripTerminalSequences(raw).replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
  const skill = text.match(SKILL_BLOCK);
  if (skill) text = `/skill:${skill[1]}${skill[2] ? ` ${skill[2].trim()}` : ""}`;
  text = text.replace(FENCE, (_match: string, _fence: string, body: string) => {
    const lines = body.replace(/\n$/, "").split("\n").length;
    return `[代码 ${lines} 行，已省略]`;
  });
  return text.replace(CONTROL, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** User-typed note text: keep line breaks, drop terminal controls and trailing blank space. */
export function cleanNote(raw: string): string {
  return stripTerminalSequences(raw).replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(CONTROL, "").replace(/\s+$/, "");
}

/** Case, whitespace and punctuation are ignored; particles such as "那你…吧" are stripped. */
export function isAcknowledgement(text: string): boolean {
  let word = text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  if (ACK_WORDS.has(word)) return true;
  if (word === "你好") return false; // a greeting, not "你" + "好"
  for (let changed = true; changed && word;) {
    changed = false;
    for (const prefix of ACK_PREFIXES) {
      if (word.startsWith(prefix)) { word = word.slice(prefix.length); changed = true; break; }
    }
    for (const suffix of ACK_SUFFIXES) {
      if (word.endsWith(suffix)) { word = word.slice(0, -suffix.length); changed = true; break; }
    }
    if (ACK_WORDS.has(word)) return true;
  }
  return word === "";
}

export const isTaskPrompt = (text: string) => text !== "" && !isAcknowledgement(text);

export function parseOp(data: unknown): NoteOp | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const value = data as Record<string, unknown>;
  if (value.op === "set" && typeof value.text === "string") return { op: "set", text: value.text };
  if (value.op === "undo" || value.op === "unpin") return { op: value.op };
  if (value.op === "pin" && typeof value.entryId === "string") return { op: "pin", entryId: value.entryId };
  return undefined;
}

/** Replay this extension's entries along the active branch, root to leaf. */
export function replay(entries: readonly BranchEntry[]): NoteState {
  const state: NoteState = { note: "", history: [] };
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== NOTE_ENTRY) continue;
    const op = parseOp(entry.data);
    if (op?.op === "set") {
      state.history.push(state.note);
      state.note = op.text;
    } else if (op?.op === "undo" && state.history.length) {
      state.note = state.history.pop()!;
    } else if (op?.op === "pin") state.pinnedId = op.entryId;
    else if (op?.op === "unpin") state.pinnedId = undefined;
  }
  return state;
}

/** User prompts on the branch, oldest first, already cleaned. */
export function userPrompts(entries: readonly BranchEntry[]): Prompt[] {
  const prompts: Prompt[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const text = cleanPrompt(messageText(entry.message.content));
    if (text) prompts.push({ id: entry.id, text, timestamp: entry.message.timestamp });
  }
  return prompts;
}

/** A pin wins while its entry is on this branch; otherwise the latest task-like prompt. */
export function findAnchor(prompts: readonly Prompt[], pinnedId?: string): Prompt | undefined {
  if (pinnedId) {
    const pinned = prompts.find(prompt => prompt.id === pinnedId);
    if (pinned) return pinned;
  }
  for (let i = prompts.length - 1; i >= 0; i--) if (isTaskPrompt(prompts[i].text)) return prompts[i];
  return undefined;
}

export function formatTime(timestamp: number | undefined, now = new Date()): string {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return "";
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.toDateString() === now.toDateString() ? time : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

export interface Style {
  label(text: string): string;
  body(text: string): string;
}

export interface View {
  anchor?: Prompt;
  note: string;
  expanded: boolean;
}

const TASK_LABEL = (expanded: boolean) => ` 任务 ${expanded ? "▾" : "▸"} `;
const NOTE_LABEL = " 备忘   ";

function wrap(text: string, width: number): string[] {
  return text.split("\n").flatMap(line => line ? wrapTextWithAnsi(line, width) : [""]);
}

/** Rendered rows plus how many leading rows belong to the clickable task block. */
export function renderView(view: View, width: number, style: Style, now = new Date()): { lines: string[]; taskRows: number } {
  const lines: string[] = [];
  const indent = " ".repeat(visibleWidth(NOTE_LABEL));
  const room = Math.max(1, width - visibleWidth(NOTE_LABEL) - 1);
  if (view.anchor) {
    const label = style.label(TASK_LABEL(view.expanded));
    let time = formatTime(view.anchor.timestamp, now);
    if (room - visibleWidth(time) - 2 < 12) time = "";
    const textWidth = time ? room - visibleWidth(time) - 2 : room;
    const rows = view.expanded
      ? wrap(view.anchor.text, textWidth)
      // Plain text in, plain text out: drop the resets truncateToWidth adds so styling covers "…".
      : [stripTerminalSequences(truncateToWidth(view.anchor.text.replace(/\s+/g, " "), textWidth, "…"))];
    rows.forEach((row, index) => {
      const head = index === 0 ? label : indent;
      const tail = index === 0 && time
        ? " ".repeat(Math.max(0, textWidth - visibleWidth(row)) + 2) + style.label(time)
        : "";
      lines.push(head + style.body(row) + tail);
    });
  }
  const taskRows = lines.length;
  if (view.note.trim()) {
    wrap(view.note.replace(/\s+$/, ""), room).forEach((row, index) => {
      lines.push((index === 0 ? style.label(NOTE_LABEL) : indent) + style.body(row));
    });
  }
  return { lines, taskRows };
}
