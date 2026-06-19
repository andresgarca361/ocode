# opencode-bundle

**OpenCode CLI + Universal Proxy Server** — a drop-in enhancement for [OpenCode](https://opencode.ai) that adds context-aware message truncation, automatic model fallback, hybrid flash↔heavy routing, and a web-based configuration UI.

## Why This Exists

Plain OpenCode connects directly to a single upstream provider (e.g., OpenAI, Anthropic, NVIDIA). This bundle adds a **local proxy layer** that sits between OpenCode and your models, solving four problems:

| Problem | Solution |
|---|---|
| **Context limits** — long conversations exceed the flash model's context window | Automatic truncation preserves system prompt, first message, recent messages, and keywords |
| **No fallback** — if a model errors or rate-limits, the request fails | Falls back to a secondary model on network errors, rate limits, or context overflows |
| **Manual model switching** — you must pick flash or heavy upfront | Hybrid mode auto-routes between flash and heavy based on session context |
| **Hardcoded context sizes** — OpenCode doesn't know each model's real context limit | Proxy fetches live context windows from the model catalog and exposes them to OpenCode |

## What's Included

```
opencode-bundle/
├── install.sh          # One-curl installer (macOS, Linux)
├── start.sh            # Starts/stops the proxy server
├── proxy.mjs           # The universal proxy server (Node.js)
├── proxy-config.json   # Default proxy config (flash, heavy, fallbacks, RPM)
├── opencode.jsonc      # OpenCode provider config with all proxy models
└── ocode               # CLI wrapper: manages proxy, keep-awake, GUI, TUI
```

### Components

**proxy.mjs** — The core. An HTTP server on `127.0.0.1:18080` that:
- Accepts OpenAI-compatible, Anthropic, and Google API requests
- Routes `proxy/flash`, `proxy/heavy`, `proxy/hybrid` to your configured upstream models
- Fetches model catalog from models.dev + NVIDIA API (cached locally)
- Enforces per-minute rate limits (RPM)
- Truncates oversized context to fit the selected model (preserving anchors, keywords, tool calls)
- Escalates to heavy model if even truncated flash can't fit
- Falls back to secondary models on network errors or rate limits
- Provides a web config UI at `http://127.0.0.1:18080`
- Exposes stats at `/api/stats` (truncation summary, fallback events, model contexts)

**ocode** — CLI wrapper that manages the full stack:
- `ocode all` — Start proxy + keep-awake + GUI
- `ocode all-tui` — Start proxy + keep-awake + TUI
- `ocode gui` — OpenCode GUI only
- `ocode tui` — OpenCode TUI only
- `ocode -p 'prompt'` — Headless (one-shot)

**opencode.jsonc** — Pre-configured provider with 5 virtual models:
- `proxy/flash` — Fast/cheap model (e.g., `opencode/big-pickle`, `deepseek-v4-flash`)
- `proxy/heavy` — Powerful/slow model (e.g., `deepseek-v4-pro`, `claude-sonnet-4`)
- `proxy/hybrid` — Auto-routes between flash and heavy based on conversation
- `proxy/flash-default` — Flash fallback if config is missing
- `proxy/heavy-default` — Heavy fallback if config is missing

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/andresgarca361/ocode/main/install.sh | bash
```

This installs:
- `~/.opencode/bin/opencode` — OpenCode binary
- `~/.opencode/proxy/proxy.mjs` — Proxy server
- `~/.opencode/proxy/proxy-config.json` — Proxy config
- `~/.opencode/proxy/start.sh` — Start script
- `~/.local/bin/ocode` — CLI wrapper
- `~/.config/opencode/opencode.jsonc` — Provider config
- `~/.local/share/opencode/auth.json` — API key placeholder

Adds `~/.local/bin` to your `PATH` in `.zshrc`/`.bashrc`.

## Setup After Install

### 1. Add API Keys

Edit `~/.local/share/opencode/auth.json`:

```json
{
  "nvidia": {
    "type": "api",
    "key": "nvapi-..."
  }
}
```

Or set environment variables:
```bash
export NVIDIA_API_KEY="nvapi-..."
export OPENAI_API_KEY="sk-..."
```

### 2. Start the Proxy

```bash
ocode all
```

This starts the proxy on port 18080, plus OpenCode's GUI.

### 3. Configure Models

Open `http://127.0.0.1:18080` in your browser.

Select your **Flash** (fast/cheap) and **Heavy** (powerful) models from the dropdown. Each model shows its real-time context window size fetched from the catalog. You can also configure fallback models and RPM.

### 4. Select Provider in OpenCode

In the OpenCode GUI, select **Universal Proxy** as your provider, then pick:
- `proxy/hybrid` for auto-routing (recommended — uses flash for simple queries, heavy for complex ones)
- `proxy/flash` to always use the flash model
- `proxy/heavy` to always use the heavy model

## Architecture

```
                    ┌──────────────────────┐
                    │    OpenCode GUI/TUI   │
                    │  (opencode binary)    │
                    └──────────┬───────────┘
                               │
                    POST /v1/chat/completions
                    model: "proxy/hybrid"
                               │
                    ┌──────────▼───────────┐
                    │   proxy.mjs (:18080)  │
                    │                       │
                    │  resolveProxyModel()  │
                    │  applyTruncation()    │
                    │  proxyRequest()       │
                    │  buildModelCatalog()  │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │   Upstream API        │
                    │  (opencode.ai,        │
                    │   NVIDIA, OpenAI,     │
                    │   Anthropic, Google)  │
                    └──────────────────────┘
```

### Request Flow (Hybrid Mode)

1. OpenCode sends `model: "proxy/hybrid"` to the proxy
2. `resolveHybridModel()` checks the session:
   - If last assistant response had tool calls → use flash
   - If recent tool messages contain errors → use heavy
   - If user query contains reasoning keywords (debug, analyze, math, etc.) → use heavy
   - If context is large (>15k tokens) → use heavy
   - If user just says "ok"/"thanks"/"continue" → stay on current model
3. The selected model (flash or heavy) resolves to an actual upstream model ID
4. `applyTruncation()` checks if the messages fit within 75% of the model's context window
   - If yes → send as-is
   - If no → truncate (preserving system → first user → keywords → tool calls → recent 3 → rest)
   - If still too large after truncation → escalate to heavy (if flash) or try fallback
5. `proxyRequest()` sends the request to the upstream API
   - On network error → try fallback
   - On rate limit → try fallback
   - On success → return response

### Context-Aware Truncation

When the flash model's context is exceeded, truncation removes messages in this priority order:

1. **Anchors** (never removed): system prompt, first user message, last 3 messages
2. **Keywords** (preserved if possible): messages containing `todo`, `bug`, `error`, `fix`, `decision`, `warning`, `issue`, `summary`, etc.
3. **Tool calls/outputs** (preserved if budget allows)
4. **Middle messages**: 5 oldest non-anchor + 10 newest non-anchor first, then rest
5. **Fill remaining budget** greedily

If even the truncated request doesn't fit the flash model, it escalates to the heavy model instead.

### Fallback Chain

```
Flash Primary (e.g., opencode/big-pickle)
  └── on error/rate-limit/oversized → Flash Fallback (e.g., deepseek-v4-flash)

Heavy Primary (e.g., deepseek-v4-pro)
  └── on error/rate-limit/oversized → Heavy Fallback (e.g., glm-5.1)
```

### Provider Compatibility

All requests are converted to the upstream API's expected format:

| Provider | Format | URL |
|---|---|---|
| OpenAI-compatible | OpenAI chat | `{apiBase}/chat/completions` |
| Anthropic | Anthropic messages | `{apiBase}/messages` |
| Google | Google generateContent | `{apiBase}/models/{model}:generateContent` |
| OpenCode Zen | OpenAI-compatible | `https://opencode.ai/zen/v1/chat/completions` |

## Web Config UI

Visit `http://127.0.0.1:18080` to:

- Select flash & heavy models (shows each model's context window)
- Configure fallback flash & heavy models
- Set RPM limit (1-600)
- Toggle auto-routing
- See context ratio warning (if heavy is >50x flash)
- View stats: truncation summary, fallback events

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Config web UI |
| `/config` | GET | Get current config with context sizes |
| `/config` | POST | Update config |
| `/v1/models` | GET | List all available models with context windows |
| `/v1/providers` | GET | List all providers with key status |
| `/v1/chat/completions` | POST | OpenAI-compatible proxy |
| `/v1/messages` | POST | Anthropic-compatible proxy |
| `/v1/refresh` | POST | Refresh model catalog from upstream |
| `/api/stats` | GET | Truncation & fallback stats |
| `/health` | GET | Health check |

## Stats & Monitoring

```bash
curl http://127.0.0.1:18080/api/stats
```

Returns:
- Current RPM
- Last truncation summary (model, kept/dropped count, token estimates, keywords)
- Last fallback event (from → to, reason, timestamp)
- All model configs with context sizes

## Environment Variables

| Variable | Purpose |
|---|---|
| `NVIDIA_API_KEY` | API key for NVIDIA NIM models |
| `OPENAI_API_KEY` | API key for OpenAI models |
| `ANTHROPIC_API_KEY` | API key for Anthropic models |
| `GOOGLE_API_KEY` | API key for Google Gemini models |
| `NODE_EXTRA_CA_CERTS` | Custom CA certificate path (SSL) |
| `PROXY_PORT` | Proxy port (default: 18080) |
| `NODE_ENV=production` | Enable strict SSL verification |

## Differences from Plain OpenCode

| Feature | Plain OpenCode | opencode-bundle |
|---|---|---|
| Provider connection | Direct to upstream | Via local proxy on `:18080` |
| Model selection | Fixed per-provider | Dynamic flash/heavy/hybrid switching |
| Context management | None (fails if too large) | Automatic truncation + escalation |
| Error handling | Request fails | Falls back to secondary model |
| Real-time context display | Not available | Shows in config UI dropdowns |
| RPM throttling | None at proxy level | Configurable RPM limiter |
| Multi-provider routing | Manual config | Auto-routes by session |
| Install | Binary download only | Single `curl \| bash` with all components |

## Updating

```bash
# Re-run the installer to get the latest proxy + config files
curl -fsSL https://raw.githubusercontent.com/YOUR_USERNAME/opencode-bundle/main/install.sh | bash
```

Or update individual components from the repo.

## License

MIT
