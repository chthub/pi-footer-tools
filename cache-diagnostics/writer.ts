import { constants } from "node:fs";
import { mkdir, mkdtemp, lstat, open, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { Channel, JsonRecord } from "./core.ts";

interface FileState { handle?: FileHandle; bytes: number; index: number }
interface Queued { channel: Channel; line: string; bytes: number }
export interface WriterOptions { maxFileBytes?: number; maxFiles?: number; maxQueueBytes?: number; maxLineBytes?: number }

/** Bounded async writer. It only rotates files in its own private capture directory. */
export class JsonlWriter {
  directory = "";
  failed = false;
  dropped = 0;
  written = 0;
  rotatedFiles = 0;
  private closed = false;
  private closePromise?: Promise<void>;
  private queue: Queued[] = [];
  private queueBytes = 0;
  private work?: Promise<void>;
  private files: Record<Channel, FileState> = {
    summary: { bytes: 0, index: 0 }, anomalies: { bytes: 0, index: 0 },
  };
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly maxQueueBytes: number;
  private readonly maxLineBytes: number;
  readonly ready: Promise<void>;
  constructor(root: string, private readonly onFailure: () => void, options: WriterOptions = {}) {
    this.maxFileBytes = options.maxFileBytes ?? 4 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 3;
    this.maxQueueBytes = options.maxQueueBytes ?? 2 * 1024 * 1024;
    this.maxLineBytes = options.maxLineBytes ?? 256 * 1024;
    for (const n of [this.maxFileBytes, this.maxFiles, this.maxQueueBytes, this.maxLineBytes]) {
      if (!Number.isSafeInteger(n) || n < 1) throw new Error("Invalid diagnostic writer bounds");
    }
    this.ready = this.initialize(root).catch(() => this.fail());
  }
  private async initialize(root: string): Promise<void> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Diagnostic root must be a real directory");
    this.directory = await mkdtemp(join(root, "capture-")); // Node creates this with mode 0700.
  }
  private fail(): void {
    if (this.failed) return;
    this.failed = true;
    this.dropped += this.queue.length;
    this.queue = []; this.queueBytes = 0;
    try { this.onFailure(); } catch { /* A diagnostic must never disrupt a model call. */ }
  }
  emit(channel: Channel, record: JsonRecord): void {
    if (this.failed || this.closed) { this.dropped++; return; }
    let line: string;
    try { line = JSON.stringify({ schemaVersion: 1, ...record }) + "\n"; }
    catch { this.dropped++; return; }
    const bytes = Buffer.byteLength(line);
    if (bytes > Math.min(this.maxLineBytes, this.maxFileBytes) || bytes + this.queueBytes > this.maxQueueBytes) { this.dropped++; return; }
    this.queue.push({ channel, line, bytes }); this.queueBytes += bytes;
    if (!this.work) this.start();
  }
  private start(): void {
    this.work = this.pump().catch(() => this.fail()).finally(() => {
      this.work = undefined;
      if (this.queue.length && !this.failed) this.start();
    });
  }
  private filePath(channel: Channel, index: number): string { return join(this.directory, `${channel}-${String(index).padStart(6, "0")}.jsonl`); }
  private async pump(): Promise<void> {
    await this.ready;
    while (this.queue.length && !this.failed) {
      const row = this.queue[0];
      const state = this.files[row.channel];
      if (state.handle && state.bytes + row.bytes > this.maxFileBytes) {
        await state.handle.close(); state.handle = undefined;
        state.index++; state.bytes = 0;
      }
      if (!state.handle) {
        state.handle = await open(this.filePath(row.channel, state.index), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        if (state.index >= this.maxFiles) {
          await unlink(this.filePath(row.channel, state.index - this.maxFiles));
          this.rotatedFiles++;
        }
      }
      const buffer = Buffer.from(row.line);
      let offset = 0;
      while (offset < buffer.length) {
        const result = await state.handle.write(buffer, offset, buffer.length - offset);
        if (result.bytesWritten === 0) throw new Error("Zero-byte diagnostic write");
        offset += result.bytesWritten;
      }
      state.bytes += row.bytes;
      this.queue.shift(); this.queueBytes -= row.bytes; this.written++;
    }
  }
  async flush(): Promise<void> {
    await this.ready;
    while (this.work) await this.work;
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.finalize();
    return this.closePromise;
  }
  private async finalize(): Promise<void> {
    await this.flush();
    for (const state of Object.values(this.files)) {
      try { await state.handle?.close(); } catch { this.fail(); }
      state.handle = undefined;
    }
  }
  status(): JsonRecord {
    return { directory: this.directory || undefined, failed: this.failed, dropped: this.dropped, written: this.written, queued: this.queue.length, rotatedFiles: this.rotatedFiles };
  }
}
