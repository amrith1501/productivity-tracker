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
  notifications: () => req('/notifications'),
  markNotificationsRead: (ids) =>
    req('/notifications/read', { method: 'POST',
      body: JSON.stringify({ ids: ids ?? null }) }),
  employees: () => req('/employees'),
  tasks: (params = {}) => {
    const normalized = {};
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === false) continue;
      normalized[k] = v === true ? 'true' : v;
    }
    const q = new URLSearchParams(normalized).toString();
    return req('/tasks' + (q ? `?${q}` : ''));
  },
  stats: () => req('/stats'),
  updateTask: (id, body) =>
    req(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteTask: (id) => req(`/tasks/${id}`, { method: 'DELETE' }),
  start: (id) => req(`/tasks/${id}/start`, { method: 'POST' }),
  submit: (id) => req(`/tasks/${id}/submit`, { method: 'POST' }),
  approve: (id) => req(`/tasks/${id}/approve`, { method: 'POST' }),
  ingest: () => req('/ingest', { method: 'POST' }),
  importDirectory: (path) =>
    req('/supervisor/import-directory', { method: 'POST',
      body: JSON.stringify({ path }) }),
  exportTasks: async (start, end) => {
    const params = {};
    if (start) params.start = start;
    if (end) params.end = end;
    const q = new URLSearchParams(params).toString();
    const res = await fetch(`${BASE}/supervisor/export${q ? `?${q}` : ''}`, {
      credentials: 'include',
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
    const blob = await res.blob();
    // Prefer the server-provided filename when present.
    const disp = res.headers.get('Content-Disposition') || '';
    const match = disp.match(/filename="?([^"]+)"?/);
    const filename = match ? match[1] : 'productivity_export.xlsx';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  listWorkers: () => req('/supervisor/workers'),
  addWorker: (username, password, employee) =>
    req('/supervisor/workers', { method: 'POST',
      body: JSON.stringify({ username, password, employee }) }),
  removeWorker: (id, { deleteTasks = false } = {}) =>
    req(`/supervisor/workers/${id}?delete_tasks=${deleteTasks ? 'true' : 'false'}`,
        { method: 'DELETE' }),
  deleteAllTasks: ({ status } = {}) => {
    const q = status ? `?status=${encodeURIComponent(status)}` : '';
    return req(`/tasks${q}`, { method: 'DELETE' });
  },
};
