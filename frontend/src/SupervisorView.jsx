import { useEffect, useState } from 'react';
import { api } from './api';
import StatusBadge from './StatusBadge.jsx';
import WorkerProductivityCharts from './WorkerProductivityCharts.jsx';

export default function SupervisorView({ employees: initialEmployees }) {
  const [employees, setEmployees] = useState(initialEmployees || []);
  const [tasks, setTasks] = useState([]);          // recent (last 10 days)
  const [historyTasks, setHistoryTasks] = useState([]);  // full history for charts
  const [filter, setFilter] = useState('all');
  const [editing, setEditing] = useState(null);
  const [workers, setWorkers] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [bulkDelete, setBulkDelete] = useState(null);
  const [importPath, setImportPath] = useState('');
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState(null);
  const [tab, setTab] = useState('tasks');

  // Tasks change second-by-second as workers start/submit/approve, so we
  // keep this poll on a tight loop.
  const refreshTasks = async () => {
    setTasks(await api.tasks());
  };

  // Full history powers the monthly/yearly line charts; only worth
  // refreshing while the Productivity tab is visible.
  const refreshHistory = async () => {
    setHistoryTasks(await api.tasks({ all: true }));
  };

  // The team roster rarely changes — fetch on mount and again whenever an
  // action mutates it (add/remove worker, import directory, etc.).
  const refreshTeam = async () => {
    const [w, e] = await Promise.all([api.listWorkers(), api.employees()]);
    setWorkers(w);
    setEmployees(e);
  };

  const refresh = async () => {
    await Promise.all([
      refreshTasks(),
      tab === 'productivity' ? refreshHistory() : Promise.resolve(),
      refreshTeam(),
    ]);
  };

  // Stat cards reflect the same 10-day window as the table, computed
  // client-side so we don't need to round-trip a separate endpoint.
  const stats = (() => {
    const by_status = {};
    for (const t of tasks) {
      by_status[t.status] = (by_status[t.status] || 0) + 1;
    }
    return { total: tasks.length, by_status };
  })();

  // Initial load: fetch everything once.
  useEffect(() => {
    refreshTasks();
    refreshHistory();
    refreshTeam();
  }, []);

  // Tight poll for the live task table.
  useEffect(() => {
    const i = setInterval(refreshTasks, 4000);
    return () => clearInterval(i);
  }, []);

  // Keep the full history fresh while the Productivity or Export tab is
  // visible (both read from it).
  useEffect(() => {
    if (tab !== 'productivity' && tab !== 'export') return undefined;
    refreshHistory();
    const i = setInterval(refreshHistory, 4000);
    return () => clearInterval(i);
  }, [tab]);

  const filtered = filter === 'all' ? tasks : tasks.filter((t) => t.status === filter);

  const approve = async (id) => {
    await api.approve(id);
    refresh();
  };

  const runImport = async () => {
    const path = importPath.trim();
    if (!path) {
      setImportMsg({ ok: false, text: 'Enter a directory path first.' });
      return;
    }
    setImporting(true);
    setImportMsg(null);
    try {
      const res = await api.importDirectory(path);
      const parts = [
        `Imported ${res.added} task${res.added === 1 ? '' : 's'}`,
        `from ${res.scanned} file${res.scanned === 1 ? '' : 's'}`,
      ];
      if (res.duplicates) {
        parts.push(`${res.duplicates} existing task${res.duplicates === 1 ? '' : 's'} skipped`);
      }
      if (res.errors?.length) parts.push(`${res.errors.length} error(s)`);
      setImportMsg({
        ok: true,
        text: parts.join(' · '),
        errors: res.errors || [],
      });
      refresh();
    } catch (e) {
      setImportMsg({ ok: false, text: e.message });
    } finally {
      setImporting(false);
    }
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

  const deleteEdit = async () => {
    await api.deleteTask(editing.id);
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

      <div className="border-b border-slate-200">
        <nav className="-mb-px flex gap-6">
          <TabButton active={tab === 'tasks'} onClick={() => setTab('tasks')}>
            Tasks
          </TabButton>
          <TabButton active={tab === 'productivity'} onClick={() => setTab('productivity')}>
            Productivity
          </TabButton>
          <TabButton active={tab === 'export'} onClick={() => setTab('export')}>
            Export
          </TabButton>
        </nav>
      </div>

      {tab === 'export' ? (
        <ExportBar tasks={historyTasks} employees={employees} />
      ) : tab === 'productivity' ? (
        <WorkerProductivityCharts workers={workers} tasks={historyTasks} />
      ) : (
        <TasksTab
          workers={workers}
          employees={employees}
          tasks={tasks}
          filtered={filtered}
          filter={filter}
          setFilter={setFilter}
          setShowAdd={setShowAdd}
          setRemoving={setRemoving}
          setBulkDelete={setBulkDelete}
          setEditing={setEditing}
          approve={approve}
          refresh={refresh}
          importPath={importPath}
          setImportPath={setImportPath}
          importing={importing}
          importMsg={importMsg}
          runImport={runImport}
        />
      )}

      {showAdd && (
        <AddWorkerModal
          onClose={() => setShowAdd(false)}
          onCreated={() => { setShowAdd(false); refresh(); }}
        />
      )}

      {removing && (
        <RemoveWorkerModal
          worker={removing}
          teamSize={workers.length}
          onClose={() => setRemoving(null)}
          onRemoved={() => { setRemoving(null); refresh(); }}
        />
      )}

      {bulkDelete && (
        <DeleteTasksModal
          scope={bulkDelete.scope}
          count={filtered.length}
          onClose={() => setBulkDelete(null)}
          onDeleted={() => { setBulkDelete(null); refresh(); }}
        />
      )}

      {editing && (
        <EditTaskModal
          editing={editing}
          setEditing={setEditing}
          employees={employees}
          onSave={saveEdit}
          onDelete={deleteEdit}
        />
      )}
    </div>
  );
}

function Spinner({ className = 'h-4 w-4' }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none"
         aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25"
              strokeWidth="4" />
      <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4"
            strokeLinecap="round" />
    </svg>
  );
}

function ExportBar({ tasks = [], employees = [] }) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const invalidRange = start && end && start > end;
  // The preview is only meaningful once a full range is chosen.
  const rangeSelected = Boolean(start && end && !invalidRange);

  // Preview mirrors the backend export: filter by the task's creation date
  // (date portion only), inclusive of both bounds.
  const filtered = invalidRange ? [] : tasks.filter((t) => {
    const day = (t.created_at || '').slice(0, 10);
    if (!day) return false;
    if (start && day < start) return false;
    if (end && day > end) return false;
    return true;
  });

  const summary = (() => {
    const rows = {};
    for (const e of employees) {
      rows[e] = { total: 0, pending: 0, in_progress: 0, submitted: 0, approved: 0 };
    }
    for (const t of filtered) {
      const r = rows[t.assignee] || (rows[t.assignee] = {
        total: 0, pending: 0, in_progress: 0, submitted: 0, approved: 0,
      });
      r.total += 1;
      r[t.status] = (r[t.status] || 0) + 1;
    }
    return Object.entries(rows)
      .map(([employee, r]) => ({
        employee, ...r,
        rate: r.total ? Math.round((r.approved / r.total) * 100) : null,
      }))
      .sort((a, b) => a.employee.localeCompare(b.employee));
  })();

  const PREVIEW_LIMIT = 50;

  const download = async () => {
    setErr('');
    if (invalidRange) {
      setErr('Start date must be on or before end date.');
      return;
    }
    setBusy(true);
    try {
      await api.exportTasks(start, end);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl shadow-sm border p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <div className="text-sm font-semibold text-slate-600">Export to Excel</div>
            <div className="text-xs text-slate-400">
              Tasks + productivity summary for a date range (by task creation date).
            </div>
          </div>
          <div className="flex items-end gap-3 ml-auto flex-wrap">
            <label className="text-xs text-slate-500">
              <span className="block mb-1">From</span>
              <input
                type="date"
                value={start}
                max={end || undefined}
                onChange={(e) => setStart(e.target.value)}
                className="border rounded-md p-2 text-sm"
              />
            </label>
            <label className="text-xs text-slate-500">
              <span className="block mb-1">To</span>
              <input
                type="date"
                value={end}
                min={start || undefined}
                onChange={(e) => setEnd(e.target.value)}
                className="border rounded-md p-2 text-sm"
              />
            </label>
            {(start || end) && (
              <button
                onClick={() => { setStart(''); setEnd(''); setErr(''); }}
                className="px-3 py-2 rounded-md text-sm border text-slate-600 hover:bg-slate-50"
              >
                Clear
              </button>
            )}
            <button
              onClick={download}
              disabled={busy || !rangeSelected || filtered.length === 0}
              className="px-4 py-2 rounded-md text-sm bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-2"
            >
              {busy && <Spinner />}
              {busy ? 'Preparing…' : 'Download Excel'}
            </button>
          </div>
        </div>
        <div className="text-xs text-slate-500 mt-2">
          {invalidRange
            ? <span className="text-red-600">Start date must be on or before end date.</span>
            : rangeSelected
              ? <>
                  <span className="font-semibold text-slate-700">{filtered.length}</span>
                  {' '}task{filtered.length === 1 ? '' : 's'} match{filtered.length === 1 ? 'es' : ''}
                  {' '}{start} → {end}
                </>
              : <span>Select a start and end date to preview what will be exported.</span>}
        </div>
        {err && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md p-2 mt-3">
            {err}
          </div>
        )}
      </div>

      {rangeSelected && filtered.length > 0 && (
        <>
          <div className="bg-white rounded-xl shadow-sm border p-4">
            <h3 className="font-semibold text-sm text-slate-600 mb-3">
              Productivity preview
              <span className="text-slate-400 font-normal"> · “Productivity” sheet</span>
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-slate-500 text-left border-b">
                  <tr>
                    <th className="py-1.5 pr-3">Employee</th>
                    <th className="py-1.5 px-2 text-right">Total</th>
                    <th className="py-1.5 px-2 text-right">Pending</th>
                    <th className="py-1.5 px-2 text-right">In progress</th>
                    <th className="py-1.5 px-2 text-right">Submitted</th>
                    <th className="py-1.5 px-2 text-right">Approved</th>
                    <th className="py-1.5 pl-2 text-right">Completion</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.map((r) => (
                    <tr key={r.employee} className="border-b last:border-b-0">
                      <td className="py-1.5 pr-3">{r.employee}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums">{r.total}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums">{r.pending}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums">{r.in_progress}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums">{r.submitted}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums">{r.approved}</td>
                      <td className="py-1.5 pl-2 text-right tabular-nums">
                        {r.rate === null ? '—' : `${r.rate}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
            <div className="p-4 pb-2 flex items-center justify-between">
              <h3 className="font-semibold text-sm text-slate-600">
                Tasks preview
                <span className="text-slate-400 font-normal"> · “Tasks” sheet</span>
              </h3>
              <span className="text-xs text-slate-400">
                {filtered.length > PREVIEW_LIMIT
                  ? `showing first ${PREVIEW_LIMIT} of ${filtered.length}`
                  : `${filtered.length} row${filtered.length === 1 ? '' : 's'}`}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600 text-left">
                  <tr>
                    <th className="p-3">Task ID</th>
                    <th className="p-3">Title</th>
                    <th className="p-3">Assignee</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, PREVIEW_LIMIT).map((t) => (
                    <tr key={t.id} className="border-t">
                      <td className="p-3 text-xs font-mono text-slate-500">
                        {t.external_id || '—'}
                      </td>
                      <td className="p-3">{t.title}</td>
                      <td className="p-3">{t.assignee}</td>
                      <td className="p-3"><StatusBadge status={t.status} /></td>
                      <td className="p-3 text-xs text-slate-500">
                        {(t.created_at || '').slice(0, 10)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`py-2 px-1 border-b-2 font-medium text-sm transition-colors ${
        active
          ? 'border-indigo-500 text-indigo-600'
          : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
      }`}
    >
      {children}
    </button>
  );
}

function TasksTab({
  workers, employees, tasks, filtered, filter, setFilter,
  setShowAdd, setRemoving, setBulkDelete, setEditing,
  approve, refresh, importPath, setImportPath, importing, importMsg, runImport,
}) {
  const [rescanning, setRescanning] = useState(false);

  const rescan = async () => {
    if (rescanning) return;
    setRescanning(true);
    try {
      await api.ingest();
      await refresh();
    } finally {
      setRescanning(false);
    }
  };

  return (
    <div className="space-y-6">
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
                <th className="py-1 text-right">Actions</th>
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
                  <td className="py-1.5 text-right">
                    <button
                      onClick={() => setRemoving(w)}
                      className="px-2 py-1 rounded text-xs text-red-700 border border-red-200 hover:bg-red-50"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="bg-white rounded-xl shadow-sm border p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold text-sm text-slate-600">
            Import tasks from a directory
          </h3>
          <span className="text-xs text-slate-400">
            Round-robin across your team ({employees.length} worker{employees.length === 1 ? '' : 's'})
          </span>
        </div>
        <p className="text-xs text-slate-500 mb-3">
          Provide a folder path on the server. All <code>.json</code>,
          {' '}<code>.txt</code>, and <code>.csv</code> files inside are parsed and
          the resulting tasks are added to your team. CSV rows can use the columns
          {' '}<code>Task ID</code>, <code>Task Name</code>, <code>Description</code>,
          {' '}and <code>Assigned Employee_ID</code> (username or display name) — when
          that column is filled the task goes straight to that worker; blank rows
          are auto-divided evenly across your team. Existing tasks are skipped,
          but deleted tasks can be imported again from the same file. A ready-made
          example lives in <code>samples/sample_tasks.csv</code>.
        </p>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            value={importPath}
            onChange={(e) => setImportPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runImport(); }}
            placeholder="e.g. C:\Users\me\Desktop\tasks  or  /home/me/tasks"
            className="flex-1 border rounded-md p-2 text-sm font-mono"
            disabled={importing}
          />
          <button
            onClick={runImport}
            disabled={importing || employees.length === 0}
            className="px-4 py-2 rounded-md text-sm bg-[#0a1f44] text-white hover:bg-[#13294b] disabled:opacity-50"
          >
            {importing ? 'Importing…' : 'Import'}
          </button>
        </div>
        {employees.length === 0 && (
          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-2 mt-3">
            Add at least one worker to your team before importing tasks.
          </div>
        )}
        {importMsg && (
          <div
            className={`text-sm rounded-md p-2 mt-3 border ${
              importMsg.ok
                ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                : 'bg-red-50 text-red-800 border-red-200'
            }`}
          >
            <div>{importMsg.text}</div>
            {importMsg.errors?.length > 0 && (
              <ul className="mt-1 text-xs list-disc pl-5 text-red-700">
                {importMsg.errors.map((err, i) => <li key={i}>{err}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>

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
          onClick={rescan}
          disabled={rescanning}
          className="ml-auto px-3 py-1.5 rounded-md text-sm bg-slate-800 text-white hover:bg-slate-900 disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-2"
        >
          {rescanning && <Spinner />}
          {rescanning ? 'Rescanning…' : 'Rescan inbox'}
        </button>
        <button
          onClick={() => setBulkDelete({ scope: filter })}
          disabled={filtered.length === 0}
          className="px-3 py-1.5 rounded-md text-sm bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
        >
          Delete {filter === 'all' ? 'all' : filter.replace('_', ' ')}
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 text-left">
            <tr>
              <th className="p-3">Task ID</th>
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
                <td className="p-3 text-xs font-mono text-slate-500">
                  {t.external_id || '—'}
                </td>
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
              <tr><td colSpan="6" className="p-6 text-center text-slate-400">No tasks</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EditTaskModal({ editing, setEditing, employees, onSave, onDelete }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const runDelete = async () => {
    setErr('');
    setBusy(true);
    try {
      await onDelete();
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };

  return (
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
        {err && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md p-2">
            {err}
          </div>
        )}
        {confirmDelete ? (
          <div className="bg-red-50 border border-red-200 rounded-md p-3 space-y-2">
            <div className="text-sm text-red-800">
              Delete this task permanently? This cannot be undone.
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(false)}
                disabled={busy}
                className="px-3 py-1.5 rounded-md border text-sm"
              >
                Keep
              </button>
              <button
                onClick={runDelete}
                disabled={busy}
                className="px-3 py-1.5 rounded-md bg-red-600 text-white text-sm inline-flex items-center gap-2 disabled:opacity-50"
              >
                {busy && <Spinner />}
                {busy ? 'Deleting…' : 'Delete task'}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center pt-2">
            <button
              onClick={() => setConfirmDelete(true)}
              className="px-3 py-1.5 rounded-md text-sm text-red-700 border border-red-200 hover:bg-red-50"
            >
              Delete
            </button>
            <div className="flex justify-end gap-2 ml-auto">
              <button onClick={() => setEditing(null)} className="px-3 py-1.5 rounded-md border">Cancel</button>
              <button onClick={onSave} className="px-3 py-1.5 rounded-md bg-indigo-600 text-white">Save</button>
            </div>
          </div>
        )}
      </div>
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

function RemoveWorkerModal({ worker, teamSize, onClose, onRemoved }) {
  const lastOnTeam = teamSize <= 1;
  const [mode, setMode] = useState(lastOnTeam ? 'delete' : 'reassign');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    setErr('');
    setBusy(true);
    try {
      await api.removeWorker(worker.id, { deleteTasks: mode === 'delete' });
      onRemoved();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-10">
      <div className="bg-white rounded-xl p-6 w-full max-w-md space-y-3 shadow-xl">
        <h3 className="font-semibold text-lg">Remove worker</h3>
        <p className="text-sm text-slate-600">
          This deactivates <strong>{worker.employee}</strong>{' '}
          <span className="text-slate-400">({worker.username})</span>. They will
          no longer be able to sign in or appear on your team. Completed task
          history is preserved.
        </p>
        <div className="text-xs font-medium text-slate-600 pt-2">
          What should happen to their open tasks?
        </div>
        <label className={`flex items-start gap-2 border rounded-md p-2 text-sm cursor-pointer
          ${mode === 'reassign' ? 'border-indigo-400 bg-indigo-50' : ''}
          ${lastOnTeam ? 'opacity-50 cursor-not-allowed' : ''}`}>
          <input
            type="radio"
            checked={mode === 'reassign'}
            disabled={lastOnTeam}
            onChange={() => setMode('reassign')}
            className="mt-1"
          />
          <div>
            <div className="font-medium">Reassign to the rest of the team</div>
            <div className="text-xs text-slate-500">
              Open tasks are reset to <em>pending</em> and split round-robin
              across remaining workers.
              {lastOnTeam && ' Disabled — no other workers on your team.'}
            </div>
          </div>
        </label>
        <label className={`flex items-start gap-2 border rounded-md p-2 text-sm cursor-pointer
          ${mode === 'delete' ? 'border-red-400 bg-red-50' : ''}`}>
          <input
            type="radio"
            checked={mode === 'delete'}
            onChange={() => setMode('delete')}
            className="mt-1"
          />
          <div>
            <div className="font-medium">Delete their open tasks</div>
            <div className="text-xs text-slate-500">
              Pending, in-progress, and submitted tasks assigned to this worker
              are removed permanently. Approved tasks are kept.
            </div>
          </div>
        </label>
        {err && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md p-2">
            {err}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md border">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
          >
            {busy ? 'Removing…' : 'Remove worker'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteTasksModal({ scope, count, onClose, onDeleted }) {
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const scopeLabel = scope === 'all' ? 'all team tasks' : `${scope.replace('_', ' ')} tasks`;
  const required = scope === 'all' ? 'DELETE' : null;
  const canSubmit = required ? confirm.trim().toUpperCase() === required : true;

  const submit = async () => {
    setErr('');
    setBusy(true);
    try {
      await api.deleteAllTasks(scope === 'all' ? {} : { status: scope });
      onDeleted();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-10">
      <div className="bg-white rounded-xl p-6 w-full max-w-md space-y-3 shadow-xl">
        <h3 className="font-semibold text-lg text-red-700">Delete {scopeLabel}</h3>
        <p className="text-sm text-slate-600">
          This permanently deletes <strong>{count}</strong> task{count === 1 ? '' : 's'}
          {' '}assigned to your team{scope === 'all' ? '' : ` with status “${scope.replace('_', ' ')}”`}.
          This cannot be undone.
        </p>
        {required && (
          <div>
            <label className="text-xs font-medium text-slate-600">
              Type <code className="font-mono">{required}</code> to confirm
            </label>
            <input
              autoFocus
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-full border rounded-md p-2 mt-1 font-mono"
            />
          </div>
        )}
        {err && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md p-2">
            {err}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md border">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || !canSubmit}
            className="px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
          >
            {busy ? 'Deleting…' : `Delete ${count} task${count === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
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
