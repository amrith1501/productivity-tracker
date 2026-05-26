import { useEffect, useState } from 'react';
import { api } from './api';
import StatusBadge from './StatusBadge.jsx';

export default function SupervisorView({ employees: initialEmployees }) {
  const [employees, setEmployees] = useState(initialEmployees || []);
  const [tasks, setTasks] = useState([]);
  const [stats, setStats] = useState(null);
  const [filter, setFilter] = useState('all');
  const [editing, setEditing] = useState(null);
  const [workers, setWorkers] = useState([]);
  const [showAdd, setShowAdd] = useState(false);

  const refresh = async () => {
    const [t, s, w, e] = await Promise.all([
      api.tasks(), api.stats(), api.listWorkers(), api.employees(),
    ]);
    setTasks(t); setStats(s); setWorkers(w); setEmployees(e);
  };

  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 4000);
    return () => clearInterval(i);
  }, []);

  const filtered = filter === 'all' ? tasks : tasks.filter((t) => t.status === filter);

  const approve = async (id) => {
    await api.approve(id);
    refresh();
  };

  const saveEdit = async () => {
    await api.updateTask(editing.id, {
      title: editing.title,
      description: editing.description,
      assignee: editing.assignee,
      status: editing.status,
    });
    setEditing(null);
    refresh();
  };

  return (
    <div className="space-y-6">
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <StatCard label="Total" value={stats.total} color="indigo" />
          <StatCard label="Pending" value={stats.by_status.pending || 0} color="slate" />
          <StatCard label="In progress" value={stats.by_status.in_progress || 0} color="amber" />
          <StatCard label="Submitted" value={stats.by_status.submitted || 0} color="blue" />
          <StatCard label="Approved" value={stats.by_status.approved || 0} color="emerald" />
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border p-4">
        <h3 className="font-semibold mb-2 text-sm text-slate-600">Workload per employee</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {employees.map((e) => {
            const b = stats?.by_assignee[e] || {};
            const total = Object.values(b).reduce((a, c) => a + c, 0);
            return (
              <div key={e} className="border rounded-lg p-3">
                <div className="font-medium">{e}</div>
                <div className="text-xs text-slate-500">{total} total</div>
                <div className="mt-2 text-xs space-x-2">
                  <span>P:{b.pending || 0}</span>
                  <span>I:{b.in_progress || 0}</span>
                  <span>S:{b.submitted || 0}</span>
                  <span>A:{b.approved || 0}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-sm text-slate-600">
            My team <span className="text-slate-400">({workers.length})</span>
          </h3>
          <button
            onClick={() => setShowAdd(true)}
            className="px-3 py-1.5 rounded-md text-sm bg-[#0a1f44] text-white hover:bg-[#13294b]"
          >
            + Add worker
          </button>
        </div>
        {workers.length === 0 ? (
          <p className="text-sm text-slate-400 italic">
            No workers yet. Click “Add worker” to create one.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-slate-500 text-left">
              <tr>
                <th className="py-1">Display name</th>
                <th className="py-1">Username</th>
                <th className="py-1">Last login</th>
              </tr>
            </thead>
            <tbody>
              {workers.map((w) => (
                <tr key={w.id} className="border-t">
                  <td className="py-1.5">{w.employee}</td>
                  <td className="py-1.5 text-slate-500">{w.username}</td>
                  <td className="py-1.5 text-slate-500 text-xs">
                    {w.last_login_at || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showAdd && (
        <AddWorkerModal
          onClose={() => setShowAdd(false)}
          onCreated={() => { setShowAdd(false); refresh(); }}
        />
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {['all', 'pending', 'in_progress', 'submitted', 'approved'].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-md text-sm border ${
              filter === f ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white'
            }`}
          >
            {f.replace('_', ' ')}
          </button>
        ))}
        <button
          onClick={async () => { await api.ingest(); refresh(); }}
          className="ml-auto px-3 py-1.5 rounded-md text-sm bg-slate-800 text-white"
        >
          Rescan inbox
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 text-left">
            <tr>
              <th className="p-3">Title</th>
              <th className="p-3">Assignee</th>
              <th className="p-3">Status</th>
              <th className="p-3">Source</th>
              <th className="p-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((t) => (
              <tr key={t.id} className="border-t hover:bg-slate-50">
                <td className="p-3">
                  <div className="font-medium">{t.title}</div>
                  {t.description && <div className="text-xs text-slate-500">{t.description}</div>}
                </td>
                <td className="p-3">{t.assignee}</td>
                <td className="p-3"><StatusBadge status={t.status} /></td>
                <td className="p-3 text-xs text-slate-500">{t.source_file}</td>
                <td className="p-3 text-right space-x-2">
                  {t.status === 'submitted' && (
                    <button
                      onClick={() => approve(t.id)}
                      className="px-2 py-1 rounded bg-emerald-600 text-white text-xs"
                    >
                      Approve
                    </button>
                  )}
                  <button
                    onClick={() => setEditing({ ...t })}
                    className="px-2 py-1 rounded bg-white border text-xs"
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan="5" className="p-6 text-center text-slate-400">No tasks</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-10">
          <div className="bg-white rounded-xl p-6 w-full max-w-md space-y-3 shadow-xl">
            <h3 className="font-semibold text-lg">Edit task</h3>
            <input
              className="w-full border rounded-md p-2"
              value={editing.title}
              onChange={(e) => setEditing({ ...editing, title: e.target.value })}
            />
            <textarea
              className="w-full border rounded-md p-2"
              rows="3"
              value={editing.description}
              onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            />
            <select
              className="w-full border rounded-md p-2"
              value={editing.assignee}
              onChange={(e) => setEditing({ ...editing, assignee: e.target.value })}
            >
              {employees.map((emp) => <option key={emp}>{emp}</option>)}
            </select>
            <select
              className="w-full border rounded-md p-2"
              value={editing.status}
              onChange={(e) => setEditing({ ...editing, status: e.target.value })}
            >
              {['pending', 'in_progress', 'submitted', 'approved'].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setEditing(null)} className="px-3 py-1.5 rounded-md border">Cancel</button>
              <button onClick={saveEdit} className="px-3 py-1.5 rounded-md bg-indigo-600 text-white">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AddWorkerModal({ onClose, onCreated }) {
  const [employee, setEmployee] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (password.length < 8) return setErr('Password must be at least 8 characters.');
    setBusy(true);
    try {
      await api.addWorker(username, password, employee);
      onCreated();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-10">
      <form onSubmit={submit}
        className="bg-white rounded-xl p-6 w-full max-w-md space-y-3 shadow-xl">
        <h3 className="font-semibold text-lg">Add a new worker</h3>
        <p className="text-xs text-slate-500">
          The worker will be assigned under you and receive tasks from the next intake cycle.
        </p>
        <div>
          <label className="text-xs font-medium text-slate-600">Display name</label>
          <input
            value={employee}
            onChange={(e) => setEmployee(e.target.value)}
            autoFocus
            className="w-full border rounded-md p-2 mt-1"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-600">Username</label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
            className="w-full border rounded-md p-2 mt-1"
          />
          <div className="text-xs text-slate-400 mt-1">
            3+ chars, letters / numbers / underscore.
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-slate-600">Temporary password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full border rounded-md p-2 mt-1"
          />
          <div className="text-xs text-slate-400 mt-1">
            At least 8 characters. Share securely; the worker can change it later via Forgot password.
          </div>
        </div>
        {err && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md p-2">
            {err}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose}
            className="px-3 py-1.5 rounded-md border">Cancel</button>
          <button disabled={busy}
            className="px-3 py-1.5 rounded-md bg-[#0a1f44] hover:bg-[#13294b] text-white disabled:opacity-50">
            {busy ? 'Creating…' : 'Create worker'}
          </button>
        </div>
      </form>
    </div>
  );
}

function StatCard({ label, value, color }) {
  const map = {
    indigo: 'border-indigo-200 text-indigo-700',
    slate: 'border-slate-200 text-slate-700',
    amber: 'border-amber-200 text-amber-700',
    blue: 'border-blue-200 text-blue-700',
    emerald: 'border-emerald-200 text-emerald-700',
  };
  return (
    <div className={`bg-white rounded-xl shadow-sm border-l-4 ${map[color]} p-3`}>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}
