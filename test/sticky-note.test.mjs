import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

// Keep regression tests independent of personal configuration.
process.env.PI_FOOTER_TOOLS_CONFIG = new URL("../config.json", import.meta.url).pathname;

let root = dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
while (!existsSync(join(root, "package.json"))) root = dirname(root);
const { createJiti } = createRequire(join(root, "package.json"))("jiti");
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": join(root, "dist/index.js"),
  "@earendil-works/pi-tui": join(root, "node_modules/@earendil-works/pi-tui/dist/index.js"),
} });
const base = new URL("../sticky-note/", import.meta.url).pathname;
const core = await jiti.import(join(base, "core.ts"));
const { loadStickyNoteConfig } = await jiti.import(join(base, "config.ts"));
const { registerStickyNote } = await jiti.import(join(base, "index.ts"));
const { visibleWidth } = await jiti.import("@earendil-works/pi-tui");

const plain = { label: text => text, body: text => text };
const user = (id, text, timestamp = Date.UTC(2026, 9, 13, 6, 20)) =>
  ({ type: "message", id, message: { role: "user", content: [{ type: "text", text }], timestamp } });
const note = (id, data) => ({ type: "custom", id, customType: core.NOTE_ENTRY, data });

test("only the fixed acknowledgement lexicon is skipped; everything else is a task", () => {
  for (const text of ["继续", "同意", "可以", "确认", "批准", "同意继续", "继续下一步", "继续推进", "那你继续", "那继续",
    "可以了", "好的！", "行，那你继续吧", "嗯嗯", "OK", "Go ahead.", "LGTM", "y"]) {
    assert.equal(core.isAcknowledgement(text), true, text);
  }
  for (const text of ["测试下子代理", "list your tools", "你好", "你是什么模型", "提交", "commit and push", "跑完了",
    "继续t12", "继续测试下", "继续你提到的1，2", "行啊，那你做吧", "接下来怎么做"]) {
    assert.equal(core.isTaskPrompt(text), true, text);
  }
  assert.equal(core.isTaskPrompt(""), false);
});

test("cleanPrompt folds skills, fenced pastes and terminal controls", () => {
  const skill = '<skill name="pdf" location="/x/SKILL.md">\nlong body\n</skill>\n\nextract report.pdf';
  assert.equal(core.cleanPrompt(skill), "/skill:pdf extract report.pdf");
  assert.equal(core.cleanPrompt("看这个报错\n```\na\nb\nc\n```\n怎么修"), "看这个报错\n[代码 3 行，已省略]\n怎么修");
  assert.equal(core.cleanPrompt("unterminated\n```py\nx = 1\ny = 2"), "unterminated\n[代码 2 行，已省略]");
  assert.equal(core.cleanPrompt("\x1b[31mred\x1b[0m\x07 text\n\n\n\nend"), "red text\n\nend");
  assert.equal(core.messageText([{ type: "image" }, { type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");
});

test("anchor is the latest task-like prompt unless a pin on this branch wins", () => {
  const prompts = core.userPrompts([
    user("u1", "把 cache 诊断的日志改成按天切分"), user("u2", "可以"),
    user("u3", "把 telegram 回复路由改成按 session id 匹配"), user("u4", "继续"),
  ]);
  assert.equal(core.findAnchor(prompts)?.id, "u3");
  assert.equal(core.findAnchor(prompts, "u1")?.id, "u1");
  assert.equal(core.findAnchor(prompts, "gone")?.id, "u3");
  assert.equal(core.findAnchor(core.userPrompts([user("u1", "继续"), user("u2", "好的")])), undefined);
});

test("note entries replay set/undo/pin along the branch", () => {
  const state = core.replay([
    note("n1", { op: "set", text: "first" }), note("n2", { op: "set", text: "second" }),
    note("n3", { op: "set", text: "" }), note("n4", { op: "undo" }), note("n5", { op: "pin", entryId: "u1" }),
    note("bad", { op: "set", text: 3 }), { type: "custom", customType: "other", data: { op: "set", text: "x" } },
  ]);
  assert.equal(state.note, "second");
  assert.deepEqual(state.history, ["", "first"]);
  assert.equal(state.pinnedId, "u1");
  assert.equal(core.replay([note("n1", { op: "undo" })]).note, "");
  assert.equal(core.replay([note("p", { op: "pin", entryId: "u1" }), note("q", { op: "unpin" })]).pinnedId, undefined);
});

test("render: folded task is one row with time; expanded wraps; note is never folded", () => {
  const now = new Date(2026, 9, 13, 15);
  const anchor = { text: "把 telegram-notify 的回复路由改成按 session id 匹配，旧的按 chat id 的逻辑保留做 fallback\n补测试", timestamp: new Date(2026, 9, 13, 14, 20).getTime() };
  const noteText = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行`).join("\n");
  const folded = core.renderView({ anchor, note: noteText, expanded: false }, 60, plain, now);
  assert.equal(folded.taskRows, 1);
  assert.match(folded.lines[0], /^ 任务 ↗ 把 telegram.*…\s+14:20$/);
  assert.equal(folded.lines.length, 13, "all 12 note lines stay visible");
  assert.match(folded.lines[1], /^ 备忘   第 1 行$/);
  assert.match(folded.lines[2], /^ {8}第 2 行$/);
  const open = core.renderView({ anchor, note: "", expanded: true }, 60, plain, now);
  assert.ok(open.taskRows > 2);
  assert.match(open.lines[0], /^ 任务 ↗ .*14:20$/);
  assert.ok(open.lines.join("").includes("补测试"));
  for (const width of [20, 40, 60, 120]) {
    for (const line of core.renderView({ anchor, note: noteText, expanded: true }, width, plain, now).lines) {
      assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
    }
  }
  assert.equal(core.formatTime(new Date(2026, 9, 12, 9, 5).getTime(), now), "10-12 09:05");
  assert.deepEqual(core.renderView({ note: "  ", expanded: false }, 60, plain, now).lines, []);
});

function configFile(value) {
  const dir = mkdtempSync(join(tmpdir(), "sticky-note-"));
  const path = join(dir, "footer-tools.json");
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return { path, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("config: off by default, explicit boolean only, malformed fails closed", () => {
  assert.equal(loadStickyNoteConfig(process.env.PI_FOOTER_TOOLS_CONFIG).enabled, false);
  for (const [value, enabled, state] of [
    [{ stickyNote: { enabled: true } }, true, "loaded"], [{}, false, "missing"],
    [{ stickyNote: { enabled: "yes" } }, false, "invalid"], ["{", false, "invalid"],
  ]) {
    const file = configFile(value);
    try { assert.deepEqual(loadStickyNoteConfig(file.path), { enabled, state }); }
    finally { file.done(); }
  }
});

function harness(mode = "tui") {
  const file = configFile({ stickyNote: { enabled: true } });
  const handlers = new Map();
  const commands = new Map();
  const shortcuts = new Map();
  const branch = [];
  const notes = [];
  const ui = { widget: undefined, renders: 0, editorReply: undefined, selectReply: undefined, editorPrefill: undefined };
  const tui = { requestRender: () => { ui.renders++; } };
  const theme = { fg: (_color, text) => text };
  let component;
  const ctx = {
    mode,
    sessionManager: { getBranch: () => [...branch] },
    ui: {
      setWidget: (key, factory) => { ui.widget = factory ? key : undefined; component = factory?.(tui, theme); },
      notify: (text) => notes.push(text),
      editor: async (title, prefill) => {
        if (ui.editor) return ui.editor(title, prefill);
        ui.editorPrefill = prefill;
        return ui.editorReply;
      },
      select: async (_title, options) => { ui.options = options; return ui.selectReply?.(options); },
    },
  };
  let nextId = 0;
  registerStickyNote({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, options) => commands.set(name, options),
    registerShortcut: (key, options) => shortcuts.set(key, options),
    appendEntry: (customType, data) => branch.push({ type: "custom", id: `c${nextId++}`, customType, data }),
  }, { configPath: file.path });
  file.done();
  return {
    branch, notes, ui, handlers, commands, shortcuts,
    fire: (name, event = {}) => handlers.get(name)?.(event, ctx),
    shortcut: () => shortcuts.get("alt+m").handler(ctx),
    note: (args) => commands.get("note").handler(args, ctx),
    lines: (width = 80) => component ? component.render(width) : [],
    click: (y) => component.handleMouse({ type: "click", button: "left", x: 3, y }),
  };
}

test("disabled config registers nothing", () => {
  const handlers = [];
  const file = configFile({ stickyNote: { enabled: false } });
  registerStickyNote({ on: (name) => handlers.push(name), registerCommand: () => assert.fail(), registerShortcut: () => assert.fail() },
    { configPath: file.path });
  file.done();
  assert.deepEqual(handlers, []);
});

test("jump command is a view-only action with a keyboard completion and clear unavailable-state notices", async () => {
  const h = harness();
  h.fire("session_start");
  await h.note("jump");
  assert.ok(h.notes.some(text => text.includes("当前没有任务行")));
  h.branch.push(user("u1", "inspect the source prompt"));
  h.fire("agent_end");
  const branch = structuredClone(h.branch);
  const before = h.lines();
  await h.note("jump");
  assert.deepEqual(h.branch, branch, "jump never appends a note or navigates the branch");
  assert.deepEqual(h.lines(), before);
  assert.ok(h.notes.some(text => text.includes("不支持定位")));
  assert.deepEqual(h.commands.get("note").getArgumentCompletions("j"), [{ value: "jump", label: "jump" }]);
  h.fire("session_shutdown");
});

test("non-TUI modes neither mount the task nor try to jump or edit", async () => {
  for (const mode of ["rpc", "print", "json"]) {
    const h = harness(mode);
    h.branch.push(user("u1", "inspect the source prompt"));
    h.fire("session_start");
    await h.note("jump");
    await h.shortcut();
    assert.equal(h.ui.widget, undefined);
    assert.equal(h.ui.editorPrefill, undefined);
    assert.deepEqual(h.notes, []);
    assert.equal(h.branch.length, 1);
  }
});

test("widget clicks locate prompts instead of expanding, while note editing and manual expansion stay intact", async () => {
  const h = harness();
  assert.ok(h.shortcuts.has("alt+m"));
  h.fire("session_start", { reason: "startup" });
  assert.equal(h.ui.widget, undefined, "nothing to show yet");

  // Live prompt shows before it is persisted; short follow-ups do not replace it.
  const task = { role: "user", content: "把 telegram 回复路由改成按 session id 匹配，补测试", timestamp: Date.now() };
  h.fire("message_end", { message: task });
  assert.match(h.lines()[0], /任务 ↗ 把 telegram/);
  h.fire("message_end", { message: { role: "user", content: "继续", timestamp: Date.now() } });
  assert.match(h.lines()[0], /把 telegram/);

  const beforeClick = h.lines();
  assert.equal(h.click(0).handled, true);
  assert.deepEqual(h.lines(), beforeClick, "task clicks never expand or fold the preview");
  assert.ok(h.notes.some(text => text.includes("不支持定位")), "unsupported UI warns instead of pretending to jump");
  assert.equal(h.click(-1), undefined);
  assert.equal(h.click(5), undefined, "clicks outside the widget pass through");
  h.branch.push({ type: "message", id: "u1", message: task });
  h.fire("agent_end");
  assert.equal(h.lines(30).length, 1);
  // Manual expansion remains available, but is no longer the task click action.
  await h.note("task");
  assert.ok(h.lines(30).length > 1);

  // Alt+M opens an empty editor when there is no note; saving appends a custom entry.
  h.ui.editorReply = "等它改完 → 手机上验证\n别合并\n\n";
  await h.shortcut();
  assert.equal(h.ui.editorPrefill, "");
  assert.deepEqual(h.branch.at(-1).data, { op: "set", text: "等它改完 → 手机上验证\n别合并" });
  assert.deepEqual(h.lines().slice(-2), [" 备忘   等它改完 → 手机上验证", "        别合并"]);

  // Cancel changes nothing; next edit is prefilled with the note.
  h.ui.editorReply = undefined;
  await h.shortcut();
  assert.equal(h.ui.editorPrefill, "等它改完 → 手机上验证\n别合并");
  assert.equal(h.branch.filter(entry => entry.type === "custom").length, 1);

  await h.note("clear");
  assert.equal(h.lines().some(line => line.includes("备忘")), false);
  assert.ok(h.notes.some(text => text.includes("/note undo")));
  await h.note("undo");
  assert.ok(h.lines().some(line => line.includes("别合并")));
  await h.note("一句话备忘");
  assert.match(h.lines().at(-1), /备忘   一句话备忘$/);

  // Clicking a note row opens the editor prefilled with the note; a second click while open is ignored.
  let release;
  let opened = 0;
  h.ui.editor = (_title, prefill) => { opened++; h.ui.editorPrefill = prefill; return new Promise(resolve => { release = resolve; }); };
  const noteRow = h.lines().length - 1;
  assert.equal(h.click(noteRow).handled, true);
  assert.equal(h.click(noteRow).handled, true);
  assert.equal(opened, 1);
  assert.equal(h.ui.editorPrefill, "一句话备忘");
  release("点击后改的备忘");
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.lines().at(-1), /备忘   点击后改的备忘$/);
  assert.ok(h.lines(30).length > 2, "a note click does not fold the task");
  h.ui.editor = undefined;

  // /note task is the keyboard path for folding.
  await h.note("task");
  assert.equal(h.lines(30).length, 2);

  // Pin an older prompt; a newer task does not replace it until unpinned.
  h.branch.push({ type: "message", id: "u2", message: { role: "user", content: "再把 README 里对应的段落全部更新一下", timestamp: Date.now() } });
  h.fire("agent_end");
  assert.match(h.lines()[0], /README/);
  h.ui.selectReply = options => options.find(option => option.includes("telegram"));
  await h.note("pin");
  assert.match(h.lines()[0], /telegram/);
  h.fire("message_end", { message: { role: "user", content: "顺便把 CHANGELOG 也补上这一条更新说明", timestamp: Date.now() } });
  assert.match(h.lines()[0], /telegram/);
  h.ui.selectReply = options => options[0];
  await h.note("pin");
  assert.match(h.lines()[0], /README/);

  // /tree to a branch before the note: note and pin disappear with it.
  h.branch.splice(1);
  h.fire("session_tree");
  assert.equal(h.lines().length, 1);
  h.branch.splice(0);
  h.fire("session_tree");
  assert.equal(h.ui.widget, undefined);
  h.fire("session_shutdown", { reason: "quit" });
});
