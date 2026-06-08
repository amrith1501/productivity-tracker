import { useEffect, useRef, useState } from 'react';
import { api } from './api';

function timeAgo(iso) {
  if (!iso) return '';
  // SQLite datetime('now') returns UTC without a timezone marker; treat it
  // as UTC so the relative time is correct.
  const t = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z');
  const secs = Math.max(0, (Date.now() - t.getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const ICON = {
  task_assigned: '📋',
  task_submitted: '✅',
};

export default function NotificationBell() {
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const panelRef = useRef(null);
  const btnRef = useRef(null);

  const load = async () => {
    try {
      const res = await api.notifications();
      setItems(res.items || []);
      setUnread(res.unread || 0);
    } catch {
      // Ignore transient errors; the poll will retry.
    }
  };

  useEffect(() => {
    load();
    const i = setInterval(load, 5000);
    return () => clearInterval(i);
  }, []);

  // Close the panel when clicking outside of it.
  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => {
      if (panelRef.current?.contains(e.target)) return;
      if (btnRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    // Opening the panel marks everything read.
    if (next && unread > 0) {
      try {
        const res = await api.markNotificationsRead();
        setUnread(res.unread ?? 0);
        setItems((prev) => prev.map((n) => ({
          ...n, read_at: n.read_at || new Date().toISOString(),
        })));
      } catch {
        // Leave the badge as-is if the request fails.
      }
    }
  };

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={toggle}
        aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`}
        className="relative p-2 rounded-md hover:bg-white/10 transition"
      >
        <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
             strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1
                           rounded-full bg-red-500 text-white text-[11px] font-bold
                           flex items-center justify-center leading-none">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 mt-2 w-80 max-w-[90vw] bg-white text-slate-800
                     rounded-xl shadow-xl border z-50 overflow-hidden"
        >
          <div className="px-4 py-3 border-b flex items-center justify-between">
            <span className="font-semibold text-sm">Notifications</span>
            <span className="text-xs text-slate-400">{items.length} recent</span>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-slate-400">
                You're all caught up.
              </div>
            ) : (
              items.map((n) => (
                <div
                  key={n.id}
                  className={`px-4 py-3 border-b last:border-b-0 flex gap-3 text-sm ${
                    n.read_at ? 'bg-white' : 'bg-indigo-50/60'
                  }`}
                >
                  <span className="text-base leading-none mt-0.5">
                    {ICON[n.type] || '🔔'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-slate-800 break-words">{n.message}</div>
                    <div className="text-xs text-slate-400 mt-0.5">
                      {timeAgo(n.created_at)}
                    </div>
                  </div>
                  {!n.read_at && (
                    <span className="mt-1 w-2 h-2 rounded-full bg-indigo-500 shrink-0" />
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
