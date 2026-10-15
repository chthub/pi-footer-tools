import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";

// Same installed-SDK loader as sticky-note.test.mjs; no personal Pi configuration.
let root = dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
while (!existsSync(join(root, "package.json"))) root = dirname(root);
const { createJiti } = createRequire(join(root, "package.json"))("jiti");
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": join(root, "dist/index.js"),
  "@earendil-works/pi-tui": join(root, "node_modules/@earendil-works/pi-tui/dist/index.js"),
} });
const { scrollToPrompt } = await jiti.import(new URL("../sticky-note/navigation.ts", import.meta.url).pathname);
const { cleanPrompt, userPrompts } = await jiti.import(new URL("../sticky-note/core.ts", import.meta.url).pathname);
const { Container, ScrollView, Spacer, Text, TuiAltScreen, TuiMainScreen, VStack } = await jiti.import("@earendil-works/pi-tui");
const { registerStickyNote } = await jiti.import(new URL("../sticky-note/index.ts", import.meta.url).pathname);
const { initTheme, parseSkillBlock, UserMessageComponent, SkillInvocationMessageComponent } =
  await jiti.import("@earendil-works/pi-coding-agent");
const { createInteractiveTuiReference } = await jiti.import(join(root, "dist/modes/interactive/tui-renderer.js"));
initTheme("dark", false);

const user = (id, content, timestamp = 100) => ({
  type: "message", id, parentId: null, timestamp: new Date(timestamp).toISOString(),
  message: { role: "user", content, timestamp },
});
const compaction = (id, firstKeptEntryId) => ({
  type: "compaction", id, parentId: null, timestamp: new Date(300).toISOString(),
  summary: "older turns summarized", firstKeptEntryId, tokensBefore: 1000,
});
const prompt = entry => userPrompts([entry])[0];
const freeze = value => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const raw = entry => typeof entry.message.content === "string" ? entry.message.content :
  entry.message.content.filter(part => part.type === "text").map(part => part.text).join("");

class MemoryTerminal {
  columns = 64;
  rows = 10;
  kittyProtocolActive = false;
  writes = [];
  start(input, resize) { this.input = input; this.resize = resize; }
  write(data) { this.writes.push(data); }
  stop() {}
  async drainInput() {}
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}
}

function fixture(t, entries, { scrollbar = "hidden", columns = 64, rows = 10 } = {}) {
  const terminal = new MemoryTerminal();
  Object.assign(terminal, { columns, rows });
  const header = new Container();
  header.addChild(new Text("header\nresource notices", 0, 0));
  const chat = new Container();
  const document = new Container();
  document.addChild(header);
  document.addChild(chat);
  const components = new Map();
  function add(entry) {
    if (chat.children.length) chat.addChild(new Spacer(1));
    const text = raw(entry);
    const skill = parseSkillBlock(text);
    const component = skill ? new SkillInvocationMessageComponent(skill) : new UserMessageComponent(text);
    components.set(entry.id, component);
    chat.addChild(component);
    if (skill?.userMessage) {
      chat.addChild(new Spacer(1));
      chat.addChild(new UserMessageComponent(skill.userMessage));
    }
  }
  entries.forEach(add);
  // Keep target rows away from the end clamp in most tests.
  chat.addChild(new Text(Array.from({ length: 35 }, (_, i) => `assistant tail ${i}`).join("\n"), 0, 0));
  const scroll = new ScrollView(document, { primary: true, follow: "end", scrollbar });
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  tui.setLayoutRoot(scroll);
  tui.start();
  tui.renderNow();
  t.after(() => tui.stop({ preserveScreen: true }));
  const calls = [];
  const originalScroll = scroll.scrollTo.bind(scroll);
  scroll.scrollTo = (row, options) => { calls.push({ row, options }); originalScroll(row, options); };
  function row(id) {
    const width = scroll.getContentWidth(terminal.columns);
    let result = header.render(width).length;
    for (const child of chat.children) {
      if (child === components.get(id)) return result;
      result += child.render(width).length;
    }
    assert.fail(`No rendered component ${id}`);
  }
  return { terminal, tui, scroll, chat, document, header, components, calls, row, add };
}

function jumped(h, anchor, branch, id = anchor.id) {
  const snapshot = JSON.stringify(branch);
  assert.equal(scrollToPrompt(h.tui, anchor, branch), "jumped");
  assert.deepEqual(h.calls.at(-1), { row: h.row(id), options: { disableFollow: true } });
  assert.equal(h.scroll.scrollTop, h.row(id));
  assert.equal(h.scroll.isFollowingEnd, false);
  assert.equal(JSON.stringify(branch), snapshot, "navigation never changes the branch");
}

test("pinned older ID and repeated identical prompts jump to distinct source rows through the real proxy", t => {
  const branch = freeze([user("old", "same prompt"), user("middle", "another task"), user("new", "same prompt")]);
  const h = fixture(t, branch);
  const renderer = h.tui;
  h.tui = createInteractiveTuiReference(() => renderer);
  jumped(h, prompt(branch[0]), branch);
  jumped(h, prompt(branch[2]), branch);
  jumped(h, prompt(branch[1]), branch);
  assert.notEqual(h.row("old"), h.row("new"));
});

test("raw fenced pastes with equal cleaned previews remain different source prompts", t => {
  const branch = freeze([user("a", "fix\n```js\nfirst()\n```"), user("b", "fix\n```js\nsecond()\n```")]);
  assert.equal(cleanPrompt(raw(branch[0])), cleanPrompt(raw(branch[1])));
  const h = fixture(t, branch);
  jumped(h, prompt(branch[0]), branch);
  jumped(h, prompt(branch[1]), branch);
  const compactedBranch = freeze([...branch, compaction("compact", "b")]);
  const compacted = fixture(t, [branch[1]]);
  assert.equal(scrollToPrompt(compacted.tui, prompt(branch[0]), compactedBranch), "missing");
  assert.equal(compacted.calls.length, 0);
  jumped(compacted, prompt(branch[1]), compactedBranch);
});

test("skills with and without following user text are ONE source prompt each", t => {
  const skill = (body, suffix = "") => `<skill name="pdf" location="/skills/pdf/SKILL.md">\n${body}\n</skill>${suffix}`;
  const branch = freeze([
    user("plain", "extract report.pdf"),
    user("skill-only", skill("read the pdf")),
    user("skill-user", skill("extract tables", "\n\nextract report.pdf")),
    user("repeated", "extract report.pdf"),
    user("skill-repeat", skill("extract tables", "\n\nextract report.pdf")),
  ]);
  const h = fixture(t, branch);
  for (const entry of branch) jumped(h, prompt(entry), branch);
  // Expanded skills alter all following heights, but a jump does not expand anything itself.
  h.components.get("skill-only").setExpanded(true);
  jumped(h, prompt(branch[2]), branch);
  assert.equal(h.components.get("skill-user").expanded, false);
  const compactedBranch = freeze([...branch, compaction("compact", "skill-user")]);
  const compacted = fixture(t, branch.slice(2));
  assert.equal(scrollToPrompt(compacted.tui, prompt(branch[1]), compactedBranch), "missing");
  jumped(compacted, prompt(branch[2]), compactedBranch);
  jumped(compacted, prompt(branch[4]), compactedBranch);
});

test("live anchors uniquely resolve by cleaned text AND timestamp, using core preview but host raw text joins", t => {
  const branch = freeze([
    user("old", [{ type: "text", text: "left" }, { type: "text", text: "right" }], 101),
    user("new", [{ type: "text", text: "left" }, { type: "image", data: "ignored" }, { type: "text", text: "right" }], 202),
  ]);
  const h = fixture(t, branch);
  const anchor = { text: "left\nright", timestamp: 101 };
  jumped(h, anchor, branch, "old");
  assert.equal(scrollToPrompt(h.tui, { ...anchor, timestamp: 999 }, branch), "pending");
  assert.equal(scrollToPrompt(h.tui, { text: anchor.text }, branch), "pending");
  assert.equal(scrollToPrompt(h.tui, { ...anchor, timestamp: NaN }, branch), "pending");
  assert.equal(scrollToPrompt(h.tui, { id: "absent", ...anchor }, branch), "missing", "IDs never fall back to text");
  const ambiguous = freeze([...branch, user("third", branch[0].message.content, 101)]);
  assert.equal(scrollToPrompt(h.tui, anchor, ambiguous), "missing");
});

test("missing/compacted older duplicates never jump to the surviving equal prompt", t => {
  const branch = freeze([user("a", "same"), user("b", "intervening"), user("c", "same"), compaction("compact", "c")]);
  const h = fixture(t, [branch[2]]);
  assert.equal(scrollToPrompt(h.tui, prompt(branch[0]), branch), "missing");
  assert.equal(scrollToPrompt(h.tui, prompt(branch[1]), branch), "missing");
  assert.equal(h.calls.length, 0);
  jumped(h, prompt(branch[2]), branch);
  const empty = fixture(t, []);
  assert.equal(scrollToPrompt(empty.tui, prompt(branch[2]), branch), "missing");
});

test("forces a fresh layout after resize and uses scrollbar content width and changed preceding heights", t => {
  const branch = freeze([user("long", "wide words wrap at different widths ".repeat(8)), user("target", "destination")]);
  const h = fixture(t, branch, { scrollbar: "always" });
  jumped(h, prompt(branch[1]), branch);
  const oldRow = h.row("target");
  h.terminal.columns = 23;
  h.terminal.rows = 8;
  h.header.addChild(new Text("new notice\nsecond line", 0, 0));
  // Deliberately do not render: the adapter must flush the stale layout first.
  jumped(h, prompt(branch[1]), branch);
  assert.ok(h.row("target") > oldRow);
  assert.equal(h.tui.currentLayout.width, 23);
  assert.equal(h.scroll.getContentWidth(23), 22);
});

test("tool/subagent components are opaque even when containing real user-message previews", t => {
  const branch = freeze([user("old", "same"), user("new", "same")]);
  const h = fixture(t, branch);
  class Preview extends Container {}
  const preview = new Preview();
  preview.addChild(new UserMessageComponent("same"));
  h.chat.children.splice(1, 0, preview);
  jumped(h, prompt(branch[0]), branch);
  jumped(h, prompt(branch[1]), branch);
});

test("identical unpersisted message_start after compaction never shifts retained or compacted prompt IDs", t => {
  const a = user("a", "same", 100);
  const b = user("b", "same", 200);
  const branch = freeze([a, b, compaction("compact", "b")]);
  const h = fixture(t, [b]);
  // Before message_start, b is precisely the retained source and a is absent.
  assert.equal(scrollToPrompt(h.tui, prompt(a), branch), "missing");
  jumped(h, prompt(b), branch);
  h.add(user("not-persisted-c", "same", 300));
  h.scroll.scrollToEnd();
  h.tui.renderNow();
  const before = h.scroll.scrollTop;
  h.calls.length = 0;
  for (const anchor of [prompt(a), prompt(b)]) {
    assert.equal(scrollToPrompt(h.tui, anchor, branch), "missing");
    assert.equal(h.scroll.scrollTop, before);
    assert.equal(h.calls.length, 0);
  }
});

test("extra identical or distinct unpersisted rendered prompts fail closed without compaction", t => {
  const branch = freeze([user("a", "same"), user("b", "same")]);
  for (const text of ["same", "fresh live prompt"]) {
    const h = fixture(t, branch);
    h.add(user("not-persisted", text));
    h.tui.renderNow();
    const before = h.scroll.scrollTop;
    for (const entry of branch) {
      assert.equal(scrollToPrompt(h.tui, prompt(entry), branch), "missing");
      assert.equal(h.scroll.scrollTop, before);
      assert.equal(h.calls.length, 0);
    }
  }
});

test("latest compaction explicitly determines retained IDs and includes post-compaction prompts", t => {
  const a = user("a", "same");
  const b = user("b", "same");
  const c = user("c", "same");
  const d = user("d", "same");
  const branch = freeze([a, b, compaction("first", "b"), c, compaction("latest", "c"), d]);
  const h = fixture(t, [c, d]);
  for (const entry of [a, b]) assert.equal(scrollToPrompt(h.tui, prompt(entry), branch), "missing");
  assert.equal(h.calls.length, 0);
  jumped(h, prompt(c), branch);
  jumped(h, prompt(d), branch);
  const noKept = freeze([a, b, compaction("latest", "latest"), d]);
  const postOnly = fixture(t, [d]);
  assert.equal(scrollToPrompt(postOnly.tui, prompt(b), noKept), "missing");
  jumped(postOnly, prompt(d), noKept);
  const invalid = freeze([a, b, compaction("latest", "not-on-branch"), d]);
  assert.equal(scrollToPrompt(postOnly.tui, prompt(d), invalid), "missing");
});

test("missing rendered prompts and exact-order mismatches never fall back to a matching suffix", t => {
  const branch = freeze([user("a", "first"), user("b", "second"), user("c", "third")]);
  for (const rendered of [branch.slice(1), [branch[0], branch[2]], [branch[1], branch[0], branch[2]]]) {
    const h = fixture(t, rendered);
    for (const entry of branch) assert.equal(scrollToPrompt(h.tui, prompt(entry), branch), "missing");
    assert.equal(h.calls.length, 0);
  }
});

test("disableFollow also holds when target is at the clamped end of a short document", t => {
  const branch = freeze([user("a", "short")]);
  const h = fixture(t, branch, { rows: 100 });
  assert.equal(scrollToPrompt(h.tui, prompt(branch[0]), branch), "jumped");
  assert.equal(h.scroll.scrollTop, 0);
  assert.equal(h.scroll.isFollowingEnd, false);
  h.tui.renderNow();
  assert.equal(h.scroll.isFollowingEnd, false);
});

test("mounted sticky-note click and /note jump scroll to the pinned old prompt through native fullscreen mouse dispatch", async t => {
  const task = "older pinned task with enough words to wrap in the optional expanded view ".repeat(3);
  const entries = [user("old", task, 100), user("new", "newer task", 200)];
  const branch = freeze([...entries,
    { type: "custom", id: "pin", customType: "footer-tools.sticky-note", data: { op: "pin", entryId: "old" } },
    { type: "custom", id: "note", customType: "footer-tools.sticky-note", data: { op: "set", text: "personal note" } },
  ]);
  const snapshot = JSON.stringify(branch);
  const h = fixture(t, entries, { rows: 20 });
  const tui = createInteractiveTuiReference(() => h.tui);
  const footer = new Container();
  h.tui.setLayoutRoot(new VStack([
    { component: h.scroll, grow: 1, shrink: 1, basis: 0 },
    { component: footer, basis: "auto", shrink: 0 },
  ]));
  const configDir = mkdtempSync(join(tmpdir(), "sticky-navigation-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const configPath = join(configDir, "config.json");
  writeFileSync(configPath, JSON.stringify({ stickyNote: { enabled: true } }));
  const handlers = new Map();
  const commands = new Map();
  const notices = [];
  let widget;
  let editorCalls = 0;
  let editorPrefill;
  const forbidden = () => assert.fail("UI navigation must not mutate/resend/navigate/fork");
  const ctx = {
    mode: "tui",
    sessionManager: { getBranch: () => branch, navigateTree: forbidden, fork: forbidden },
    navigateTree: forbidden, fork: forbidden, newSession: forbidden,
    ui: {
      setWidget: (_key, factory) => {
        footer.clear();
        widget = factory?.(tui, { fg: (_color, text) => text });
        if (widget) footer.addChild(widget);
      },
      notify: (...args) => notices.push(args),
      editor: async (_title, prefill) => { editorCalls++; editorPrefill = prefill; return undefined; },
      setEditorText: forbidden,
    },
  };
  registerStickyNote({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    registerShortcut() {},
    appendEntry: forbidden, sendUserMessage: forbidden, sendMessage: forbidden,
  }, { configPath });
  handlers.get("session_start")({}, ctx);
  h.tui.renderNow();
  const folded = widget.render(h.terminal.columns);
  assert.match(folded[0], /older pinned task/);
  assert.equal(folded.length, 2, "folded task plus note");
  function clickWidgetRow(row) {
    h.tui.renderNow();
    const widgetHeight = widget.render(h.terminal.columns).length;
    const terminalY = h.terminal.rows - widgetHeight + row + 1;
    h.terminal.input(`\x1b[<0;3;${terminalY}M`);
    h.terminal.input(`\x1b[<0;3;${terminalY}m`);
  }
  clickWidgetRow(0);
  assert.equal(h.scroll.scrollTop, h.row("old"));
  assert.equal(h.scroll.isFollowingEnd, false);
  assert.deepEqual(widget.render(h.terminal.columns), folded, "click never expands");
  assert.equal(editorCalls, 0);
  h.scroll.scrollToEnd();
  await commands.get("note").handler("jump", ctx);
  assert.equal(h.scroll.scrollTop, h.row("old"));
  assert.deepEqual(widget.render(h.terminal.columns), folded);
  // Expansion remains an explicit keyboard operation, and clicking any expanded task row still only jumps.
  await commands.get("note").handler("task", ctx);
  const expanded = widget.render(h.terminal.columns);
  assert.ok(expanded.length > folded.length);
  h.scroll.scrollToEnd();
  clickWidgetRow(1);
  assert.equal(h.scroll.scrollTop, h.row("old"));
  assert.deepEqual(widget.render(h.terminal.columns), expanded, "click never folds either");
  assert.equal(editorCalls, 0);
  clickWidgetRow(expanded.length - 1);
  await Promise.resolve();
  assert.equal(editorCalls, 1);
  assert.equal(editorPrefill, "personal note");
  assert.equal(JSON.stringify(branch), snapshot);
  assert.deepEqual(notices, []);
});

test("regular mode, stopped/overlay TUI, missing methods and incompatible layouts are unsupported", t => {
  const branch = freeze([user("a", "task")]);
  const anchor = prompt(branch[0]);
  const regular = new TuiMainScreen(new MemoryTerminal());
  assert.equal(scrollToPrompt(regular, anchor, branch), "unsupported");
  assert.equal(scrollToPrompt({ requestRender() { assert.fail(); } }, anchor, branch), "unsupported");
  const h = fixture(t, branch);
  const originalRender = h.tui.renderNow.bind(h.tui);
  const corrupt = change => {
    h.tui.renderNow = () => { originalRender(); change(h.tui.currentLayout); };
    assert.equal(scrollToPrompt(h.tui, anchor, branch), "unsupported");
    assert.equal(h.calls.length, 0);
  };
  corrupt(frame => { frame.root.children = []; });
  corrupt(frame => { frame.width++; });
  corrupt(frame => { frame.root.scrollContentLines = ["wrong stale lines"]; });
  corrupt(frame => { frame.primaryScrollView = {}; });
  h.tui.renderNow = () => { throw new Error("host renderer changed"); };
  assert.equal(scrollToPrompt(h.tui, anchor, branch), "unsupported");
  h.tui.renderNow = originalRender;
  const handle = h.tui.showOverlay(new Text("overlay", 0, 0));
  assert.equal(scrollToPrompt(h.tui, anchor, branch), "unsupported");
  handle.hide();
  h.tui.stop({ preserveScreen: true });
  assert.equal(scrollToPrompt(h.tui, anchor, branch), "unsupported");
});
