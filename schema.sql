-- Database Schema for Cloudflare D1 (SQLite)

CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    is_channel_member INTEGER DEFAULT 0,
    first_seen TEXT NOT NULL,
    last_active TEXT NOT NULL,
    is_blocked INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    asked_at TEXT NOT NULL,
    tokens_used INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS daily_usage (
    user_id INTEGER NOT NULL,
    usage_date TEXT NOT NULL,
    question_count INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, usage_date),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);
