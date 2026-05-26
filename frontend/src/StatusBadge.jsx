const COLORS = {
  pending: 'bg-slate-200 text-slate-700',
  in_progress: 'bg-amber-100 text-amber-800',
  submitted: 'bg-blue-100 text-blue-800',
  approved: 'bg-emerald-100 text-emerald-800',
};

export default function StatusBadge({ status }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${COLORS[status] || ''}`}>
      {status.replace('_', ' ')}
    </span>
  );
}
