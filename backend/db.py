"""SQLite setup for user accounts."""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(__file__).parent / "app.db"


def init_db() -> None:
    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash BLOB NOT NULL,
                salt          BLOB NOT NULL,
                iterations    INTEGER NOT NULL,
                role          TEXT NOT NULL CHECK (role IN ('supervisor','worker')),
                employee      TEXT,
                manager_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
                is_active     INTEGER NOT NULL DEFAULT 1,
                created_at    TEXT NOT NULL DEFAULT (datetime('now')),
                last_login_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
            CREATE INDEX IF NOT EXISTS idx_users_manager  ON users(manager_id);

            CREATE TABLE IF NOT EXISTS password_resets (
                token_hash BLOB PRIMARY KEY,
                user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at INTEGER NOT NULL,
                used_at    TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id);
            """
        )
        # Lightweight migration for pre-existing databases.
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(users)")]
        if "manager_id" not in cols:
            conn.execute("ALTER TABLE users ADD COLUMN manager_id INTEGER "
                         "REFERENCES users(id) ON DELETE SET NULL")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_users_manager ON users(manager_id)")


@contextmanager
def connect():
    conn = sqlite3.connect(DB_PATH, isolation_level=None)  # autocommit
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    try:
        yield conn
    finally:
        conn.close()


def get_user_by_username(username: str):
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE username = ? AND is_active = 1",
            (username,),
        ).fetchone()
        return dict(row) if row else None


def mark_login(user_id: int) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE users SET last_login_at = datetime('now') WHERE id = ?",
            (user_id,),
        )


def create_user(username: str, password_hash: bytes, salt: bytes,
                iterations: int, role: str, employee: str | None,
                manager_id: int | None = None) -> int:
    with connect() as conn:
        cur = conn.execute(
            """INSERT INTO users
               (username, password_hash, salt, iterations, role, employee, manager_id)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (username, password_hash, salt, iterations, role, employee, manager_id),
        )
        return cur.lastrowid


def list_workers_for_manager(manager_id: int) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """SELECT id, username, employee, is_active, created_at, last_login_at
               FROM users
               WHERE role='worker' AND manager_id=?
               ORDER BY employee COLLATE NOCASE""",
            (manager_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def employees_for_manager(manager_id: int) -> list[str]:
    with connect() as conn:
        rows = conn.execute(
            """SELECT employee FROM users
               WHERE role='worker' AND manager_id=? AND is_active=1 AND employee IS NOT NULL
               ORDER BY employee COLLATE NOCASE""",
            (manager_id,),
        ).fetchall()
        return [r["employee"] for r in rows]


def update_password(user_id: int, password_hash: bytes, salt: bytes,
                    iterations: int) -> None:
    with connect() as conn:
        conn.execute(
            """UPDATE users SET password_hash=?, salt=?, iterations=?
               WHERE id=?""",
            (password_hash, salt, iterations, user_id),
        )


def store_reset_token(token_hash: bytes, user_id: int, expires_at: int) -> None:
    with connect() as conn:
        # Invalidate any prior unused tokens for this user.
        conn.execute("DELETE FROM password_resets WHERE user_id=? AND used_at IS NULL",
                     (user_id,))
        conn.execute(
            "INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
            (token_hash, user_id, expires_at),
        )


def consume_reset_token(token_hash: bytes) -> int | None:
    """Return user_id if token is valid and unused, then mark it used. Else None."""
    import time
    with connect() as conn:
        row = conn.execute(
            """SELECT user_id, expires_at, used_at FROM password_resets
               WHERE token_hash = ?""",
            (token_hash,),
        ).fetchone()
        if not row or row["used_at"] is not None:
            return None
        if row["expires_at"] < int(time.time()):
            return None
        conn.execute(
            "UPDATE password_resets SET used_at = datetime('now') WHERE token_hash = ?",
            (token_hash,),
        )
        return row["user_id"]
