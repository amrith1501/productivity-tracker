"""Productivity Tracker backend.

Watches `tasks_inbox/` for daily task files (JSON: {"tasks": ["..."]} or
plain .txt with one task per line). New tasks are distributed evenly
across the configured employees. State is persisted to `state.json`.
"""
from __future__ import annotations

import asyncio
import json
import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Literal, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import hashlib
import secrets as _secrets
import time as _time

from auth import (
    clear_session_cookie,
    current_user,
    hash_password,
    issue_token,
    login_throttle_check,
    login_throttle_record_failure,
    login_throttle_reset,
    require_supervisor,
    require_worker,
    set_session_cookie,
    verify_password,
)
from db import (
    consume_reset_token,
    create_user,
    employees_for_manager,
    get_user_by_username,
    init_db,
    list_workers_for_manager,
    mark_login,
    store_reset_token,
    update_password,
)

BASE = Path(__file__).parent
INBOX = BASE / "tasks_inbox"
STATE_FILE = BASE / "state.json"
EMPLOYEES_FILE = BASE / "employees.json"
INBOX.mkdir(exist_ok=True)

Status = Literal["pending", "in_progress", "submitted", "approved"]


class Task(BaseModel):
    id: str
    title: str
    description: str = ""
    assignee: str
    status: Status = "pending"
    source_file: str = ""
    created_at: str
    started_at: Optional[str] = None
    submitted_at: Optional[str] = None
    approved_at: Optional[str] = None


class TaskUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    assignee: Optional[str] = None
    status: Optional[Status] = None


def load_employees() -> list[str]:
    if EMPLOYEES_FILE.exists():
        return json.loads(EMPLOYEES_FILE.read_text())
    default = ["Alice", "Bob", "Carol", "Dave"]
    EMPLOYEES_FILE.write_text(json.dumps(default, indent=2))
    return default


def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"tasks": {}, "processed_files": [], "rr_index": 0}


def save_state() -> None:
    STATE_FILE.write_text(json.dumps(STATE, indent=2, default=str))


EMPLOYEES = load_employees()
STATE = load_state()
init_db()


class LoginRequest(BaseModel):
    username: str
    password: str


class RegisterRequest(BaseModel):
    username: str
    password: str
    employee: str  # display name


class CreateWorkerRequest(BaseModel):
    username: str
    password: str
    employee: str


class ResetRequestPayload(BaseModel):
    username: str


class ResetConfirmPayload(BaseModel):
    token: str
    new_password: str


def parse_task_file(path: Path) -> list[dict]:
    """Extract task entries from a daily file. Supports .json and .txt."""
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return []
    if path.suffix.lower() == ".json":
        data = json.loads(text)
        items = data.get("tasks", data) if isinstance(data, dict) else data
        out = []
        for it in items:
            if isinstance(it, str):
                out.append({"title": it, "description": ""})
            else:
                out.append({
                    "title": it.get("title", "Untitled"),
                    "description": it.get("description", ""),
                })
        return out
    # plain text: one task per non-empty line
    return [{"title": line.strip(), "description": ""}
            for line in text.splitlines() if line.strip()]


def ingest_inbox() -> int:
    """Scan inbox for new files and round-robin assign tasks. Returns count."""
    new_count = 0
    files = sorted(p for p in INBOX.iterdir() if p.is_file())
    for path in files:
        if path.name in STATE["processed_files"]:
            continue
        try:
            entries = parse_task_file(path)
        except Exception as e:
            print(f"[ingest] skip {path.name}: {e}")
            continue
        for entry in entries:
            idx = STATE["rr_index"] % len(EMPLOYEES)
            assignee = EMPLOYEES[idx]
            STATE["rr_index"] += 1
            tid = str(uuid.uuid4())
            task = Task(
                id=tid,
                title=entry["title"],
                description=entry.get("description", ""),
                assignee=assignee,
                source_file=path.name,
                created_at=datetime.utcnow().isoformat(),
            )
            STATE["tasks"][tid] = task.model_dump()
            new_count += 1
        STATE["processed_files"].append(path.name)
    if new_count:
        save_state()
        print(f"[ingest] added {new_count} tasks")
    return new_count


async def inbox_watcher():
    while True:
        try:
            ingest_inbox()
        except Exception as e:
            print(f"[watcher] error: {e}")
        await asyncio.sleep(5)


@asynccontextmanager
async def lifespan(app: FastAPI):
    ingest_inbox()
    task = asyncio.create_task(inbox_watcher())
    yield
    task.cancel()


app = FastAPI(lifespan=lifespan)

# CORS: allow only configured origins, and only with credentials (cookies).
# In dev, the Vite proxy makes the API same-origin, so this is mostly a
# safety net. In prod, set PT_ALLOWED_ORIGINS="https://your.app".
_origins = [o.strip() for o in
            os.environ.get("PT_ALLOWED_ORIGINS", "http://localhost:5173").split(",")
            if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type"],
)


def _client_ip(request: Request) -> str:
    # If you deploy behind a trusted reverse proxy, configure
    # uvicorn with --proxy-headers to populate request.client correctly.
    return request.client.host if request.client else "unknown"


@app.post("/api/login")
def login(req: LoginRequest, request: Request, response: Response):
    ip = _client_ip(request)
    login_throttle_check(ip)

    user = get_user_by_username(req.username)
    # Always run pbkdf2 — even on unknown user — to keep response time
    # roughly constant and avoid leaking which usernames exist.
    if user is None:
        verify_password(req.password,
                        expected_hash=b"\0" * 32,
                        salt=b"\0" * 16,
                        iterations=600_000)
        login_throttle_record_failure(ip)
        raise HTTPException(401, "Invalid credentials")

    ok = verify_password(req.password,
                         expected_hash=user["password_hash"],
                         salt=user["salt"],
                         iterations=user["iterations"])
    if not ok:
        login_throttle_record_failure(ip)
        raise HTTPException(401, "Invalid credentials")

    login_throttle_reset(ip)
    mark_login(user["id"])
    token = issue_token(
        user_id=user["id"],
        username=user["username"],
        role=user["role"],
        employee=user["employee"],
    )
    set_session_cookie(response, token)
    return {"user": {"username": user["username"], "role": user["role"],
                     "employee": user["employee"]}}


@app.post("/api/logout")
def logout(response: Response):
    clear_session_cookie(response)
    return {"ok": True}


@app.post("/api/register", status_code=201)
def register(req: RegisterRequest, response: Response):
    """Self-service registration. Always creates a 'worker' account.
    Supervisor accounts must be provisioned via the CLI for safety.
    """
    uname = req.username.strip().lower()
    employee = req.employee.strip()
    if len(uname) < 3 or not uname.replace("_", "").isalnum():
        raise HTTPException(400, "Username must be 3+ chars, alphanumeric/underscore.")
    if not employee:
        raise HTTPException(400, "Display name is required.")
    if get_user_by_username(uname):
        raise HTTPException(409, "Username already taken.")
    try:
        digest, salt, iters = hash_password(req.password)
    except ValueError as e:
        raise HTTPException(400, str(e))
    uid = create_user(uname, digest, salt, iters, "worker", employee)
    # Add new employee to roster if not already present.
    if employee not in EMPLOYEES:
        EMPLOYEES.append(employee)
        EMPLOYEES_FILE.write_text(json.dumps(EMPLOYEES, indent=2))
    token = issue_token(user_id=uid, username=uname, role="worker",
                        employee=employee)
    set_session_cookie(response, token)
    return {"user": {"username": uname, "role": "worker", "employee": employee}}


PASSWORD_RESET_TTL = 30 * 60  # 30 minutes


@app.post("/api/password-reset/request")
def request_password_reset(payload: ResetRequestPayload, request: Request):
    """Generate a single-use reset token.

    Always returns the same response to avoid leaking which usernames
    exist. The token is delivered out-of-band — in production hook this
    up to your email/SMS provider. Here it's logged to the server
    console for the admin to deliver.
    """
    login_throttle_check(_client_ip(request))  # reuse throttle to slow abuse
    user = get_user_by_username(payload.username.strip().lower())
    if user:
        raw = _secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(raw.encode()).digest()
        store_reset_token(token_hash, user["id"],
                          int(_time.time()) + PASSWORD_RESET_TTL)
        print(f"[password-reset] user={user['username']} token={raw} "
              f"(expires in {PASSWORD_RESET_TTL // 60} min)")
    return {"ok": True,
            "message": "If that account exists, a reset token has been sent."}


@app.post("/api/password-reset/confirm")
def confirm_password_reset(payload: ResetConfirmPayload):
    token_hash = hashlib.sha256(payload.token.encode()).digest()
    user_id = consume_reset_token(token_hash)
    if not user_id:
        raise HTTPException(400, "Invalid or expired reset token.")
    try:
        digest, salt, iters = hash_password(payload.new_password)
    except ValueError as e:
        raise HTTPException(400, str(e))
    update_password(user_id, digest, salt, iters)
    return {"ok": True}


@app.get("/api/me")
def me(user: dict = Depends(current_user)):
    return {"username": user["sub"], "role": user["role"],
            "employee": user.get("employee")}


@app.get("/api/supervisor/workers")
def list_my_workers(user: dict = Depends(require_supervisor)):
    return list_workers_for_manager(user["uid"])


@app.post("/api/supervisor/workers", status_code=201)
def add_worker(req: CreateWorkerRequest,
               user: dict = Depends(require_supervisor)):
    uname = req.username.strip().lower()
    employee = req.employee.strip()
    if len(uname) < 3 or not uname.replace("_", "").isalnum():
        raise HTTPException(400, "Username must be 3+ chars, alphanumeric/underscore.")
    if not employee:
        raise HTTPException(400, "Display name is required.")
    if get_user_by_username(uname):
        raise HTTPException(409, "Username already taken.")
    try:
        digest, salt, iters = hash_password(req.password)
    except ValueError as e:
        raise HTTPException(400, str(e))
    uid = create_user(uname, digest, salt, iters, "worker", employee,
                      manager_id=user["uid"])
    if employee not in EMPLOYEES:
        EMPLOYEES.append(employee)
        EMPLOYEES_FILE.write_text(json.dumps(EMPLOYEES, indent=2))
    return {"id": uid, "username": uname, "employee": employee}


def _team_employees(user: dict) -> list[str]:
    """Display names of the supervisor's direct reports."""
    return employees_for_manager(user["uid"])


@app.get("/api/employees")
def get_employees(user: dict = Depends(current_user)):
    # Supervisors get only their own team; workers get the full roster
    # for any UI that needs it (currently none, but keep the contract).
    if user["role"] == "supervisor":
        return _team_employees(user)
    return EMPLOYEES


@app.get("/api/tasks")
def list_tasks(status: Optional[Status] = None,
               assignee: Optional[str] = None,
               user: dict = Depends(current_user)):
    items = list(STATE["tasks"].values())
    if user["role"] == "worker":
        items = [t for t in items if t["assignee"] == user.get("employee")]
    else:  # supervisor: only tasks for their team
        team = set(_team_employees(user))
        items = [t for t in items if t["assignee"] in team]
        if assignee:
            items = [t for t in items if t["assignee"] == assignee]
    if status:
        items = [t for t in items if t["status"] == status]
    items.sort(key=lambda t: t["created_at"], reverse=True)
    return items


@app.get("/api/tasks/{task_id}")
def get_task(task_id: str, user: dict = Depends(current_user)):
    if task_id not in STATE["tasks"]:
        raise HTTPException(404, "Task not found")
    t = STATE["tasks"][task_id]
    if user["role"] == "worker" and t["assignee"] != user.get("employee"):
        raise HTTPException(403, "Not your task")
    return t


@app.patch("/api/tasks/{task_id}")
def update_task(task_id: str, payload: TaskUpdate,
                user: dict = Depends(require_supervisor)):
    if task_id not in STATE["tasks"]:
        raise HTTPException(404, "Task not found")
    t = STATE["tasks"][task_id]
    team = set(_team_employees(user))
    if t["assignee"] not in team:
        raise HTTPException(403, "Not your team's task")
    data = payload.model_dump(exclude_unset=True)
    if "assignee" in data and data["assignee"] not in team:
        raise HTTPException(400, "Assignee must be on your team")
    t.update(data)
    save_state()
    return t


@app.post("/api/tasks/{task_id}/start")
def start_task(task_id: str, user: dict = Depends(require_worker)):
    t = STATE["tasks"].get(task_id)
    if not t:
        raise HTTPException(404, "Task not found")
    if t["assignee"] != user.get("employee"):
        raise HTTPException(403, "Not your task")
    if t["status"] != "pending":
        raise HTTPException(400, f"Cannot start from status {t['status']}")
    t["status"] = "in_progress"
    t["started_at"] = datetime.utcnow().isoformat()
    save_state()
    return t


@app.post("/api/tasks/{task_id}/submit")
def submit_task(task_id: str, user: dict = Depends(require_worker)):
    t = STATE["tasks"].get(task_id)
    if not t:
        raise HTTPException(404, "Task not found")
    if t["assignee"] != user.get("employee"):
        raise HTTPException(403, "Not your task")
    if t["status"] != "in_progress":
        raise HTTPException(400, f"Cannot submit from status {t['status']}")
    t["status"] = "submitted"
    t["submitted_at"] = datetime.utcnow().isoformat()
    save_state()
    return t


@app.post("/api/tasks/{task_id}/approve")
def approve_task(task_id: str, user: dict = Depends(require_supervisor)):
    t = STATE["tasks"].get(task_id)
    if not t:
        raise HTTPException(404, "Task not found")
    if t["assignee"] not in set(_team_employees(user)):
        raise HTTPException(403, "Not your team's task")
    if t["status"] != "submitted":
        raise HTTPException(400, f"Cannot approve from status {t['status']}")
    t["status"] = "approved"
    t["approved_at"] = datetime.utcnow().isoformat()
    save_state()
    return t


@app.post("/api/ingest")
def force_ingest(user: dict = Depends(require_supervisor)):
    return {"added": ingest_inbox()}


@app.get("/api/stats")
def stats(user: dict = Depends(require_supervisor)):
    team = _team_employees(user)
    team_set = set(team)
    by_status: dict[str, int] = {}
    by_assignee: dict[str, dict[str, int]] = {e: {} for e in team}
    total = 0
    for t in STATE["tasks"].values():
        if t["assignee"] not in team_set:
            continue
        total += 1
        by_status[t["status"]] = by_status.get(t["status"], 0) + 1
        a = by_assignee.setdefault(t["assignee"], {})
        a[t["status"]] = a.get(t["status"], 0) + 1
    return {"by_status": by_status, "by_assignee": by_assignee, "total": total}
