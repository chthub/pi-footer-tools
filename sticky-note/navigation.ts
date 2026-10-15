import {
  parseSkillBlock,
  SkillInvocationMessageComponent,
  type SessionEntry,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, Spacer, type Component, type TUI } from "@earendil-works/pi-tui";
import { cleanPrompt, messageText, type Prompt } from "./core.ts";

type Result = "jumped" | "unsupported" | "missing" | "pending";
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => typeof value === "object" && value !== null;
const lines = (value: unknown): value is string[] => Array.isArray(value) && value.every(line => typeof line === "string");
const positiveInteger = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;
const jumping = new WeakSet<object>();

/** Same join as InteractiveMode.getUserMessageText, NOT the note's newline-separated preview. */
function rawText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(part => record(part) && part.type === "text" && typeof part.text === "string")
    .map(part => part.text).join("");
}

function skillKey(block: unknown): string | undefined {
  if (!record(block) || typeof block.name !== "string" || typeof block.location !== "string" ||
    typeof block.content !== "string" || (block.userMessage !== undefined && typeof block.userMessage !== "string")) return;
  return JSON.stringify(["skill", block.name, block.location, block.content, block.userMessage ?? null]);
}

function sourceKey(text: string): string {
  const skill = parseSkillBlock(text);
  return skill ? skillKey(skill)! : JSON.stringify(["text", text]);
}

function plainContainer(component: unknown): component is Container {
  return record(component) && Object.getPrototypeOf(component) === Container.prototype &&
    component.render === Container.prototype.render && Array.isArray(component.children);
}

interface Leaf { component: Component; row: number; height: number }

/** Only plain document/header/chat containers are transparent. Tools and subagent previews are opaque. */
function collectLeaves(document: Container, width: number): { leaves: Leaf[]; output: string[] } | undefined {
  const leaves: Leaf[] = [];
  const output: string[] = [];
  const seen = new Set<Component>();
  function walk(component: Component): boolean {
    if (!record(component) || seen.has(component)) return false;
    seen.add(component);
    if (plainContainer(component)) return component.children.every(walk);
    if (typeof component.render !== "function") return false;
    const rendered: unknown = component.render(width);
    if (!lines(rendered)) return false;
    leaves.push({ component, row: output.length, height: rendered.length });
    output.push(...rendered);
    return true;
  }
  return walk(document) ? { leaves, output } : undefined;
}

/** Guarded Pi 1.2.0 fullscreen adapter. No session APIs, editor input, model calls, or text search. */
export function scrollToPrompt(tui: TUI, anchor: Prompt, branch: readonly SessionEntry[]): Result {
  if (jumping.has(tui)) return "unsupported";
  jumping.add(tui);
  try {
    // Property access (not own-property reflection) also supports createInteractiveTuiReference's proxy.
    const host = tui as unknown as RecordValue;
    if (host.mode !== "fullscreen" || host.stopped !== false || host.altScreenActive !== true ||
      typeof host.renderNow !== "function" || typeof host.requestRender !== "function" ||
      typeof host.hasOverlay !== "function" || host.hasOverlay()) return "unsupported";

    const sources = branch.flatMap((entry, branchIndex) => {
      if (entry.type !== "message" || entry.message.role !== "user") return [];
      const raw = rawText(entry.message.content);
      return raw ? [{ id: entry.id, branchIndex, key: sourceKey(raw), text: cleanPrompt(messageText(entry.message.content)),
        timestamp: entry.message.timestamp }] : [];
    });
    let target: (typeof sources)[number] | undefined;
    if (anchor.id !== undefined) {
      const matches = sources.filter(source => source.id === anchor.id);
      if (matches.length !== 1) return "missing";
      target = matches[0];
    } else {
      if (anchor.timestamp === undefined || !Number.isFinite(anchor.timestamp)) return "pending";
      const matches = sources.filter(source => source.timestamp === anchor.timestamp && source.text === anchor.text);
      if (matches.length === 0) return "pending";
      if (matches.length !== 1) return "missing";
      target = matches[0];
    }

    // Flush queued layout/resize work before observing private layout state. Do not reset the viewport.
    host.renderNow();
    const frame = host.currentLayout;
    if (!record(frame) || !positiveInteger(frame.width) || !positiveInteger(frame.height) ||
      !record(host.terminal) || frame.width !== host.terminal.columns || frame.height !== host.terminal.rows ||
      !(frame.primaryScrollView instanceof ScrollView)) return "unsupported";
    const scroll = frame.primaryScrollView;
    const boxes: RecordValue[] = [];
    const visited = new Set<unknown>();
    function findBox(box: unknown): boolean {
      if (!record(box) || visited.has(box) || !Array.isArray(box.children)) return false;
      visited.add(box);
      if (box.scrollView === scroll) boxes.push(box);
      return box.children.every(findBox);
    }
    if (!findBox(frame.root) || boxes.length !== 1) return "unsupported";
    const box = boxes[0];
    if (!record(box.rect) || !positiveInteger(box.rect.width) || !lines(box.scrollContentLines) ||
      !Array.isArray(box.children) || box.children.length !== 1 || !record(box.children[0]) ||
      !plainContainer(box.children[0].component) || scroll.children.length !== 1 ||
      scroll.children[0] !== box.children[0].component) return "unsupported";
    const width = scroll.getContentWidth(box.rect.width);
    if (!positiveInteger(width)) return "unsupported";
    const collected = collectLeaves(box.children[0].component, width);
    if (!collected || collected.output.length !== box.scrollContentLines.length ||
      collected.output.some((line, index) => line !== (box.scrollContentLines as string[])[index])) return "unsupported";

    const visible: { key: string; row: number }[] = [];
    const { leaves } = collected;
    for (let index = 0; index < leaves.length; index++) {
      const { component, row, height } = leaves[index];
      if (Object.getPrototypeOf(component) === SkillInvocationMessageComponent.prototype) {
        const block = (component as unknown as RecordValue).skillBlock;
        const key = skillKey(block);
        if (!key || !record(block) || height === 0) return "unsupported";
        if (block.userMessage) {
          // Host renders skill + spacer + user text as ONE source prompt.
          const spacer = leaves[index + 1];
          const user = leaves[index + 2];
          if (!spacer || Object.getPrototypeOf(spacer.component) !== Spacer.prototype || spacer.height !== 1 ||
            !user || Object.getPrototypeOf(user.component) !== UserMessageComponent.prototype ||
            (user.component as unknown as RecordValue).text !== block.userMessage) return "unsupported";
          index += 2;
        }
        visible.push({ key, row });
      } else if (Object.getPrototypeOf(component) === UserMessageComponent.prototype) {
        const text = (component as unknown as RecordValue).text;
        if (typeof text !== "string" || height === 0) return "unsupported";
        visible.push({ key: JSON.stringify(["text", text]), row });
      }
    }

    // `branch` is already the full root-to-leaf path. Mirror buildContextEntries' retained range,
    // without walking parentId again (or guessing a suffix from duplicate text).
    let expected = sources;
    for (let index = branch.length - 1; index >= 0; index--) {
      const compaction = branch[index];
      if (compaction.type !== "compaction") continue;
      let firstKept = index; // firstKeptEntryId === compaction.id means no pre-compaction entries kept.
      if (compaction.firstKeptEntryId !== compaction.id) {
        const matches = branch.slice(0, index).flatMap((entry, keptIndex) =>
          entry.id === compaction.firstKeptEntryId ? [keptIndex] : []);
        if (matches.length !== 1) return "missing";
        firstKept = matches[0];
      }
      expected = sources.filter(source => source.branchIndex >= firstKept && source.branchIndex !== index);
      break; // Only the latest compaction controls the active retained range.
    }
    // Check the ENTIRE expected sequence before trusting any row. Even an identical unpersisted
    // message_start component must invalidate mapping; greedy matching could silently shift IDs.
    // Raw keys preserve distinct fenced pastes that share the same cleaned note preview.
    if (visible.length !== expected.length || visible.some((prompt, index) => prompt.key !== expected[index].key)) {
      return "missing";
    }
    const targetIndex = expected.indexOf(target);
    if (targetIndex < 0) return "missing";
    const targetRow = visible[targetIndex].row;
    scroll.scrollTo(targetRow, { disableFollow: true });
    host.requestRender();
    return "jumped";
  } catch {
    // Internal SDK shapes/renderers can change. A broken adapter must not escape into mouse dispatch.
    return "unsupported";
  } finally {
    jumping.delete(tui);
  }
}
