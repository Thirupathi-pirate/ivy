<div align="center">
  <img src="blog-source/assets/avatar.webp" width="120" height="120" style="border-radius:50%; border: 3px solid #BB86FC;" alt="Ivy Logo"/>
  <h1 align="center">🌿 Ivy</h1>
  <p align="center">
    <b>AI Blog Bot</b> — Telegram assistant + automated blog writer
    <br />
    <i>Research. Write. Publish. All on autopilot.</i>
  </p>

  <p>
    <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white" alt="TypeScript"/>
    <img src="https://img.shields.io/badge/Python-3776AB?style=flat&logo=python&logoColor=white" alt="Python"/>
    <img src="https://img.shields.io/badge/Cloudflare-F38020?style=flat&logo=cloudflare&logoColor=white" alt="Cloudflare"/>
    <img src="https://img.shields.io/badge/Gemini-8E75FF?style=flat&logo=googlegemini&logoColor=white" alt="Gemini"/>
    <img src="https://img.shields.io/badge/CrewAI-FF6B6B?style=flat&logo=crewai&logoColor=white" alt="CrewAI"/>
    <img src="https://img.shields.io/badge/Jekyll-CC0000?style=flat&logo=jekyll&logoColor=white" alt="Jekyll"/>
    <img src="https://img.shields.io/badge/D1-003B5C?style=flat&logo=cloudflare&logoColor=white" alt="D1"/>
  </p>
</div>

---

## ✨ What Ivy Does

Ivy is a Telegram bot that chats like a friend, remembers everything, and writes blog posts for you — on autopilot.

| | Capability | How It Works |
|---|-----------|-------------|
| 💬 | **AI Chat** | Web search, reminders, memory, image/voice/PDF analysis, movie discovery |
| 📝 | **Auto Blogging** | 3x daily — discovers trending topics, researches, writes, publishes |
| 🧠 | **Long-Term Memory** | Remembers facts across conversations (D1-backed) |
| ⏰ | **Reminders** | "Remind me at 2:30 PM to call mom" — cron-delivered |
| 🔍 | **Trending Topics** | News API + Tavily finds what's hot — no manual input needed |
| 🎬 | **Movies** | TMDB + Reddit + Tavily multi-source recommendations |
| 📸 | **Vision** | Describe photos, transcribe voice, read PDFs & documents |

---

## 🏗️ Architecture

```
                    ┌──────────────────────────────────────┐
  Telegram ──────── │  Cloudflare Worker (Hono + grammY)   │
                    │                                      │
                    │  ┌──────────────────────────────────┐ │
                    │  │        Gemini API                │ │
                    │  │  (3-model fallback chain)        │ │
                    │  └──────┬───────────────────────────┘ │
                    │         │                             │
                    │  ┌──────▼──────────┐  ┌────────────┐ │
                    │  │  D1 Database   │  │  GPT Chat  │ │
                    │  │ sessions       │  │  Loop      │ │
                    │  │ memories       │  │  (tools)   │ │
                    │  │ reminders      │  └────────────┘ │
                    │  └───────────────┘                  │
                    └──────────┬───────────────────────────┘
                               │
                    ┌──────────▼───────────────────────────┐
                    │  GitHub Actions Dispatch (/write)     │
                    │                                      │
                    │  ┌──────────┐ ┌───────────┐ ┌──────┐ │
                    │  │ Writer   │→│ Humaniser │→│Editor│ │
                    │  │(research)│ │(rewrite)  │ │(polish)│
                    │  └──────────┘ └───────────┘ └──────┘ │
                    │          CrewAI Pipeline              │
                    └──────────┬───────────────────────────┘
                               │
                    ┌──────────▼───────────────────────────┐
                    │  Jekyll Build → GitHub Pages         │
                    │  Telegram Notification                │
                    └──────────────────────────────────────┘
```

---

## 🚀 Quick Start

### Prerequisites
```
Node.js 20+  │  Python 3.10+  │  uv (pip install uv)  │  Wrangler CLI
```

### 1. Clone & Install
```bash
git clone https://github.com/Thirupathi-pirate/ivy.git && cd ivy
uv sync              # Python deps (CrewAI)
npm install          # TypeScript deps (Worker)
```

### 2. Environment Variables
Set these in `.env`:

| Variable | Why It's Needed |
|----------|----------------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot authentication |
| `GEMINI_API_KEY` | Powers the AI brain + CrewAI writer |
| `GROQ_API_KEY` | Voice transcription (Whisper) |
| `TAVILY_API_KEY` | Web search tool for research |
| `GITHUB_PAT` | Triggers blog publishing workflow |
| `GITHUB_REPO` | e.g. `Thirupathi-pirate/ivy` |
| `UNSPLASH_ACCESS_KEY` | Fetches blog cover images |
| `NEWS_API_KEY` | Trending topic discovery |

><sub>Optional: `TMDB_API_KEY`, `REDDIT_CLIENT_ID/SECRET/USER_AGENT` for enhanced movie tools.</sub>

### 3. Deploy the Worker
```bash
npm run deploy
```

Then visit:
- `https://your-worker.workers.dev/init` — creates D1 tables
- `https://your-worker.workers.dev/?command=set` — registers Telegram webhook

---

## 📱 Telegram Commands

| Command | What It Does |
|---------|--------------|
| `/start` | 👋 Welcome message |
| `/write <topic>` | ✍️ Generate & publish a blog post |
| `/models` | 🔄 Switch AI model (inline menu) |
| `/model <name>` | 🎯 Set model directly |
| `/new` | 🆕 Reset conversation |
| `/clear` | 🧹 Clear chat history |
| `/redo` | ↩️ Re-send last message |
| `/forget` | 🗑️ Wipe memories + reset |
| `/system` | 📊 Bot status |
| `/help` | ❓ All commands |

><sub>Send 📸 photos, 🎤 voice messages, 📄 PDFs for analysis. In groups, mention `@IvyBot`.</sub>

---

## 📅 Publishing Schedule

| Time (IST) | Type | Topic Source |
|------------|------|-------------|
| 🌅 **5:50 AM** | Tech | News API + Tavily (filtered by 200+ tech keywords) |
| ☀️ **10:00 AM** | General | News API top headlines + Tavily trending |
| 🌆 **5:30 PM** | General | News API top headlines + Tavily trending |

**Pipeline:** Find topic → CrewAI writes (≥2500 words) → Unsplash images → Jekyll post → Deploy → Telegram notification

Manual trigger: `/write <topic>` dispatches the same pipeline instantly.

---

## 🧰 Tech Stack

```
┌─ Bot Runtime ──── Cloudflare Workers (Hono + grammY)
├─ AI Chat ──────── Google Gemini (gemini-2.5-flash-lite → gemini-2.5-flash → gemini-3.1-flash-lite)
├─ Voice ────────── Groq Whisper (whisper-large-v3-turbo)
├─ Web Search ───── Tavily API
├─ Database ─────── Cloudflare D1 (SQLite) — sessions, memories, reminders
├─ Blog Writer ──── CrewAI — 3 agents: Writer (research) → Humaniser (rewrite) → Editor (polish)
├─ Blog Host ────── Jekyll + Chirpy 7.5 → GitHub Pages (Midnight Purple theme)
├─ Trending ─────── News API + Tavily
├─ Images ───────── Unsplash API
└─ CI/CD ────────── GitHub Actions (3x daily cron + manual dispatch)
```

---

## 📂 Project Structure

```
src/
├── index.ts                 🟦 Hono app, Telegram bot, admin routes
├── ai.ts                    🧠 Gemini API, tool loop, memory, movies
└── blog_writing_crew/       📝 CrewAI pipeline
    ├── crew.py              Agent & task definitions
    ├── main.py              Entrypoints (run / train / replay / test)
    ├── config/
    │   ├── agents.yaml      Agent roles & backstories
    │   └── tasks.yaml       Task instructions
    └── tools/
        └── custom_tool.py   🔧 Tavily, Wikipedia, Hacker News, ArXiv, OpenLibrary, RSS

scripts/
├── publish_post.py          🖼️ Unsplash cover + frontmatter → Jekyll post
└── find_trending_topic.py   🔍 Trending topic discovery (News API + Tavily)

blog-source/                 📖 Jekyll site (Chirpy theme, _posts/)
.github/workflows/           ⚙️ CI/CD pipelines
```

---

## 📜 License

MIT — use it, tweak it, ship it.
