# pi-footer-tools

[English](README.md) | [Chinese](README.zh.md)

`pi-footer-tools` is a collection of small tools for Pi's existing footer: it adds status items without replacing the footer or interfering with other extensions.

- **Output speed**: always enabled; displays the average output speed of each model request.
- **Account switching**: optional; switches Codex authentication in the current window and displays the account name.
- **Context cost comparison**: optional; displays estimated API-equivalent costs for cache reads and cold starts.
- **Cache diagnostics**: optional; provides status commands and records restricted metadata.
- **[Telegram notifications/replies](telegram-notify/README.md)**: optional; displays the window's toggle state and supports completion notifications and authorized replies.

Each optional feature has its own configuration switch. All are disabled by default in the repository. Telegram was merged from `pi-telegram-notify` into this repository; only `telegram-notify/` is maintained going forward.

## Output speed

The default measurement is `overall`; you can also select the original `stream` measurement:

```text
Avg overall 43.7 tok/s
Avg stream 61.2 tok/s
```

- **overall (default)**: API `usage.output` for a single assistant message in the current main session, divided by the time from its first `before_provider_request` hook to its `message_end`. The hook is an approximate timestamp before request payload submission, **not the exact socket-send time**. It excludes context preparation before the hook, but includes the wait for first output after the hook, pauses/retries, and end-of-message latency. Repeated hooks for the same message retain the first timestamp. Without a hook, it displays `Avg overall -- tok/s`, with no fallback to `turn_start`. Even without deltas, a final message with valid usage and a positive duration can produce a measurement.
- **stream (original measurement)**: the same message's `usage.output`, divided by the time from the first nonempty text, thinking, or tool-argument delta to `message_end`. It does not depend on the pre-request hook and excludes the wait before first output (including retry waits), but includes pauses, internal retries, and end-event transport latency after first output. Without a nonempty delta, it displays `Avg stream -- tok/s`. It can work without a pre-request hook.
- **Shared boundaries**: both use only the output usage of a single assistant message in the main session, including thinking and generated tool arguments, but excluding sub-agent tokens and tool execution time. Neither counts stream chunks nor guesses from character counts. Both are client-observed averages, **not plain-text-only speed or pure server-side GPU decoding speed**.
- **English average and measurement label only**: no “speed test” label, first-token latency, total output tokens, thinking breakdown, or stop reason.
- The previous result remains visible during waiting, thinking, output, and tool execution. At the end of each final model message, both measurements are saved together and directly replace the previous results, with no intermediate status. No speed item is shown before the first result. A request that ends without a final model message produces no new measurement and does not replace the previous results.
- If the final message fails, is interrupted, lacks valid output usage, or has a nonpositive duration for a measurement, that measurement displays `--` (for example, `Avg overall -- tok/s`). A missing hook affects only overall; missing deltas affect only stream.
- **stream limitations**: it uses all output tokens, but cannot determine how many tokens were in the first stream chunk or observe thinking that the provider does not expose in the stream. In particular, short replies, batched arrivals, or hidden thinking can inflate the stream average; it cannot establish pure decoding performance. Overall includes waiting after the pre-request hook and likewise cannot isolate pure decoding performance.
- Historical speed results are not restored. Switching sessions, history trees, or models clears both results so old results are not mistaken for a new measurement. The measurement selection lives only in the extension runtime, not on disk or in the session. Rebuilding the extension runtime with `/reload` or a restart restores `overall`.

Use these commands in the TUI (arguments support completion):

```text
/token-speed overall    # Select overall
/token-speed stream     # Select stream
/token-speed status     # Show the current measurement
/token-speed            # Toggle overall / stream
```

Switching measurements immediately redraws the corresponding saved result without sending a request. You can also switch during a request without changing its timing. Commands do not operate on the UI in RPC/print modes.

Speed is displayed only in the TUI. Speed measurement itself makes no network or extra model requests, uses no timers or tokenizer, and writes neither disk nor session data. With diagnostics disabled, it writes no logs and subscribes to no additional raw stream events. Each speed-related stream update performs only constant-time checks; stream events do not refresh the speed display during a request. The footer is updated on request completion, measurement changes, session/model/tree resets, and exit. Optional Telegram functionality has separate switches: enabling window notifications accesses Telegram; separately allowing inbound messages lets remote replies start the model and its tools, outside speed measurement's zero-request guarantee.

## Installation

Clone the repository anywhere, then create a symbolic link in Pi's extensions directory:

```text
~/.pi/agent/extensions/pi-footer-tools -> <repository-path>/pi-footer-tools
```

Run `/reload` in Pi to load the new code. Speed appears on the next model reply during normal use; no dedicated test request is needed. To uninstall, remove the symbolic link and run `/reload`.

## Migrating from the old name

This project was renamed from `pi-token-speed` to `pi-footer-tools`, including its configuration names. **Old configuration filenames and environment variables are not read**:

- Move your existing `~/.pi/token-speed.json` to `~/.pi/footer-tools.json`, preserving all contents and `0600` permissions. Do not overwrite personal configuration with repository defaults. If both files exist, manually decide which one to use before making any replacement.
- If you use `PI_TOKEN_SPEED_CONFIG`, change it to `PI_FOOTER_TOOLS_CONFIG`, keeping it pointed at your existing custom file or updating the path accordingly. Remove the old variable from the parent shell. Custom files do not require a fixed filename.
- Rename the local repository directory and discovery symbolic link to `pi-footer-tools`; update old paths in settings, startup scripts, and explicit `-e` arguments. Keep only one loading entry point.
- The GitHub URL is `https://github.com/chthub/pi-footer-tools`; update the remote of an existing clone accordingly.
- After migration, **restart Pi and resume the original session** to clear the old runtime identity. This rename does not inherit the in-memory account selection, speed results, or Telegram ON state. Reselect the account and re-enable Telegram as needed.

Configuration fields (`accountSwitch`, `contextCost`, `cacheDiagnostics`, `telegramNotify`) are unchanged. OAuth and Telegram credentials, the diagnostics log directory, and feature-specific environment variables do not move.

## Configuration and privacy

The repository's `config.json` contains only generic defaults: speed is always enabled, and all other features are disabled by default. It contains no real account list, authentication paths, or personal billing policies.

Configuration precedence (whole-file replacement, not merging):

1. The JSON file specified by `PI_FOOTER_TOOLS_CONFIG`;
2. `~/.pi/footer-tools.json`, suitable for sharing across multiple Pi launch configurations;
3. The repository's `config.json`.

Keep personal account names, directories, and preferences in one of the personal configuration files above, **outside the repository**. The file does not need to contain tokens; each account's OAuth credentials remain in its own `auth.json`. Permissions of `0600` are recommended. Invalid or unreadable configuration fails closed; it does not skip a private file and fall back to another configuration. Run `/reload` after changes. A missing selected configuration file also does not trigger fallback.

## Optional Telegram notifications/replies (fully disabled by default)

No second extension is needed. Add or modify this section only in the **complete configuration file** selected by the precedence above. If you already have personal configuration, preserve account, diagnostics, cost, and other fields; do not replace the whole file with this example:

```json
{
  "telegramNotify": {
    "enabled": true
  }
}
```

- `enabled` must be a JSON boolean; the default is `false`, and a missing section or invalid configuration also disables the feature. **There is no `enabledByDefault` option.** Explicit `false` or missing configuration registers no `/notify`, Alt+N, Telegram feature events, or TG status; reads no Telegram credentials; sends no requests; and starts no receiver process. Invalid or unreadable configuration also remains disabled, but registers one `session_start` handler solely to warn once in the TUI.
- `true` only loads the capability; **each window still starts OFF**. After `/reload`, enable it with **Alt+N** or `/notify on`, disable it with `/notify off`, or inspect it with `/notify status`. `/notify` without arguments toggles it. The runtime toggle is not written back to configuration; reload/new/resumed/forked sessions start OFF again.
- Credentials stay in their existing location: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, or `<agent-dir>/telegram-notify.json`, with environment variables taking precedence per field. They do not move into the tools configuration. Sending only is the default; `receiveMessages: true` is required to allow inbound messages, and groups additionally require an `allowedUserIds` allowlist.
- **Privacy and permissions**: when enabled, final assistant reply text leaves the local machine for Telegram. Receiving messages is a remote-operation capability that can trigger the current model and tools, not just notifications. Linux `flock` receiver coordination covers only the same user on the same host; it cannot safely share one bot across hosts/nodes.
- **Migration must be manual**: first enable the feature in the existing external tools configuration while preserving other fields; then remove the old `pi-telegram-notify` discovery symbolic link, or disable the old package's extension in Pi settings, and run `/reload`. **Never load both implementations together** (also check explicit `-e` and other entry points). Repository updates do not automatically change personal configuration, credentials, or installed links. The old repository remains a standalone archived rollback version, not a wrapper dependent on an adjacent repository.

See the [Telegram documentation](telegram-notify/README.md) for full security boundaries, credential configuration, receiving messages, and migration steps. The merge was verified with **Pi 1.1.0**: the Telegram Node suite and real Pi PTY integration tests used synthetic models and intercepted Telegram requests, not real-bot end-to-end verification.

## Optional account switching (independent switch)

Switch ChatGPT/Codex authentication in the **current window and conversation**, without exiting or resuming. Accounts are explicitly supplied in personal configuration; the code presets no account names and scans neither shell aliases nor local authentication directories. This example uses only fictional configuration:

```json
{
  "accountSwitch": {
    "enabled": true,
    "accounts": [
      { "name": "default", "agentDir": "~/.pi/agent" },
      { "name": "work", "agentDir": "~/.pi/example-work" }
    ]
  }
}
```

Each `accounts` entry contains a chosen `name` and that account's Pi `agentDir`; its authentication file is `<agentDir>/auth.json`. Directories support absolute paths or `~/`, not relative paths. Names may contain letters, digits, underscores, dots, and hyphens, up to 64 characters. Names must be unique; `status` is reserved. At most 64 accounts can be configured. The list must be nonempty when enabled.

After `/reload`:

```text
/switch-account          # Open the account picker; Esc cancels
/switch-account work     # Switch by configured name; supports completion
/switch-account status   # Show the current ChatGPT/Codex account
```

The footer adds only a gray name (such as `work`), without an Account prefix. It does not replace the footer or affect speed or cost displays.

- Set `"enabled": false` and run `/reload` to disable the command and account display and restore the startup account's authentication, without affecting other features. A missing section defaults to disabled; invalid configuration warns and disables it.
- **Only `openai-codex` authentication is switched**. The conversation, model, thinking level, session file location, agent directory, AGENTS, plugins, other providers, and environment variables stay unchanged. Sessions remain in the startup configuration's session directory. Non-Codex models show `(Codex only)`; their account is unaffected.
- Names are configuration labels, not email addresses, access tokens, refresh tokens, or real account IDs. If the current agent directory matches no configured account, its directory name is shown.
- Switching is refused during generation, tool execution, retries, or when messages are queued. If an account reaches a limit, press Esc to stop the current run first. Switching does not automatically resend a failed message; the next message uses the new account.
- The target must already have complete ChatGPT/Codex OAuth login information. Missing, damaged, or API-key authentication cannot be selected, and no files are created for accounts that are not logged in. If needed, run `/login` using the target launch configuration first. Cancellation or switching failure leaves the original selection unchanged.
- A successful switch resets the comparison baseline of enabled cache diagnostics to avoid false cold-cache warnings across accounts. Account IDs and tokens are not recorded.
- **Authentication is not copied between accounts or overwritten across accounts**. OAuth auto-refresh still uses Pi's built-in cross-process file locking, and refreshed credentials are written back to the selected account's own file. After switching, `/login` and `/logout` for Codex also act on that account (other providers still use the startup directory). The command makes no model requests and does not check remote quota. Expired tokens are refreshed normally by Pi on the next request; an invalid refresh token still requires logging in again.
- Selection survives an ordinary `/reload`, but is not written to the session or disk. Exiting/restarting, `/new`, `/resume`, or `/fork` rebuilds the session runtime and restores the startup account. Disabling or removing the extension and running `/reload` also restores it. There are no timers or per-token authentication operations.
- **Compatibility boundary**: authentication/request flows were tested with Pi **1.1.0**. Pi currently has no public interface for replacing credential storage at runtime, so a structure-checked internal adapter is used only in `account-switch/routing.ts`; all other authentication, streaming requests, and OAuth refresh use Pi's built-in logic. Enabling/switching is refused if internal structures are incompatible or a Codex runtime API-key override exists. Rerun `npm test` after upgrading Pi. This feature is enabled only in the interactive TUI; print/JSON/RPC modes do not change authentication.

## Optional cache diagnostics (configurable default)

Diagnostics are integrated into the same extension; their switch does not affect speed, and no second extension is needed. The repository's `config.json` **disables diagnostics by default**; a missing configuration file is treated as disabled.

Enable them in a personal configuration file outside the repository:

```json
{
  "cacheDiagnostics": {
    "enabledByDefault": true
  }
}
```

- `false`: off by default; `true`: on by default. Use a JSON boolean, not a quoted string.
- Run `/reload` or restart Pi after changes. No changes to Pi's `settings.json` are needed.
- Use the precedence in [Configuration and privacy](#configuration-and-privacy). Multiple instances can share personal configuration; a running instance does not automatically hot-reload it.

You can still temporarily toggle diagnostics or inspect status in the current instance:

```text
/cache-diagnostics on
/cache-diagnostics status
/cache-diagnostics off
```

Without arguments, the command queries status rather than toggling. It changes only the current instance and does not rewrite `config.json`; after reload, the configured default is used. You can also explicitly enable diagnostics with `pi --cache-diagnostics`; the command-line flag takes precedence over configuration. A missing file defaults to disabled; malformed or unreadable configuration warns and treats the configured default as disabled. `status` shows the current state, loaded configuration default, and configuration path.

The first version parses only OpenAI Responses formats, including `openai-codex-responses`. It saves brief metadata for each observed request. When cache reads drop to zero, decrease sharply, fields are missing, or conversion differs, it additionally saves a before/after request fingerprint comparison. The first call and observed compaction/branch/model-change boundaries reset the comparison baseline to avoid flagging normal cold starts as zero-read events.

- **Recording only**: no prompt injection, model-tool registration, request-parameter changes, extra keep-alive, retries, or model calls. Official diagnostic parameters are not automatically set either.
- **Content protection**: no conversations, output, tool-argument bodies, secrets, or authentication headers are saved. Saved data includes valid numeric usage, field presence, response IDs, allowlisted parameters, and HMAC fingerprints unique to each activation.
- **Bounded and isolated**: logs are written in the background and rotated. Write failures disable diagnostics without interrupting model requests. No disk writes or footer refreshes occur on each token.
- **Not packet capture**: fingerprints come from the pre-request hook, and raw usage comes from structured events before SDK conversion. They cannot prove final transmitted bytes, physical connection reuse, server-side cache root causes, or subscription quota deductions.

The default log root is `~/.pi/agent/cache-diagnostics/`; a custom Pi agent directory follows `getAgentDir()`. Each activation/session switch creates a separate `capture-*` directory, and `status` shows the exact location. Use `PI_CACHE_DIAGNOSTICS_DIR` to specify another directory.

**Enabling diagnostics in personal configuration continuously writes metadata logs (without conversation content) to that directory. Old directories are not automatically deleted. When no longer needed, set `enabledByDefault` to `false` and run `/reload`.** See the [cache diagnostics documentation](cache-diagnostics/README.md) for detailed fields, storage limits, and evidence boundaries.

## Optional context cost comparison (personal configuration switch)

Adds a `context-cost` status item using the same dim gray as Pi's built-in footer. It compares two background-input costs for the **currently selected model** (USD, Standard API-equivalent estimates, not an actual bill):

```text
Cache read $0.8000 | Cold start $0.6250
```

- **Cache read**: prices the entire estimated current context as cache reads when continuing in the current window. The first version uses Pi's `getContextUsage().tokens` as current context C and approximates H≈T≈C: the price tier is determined by the next request's total input T (crossing a threshold applies that tier to the whole request), while the billed quantity is history H. C may include the previous output, but excludes unsent editor text and new tool overhead; it is imprecise near tier boundaries.
- **Cold start**: prices loading fixed background in a new window (50,000 tokens by default, configurable with `startupTokens`) entirely as initial cache writes, without adding ordinary input charges. If that background exceeds a tier threshold, the corresponding tier also applies.
- Compares background input only: excludes new input, output/reasoning, tool fees, generating handoff summaries, and rework. It does not represent an actual bill, subscription quota deductions, or Fast/Batch/Flex pricing. It makes no recommendations such as “start a new window.”
- **Unknown is not shown as $0**: unknown context (for example, after compaction and before the next valid reply) displays `—`; the new-window price is still shown normally. Zero is a valid value.
- **Price source**: reads Pi's model data `model.cost` directly (ordinary input, cache reads, cache writes, and `tiers`). Tier rules match Pi's `calculateCost`: the highest threshold exceeded by total input applies to the entire request. Prices update with Pi upgrades; this extension stores no separate price table.
- **Supported scope**: calculates only for models whose provider is `openai` or `openai-codex`. Other providers often lack cache unit prices and display `API price not configured`.
- **Zeros in OpenAI data**: if cache-write price is zero (models before GPT-6, where cache writes have no additional charge), Cold start uses the ordinary input price. If cache-read or ordinary input prices are zero (for example, pro models with no cache discount), or prices are missing or malformed, it does not force a calculation and displays `API price not configured`.

By default, pricing and tiers strictly follow Pi's model data. If your own billing policy explicitly excludes long-context tiers, list exact `provider/modelId` values in personal configuration under `contextCost.untieredModels`. The code presets no subscription exceptions and does not infer actual remote bills from this setting.

Configuration (disabled in repository defaults; enable in personal configuration):

```json
{
  "contextCost": {
    "enabled": true,
    "startupMode": "cache-write",
    "startupTokens": 50000
  }
}
```

- `enabled`: JSON boolean. `false` or a missing `contextCost` section registers no events at all.
- `startupMode`: optional, default `"cache-write"`; `"uncached-input"` uses ordinary cold-input pricing instead (Astra $0.5000, 6.1 Sol $0.1000). The footer label remains `Cold start`.
- `startupTokens`: optional, default `50000`; must be a positive integer. The footer does not display this number.
- `untieredModels`: optional, default `[]`; a list of strings, each an exact `provider/modelId`. Tiers are ignored only for those models. Wildcards and automatic subscription-policy detection are not supported.
- Malformed configuration disables the feature and warns once in the TUI. Changes take effect after `/reload`.

Displayed only in TUI mode. Pi has no theme-change event, so after a theme change the gray color updates on the next refresh. It recalculates locally on session start/resume/fork/reload, model changes, each turn end, compaction, and tree navigation. There are no timers, network requests, or model requests. Switching to an unsupported model immediately replaces old amounts; on exit, it clears only its own status item.

## Tests

Dual-measurement speed update (installed Pi **1.2.0**): `npm run typecheck` passed, and the full `npm test` run passed **153/153**, with **0 failures and 0 skips**. This update added **10 speed tests**. A targeted speed-command PTY smoke test with real Pi **1.2.0** also passed, verifying default overall, explicit selection, toggling without arguments, status, restoration of overall after reload, and no extra model requests when switching. It reused the existing synthetic fixture with deliberately zero output usage, so `--` was expected; it does not verify real API generation speed or numeric timing. The **two existing full PTY suites were not rerun**.

Speed boundary coverage includes overall/stream timing, repeated/missing pre-request hooks, valid final usage without deltas, failure/interruption/invalid usage/nonpositive durations, measurement commands and completion, redraws on switching, switching during requests, lifecycle resets, and non-TUI behavior. The Pi 1.1.0 results below are **historical verification records**, separate from the current update.

Rename regression (Pi **1.1.0**): the full `npm test` run passed **142/142**, with no failures or skips. Production type checking, Telegram fixture type checking, two real Pi PTY test suites, and Ruff/basedpyright checks for the Python files changed in that update all passed. New tests covered the new package name, personal configuration filename, and environment-variable precedence. PTY tests used synthetic models and intercepted Telegram requests, not real-bot end-to-end verification.

After the footer ordering adjustment, a “speed → TG → LSP” ordering regression test was added. A fresh full `npm test` run passed **143/143**, and production type checking passed. That verification did not rerun the PTY suites.

`npm test` requires Pi installed on PATH (`npm install -g @earendil-works/pi-coding-agent`). It uses the installed Pi loader and jiti to load the actual extension, then verifies statistics with deterministic events and a monotonic clock. Context cost comparison also has pure-calculation tests (acceptance tables, tiers, configurable untiered policies, unknown values), configuration parsing, and lifecycle tests. Tests make no model calls or API requests. Account-switching tests use temporary synthetic credentials and the installed Pi's real ModelRuntime, covering authentication routing, preservation of request context/model, concurrent OAuth refresh and correct writeback, login/logout, failure rollback, reload/disabling, non-TUI behavior, and command interactions. They neither read nor modify real accounts. Diagnostics tests write synthetic logs only in temporary directories and clean them up; coverage includes missing raw fields/explicit zeros, conversion differences, before/after anomaly comparisons, concurrent correlation protection, disabled defaults, dynamic subscriptions, permissions/rotation, write failures, and speed regression with diagnostics enabled.

The merged `npm test` script also includes `test/telegram-notify/*.test.mjs`; do not run only the original top-level glob and miss the Telegram suite. You can also run the complete suite directly:

```bash
node --test test/*.test.mjs test/telegram-notify/*.test.mjs
```

With Pi **1.1.0**, the Telegram-specific Node tests passed **44/44**, and the existing regression tests passed **96/96**. Production type checking, TUI fixture type checking, two real Pi PTY integration suites, and Python Ruff/basedpyright checks all passed. These are separate completed verification records, not a claim that they came from one full merged-suite run. Telegram tests cover zero registration when disabled/configuration is missing, a single TUI warning handler for invalid configuration, no credential reads/network access when disabled, initial window OFF state, sending and cancellation, authorization, routing, and integration regressions.

Optional real Pi PTY and fixture checks (not included in `npm test`):

```bash
node test/telegram-notify/typecheck.mjs
python3 test/telegram-notify/tui-smoke.py
python3 test/telegram-notify/tui-inbound.py
ruff check test/telegram-notify/tui-smoke.py test/telegram-notify/tui-inbound.py
basedpyright --level error test/telegram-notify/tui-smoke.py test/telegram-notify/tui-inbound.py
```

PTY tests require Linux, `pi`, `node`, and `flock`. They load the integrated main entry point using isolated temporary configuration, synthetic models, and intercepted Telegram requests. They call no paid models and send no real Telegram messages. Their scope does not include real-bot end-to-end testing of the new integration. These automated tests do not modify personal credentials, symbolic links, or configuration; manual migration is outside their scope. See [Telegram verification](telegram-notify/README.md#验证) and the [test documentation](test/telegram-notify/README.md) for details.

`npm run typecheck` checks this extension's types, resolving Pi and Node types from `node_modules`. First run `npm install` to install development dependencies. Alternatively, link the globally installed Pi without downloading:

```bash
mkdir -p node_modules/@earendil-works
ln -s "$(npm root -g)/@earendil-works/pi-coding-agent" node_modules/@earendil-works/pi-coding-agent
```
