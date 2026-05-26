const BASE = '/api';

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  if (res.status === 401) {
    window.dispatchEvent(new Event('pt-logout'));
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  login: (username, password) =>
    req('/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  register: (username, password, employee) =>
    req('/register', { method: 'POST',
      body: JSON.stringify({ username, password, employee }) }),
  requestReset: (username) =>
    req('/password-reset/request', { method: 'POST',
      body: JSON.stringify({ username }) }),
  confirmReset: (token, new_password) =>
    req('/password-reset/confirm', { method: 'POST',
      body: JSON.stringify({ token, new_password }) }),
  logout: () => req('/logout', { method: 'POST' }),
  me: () => req('/me'),
  employees: () => req('/employees'),
  tasks: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return req('/tasks' + (q ? `?${q}` : ''));
  },
  stats: () => req('/stats'),
  updateTask: (id, body) =>
    req(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  start: (id) => req(`/tasks/${id}/start`, { method: 'POST' }),
  submit: (id) => req(`/tasks/${id}/submit`, { method: 'POST' }),
  approve: (id) => req(`/tasks/${id}/approve`, { method: 'POST' }),
  ingest: () => req('/ingest', { method: 'POST' }),
  listWorkers: () => req('/supervisor/workers'),
  addWorker: (username, password, employee) =>
    req('/supervisor/workers', { method: 'POST',
      body: JSON.stringify({ username, password, employee }) }),
};
