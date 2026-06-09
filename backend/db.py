"""SQLite setup for user accounts and tasks."""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Iterable

DB_PATH = Path(__file__).parent / "app.db"

TASK_STATUSES = ("pending", "in_progress", "submitted", "approved")


def init_db() -> None:
    with connect() as conn:
        # 1. Create the users table (or no-op if it already exists from an
        #    older schema). Indexes on potentially-missing columns must
        #    wait until after the migration step below.
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
            """
        )
        # 2. Lightweight migration: add manager_id to pre-existing databases
        #    that were created before this column was introduced.
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(users)")]
        if "manager_id" not in cols:
            conn.execute("ALTER TABLE users ADD COLUMN manager_id INTEGER "
                         "REFERENCES users(id) ON DELETE SET NULL")
        # 3. Now safe to create the manager_id index and the rest of the schema.
        conn.executescript(
            """
            CREATE INDEX IF NOT EXISTS idx_users_manager ON users(manager_id);

            CREATE TABLE IF NOT EXISTS password_resets (
                token_hash BLOB PRIMARY KEY,
                user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at INTEGER NOT NULL,
                used_at    TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id);

            -- Per-supervisor task storage. Each task is owned by a single
            -- supervisor and assigned to one of their workers by display name.
            -- `external_id` is the optional Task ID carried in the source
            -- file (e.g. "T-001"); it's used to make ingestion idempotent.
            CREATE TABLE IF NOT EXISTS tasks (
                id            TEXT PRIMARY KEY,
                supervisor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                external_id   TEXT,
                title         TEXT NOT NULL,
                description   TEXT NOT NULL DEFAULT '',
                assignee      TEXT NOT NULL,
                status        TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','in_progress','submitted','approved')),
                source_file   TEXT NOT NULL DEFAULT '',
                created_at    TEXT NOT NULL,
                started_at    TEXT,
                submitted_at  TEXT,
                approved_at   TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_tasks_supervisor
                ON tasks(supervisor_id);
            CREATE INDEX IF NOT EXISTS idx_tasks_supervisor_created
                ON tasks(supervisor_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_tasks_assignee
                ON tasks(assignee);

            -- Per-supervisor record of which import-directory files have
            -- already been ingested, so reruns are idempotent.
            CREATE TABLE IF NOT EXISTS processed_imports (
                supervisor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                path          TEXT NOT NULL,
                processed_at  TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (supervisor_id, path)
            );

            -- Round-robin counter so each supervisor's intake stays
            -- balanced across their own team independently of others.
            CREATE TABLE IF NOT EXISTS supervisor_rr (
                supervisor_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                rr_index      INTEGER NOT NULL DEFAULT 0
            );

            -- Tracks files the global inbox watcher has already seen so
            -- restarts don't reprocess them.
            CREATE TABLE IF NOT EXISTS inbox_processed (
                filename     TEXT PRIMARY KEY,
                processed_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            -- In-app alerts. One row per recipient per event. `read_at` is
            -- NULL until the user opens their notification panel.
            CREATE TABLE IF NOT EXISTS notifications (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                type       TEXT NOT NULL,
                message    TEXT NOT NULL,
                task_id    TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                read_at    TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_notifications_user
                ON notifications(user_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_notifications_unread
                ON notifications(user_id, read_at);
            """
        )
        # 4. Migration: add tasks.external_id to databases created before the
        #    column existed, then build the per-supervisor uniqueness index.
        task_cols = [r["name"] for r in conn.execute("PRAGMA table_info(tasks)")]
        if "external_id" not in task_cols:
            conn.execute("ALTER TABLE tasks ADD COLUMN external_id TEXT")
        # A partial UNIQUE index enforces "one task per (supervisor, Task ID)"
        # while allowing unlimited rows whose external_id is NULL (tasks that
        # came from a file without an ID column).
        conn.execute(
            """CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_supervisor_extid
               ON tasks(supervisor_id, external_id)
               WHERE external_id IS NOT NULL"""
        )


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


def list_workers_for_manager(manager_id: int,
                             include_inactive: bool = False) -> list[dict]:
    """Return workers belonging to `manager_id`. By default removed
    (soft-deleted) workers are excluded so the supervisor's team view
    matches the employees roster used elsewhere.
    """
    query = ["""SELECT id, username, employee, is_active, created_at, last_login_at
                FROM users
                WHERE role='worker' AND manager_id=?"""]
    if not include_inactive:
        query.append("AND is_active = 1")
    query.append("ORDER BY employee COLLATE NOCASE")
    with connect() as conn:
        rows = conn.execute("\n".join(query), (manager_id,)).fetchall()
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


def deactivate_worker(worker_id: int, manager_id: int) -> dict | None:
    """Soft-delete a worker by setting is_active=0. Only works when the
    worker is currently active and belongs to `manager_id`. Returns the
    affected row (pre-update view) or None when nothing matched, so the
    caller can distinguish 404 from 403.
    """
    with connect() as conn:
        row = conn.execute(
            """SELECT id, username, employee, manager_id, is_active, role
               FROM users WHERE id = ?""",
            (worker_id,),
        ).fetchone()
        if not row:
            return None
        if row["role"] != "worker" or row["manager_id"] != manager_id \
                or row["is_active"] != 1:
            return None
        conn.execute("UPDATE users SET is_active = 0 WHERE id = ?", (worker_id,))
        # Invalidate any outstanding password-reset tokens for this user.
        conn.execute("DELETE FROM password_resets WHERE user_id = ?", (worker_id,))
        return dict(row)


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


# ---------- Tasks ----------

_TASK_COLUMNS = (
    "id", "supervisor_id", "external_id", "title", "description", "assignee",
    "status", "source_file", "created_at", "started_at", "submitted_at",
    "approved_at",
)


def _row_to_task(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    out = {k: row[k] for k in _TASK_COLUMNS}
    # The API shape historically didn't expose supervisor_id; keep it under
    # the hood for the frontend but include it in dict so server code can
    # use it when needed.
    return out


def create_task(*, task_id: str, supervisor_id: int, title: str,
                description: str, assignee: str, status: str,
                source_file: str, created_at: str,
                external_id: str | None = None) -> dict:
    with connect() as conn:
        conn.execute(
            """INSERT INTO tasks
               (id, supervisor_id, external_id, title, description, assignee,
                status, source_file, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (task_id, supervisor_id, external_id, title, description, assignee,
             status, source_file, created_at),
        )
        row = conn.execute(
            "SELECT * FROM tasks WHERE id = ?", (task_id,)
        ).fetchone()
        return _row_to_task(row)


def existing_external_ids(supervisor_id: int) -> set[str]:
    """All external (source-file) Task IDs already stored for a supervisor.
    Used to make ingestion idempotent — a Task ID is imported at most once
    per supervisor.
    """
    with connect() as conn:
        rows = conn.execute(
            """SELECT external_id FROM tasks
               WHERE supervisor_id = ? AND external_id IS NOT NULL""",
            (supervisor_id,),
        ).fetchall()
        return {r["external_id"] for r in rows}


def existing_task_keys(supervisor_id: int) -> tuple[set[str], set[str]]:
    """Snapshot of what's currently stored for a supervisor, used to dedupe
    ingestion against the *live* task list (not against a record of files
    seen in the past). Returns ``(external_ids, content_keys)`` where:

    - ``external_ids`` are the Task IDs present in the DB right now.
    - ``content_keys`` identify tasks that carry no Task ID, by
      ``source_file``/``title``/``description``.

    Because this reflects the current rows, a task that the supervisor
    deletes drops out of the snapshot and will be re-created the next time
    its source file is scanned.
    """
    ext_ids: set[str] = set()
    content: set[str] = set()
    with connect() as conn:
        rows = conn.execute(
            """SELECT external_id, source_file, title, description
               FROM tasks WHERE supervisor_id = ?""",
            (supervisor_id,),
        ).fetchall()
    for r in rows:
        if r["external_id"]:
            ext_ids.add(r["external_id"])
        else:
            content.add(
                f"{r['source_file']}\x1f{r['title']}\x1f{r['description'] or ''}")
    return ext_ids, content


def get_task(task_id: str) -> dict | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM tasks WHERE id = ?", (task_id,)
        ).fetchone()
        return _row_to_task(row)


def _since_iso(days: int | None) -> str | None:
    if not days or days <= 0:
        return None
    cutoff = datetime.utcnow() - timedelta(days=days)
    return cutoff.isoformat()


def list_tasks_for_supervisor(supervisor_id: int, *,
                              days: int | None = None,
                              status: str | None = None,
                              assignee: str | None = None) -> list[dict]:
    sql = ["SELECT * FROM tasks WHERE supervisor_id = ?"]
    params: list = [supervisor_id]
    since = _since_iso(days)
    if since:
        sql.append("AND created_at >= ?")
        params.append(since)
    if status:
        sql.append("AND status = ?")
        params.append(status)
    if assignee:
        sql.append("AND assignee = ?")
        params.append(assignee)
    sql.append("ORDER BY created_at DESC")
    with connect() as conn:
        rows = conn.execute(" ".join(sql), params).fetchall()
        return [_row_to_task(r) for r in rows]


def list_tasks_for_supervisor_range(supervisor_id: int, *,
                                    start_iso: str | None = None,
                                    end_iso: str | None = None) -> list[dict]:
    """Tasks owned by a supervisor whose `created_at` falls within the
    given ISO bounds (inclusive). Either bound may be omitted. Ordered
    oldest-first, which reads naturally in an exported spreadsheet.
    """
    sql = ["SELECT * FROM tasks WHERE supervisor_id = ?"]
    params: list = [supervisor_id]
    if start_iso:
        sql.append("AND created_at >= ?")
        params.append(start_iso)
    if end_iso:
        sql.append("AND created_at <= ?")
        params.append(end_iso)
    sql.append("ORDER BY created_at ASC")
    with connect() as conn:
        rows = conn.execute(" ".join(sql), params).fetchall()
        return [_row_to_task(r) for r in rows]


def list_tasks_for_worker(employee: str, *,
                          days: int | None = None,
                          status: str | None = None) -> list[dict]:
    sql = ["SELECT * FROM tasks WHERE assignee = ?"]
    params: list = [employee]
    since = _since_iso(days)
    if since:
        sql.append("AND created_at >= ?")
        params.append(since)
    if status:
        sql.append("AND status = ?")
        params.append(status)
    sql.append("ORDER BY created_at DESC")
    with connect() as conn:
        rows = conn.execute(" ".join(sql), params).fetchall()
        return [_row_to_task(r) for r in rows]


def update_task_fields(task_id: str, fields: dict) -> dict | None:
    if not fields:
        return get_task(task_id)
    allowed = {"title", "description", "assignee", "status",
               "started_at", "submitted_at", "approved_at"}
    cols = [k for k in fields.keys() if k in allowed]
    if not cols:
        return get_task(task_id)
    set_clause = ", ".join(f"{c} = ?" for c in cols)
    params = [fields[c] for c in cols] + [task_id]
    with connect() as conn:
        conn.execute(f"UPDATE tasks SET {set_clause} WHERE id = ?", params)
        row = conn.execute(
            "SELECT * FROM tasks WHERE id = ?", (task_id,)
        ).fetchone()
        return _row_to_task(row)


def delete_task(task_id: str) -> bool:
    with connect() as conn:
        cur = conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        return cur.rowcount > 0


def delete_tasks_for_supervisor(supervisor_id: int, *,
                                status: str | None = None) -> int:
    sql = "DELETE FROM tasks WHERE supervisor_id = ?"
    params: list = [supervisor_id]
    if status:
        sql += " AND status = ?"
        params.append(status)
    with connect() as conn:
        cur = conn.execute(sql, params)
        return cur.rowcount


def open_task_ids_for_assignee(assignee: str, supervisor_id: int) -> list[str]:
    """IDs of pending/in-progress/submitted tasks for a worker.
    Approved tasks are kept as audit history.
    """
    with connect() as conn:
        rows = conn.execute(
            """SELECT id FROM tasks
               WHERE assignee = ? AND supervisor_id = ?
                 AND status IN ('pending','in_progress','submitted')
               ORDER BY created_at""",
            (assignee, supervisor_id),
        ).fetchall()
        return [r["id"] for r in rows]


def delete_tasks_by_ids(ids: Iterable[str]) -> int:
    ids = list(ids)
    if not ids:
        return 0
    placeholders = ",".join("?" * len(ids))
    with connect() as conn:
        cur = conn.execute(
            f"DELETE FROM tasks WHERE id IN ({placeholders})", ids
        )
        return cur.rowcount


def reset_tasks_for_reassignment(ids: Iterable[str], new_assignee: str) -> int:
    """Reassign a batch of tasks and reset their in-flight state so the
    new owner starts cleanly. Approved/cancelled tasks should not be
    passed in here.
    """
    ids = list(ids)
    if not ids:
        return 0
    placeholders = ",".join("?" * len(ids))
    with connect() as conn:
        cur = conn.execute(
            f"""UPDATE tasks
                SET assignee     = ?,
                    status       = 'pending',
                    started_at   = NULL,
                    submitted_at = NULL
                WHERE id IN ({placeholders})""",
            [new_assignee, *ids],
        )
        return cur.rowcount


def stats_for_supervisor(supervisor_id: int) -> dict:
    """Aggregate counts: by_status (overall) and by_assignee (per worker).
    Empty buckets are not included.
    """
    with connect() as conn:
        by_status: dict[str, int] = {}
        by_assignee: dict[str, dict[str, int]] = {}
        total = 0
        rows = conn.execute(
            """SELECT assignee, status, COUNT(*) AS n
               FROM tasks WHERE supervisor_id = ?
               GROUP BY assignee, status""",
            (supervisor_id,),
        ).fetchall()
        for r in rows:
            n = r["n"]
            total += n
            by_status[r["status"]] = by_status.get(r["status"], 0) + n
            d = by_assignee.setdefault(r["assignee"], {})
            d[r["status"]] = n
        return {"by_status": by_status, "by_assignee": by_assignee,
                "total": total}


# ---------- Per-supervisor ingestion bookkeeping ----------

def get_processed_imports(supervisor_id: int) -> set[str]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT path FROM processed_imports WHERE supervisor_id = ?",
            (supervisor_id,),
        ).fetchall()
        return {r["path"] for r in rows}


def mark_import_processed(supervisor_id: int, path: str) -> None:
    with connect() as conn:
        conn.execute(
            """INSERT OR IGNORE INTO processed_imports (supervisor_id, path)
               VALUES (?, ?)""",
            (supervisor_id, path),
        )


def get_rr_index(supervisor_id: int) -> int:
    with connect() as conn:
        row = conn.execute(
            "SELECT rr_index FROM supervisor_rr WHERE supervisor_id = ?",
            (supervisor_id,),
        ).fetchone()
        return int(row["rr_index"]) if row else 0


def set_rr_index(supervisor_id: int, value: int) -> None:
    with connect() as conn:
        conn.execute(
            """INSERT INTO supervisor_rr (supervisor_id, rr_index)
               VALUES (?, ?)
               ON CONFLICT(supervisor_id) DO UPDATE SET rr_index = excluded.rr_index""",
            (supervisor_id, value),
        )


def get_inbox_processed_filenames() -> set[str]:
    with connect() as conn:
        rows = conn.execute("SELECT filename FROM inbox_processed").fetchall()
        return {r["filename"] for r in rows}


def mark_inbox_processed(filename: str) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO inbox_processed (filename) VALUES (?)",
            (filename,),
        )


def list_active_workers_with_manager() -> list[dict]:
    """All active workers that have a supervisor assigned. Used by the
    global inbox watcher to route tasks to the right supervisor.
    """
    with connect() as conn:
        rows = conn.execute(
            """SELECT id, username, employee, manager_id
               FROM users
               WHERE role = 'worker' AND is_active = 1
                 AND manager_id IS NOT NULL AND employee IS NOT NULL
               ORDER BY id"""
        ).fetchall()
        return [dict(r) for r in rows]


def task_count() -> int:
    with connect() as conn:
        row = conn.execute("SELECT COUNT(*) AS n FROM tasks").fetchone()
        return int(row["n"])


def get_worker_id_by_employee(manager_id: int, employee: str) -> int | None:
    """Resolve an active worker's user id from their display name within a
    given supervisor's team. Returns None if no such worker exists (e.g. a
    legacy roster name that was never a real account).
    """
    with connect() as conn:
        row = conn.execute(
            """SELECT id FROM users
               WHERE role = 'worker' AND is_active = 1
                 AND manager_id = ? AND employee = ? COLLATE NOCASE
               LIMIT 1""",
            (manager_id, employee),
        ).fetchone()
        return int(row["id"]) if row else None


# ---------- Notifications ----------

def create_notification(user_id: int, type: str, message: str,
                        task_id: str | None = None) -> None:
    with connect() as conn:
        conn.execute(
            """INSERT INTO notifications (user_id, type, message, task_id)
               VALUES (?, ?, ?, ?)""",
            (user_id, type, message, task_id),
        )


def list_notifications(user_id: int, limit: int = 50) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """SELECT id, type, message, task_id, created_at, read_at
               FROM notifications
               WHERE user_id = ?
               ORDER BY created_at DESC, id DESC
               LIMIT ?""",
            (user_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]


def count_unread_notifications(user_id: int) -> int:
    with connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM notifications "
            "WHERE user_id = ? AND read_at IS NULL",
            (user_id,),
        ).fetchone()
        return int(row["n"])


def mark_notifications_read(user_id: int,
                            ids: Iterable[int] | None = None) -> int:
    """Mark notifications read. With `ids` limits to those rows (still
    scoped to the user); without it marks all of the user's unread ones.
    """
    with connect() as conn:
        if ids is not None:
            ids = list(ids)
            if not ids:
                return 0
            placeholders = ",".join("?" * len(ids))
            cur = conn.execute(
                f"""UPDATE notifications SET read_at = datetime('now')
                    WHERE user_id = ? AND read_at IS NULL
                      AND id IN ({placeholders})""",
                [user_id, *ids],
            )
        else:
            cur = conn.execute(
                """UPDATE notifications SET read_at = datetime('now')
                   WHERE user_id = ? AND read_at IS NULL""",
                (user_id,),
            )
        return cur.rowcount
