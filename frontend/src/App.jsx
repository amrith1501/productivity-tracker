import { useEffect, useState } from 'react';
import { api } from './api';
import Login from './Login.jsx';
import SupervisorView from './SupervisorView.jsx';
import WorkerView from './WorkerView.jsx';
import NotificationBell from './NotificationBell.jsx';

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [employees, setEmployees] = useState([]);

  useEffect(() => {
    const handleLogout = () => setUser(null);
    window.addEventListener('pt-logout', handleLogout);
    return () => window.removeEventListener('pt-logout', handleLogout);
  }, []);

  useEffect(() => {
    api.me()
      .then((u) => setUser(u))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (user?.role === 'supervisor') {
      api.employees().then(setEmployees).catch(() => {});
    }
  }, [user]);

  const logout = async () => {
    try { await api.logout(); } catch {}
    setUser(null);
  };

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-slate-400">Loading…</div>;
  }

  if (!user) {
    return <Login onLogin={setUser} />;
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="bg-[#0a1f44] text-white shadow-md">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between flex-wrap gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Horizon Productivity Tracker</h1>
          <div className="flex items-center gap-3">
            <NotificationBell />
            <div className="text-right">
              <div className="text-sm font-medium">{user.employee || user.username}</div>
              <div className="text-xs text-slate-300 capitalize">{user.role}</div>
            </div>
            <button
              onClick={logout}
              className="px-3 py-1.5 rounded-md text-sm border border-white/20 bg-white/10 hover:bg-white/20 text-white transition"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6">
        {user.role === 'supervisor'
          ? <SupervisorView employees={employees} />
          : <WorkerView worker={user.employee} />}
      </main>
    </div>
  );
}
