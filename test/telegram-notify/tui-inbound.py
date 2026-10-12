"""Real Pi processes, shared local collector, synthetic Telegram replies and model."""
import hashlib
import json
import os
import runpy
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

TEST_DIR = Path(__file__).resolve().parent
Window = runpy.run_path(str(TEST_DIR / "tui-smoke.py"))["Window"]


def main():
    node = shutil.which("node")
    flock = shutil.which("flock")
    assert node and flock
    runtime = TEST_DIR / ".test-runtime"
    runtime.mkdir(exist_ok=True)
    windows = []
    collector = None
    ipc = Path(tempfile.gettempdir()) / f"pi-telegram-{os.getuid()}"
    ipc.mkdir(mode=0o700, exist_ok=True)
    digest = hashlib.sha256(b"test-only:json-token").hexdigest()[:20]
    socket = ipc / (digest + ".sock")
    lock = ipc / (digest + ".sock.lock")
    with tempfile.TemporaryDirectory(dir=runtime) as tmp:
        parent = Path(tmp)
        updates_file = parent / "updates.jsonl"
        updates_file.write_text("")
        try:
            collector = subprocess.Popen([
                flock, "-n", str(lock), node, str(TEST_DIR / "relay-fixture.mjs"), str(parent),
            ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            # stdout/stderr are synthetic fixture output only, never real credentials.
            end = time.monotonic() + 5
            while not socket.exists():
                assert collector.poll() is None, "fixture collector failed"
                assert time.monotonic() < end, "collector startup timeout"
                time.sleep(0.02)
            # Another process cannot take the same bot's collector lock.
            competing = subprocess.run([flock, "-n", str(lock), "true"], capture_output=True, check=False)
            assert competing.returncode != 0

            a = Window(parent, "A", configured=False, json_credentials=True, receive_messages=True)
            b = Window(parent, "B", configured=False, json_credentials=True, receive_messages=True)
            windows.extend([a, b])
            for window in windows:
                window.wait(lambda w=window: "TG: OFF" in w.text(), "startup OFF")
                window.toggle("ON")
                window.wait(lambda w=window: "RX:READY" in w.text(), "inbound ready")
            a.task("baseline-A")
            b.task("baseline-B")
            a_id = next(e["messageId"] for e in a.events() if e["event"] == "telegram")
            b_id = next(e["messageId"] for e in b.events() if e["event"] == "telegram")
            assert a_id != b_id

            update_id = 0

            def reply(message_id: int, text: str, chat_id: int = 456, sender_id: int = 456):
                nonlocal update_id
                update_id += 1
                event = {"update_id": update_id, "message": {
                    "text": text, "chat": {"id": chat_id, "type": "private"},
                    "from": {"id": sender_id, "is_bot": False},
                    "reply_to_message": {"message_id": message_id},
                }}
                with updates_file.open("a") as file:
                    file.write(json.dumps(event) + "\n")

            reply(a_id, "remote-wrong-chat", chat_id=999)
            reply(a_id, "remote-wrong-sender", sender_id=999)
            reply(999999, "remote-unknown-target")
            reply(a_id, "remote-idle-A")
            a.wait(lambda: a.count("agent_settled") == 2, "Telegram wakes idle A")
            a.wait(lambda: a.count("telegram") == 2, "remote result sent back")
            assert a.events()[-1]["body"]["text"] == "SMOKE_RESULT_2"
            assert b.count("model_start") == 1
            assert any(e["event"] == "model_start" and e["remote"] for e in a.events())
            print("PASS: reply wakes exactly the corresponding idle Pi process; unauthorized replies ignored")

            a.send(b"local-active\r")
            a.wait(lambda: a.count("model_start") == 3, "local task running")
            reply(a_id, "remote-busy-A")
            a.wait(lambda: a.count("model_start") == 4, "remote follow-up starts")
            a.wait(lambda: a.count("telegram") == 3, "final queued result sent")
            assert a.count("agent_settled") == 3
            assert a.events()[-1]["body"]["text"] == "SMOKE_RESULT_4"
            assert b.count("model_start") == 1
            print("PASS: busy Pi queues Telegram as follow-up, without aborting/submitting editor text")

            a.toggle("OFF")
            reply(a_id, "remote-off-A")
            reply(b_id, "remote-idle-B")
            b.wait(lambda: b.count("agent_settled") == 2, "B still receives")
            b.wait(lambda: b.count("telegram") == 2, "B remote result")
            assert a.count("model_start") == 4
            assert b.events()[-1]["body"]["text"] == "SMOKE_RESULT_2"
            print("PASS: OFF stops A receiving; shared collector continues routing B; one collector lock")

            reply(b_id, "/new")
            b.wait(lambda: b.count("agent_settled") == 3, "remote slash text is model input")
            b.wait(lambda: b.count("telegram") == 3, "slash prompt result")
            assert b.count("model_start") == 3
            assert b.events()[-1]["body"]["text"] == "SMOKE_RESULT_3"
            print("PASS: Telegram slash text is not dispatched as local Pi commands")
        finally:
            for window in windows:
                window.close()
            if collector is not None:
                collector.terminate()
                try:
                    collector.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    collector.kill()
                    collector.wait()
                if collector.stdout:
                    collector.stdout.close()
                if collector.stderr:
                    collector.stderr.close()
            socket.unlink(missing_ok=True)
            lock.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
