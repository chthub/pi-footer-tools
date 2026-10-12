import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type ReceiverStatus = "WAIT" | "READY" | "ERR";
export interface ReceiverOptions {
  token: string;
  chatId: string;
  allowedUserIds: string[];
  onText: (text: string) => void;
  onStatus: (status: ReceiverStatus) => void;
  // Dependency injection for isolated tests, not configurable from Telegram/JSON.
  socketPath?: string;
  launch?: () => void;
}

/** Linux local IPC; one flock-protected collector per bot, not one poller per Pi. */
export class Receiver {
  private socket?: Socket;
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private delay = 250;
  private ids: number[] = [];
  private seen = new Set<number>();
  private socketPath: string;
  private launch: () => void;

  constructor(private options: ReceiverOptions) {
    if (process.platform !== "linux") throw new Error("Telegram receiver requires Linux");
    const uid = process.getuid!();
    const dir = join(tmpdir(), `pi-telegram-${uid}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) {
      throw new Error("Unsafe Telegram IPC directory");
    }
    const digest = createHash("sha256").update(options.token).digest("hex");
    this.socketPath = options.socketPath ?? join(dir, `${digest.slice(0, 20)}.sock`);
    this.launch = options.launch ?? (() => {
      // Credentials are passed over private IPC, never in argv, disk, or child env.
      const child = spawn("flock", ["-n", `${this.socketPath}.lock`, process.execPath,
        fileURLToPath(new URL("./relay.mjs", import.meta.url)), this.socketPath, digest], {
        detached: true, stdio: "ignore",
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      });
      child.on("error", () => this.status("ERR"));
      child.unref();
    });
    this.status("WAIT");
    this.connect();
  }

  private status(value: ReceiverStatus): void {
    if (!this.stopped) {
      try { this.options.onStatus(value); } catch { /* A disposed UI is harmless. */ }
    }
  }

  private send(value: unknown): void {
    if (!this.socket?.destroyed && this.socket?.readyState === "open") {
      if (this.socket.writableLength > 65536) this.socket.destroy();
      else this.socket.write(JSON.stringify(value) + "\n");
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const socket = createConnection(this.socketPath);
    this.socket = socket;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      if (this.stopped) { socket.destroy(); return; }
      this.delay = 250;
      this.send({ op: "register", token: this.options.token, chatId: this.options.chatId,
        allowedUserIds: this.options.allowedUserIds, ids: this.ids });
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 32768) { socket.destroy(); return; }
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          const event = JSON.parse(line);
          if (event.op === "status" && ["WAIT", "READY", "ERR"].includes(event.status)) {
            this.status(event.status);
          } else if (event.op === "text" && Number.isSafeInteger(event.id) &&
              typeof event.text === "string" && event.text.trim() && event.text.length <= 4096 &&
              !this.seen.has(event.id) && !this.stopped) {
            this.seen.add(event.id);
            if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!);
            this.options.onText(event.text);
          }
        } catch { this.status("ERR"); }
      }
    });
    socket.on("error", () => { /* Reconnect below; never display raw socket errors. */ });
    socket.on("close", () => {
      if (this.stopped || this.socket !== socket) return;
      this.status("WAIT");
      try { this.launch(); } catch { this.status("ERR"); }
      this.retry = setTimeout(() => this.connect(), this.delay);
      this.retry.unref();
      this.delay = Math.min(this.delay * 2, 10000);
    });
  }

  remember(messageId: number): void {
    if (this.stopped || !Number.isSafeInteger(messageId) || messageId <= 0) return;
    if (!this.ids.includes(messageId)) {
      this.ids.push(messageId);
      if (this.ids.length > 128) this.ids.shift();
      this.send({ op: "remember", id: messageId });
    }
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.socket?.destroy();
    this.ids = [];
    this.seen.clear();
  }
}
