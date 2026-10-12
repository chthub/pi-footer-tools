# Telegram migration/regression tests

Run from the repository root:

```sh
node --test test/telegram-notify/*.test.mjs
node test/telegram-notify/typecheck.mjs
ruff check test/telegram-notify/tui-smoke.py test/telegram-notify/tui-inbound.py
basedpyright --level error test/telegram-notify/tui-smoke.py test/telegram-notify/tui-inbound.py
python3 test/telegram-notify/tui-smoke.py
python3 test/telegram-notify/tui-inbound.py
```

- `extension.test.mjs` and `receiver.test.mjs` port the frozen standalone regression suites to the new module paths. Registration uses a temporary enabled feature config, never personal config.
- `config.test.mjs` checks strict booleans, fail-closed states, byte limits, and path precedence.
- `integration.test.mjs` loads the main entry, composes handlers like Pi, and checks default-off registration, shortcut conflicts, speed coexistence, credential-access privacy, nonTUI behavior, reload cancellation, and inbound slash-text routing.
- PTYs load `../../index.ts`, not the standalone extension; each process gets isolated feature/credential config and a synthetic provider. Tests cover default-off, continuation/retry/queued-work settlement, real `/reload`, and shared inbound routing.
- Host APIs/types are resolved from installed Pi via jiti aliases (verified on 1.1.0, not version-pinned). Python PTYs require Linux, `pi`, `node`, and `flock`.

No paid models or real Telegram calls: all outbound Telegram fetches and collector polling are intercepted. The timeout regression uses only a loopback HTTP server. Real collector launches are blocked in integrated reception and PTY fixtures. Temporary Unix sockets are cleaned without removing the shared IPC directory.
