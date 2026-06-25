# nanobot Setup — HidenCloud + Groq + Telegram Bridge

**Part of the Ivy blog system.** Provides a persistent AI chat bot on Telegram
using the [HKUDS/nanobot](https://github.com/HKUDS/nanobot) agent framework.

---

## Architecture

```
Telegram → webhook → Cloudflare Worker
  ├── /write <topic> → GitHub Actions → CrewAI → blog post
  └── other messages → POST → nanobot bridge (HidenCloud)
                                └── nanobot SDK: await bot.run(text)
                                └── reply via Telegram sendMessage API
```

The Cloudflare Worker keeps the Telegram webhook. nanobot does **not** use its
own Telegram channel — it runs as a Python SDK library behind a tiny FastAPI
bridge that receives forwarded updates from the Worker.

## Requirements

### Runtime (HidenCloud Pterodactyl)

| Requirement | Value |
|-------------|-------|
| Egg | Python 3.11+ |
| RAM | 1 GB (3 GB recommended) |
| Disk | 2 GB |
| Port | 8080 (internal, assigned by Pterodactyl) |

### Environment Variables (set in Pterodactyl Startup tab)

| Variable | Value | Where to get it |
|----------|-------|-----------------|
| `TELEGRAM_BOT_TOKEN` | `8686403077:AAEHXhKdhpXg01Qip7TOxy2z6jqPqCz_dmg` | Already configured |
| `GROQ_API_KEY` | `gsk_...` | [Groq Console](https://console.groq.com) |
| `ALLOWED_CHAT_ID` | `5491880232` | Your Telegram user ID |

### Dependencies (installed automatically)

```
nanobot-ai              → Agent framework (pip install nanobot-ai)
fastapi                 → Bridge HTTP server
uvicorn[standard]       → ASGI server
httpx                   → Telegram API calls
groq                    → Not needed directly (nanobot uses OpenAI-compat API)
```

## Files on HidenCloud

These files are uploaded via Pterodactyl file manager:

```
/home/container/
├── bridge.py            ← FastAPI server (receives Worker forwards)
├── nanobot-config.json  ← nanobot configuration (Groq provider)
├── requirements.txt     ← Python dependencies
└── start.sh             ← Startup script (Pterodactyl entrypoint)
```

## File Contents

### bridge.py

A ~50-line FastAPI server that:
1. Receives Telegram update objects from Cloudflare Worker
2. Extracts message text + chat ID
3. Calls `await bot.run(text, session_key=chat_id)` via nanobot SDK
4. Sends the reply back via Telegram `sendMessage` API
5. Maintains per-user conversation history via nanobot's session system

```python
# Key flow:
from nanobot import Nanobot
bot = Nanobot.from_config(config_path="nanobot-config.json")

@app.post("/")
async def handle(update: dict):
    text = update["message"]["text"]
    chat_id = update["message"]["chat"]["id"]
    result = await bot.run(text, session_key=f"tg:{chat_id}")
    await httpx.post(f"https://api.telegram.org/bot{TOKEN}/sendMessage",
        json={"chat_id": chat_id, "text": result.content, "parse_mode": "Markdown"})
```

### nanobot-config.json

Configured with Groq as OpenAI-compatible provider + Llama 3.3 70B.
**After upload, replace `YOUR_GROQ_API_KEY` with your actual Groq API key.**

```json
{
  "providers": {
    "groq": {
      "apiKey": "YOUR_GROQ_API_KEY",
      "apiBase": "https://api.groq.com/openai/v1"
    }
  },
  "modelPresets": {
    "primary": {
      "label": "Primary",
      "provider": "groq",
      "model": "llama-3.3-70b-versatile",
      "maxTokens": 8192,
      "contextWindowTokens": 131072,
      "temperature": 0.7
    }
  },
  "agents": {
    "defaults": {
      "modelPreset": "primary"
    }
  },
  "workspace": "/home/container/workspace",
  "memory": true
}
```

The workspace directory `/home/container/workspace` is created automatically by `start.sh`.

### start.sh

```bash
#!/bin/bash
cd /home/container
mkdir -p /home/container/workspace
pip install -r requirements.txt --quiet
exec uvicorn bridge:app --host 0.0.0.0 --port ${SERVER_PORT:-8080}
```

## HidenCloud Setup Steps

### 1. Create Account

1. Go to [hidencloud.com](https://hidencloud.com)
2. Sign up (no credit card required)
3. Verify email

### 2. Create Server

1. Dashboard → **Create Server**
2. Select **Python** egg (Python 3.11+)
3. Plan: Free tier (Mexico, 3GB RAM)
4. Server name: `ivy-nanobot`
5. Wait for deployment (~30 seconds)

### 3. Get IP and Port

1. Server console → **Settings** tab
2. Note the **IP Address** and **Port** (e.g., `203.0.113.42:25567`)
3. This becomes your `NANOBOT_URL`: `http://203.0.113.42:25567/`

### 4. Upload Files

1. Server panel → **File Manager**
2. Create these files (or upload from repo):
   - `bridge.py`
   - `nanobot-config.json`
   - `requirements.txt`
   - `start.sh`

### 5. Set Environment Variables

1. Server panel → **Startup** tab
2. Add variables:
   - `TELEGRAM_BOT_TOKEN` = `8686403077:AAEHXhKdhpXg01Qip7TOxy2z6jqPqCz_dmg`
   - `GROQ_API_KEY` = `gsk_...`
   - `ALLOWED_CHAT_ID` = `5491880232`

### 6. Install nanobot

Via Pterodactyl console:
```bash
pip install nanobot-ai
```

Or add to `requirements.txt`:
```
nanobot-ai>=0.2.0
fastapi>=0.115.0
uvicorn[standard]>=0.32.0
httpx>=0.28.0
```

### 7. Start

1. Set startup command in Pterodactyl to: `bash start.sh`
2. Click **Start**
3. Check console logs for `nanobot started`

## Cloudflare Worker Update

The Worker already has nanobot routing. Set the secret:

```bash
# Via wrangler or Cloudflare Dashboard → Workers → ivy-blog-bot → Settings → Variables
NANOBOT_URL = http://<hidencloud-ip>:<port>/
```

Existing Worker secrets (already set):
- `GITHUB_PAT`
- `GITHUB_REPO`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

**New secret to add:**
- `NANOBOT_URL` — `http://<hidencloud-ip>:<port>/`

## Changes Made to Worker Logic

The Worker (`cloudflare-worker.js`) now has two routes:

```
if (text.startsWith("/write")):
  → Extract topic, trigger GitHub Actions dispatch (unchanged)
else:
  → Forward raw Telegram update to NANOBOT_URL via POST (fire-and-forget with ctx.waitUntil)
```

No changes to the `/write` path. Only the fallback (non-`/write`) behavior changed
from a static message to an HTTP forward. The forward uses `ctx.waitUntil()` so
the Worker responds immediately without waiting for the nanobot bridge reply.

## Auto-Renew (HidenCloud Free Tier)

HidenCloud free servers expire weekly. Use the fork + configure method:

1. Fork [kanezikii/hidencloud-renew](https://github.com/kanezikii/hidencloud-renew)
2. Add GitHub Secrets:
   - `HIDENCLOUD_EMAIL` — your HidenCloud login email
   - `HIDENCLOUD_PASSWORD` — your HidenCloud password
3. Enable the GitHub Actions workflow
4. It runs on a cron schedule and auto-renews your server

## Testing

### End-to-End Test

1. Send any non-`/write` message to the Telegram bot
2. Nanobot should reply via Groq (Llama 3.3 70B)
3. Check HidenCloud logs for: `POST /` → `groq response` flow

### Smoke Test

```bash
# From any machine:
curl -X POST <NANOBOT_URL>/health
# Expected: {"status": "ok"}
```

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Worker returns 500 | `NANOBOT_URL` secret not set | Add secret in Cloudflare Dashboard |
| nanobot won't start | Groq API key missing | Check `GROQ_API_KEY` env var |
| nanobot replies "I hit an error" | Groq API error / quota | Check HidenCloud logs, verify Groq key |
| nanobot not responding | Server offline / auto-renew needed | Restart server or renew HidenCloud |
| `/write` still works but chat doesn't | Worker can't reach HidenCloud | Verify `NANOBOT_URL` is correct and server is running |
