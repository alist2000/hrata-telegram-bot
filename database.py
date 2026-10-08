"""
Database module for Telegram AI Bot.
Handles all SQLite operations: users, questions, daily limits.
"""

import aiosqlite
import os
from datetime import datetime, date
from typing import Optional

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bot_data.db")


async def init_db():
    """Initialize the database and create tables if they don't exist."""
    async with aiosqlite.connect(DB_PATH) as db:
        # Users table — stores every Telegram user who interacts with the bot
        await db.execute("""
            CREATE TABLE IF NOT EXISTS users (
                user_id INTEGER PRIMARY KEY,
                username TEXT,
                first_name TEXT,
                last_name TEXT,
                is_channel_member INTEGER DEFAULT 0,
                first_seen TEXT NOT NULL,
                last_active TEXT NOT NULL,
                is_blocked INTEGER DEFAULT 0
            )
        """)

        # Questions table — logs every question and the bot's answer
        await db.execute("""
            CREATE TABLE IF NOT EXISTS questions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                question TEXT NOT NULL,
                answer TEXT NOT NULL,
                asked_at TEXT NOT NULL,
                tokens_used INTEGER DEFAULT 0,
                FOREIGN KEY (user_id) REFERENCES users(user_id)
            )
        """)

        # Daily usage table — tracks per-user daily question counts
        await db.execute("""
            CREATE TABLE IF NOT EXISTS daily_usage (
                user_id INTEGER NOT NULL,
                usage_date TEXT NOT NULL,
                question_count INTEGER DEFAULT 0,
                PRIMARY KEY (user_id, usage_date),
                FOREIGN KEY (user_id) REFERENCES users(user_id)
            )
        """)

        await db.commit()
    print("[OK] Database initialized successfully.")


async def upsert_user(
    user_id: int,
    username: Optional[str] = None,
    first_name: Optional[str] = None,
    last_name: Optional[str] = None,
):
    """Insert a new user or update their info on every interaction."""
    now = datetime.now().isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            INSERT INTO users (user_id, username, first_name, last_name, first_seen, last_active)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                username = excluded.username,
                first_name = excluded.first_name,
                last_name = excluded.last_name,
                last_active = excluded.last_active
        """, (user_id, username, first_name, last_name, now, now))
        await db.commit()


async def set_channel_membership(user_id: int, is_member: bool):
    """Update whether the user is currently a channel member."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            UPDATE users SET is_channel_member = ? WHERE user_id = ?
        """, (1 if is_member else 0, user_id))
        await db.commit()


async def get_daily_usage(user_id: int) -> int:
    """Return how many questions the user has asked today."""
    today = date.today().isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute("""
            SELECT question_count FROM daily_usage
            WHERE user_id = ? AND usage_date = ?
        """, (user_id, today))
        row = await cursor.fetchone()
        return row[0] if row else 0


async def increment_daily_usage(user_id: int):
    """Increment the user's daily question counter."""
    today = date.today().isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            INSERT INTO daily_usage (user_id, usage_date, question_count)
            VALUES (?, ?, 1)
            ON CONFLICT(user_id, usage_date) DO UPDATE SET
                question_count = question_count + 1
        """, (user_id, today))
        await db.commit()


async def save_question(user_id: int, question: str, answer: str, tokens_used: int = 0):
    """Save a question-answer pair to the database."""
    now = datetime.now().isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            INSERT INTO questions (user_id, question, answer, asked_at, tokens_used)
            VALUES (?, ?, ?, ?, ?)
        """, (user_id, question, answer, now, tokens_used))
        await db.commit()


async def get_user_history(user_id: int, limit: int = 10) -> list:
    """Fetch the latest questions for a user."""
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute("""
            SELECT question, answer, asked_at FROM questions
            WHERE user_id = ?
            ORDER BY asked_at DESC
            LIMIT ?
        """, (user_id, limit))
        rows = await cursor.fetchall()
        return [{"question": r[0], "answer": r[1], "asked_at": r[2]} for r in rows]


async def get_all_users() -> list:
    """Fetch all registered users (for admin panel)."""
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute("""
            SELECT user_id, username, first_name, last_name,
                   is_channel_member, first_seen, last_active, is_blocked
            FROM users
            ORDER BY last_active DESC
        """)
        rows = await cursor.fetchall()
        return [
            {
                "user_id": r[0], "username": r[1], "first_name": r[2],
                "last_name": r[3], "is_channel_member": bool(r[4]),
                "first_seen": r[5], "last_active": r[6], "is_blocked": bool(r[7]),
            }
            for r in rows
        ]


async def block_user(user_id: int):
    """Block a user from using the bot."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE users SET is_blocked = 1 WHERE user_id = ?", (user_id,))
        await db.commit()


async def unblock_user(user_id: int):
    """Unblock a user."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE users SET is_blocked = 0 WHERE user_id = ?", (user_id,))
        await db.commit()


async def is_user_blocked(user_id: int) -> bool:
    """Check if a user is blocked."""
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "SELECT is_blocked FROM users WHERE user_id = ?", (user_id,)
        )
        row = await cursor.fetchone()
        return bool(row[0]) if row else False


async def get_stats() -> dict:
    """Get overall bot statistics."""
    async with aiosqlite.connect(DB_PATH) as db:
        # Total users
        cursor = await db.execute("SELECT COUNT(*) FROM users")
        total_users = (await cursor.fetchone())[0]

        # Active today
        today = date.today().isoformat()
        cursor = await db.execute(
            "SELECT COUNT(DISTINCT user_id) FROM daily_usage WHERE usage_date = ?",
            (today,),
        )
        active_today = (await cursor.fetchone())[0]

        # Total questions ever
        cursor = await db.execute("SELECT COUNT(*) FROM questions")
        total_questions = (await cursor.fetchone())[0]

        # Questions today
        cursor = await db.execute(
            "SELECT SUM(question_count) FROM daily_usage WHERE usage_date = ?",
            (today,),
        )
        row = await cursor.fetchone()
        questions_today = row[0] if row[0] else 0

        # Channel members
        cursor = await db.execute(
            "SELECT COUNT(*) FROM users WHERE is_channel_member = 1"
        )
        channel_members = (await cursor.fetchone())[0]

        return {
            "total_users": total_users,
            "active_today": active_today,
            "total_questions": total_questions,
            "questions_today": questions_today,
            "channel_members": channel_members,
        }
