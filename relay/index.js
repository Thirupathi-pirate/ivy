import http from "http";
import WebSocket from "ws";

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const WORKER_URL = process.env.WORKER_URL;
const RELAY_SECRET = process.env.RELAY_SECRET;
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

if (!DISCORD_BOT_TOKEN || !WORKER_URL || !RELAY_SECRET) {
  console.error("Missing required env: DISCORD_BOT_TOKEN, WORKER_URL, RELAY_SECRET");
  process.exit(1);
}

let ws;
let heartbeatTimer = null;
let seq = null;
let sessionId = null;
let botUserId = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
const INTENTS = 512 | 32768 | 4096; // GUILD_MESSAGES | MESSAGE_CONTENT | DIRECT_MESSAGES

async function getBotInfo() {
  const resp = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    console.error(`Failed to get bot info: ${resp.status} ${text}`);
    process.exit(1);
  }
  const data = await resp.json();
  botUserId = data.id;
  console.log(`Logged in as ${data.username} (${botUserId})`);
}

function startHeartbeat(intervalMs) {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ op: 1, d: seq }));
    }
  }, intervalMs);
}

function identify() {
  ws.send(JSON.stringify({
    op: 2,
    d: {
      token: DISCORD_BOT_TOKEN,
      intents: INTENTS,
      properties: { os: "linux", browser: "ivy_relay", device: "ivy_relay" },
    },
  }));
}

function resume() {
  ws.send(JSON.stringify({
    op: 6,
    d: { token: DISCORD_BOT_TOKEN, session_id: sessionId, seq },
  }));
}

function forwardToWorker(channelId, text, authorId, guildId) {
  fetch(WORKER_URL + "/chat-message", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Relay-Secret": RELAY_SECRET,
    },
    body: JSON.stringify({ channelId, text, authorId, guildId }),
  }).catch((err) => console.error("Forward error:", err.message));
}

function handleMessageCreate(msg) {
  if (msg.author?.id === botUserId) return;
  if (msg.author?.bot) return;

  const isDM = !msg.guild_id;
  const isMentioned = msg.mentions?.some((m) => m.id === botUserId);

  if (!isMentioned && !isDM) return;

  let text = msg.content.replace(/<@!?(\d+)>/g, "").trim();
  if (!text && isDM) text = msg.content;
  if (!text) return;

  console.log(`[${isDM ? "DM" : "mention"}] from ${msg.author.username}: ${text.slice(0, 60)}`);
  forwardToWorker(msg.channel_id, text, msg.author.id, msg.guild_id);
}

function connect() {
  if (ws) {
    ws.removeAllListeners();
    ws.close();
  }

  ws = new WebSocket(GATEWAY_URL);

  ws.on("open", () => {
    console.log("Gateway connected");
    reconnectDelay = 1000;
  });

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const { op, d, s, t } = data;
    if (s !== null) seq = s;

    switch (op) {
      case 0:
        if (t === "READY") {
          sessionId = d.session_id;
          console.log(`Session ready: ${sessionId}`);
        } else if (t === "RESUMED") {
          console.log("Session resumed");
        } else if (t === "MESSAGE_CREATE") {
          handleMessageCreate(d);
        }
        break;
      case 7:
        console.log("Reconnect requested");
        ws.close(4000, "Reconnect");
        break;
      case 9:
        console.log("Invalid session, re-identifying");
        sessionId = null;
        identify();
        break;
      case 10:
        startHeartbeat(d.heartbeat_interval);
        if (sessionId) {
          resume();
        } else {
          identify();
        }
        break;
    }
  });

  ws.on("close", (code) => {
    clearInterval(heartbeatTimer);
    console.log(`Disconnected (code ${code}), reconnecting in ${reconnectDelay}ms`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
}

async function main() {
  console.log("Starting Ivy Discord Relay...");
  await getBotInfo();
  connect();

  const PORT = parseInt(process.env.PORT || "8080");
  http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  }).listen(PORT, () => console.log(`Health server on :${PORT}`));
}

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down");
  clearInterval(heartbeatTimer);
  ws?.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down");
  clearInterval(heartbeatTimer);
  ws?.close();
  process.exit(0);
});

main();
