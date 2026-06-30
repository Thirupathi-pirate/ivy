# Ivy Discord Relay — Fly.io Setup

## Prerequisites
- Fly.io account: `flyctl auth signup` or `flyctl auth login`
- Discord Bot Token (already have it)

## Deploy

```bash
# 1. Login to fly
flyctl auth login

# 2. Launch the app from relay/ directory
cd relay/
flyctl launch --no-deploy

# 3. Set secrets
flyctl secrets set DISCORD_BOT_TOKEN=<your-discord-bot-token>
flyctl secrets set WORKER_URL=https://ivy-blog-bot.priyamolmpraveen2.workers.dev
flyctl secrets set RELAY_SECRET=<relay-secret-from-worker>

# 4. Deploy
flyctl deploy

# 5. Check logs
flyctl logs
```

## Test

Once deployed, ping your bot in any server (it needs to be in the server) with:
  @Ivy hello

Or send a DM to the bot.

## Update

If you change relay code later:
```bash
cd relay/
flyctl deploy
```
