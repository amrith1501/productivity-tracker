"""One-shot cleanup for duplicate tasks.

Background: The very first SQLite migration didn't transfer the legacy
`state.json` bookkeeping lists (`processed_files` / `processed_imports`),
so the inbox watcher re-ingested any file still sitting in
`tasks_inbox/` once on its first post-migration tick. That can show up
as every previously-imported task appearing twice.

This script groups tasks per supervisor by
    (title, description, source_file)
— deliberately ignoring assignee, because the inbox watcher's
round-robin can land a duplicate on a different worker than the
original — and within each group keeps the single most-progressed
copy:
    approved > submitted > in_progress > pending,
    tie-broken by earliest `created_at` (your original).

Run it once, by hand, from the `backend/` directory:

    python dedupe_tasks.py            # show what would be removed
    python dedupe_tasks.py --apply    # actually delete the duplicates
"""
from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent / "app.db"

STATUS_RANK = {"approved": 3, "submitted": 2, "in_progress": 1, "pending": 0}


def _score(row: sqlite3.Row) -> tuple:
    """Higher score = more worth keeping."""
    rank = STATUS_RANK.get(row["status"], -1)
    # Prefer rows with timestamps populated; rows the user actually
    # touched should always beat freshly-ingested duplicates.
    touched = sum(1 for k in ("started_at", "submitted_at", "approved_at")
                  if row[k])
    return (rank, touched)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true",
                    help="Actually delete duplicates (otherwise dry-run).")
    args = ap.parse_args()

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """SELECT id, supervisor_id, title, description, assignee,
                  source_file, status, created_at,
                  started_at, submitted_at, approved_at
           FROM tasks
           ORDER BY created_at"""
    ).fetchall()

    groups: dict[tuple, list[sqlite3.Row]] = {}
    for r in rows:
        # Group by content, not by who it's assigned to — the inbox
        # watcher's round-robin may have reassigned the duplicate.
        key = (r["supervisor_id"], r["title"], r["description"] or "",
               r["source_file"] or "")
        groups.setdefault(key, []).append(r)

    to_delete: list[str] = []
    for key, members in groups.items():
        if len(members) < 2:
            continue
        # Best score wins; ties broken by oldest created_at (the original
        # import, vs. the watcher's freshly-created duplicate).
        ranked = sorted(
            members,
            key=lambda r: (-_score(r)[0], -_score(r)[1], r["created_at"]),
        )
        keep, drop = ranked[0], ranked[1:]
        for r in drop:
            to_delete.append(r["id"])
            print(f"  drop {r['id']}  '{r['title']}' -> {r['assignee']}"
                  f"  (status={r['status']}, created={r['created_at']})")
        print(f"  keep {keep['id']}  '{keep['title']}' -> {keep['assignee']}"
              f"  (status={keep['status']}, created={keep['created_at']})")
        print()

    if not to_delete:
        print("No duplicates found. Nothing to do.")
        return 0

    print(f"{len(to_delete)} duplicate(s) identified.")
    if not args.apply:
        print("Dry-run only. Re-run with --apply to actually delete them.")
        return 0

    placeholders = ",".join("?" * len(to_delete))
    cur = conn.execute(
        f"DELETE FROM tasks WHERE id IN ({placeholders})", to_delete
    )
    conn.commit()
    print(f"Deleted {cur.rowcount} task(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
