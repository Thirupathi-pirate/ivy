CREATE TABLE IF NOT EXISTS sessions (
  chat_id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  chat_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (chat_id, key)
);

CREATE INDEX IF NOT EXISTS idx_memories_chat_id ON memories(chat_id);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  message TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reminders_timestamp ON reminders(timestamp);
