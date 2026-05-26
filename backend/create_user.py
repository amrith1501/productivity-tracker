"""CLI to provision users.

Usage:
  python create_user.py --username boss --role supervisor
  python create_user.py --username alice --role worker --employee Alice

The password is read interactively (not from argv) so it doesn't end up
in shell history. Use --password-stdin to pipe from a secret manager.
"""
from __future__ import annotations

import argparse
import getpass
import sqlite3
import sys

from auth import hash_password
from db import create_user, init_db


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--username", required=True)
    p.add_argument("--role", required=True, choices=["supervisor", "worker"])
    p.add_argument("--employee", default=None,
                   help="Required for workers. Display name in the UI.")
    p.add_argument("--password-stdin", action="store_true",
                   help="Read password from stdin instead of prompting.")
    args = p.parse_args()

    if args.role == "worker" and not args.employee:
        print("error: --employee is required for worker accounts", file=sys.stderr)
        return 2

    if args.password_stdin:
        password = sys.stdin.readline().rstrip("\n")
    else:
        password = getpass.getpass("Password: ")
        confirm = getpass.getpass("Confirm:  ")
        if password != confirm:
            print("error: passwords do not match", file=sys.stderr)
            return 2

    if len(password) < 12:
        print("error: password must be at least 12 characters", file=sys.stderr)
        return 2

    init_db()
    try:
        digest, salt, iters = hash_password(password)
        uid = create_user(args.username, digest, salt, iters,
                          args.role, args.employee)
        print(f"Created user id={uid} username={args.username} role={args.role}")
        return 0
    except sqlite3.IntegrityError:
        print(f"error: username '{args.username}' already exists", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
