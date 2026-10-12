"""Drive installed Pi PTYs through the integrated entry; no external network/model."""
import fcntl
import json
import os
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path
from typing import Any

TEST_DIR = Path(__file__).resolve().parent
ROOT = Path(__file__).resolve().parents[2]
ANSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\\\)")


class Window:
    def __init__(self, parent: Path, name: str, configured: bool = True,
                 json_credentials: bool = False, receive_messages: bool = False,
                 feature_enabled: bool = True):
        self.dir = parent / name
        self.dir.mkdir()
        self.log = self.dir / "events.jsonl"
        self.output = b""
        if json_credentials:
            config = self.dir / "telegram-notify.json"
            config.write_text(json.dumps({
                "token": "test-only:json-token", "chatId": "456", "enabled": True,
                "receiveMessages": receive_messages,
            }))
            config.chmod(0o600)
        feature_config = self.dir / "footer-tools.json"
        feature_config.write_text(json.dumps({
            "cacheDiagnostics": {"enabledByDefault": False},
            **({"telegramNotify": {"enabled": True}} if feature_enabled else {}),
        }))
        (self.dir / "settings.json").write_text(json.dumps({
            "enableInstallTelemetry": False,
            "retry": {"enabled": True, "baseDelayMs": 10, "maxRetries": 1},
            "compaction": {"enabled": False},
            "cacheWarming": "off",
        }))
        master, slave = pty.openpty()
        self.master = master
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
        env = dict(os.environ, PI_CODING_AGENT_DIR=str(self.dir),
                   PI_FOOTER_TOOLS_CONFIG=str(feature_config),
                   TG_TEST_LOG=str(self.log), TERM="xterm-256color",
                   TELEGRAM_BOT_TOKEN="test-only:fake-token", TELEGRAM_CHAT_ID="123")
        if not configured:
            env.pop("TELEGRAM_BOT_TOKEN", None)
            env.pop("TELEGRAM_CHAT_ID", None)
        executable = shutil.which("pi")
        assert executable
        self.proc = subprocess.Popen([
            executable, "--offline", "--no-extensions", "--no-skills",
            "--no-prompt-templates", "--no-context-files", "--no-themes",
            "--no-session", "--no-tools", "--no-approve",
            "-e", str(TEST_DIR / "tui-fixture.ts"), "-e", str(ROOT / "index.ts"),
            "--provider", "tg-smoke", "--model", "synthetic", "--thinking", "off",
        ], cwd=self.dir, env=env, stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)

    def pump(self):
        ready, _, _ = select.select([self.master], [], [], 0.05)
        if ready:
            try:
                chunk = os.read(self.master, 65536)
            except OSError:
                chunk = b""
            self.output += chunk
            # Answer terminal appearance/size queries, like a terminal emulator.
            if b"\x1b]10;?" in chunk:
                os.write(self.master, b"\x1b]10;rgb:ffff/ffff/ffff\x07")
            if b"\x1b]11;?" in chunk:
                os.write(self.master, b"\x1b]11;rgb:0000/0000/0000\x07")
            if b"\x1b[6n" in chunk:
                os.write(self.master, b"\x1b[1;1R")

    def wait(self, predicate, label: str, seconds: float = 12):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self.pump()
            if predicate():
                return
            if self.proc.poll() is not None:
                break
        raise AssertionError(f"{label}\n{self.text()[-6000:]}")

    def text(self) -> str:
        return ANSI.sub(b"", self.output).decode("utf-8", errors="replace")

    def events(self) -> list[dict[str, Any]]:
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def count(self, event: str) -> int:
        return sum(e["event"] == event for e in self.events())

    def send(self, data: bytes):
        os.write(self.master, data)

    def toggle(self, state: str):
        self.output = b""
        self.send(b"\x1bn")  # Alt+N in the legacy terminal protocol.
        self.wait(lambda: f"TG: {state} [Alt+N]" in self.text(), f"toggle {state}")

    def task(self, name: str):
        start = self.count("agent_settled")
        self.send(name.encode() + b"\r")
        self.wait(lambda: self.count("agent_settled") == start + 1, f"settle {name}")
        for _ in range(4):
            self.pump()

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
        os.close(self.master)


def main():
    runtime = TEST_DIR / ".test-runtime"
    runtime.mkdir(exist_ok=True)
    windows = []
    with tempfile.TemporaryDirectory(dir=runtime) as tmp:
        parent = Path(tmp)
        try:
            disabled = Window(parent, "default-disabled", feature_enabled=False)
            windows.append(disabled)
            disabled.wait(lambda: "synthetic" in disabled.text(), "disabled startup ready")
            for _ in range(4):
                disabled.pump()
            disabled.task("default-disabled")
            assert "TG:" not in disabled.text()
            assert disabled.count("telegram") == 0
            disabled.close()
            windows.remove(disabled)
            print("PASS: integrated default-disabled startup/task has no TG UI or delivery")

            a, b = Window(parent, "A"), Window(parent, "B")
            windows.extend([a, b])
            for window in windows:
                window.wait(lambda w=window: "TG: OFF [Alt+N]" in w.text(), "startup OFF")
                assert window.count("telegram") == window.count("model_start") == 0
            a.toggle("ON")
            assert a.count("model_start") == 0  # Shortcut submitted no prompt.
            b.pump()
            assert "TG: ON" not in b.text()
            print("PASS: fresh processes OFF; immediate toggle; process B remains OFF")

            # Toggle while the model is running; an unsubmitted draft stays intact.
            a.send(b"simple\r")
            a.wait(lambda: a.count("model_start") == 1, "model active")
            a.send(b"draft-kept")
            a.toggle("OFF")
            a.toggle("ON")
            a.wait(lambda: a.count("agent_settled") == 1, "simple settlement")
            a.wait(lambda: a.count("telegram") == 1, "one Telegram send")
            a.send(b"\x15")  # Clear draft; would not do this if shortcut submitted it.
            assert a.count("model_start") == 1
            a.send(b"/notify-status-unused")  # Unsubmitted input remains editable.
            a.send(b"\x15")
            print("PASS: toggle during active run; no extra submission/cancel; one final send")

            a.toggle("OFF")
            a.task("off")
            assert a.count("telegram") == 1
            b.task("other-window")
            assert b.count("telegram") == 0
            print("PASS: OFF completion and isolated B completion send nothing")

            a.toggle("ON")
            previous = a.count("telegram")
            ends = a.count("agent_end")
            a.task("continue")
            assert a.count("agent_end") == ends + 2
            assert a.count("telegram") == previous + 1
            previous = a.count("telegram")
            ends = a.count("agent_end")
            a.task("retry")
            assert a.count("agent_end") == ends + 2
            assert a.count("telegram") == previous + 1
            print("PASS: actual pre-settle continuation + automatic retry; no premature sends")

            # Queue real follow-up work while the first model response is active.
            previous = a.count("telegram")
            calls = a.count("model_start")
            a.send(b"queued-first\r")
            a.wait(lambda: a.count("model_start") == calls + 1, "queued task starts")
            a.send(b"queued-followup\x1b\r")
            a.wait(lambda: a.count("model_start") == calls + 2, "follow-up starts")
            a.wait(lambda: a.count("telegram") == previous + 1, "queued final send")
            for _ in range(5):
                a.pump()
            assert a.count("telegram") == previous + 1
            print("PASS: queued follow-up drains before a single final notification")

            a.output = b""
            a.task("failure")
            a.wait(lambda: "TG: 发送失败" in a.text(), "quiet delivery warning")
            a.task("after-failure")
            assert a.proc.poll() is None
            assert "test-only:fake-token" not in a.text()
            print("PASS: delivery failure caught; next Pi task still works; no token disclosure")

            # Every send is after final settlement and contains the final synthetic answer.
            events = a.events()
            for i, event in enumerate(events):
                if event["event"] == "telegram":
                    assert events[i - 1]["event"] == "agent_settled"
                    assert event["body"]["chat_id"] == "123"
                    assert event["body"]["text"].startswith("SMOKE_RESULT_")

            a.output = b""
            previous = a.count("telegram")
            a.send(b"/reload\r")
            a.wait(lambda: "TG: OFF [Alt+N]" in a.text(), "reload OFF", seconds=20)
            a.task("after-reload-off")
            assert a.count("telegram") == previous
            print("PASS: real /reload tears down old runtime and resets window OFF")

            a.close()
            windows.remove(a)
            c = Window(parent, "C")
            windows.append(c)
            c.wait(lambda: "TG: OFF [Alt+N]" in c.text(), "replacement process OFF")
            assert c.count("telegram") == 0
            d = Window(parent, "unconfigured", configured=False)
            windows.append(d)
            d.wait(lambda: "UNCONFIGURED" in d.text(), "missing credentials")
            d.output = b""
            d.send(b"\x1bn")
            d.wait(lambda: "TELEGRAM_BOT_TOKEN" in d.text(), "local warning")
            assert "TG: ON" not in d.text()
            assert d.proc.poll() is None
            print("PASS: new process OFF; missing credentials safe")

            e = Window(parent, "json-config", configured=False, json_credentials=True)
            windows.append(e)
            e.wait(lambda: "TG: OFF [Alt+N]" in e.text(), "JSON-only startup OFF")
            assert "UNCONFIGURED" not in e.text()
            assert e.count("telegram") == 0
            e.toggle("ON")
            e.task("json-only")
            assert e.count("telegram") == 1
            delivery = next(event for event in e.events() if event["event"] == "telegram")
            assert delivery["body"]["chat_id"] == "456"
            assert "test-only:json-token" not in e.text()
            print("PASS: user JSON-only credentials; enabled field ignored; safe final delivery")
        finally:
            for window in windows:
                window.close()


if __name__ == "__main__":
    main()
