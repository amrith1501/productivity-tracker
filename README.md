# Productivity Tracker

A continuous task-intake productivity tracker. Drop daily task files in
`backend/tasks_inbox/`; the backend assigns them round-robin across active
workers and routes each task to that worker's supervisor. Two role-based
views: **Supervisor** (edit + approve, productivity dashboard) and
**Worker** (start + submit).

## Architecture

- **Backend** — FastAPI + SQLite (`app.db`). Watches `tasks_inbox/` every
  5 s and persists all tasks, users, password resets, and ingestion
  bookkeeping into SQLite. Each task is owned by a single supervisor
  (`tasks.supervisor_id`), giving every supervisor an isolated view.
- **Frontend** — React + Vite + Tailwind. Polls the API every 4 s. The
  task table is scoped to the **last 10 days** by default
  (`GET /api/tasks`); the productivity charts use the full history via
  `GET /api/tasks?all=true`.

The first time the new backend starts, any legacy `backend/state.json`
is migrated into SQLite (tasks are attributed to the supervisor that
manages each task's assignee) and renamed to `state.json.migrated`.

## Running

### Backend

```powershell
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt

# Dev:
$env:PT_ENV="development"
python -m uvicorn main:app --reload --port 8000

# Prod (example):
$env:PT_ENV="production"
$env:PT_SECRET="$(python -c 'import secrets; print(secrets.token_urlsafe(48))')"
$env:PT_ALLOWED_ORIGINS="https://your.app"
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --proxy-headers
```

### Provisioning users

```powershell
python create_user.py --username boss   --role supervisor
python create_user.py --username alice  --role worker --employee Alice
```

Password is prompted interactively (or piped via `--password-stdin`).
Min 12 chars. Stored as PBKDF2-HMAC-SHA256 (600k iterations) + per-user salt
in `app.db` (SQLite).

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open <http://localhost:5173>.

## Adding tasks

Drop a file into `backend/tasks_inbox/`:

- `.json` — `{ "tasks": ["Task A", {"title": "Task B", "description": "..."}] }`
- `.txt`  — one task title per line

Each file is processed once (tracked by name in `state.json`). New files appear
automatically within 5 seconds.

## Configuring employees

Edit `backend/employees.json` (list of names). Restart the backend.

## Security model

- **Passwords**: PBKDF2-HMAC-SHA256, 600,000 iterations, 16-byte random
  salt per user. Constant-time verification.
- **Sessions**: HMAC-SHA256-signed tokens delivered as HttpOnly, Secure
  (in prod), SameSite=Strict cookies. Not readable from JS. 1h TTL by
  default (`PT_TOKEN_TTL`).
- **Signing key**: `PT_SECRET` env var (required in production).
- **Throttling**: 8 failed logins per IP per 5 minutes → 429.
- **Timing**: PBKDF2 is run even for unknown usernames so response times
  don't reveal which usernames exist.
- **CORS**: Restricted to `PT_ALLOWED_ORIGINS`, credentials required.
- **Authorization**: Workers can only list/act on their own tasks;
  supervisor-only endpoints are gated server-side.

If you put this behind a reverse proxy (nginx, Caddy, ALB), terminate TLS
there, forward `X-Forwarded-*` headers, and run uvicorn with
`--proxy-headers --forwarded-allow-ips=<proxy-ip>`.

## API

| Method | Path                          | Purpose                       |
|--------|-------------------------------|-------------------------------|
| POST   | `/api/login`                  | Issue session cookie          |
| POST   | `/api/logout`                 | Clear session cookie          |
| GET    | `/api/me`                     | Current user info             |
| GET    | `/api/employees`              | List employees                |
| GET    | `/api/tasks?assignee=&status=`| List tasks                    |
| GET    | `/api/stats`                  | Aggregate counts              |
| PATCH  | `/api/tasks/{id}`             | Supervisor: edit any field    |
| POST   | `/api/tasks/{id}/start`       | Worker: pending → in_progress |
| POST   | `/api/tasks/{id}/submit`      | Worker: in_progress → submitted |
| POST   | `/api/tasks/{id}/approve`     | Supervisor: submitted → approved |
| POST   | `/api/ingest`                 | Force inbox rescan            |
