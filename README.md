# OpenRouter Cost Monitor

Real-time [OpenRouter](https://openrouter.ai) API usage and cost monitor for VS Code.

- **Status bar** — live spend / tokens / request count with a configurable mode
- **Activity bar (OpenRouter)** — *Usage* tree (session + today totals, per-model breakdown) and *Recent Requests* (last 200, newest first)
- **Dashboard webview** — today vs session spend, per-model table, recent requests, auto-refresh

## How it works

Reads the **real cost** OpenRouter bills, not estimates, through **two capture paths**:

### Path 1 — Local proxy + chat provider (real-time per-prompt cost)

When the extension activates with a valid key, it starts a **local reverse proxy**
(`127.0.0.1:random-port`) and registers an OpenRouter **chat provider** via the
proposed `lm.registerLanguageModelChatProvider` API. The provider exposes the same
models you configured (e.g. `deepseek/deepseek-v4-flash-0731`) as chat models that
route **through the proxy**, so every prompt's `usage.cost` is captured in real time
and shown in the status bar / dashboard.

- Non-streaming and streaming (SSE) completions both capture usage from the final
  `usage` block (tokens + cost + reasoning tokens).
- The proxy listens only on `127.0.0.1` and forwards to `openrouter.ai/api/v1`.

### Path 2 — Generation stats (audit, via ID)

`GET /api/v1/generation?id=...` returns usage metadata for a completed request.
The extension polls this for recently-seen generation IDs to backfill / reconcile.

> **Note:** OpenRouter has **no public "list all generations" endpoint** for a
> regular API key. The analytics + credits endpoints require a **management key**.
> The proxy + provider approach above is the only way to capture per-prompt cost
> in real time without one.

### Key facts

- Every `/chat/completions` response includes `usage.prompt_tokens`,
  `usage.completion_tokens`, `usage.total_tokens`, and `usage.cost` (USD, already
  reflecting provider pricing and caching discounts).
- The extension merges captured generations into a persistent local summary
  (stored in `workspaceState`), deduped by generation ID.
- `POST /api/v1/credits` and management-key analytics are available for a
  future credit-balance / history view.

## Setup

1. **Install deps**: `npm install`
2. **Compile**: `npm run compile` (esbuild bundle → `dist/extension.js`)
3. **Debug**: press `F5` (launch config *Run Extension* starts the watch build first)

### API key

The key is stored in **VS Code secret storage** (OS keychain), not in settings:

- Run **OpenRouter: Set API Key** from the Command Palette
- Or set `orCost.apiKey` in settings (`scope: machine`) as a plaintext fallback (not recommended)
- **OpenRouter: Clear API Key** removes it

#### Reuse the key you already configured in VS Code

If you've already set up an **OpenRouter provider** in VS Code's chat language
models (`chatLanguageModels.json`, e.g. `"apiKey": "${input:chat.lm.secret.XXXX}"`),
the extension **reads that same key automatically** — no re-entry needed. It:

1. Parses `chatLanguageModels.json` for the OpenRouter provider's `${input:...}` template
2. Reads the matching `secret://chat.lm.secret.XXXX` entry from `state.vscdb`
3. Decrypts it using the macOS Keychain master key (`Code - Insiders Safe Storage` /
   `Code - Insiders Key`) with Chromium's `os_crypt` scheme
   (PBKDF2-HMAC-SHA1 → AES-128-CBC, `v10` prefix)

This is the same key that powers your chat conversations, so the monitor tracks
exactly what you're spending in chat.

## Commands

| Command | Action |
|---|---|
| `OpenRouter: Show Dashboard` | Open the webview dashboard |
| `OpenRouter: Refresh Now` | Force a poll |
| `OpenRouter: Set API Key` | Save key to secret storage |
| `OpenRouter: Clear API Key` | Remove key |
| `OpenRouter: Reset Session Tracking` | Zero the session summary |
| `OpenRouter: Toggle Auto-Refresh` | Pause/resume polling |

## Settings

| Setting | Default | Description |
|---|---|---|
| `orCost.apiKey` | `""` | (Fallback) plaintext key; prefer secret storage |
| `orCost.pollIntervalSeconds` | `30` | Poll interval; min 5 |
| `orCost.syncAllTime` | `false` | On first run, paginate full history to bootstrap daily totals |
| `orCost.statusBarMode` | `"cost"` | `cost` \| `tokens` \| `requests` \| `session` |

## Caveats

- **Proposed API**: the chat provider uses `lm.registerLanguageModelChatProvider`,
  which is **proposed** — it requires VS Code **Insiders** and the
  `"capabilities": { "proposedApi": [...] }` flag in `package.json`. On stable
  VS Code, the provider won't register (the proxy still runs for direct API
  tracking).
- **Select the provider**: after activation, pick the **"OpenRouter (Cost Monitor)"**
  model in the chat model picker (not the built-in "OpenRouter" one) so requests
  route through the proxy.
- OpenRouter's `usage.cost` is per-request and appears on the **completion**
  response; streamed requests finalize cost on the last chunk.
- Free-tier models (`:free`, `:extended`) bill `$0`; they still count as requests.
- Token totals are the raw `total_tokens`; reasoning tokens are tracked separately.
- The proxy binds only to `127.0.0.1` and never exposes the key to other processes.

## Privacy

The API key never leaves your machine; all reads go straight to `openrouter.ai`. The extension stores summaries locally in `workspaceState` only.