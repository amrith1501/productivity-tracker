import { useEffect, useState } from 'react';
import { api } from './api';
import StatusBadge from './StatusBadge.jsx';

export default function WorkerView({ worker }) {
  const [tasks, setTasks] = useState([]);

  const refresh = async () => {
    if (!worker) return;
    setTasks(await api.tasks());
  };

  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 4000);
    return () => clearInterval(i);
  }, [worker]);

  const action = async (fn) => { await fn(); refresh(); };

  const groups = {
    pending: tasks.filter((t) => t.status === 'pending'),
    in_progress: tasks.filter((t) => t.status === 'in_progress'),
    submitted: tasks.filter((t) => t.status === 'submitted'),
    approved: tasks.filter((t) => t.status === 'approved'),
  };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl shadow-sm border p-5">
        <div className="text-sm text-slate-500">Signed in as</div>
        <div className="text-2xl font-bold">{worker || '—'}</div>
        <div className="text-sm text-slate-500 mt-1">
          {tasks.length} task{tasks.length === 1 ? '' : 's'} assigned ·
          {' '}{groups.in_progress.length} in progress ·
          {' '}{groups.approved.length} approved
        </div>
      </div>

      <Column title="To do" tasks={groups.pending} color="slate"
        action={(t) => (
          <button
            onClick={() => action(() => api.start(t.id))}
            className="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-sm"
          >Start</button>
        )} />
      <Column title="In progress" tasks={groups.in_progress} color="amber"
        action={(t) => (
          <button
            onClick={() => action(() => api.submit(t.id))}
            className="px-3 py-1.5 rounded-md bg-blue-600 text-white text-sm"
          >Submit</button>
        )} />
      <Column title="Awaiting approval" tasks={groups.submitted} color="blue"
        action={() => <span className="text-xs text-slate-500">waiting for supervisor</span>} />
      <Column title="Approved" tasks={groups.approved} color="emerald" action={() => null} />
    </div>
  );
}

function Column({ title, tasks, action, color }) {
  const borderMap = {
    slate: 'border-slate-300', amber: 'border-amber-400',
    blue: 'border-blue-400', emerald: 'border-emerald-400',
  };
  return (
    <div>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 mb-2">
        {title} <span className="text-slate-400">({tasks.length})</span>
      </h2>
      <div className="space-y-2">
        {tasks.length === 0 && (
          <div className="text-sm text-slate-400 italic px-3">Nothing here.</div>
        )}
        {tasks.map((t) => (
          <div key={t.id}
            className={`bg-white rounded-lg shadow-sm border-l-4 ${borderMap[color]} p-4 flex justify-between gap-4`}>
            <div>
              <div className="font-medium">{t.title}</div>
              {t.description && <div className="text-sm text-slate-500 mt-0.5">{t.description}</div>}
              <div className="mt-2"><StatusBadge status={t.status} /></div>
            </div>
            <div className="flex-shrink-0 self-center">{action(t)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
