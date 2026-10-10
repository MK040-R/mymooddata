"""SQLite storage: one row per user, one row per check-in prompt."""

import sqlite3
from dataclasses import dataclass
from datetime import datetime, time

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    chat_id    INTEGER PRIMARY KEY,
    tz         TEXT    NOT NULL,
    start_time TEXT    NOT NULL,   -- HH:MM, first check-in of the day
    end_time   TEXT    NOT NULL,   -- HH:MM, last check-in of the day
    per_day    INTEGER NOT NULL CHECK (per_day BETWEEN 1 AND 4),
    active     INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS prompts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     INTEGER NOT NULL,
    sent_at     TEXT    NOT NULL,  -- UTC ISO timestamp
    mood        TEXT,              -- happy | normal | unpleasant | NULL (unanswered)
    answered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_prompts_chat_sent ON prompts (chat_id, sent_at);
"""


@dataclass
class User:
    chat_id: int
    tz: str
    start_time: time
    end_time: time
    per_day: int
    active: bool


@dataclass
class Prompt:
    id: int
    sent_at: datetime
    mood: str | None


def _t(s: str) -> time:
    return time.fromisoformat(s)


class DB:
    def __init__(self, path: str):
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)

    def _user(self, r) -> User:
        return User(r["chat_id"], r["tz"], _t(r["start_time"]), _t(r["end_time"]), r["per_day"], bool(r["active"]))

    def get_user(self, chat_id: int) -> User | None:
        r = self.conn.execute("SELECT * FROM users WHERE chat_id = ?", (chat_id,)).fetchone()
        return self._user(r) if r else None

    def active_users(self) -> list[User]:
        return [self._user(r) for r in self.conn.execute("SELECT * FROM users WHERE active = 1")]

    def upsert_user(self, u: User) -> None:
        with self.conn:
            self.conn.execute(
                """INSERT INTO users (chat_id, tz, start_time, end_time, per_day, active)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT (chat_id) DO UPDATE SET tz = excluded.tz, start_time = excluded.start_time,
                     end_time = excluded.end_time, per_day = excluded.per_day, active = excluded.active""",
                (u.chat_id, u.tz, u.start_time.strftime("%H:%M"), u.end_time.strftime("%H:%M"), u.per_day, int(u.active)),
            )

    def create_prompt(self, chat_id: int, sent_at: datetime) -> int:
        with self.conn:
            cur = self.conn.execute("INSERT INTO prompts (chat_id, sent_at) VALUES (?, ?)", (chat_id, sent_at.isoformat()))
        return cur.lastrowid

    def answer_prompt(self, prompt_id: int, chat_id: int, mood: str, answered_at: datetime) -> bool:
        """Record a mood. Returns False if the prompt is unknown or already answered."""
        with self.conn:
            cur = self.conn.execute(
                "UPDATE prompts SET mood = ?, answered_at = ? WHERE id = ? AND chat_id = ? AND mood IS NULL",
                (mood, answered_at.isoformat(), prompt_id, chat_id),
            )
        return cur.rowcount == 1

    def prompts_between(self, chat_id: int, start: datetime, end: datetime) -> list[Prompt]:
        rows = self.conn.execute(
            "SELECT id, sent_at, mood FROM prompts WHERE chat_id = ? AND sent_at >= ? AND sent_at < ? ORDER BY sent_at",
            (chat_id, start.isoformat(), end.isoformat()),
        )
        return [Prompt(r["id"], datetime.fromisoformat(r["sent_at"]), r["mood"]) for r in rows]
