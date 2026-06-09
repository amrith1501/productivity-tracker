import { useMemo, useState } from 'react';

const STATUS_COLORS = {
  pending: 'bg-slate-300',
  in_progress: 'bg-amber-400',
  submitted: 'bg-blue-500',
  approved: 'bg-emerald-500',
};

const STATUS_LABELS = {
  pending: 'Pending',
  in_progress: 'In progress',
  submitted: 'Submitted',
  approved: 'Approved',
};

// Backend stores timestamps as naive UTC (e.g. "2026-06-09T03:48:41"), so a
// plain `new Date(ts)` would misread them as local time. Append a 'Z' when no
// timezone is present so they're parsed as UTC and then surfaced in the
// viewer's local zone.
function parseUTC(ts) {
  if (!ts) return null;
  const s = /([zZ]|[+-]\d{2}:?\d{2})$/.test(ts) ? ts : `${ts}Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad2 = (n) => String(n).padStart(2, '0');
// Local-time bucket keys, so an approval shows up on the day/month the
// supervisor actually saw it happen.
const localDayKey = (d) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const localMonthKey = (d) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;

function aggregateByWorker(workers, tasks) {
  const rows = workers.map((w) => ({
    employee: w.employee,
    username: w.username,
    counts: { pending: 0, in_progress: 0, submitted: 0, approved: 0 },
    total: 0,
    cycleHours: [],
  }));
  const byName = new Map(rows.map((r) => [r.employee, r]));
  for (const t of tasks) {
    const rec = byName.get(t.assignee);
    if (!rec) continue;
    rec.counts[t.status] = (rec.counts[t.status] || 0) + 1;
    rec.total += 1;
    if (t.status === 'approved' && t.started_at && t.approved_at) {
      const a = parseUTC(t.approved_at);
      const s = parseUTC(t.started_at);
      if (a && s) {
        const hrs = (a - s) / 36e5;
        if (Number.isFinite(hrs) && hrs >= 0) rec.cycleHours.push(hrs);
      }
    }
  }
  for (const r of rows) {
    r.completionRate = r.total > 0 ? r.counts.approved / r.total : 0;
    r.avgCycleHours = r.cycleHours.length
      ? r.cycleHours.reduce((a, b) => a + b, 0) / r.cycleHours.length
      : null;
  }
  // Show busiest workers first.
  rows.sort((a, b) => b.total - a.total || a.employee.localeCompare(b.employee));
  return rows;
}

function approvedByDay(tasks, days = 7,
                       labelFmt = { weekday: 'short' }) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    buckets.push({
      key: localDayKey(d),
      label: d.toLocaleDateString(undefined, labelFmt),
      date: d,
      count: 0,
    });
  }
  const idxByKey = new Map(buckets.map((b, i) => [b.key, i]));
  for (const t of tasks) {
    if (t.status !== 'approved' || !t.approved_at) continue;
    const d = parseUTC(t.approved_at);
    if (!d) continue;
    const idx = idxByKey.get(localDayKey(d));
    if (idx !== undefined) buckets[idx].count += 1;
  }
  return buckets;
}

function approvedByMonth(tasks, months = 12) {
  const now = new Date();
  const buckets = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.push({
      key: localMonthKey(d),
      date: d,
      count: 0,
      label: d.toLocaleDateString(undefined, { month: 'short' }),
      fullLabel: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
    });
  }
  const idxByKey = new Map(buckets.map((b, i) => [b.key, i]));
  for (const t of tasks) {
    if (t.status !== 'approved' || !t.approved_at) continue;
    const d = parseUTC(t.approved_at);
    if (!d) continue;
    const idx = idxByKey.get(localMonthKey(d));
    if (idx !== undefined) buckets[idx].count += 1;
  }
  return buckets;
}

function formatHours(h) {
  if (h == null) return '—';
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} d`;
}

function LineChart({ data, color = 'emerald', maxLabels = 8 }) {
  // Render the chart in a 600x180 viewBox and let SVG scale it to the
  // container. preserveAspectRatio defaults to xMidYMid meet, so the chart
  // keeps its proportions on any width.
  const W = 600;
  const H = 180;
  const padL = 32;
  const padR = 16;
  const padT = 12;
  const padB = 26;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  if (!data.length) return null;

  const maxVal = Math.max(1, ...data.map((d) => d.count));
  const stepX = data.length > 1 ? innerW / (data.length - 1) : 0;

  const points = data.map((d, i) => ({
    x: data.length > 1 ? padL + i * stepX : padL + innerW / 2,
    y: padT + innerH - (d.count / maxVal) * innerH,
    d,
  }));

  const linePath = points.map((p, i) =>
    `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`
  ).join(' ');
  const baseline = padT + innerH;
  const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(2)} ${baseline}`
                 + ` L ${points[0].x.toFixed(2)} ${baseline} Z`;

  const yTicks = [0, 0.5, 1].map((t) => ({
    y: padT + innerH - t * innerH,
    val: Math.round(t * maxVal),
  }));

  const labelStride = Math.max(1, Math.ceil(data.length / maxLabels));

  const palette = {
    emerald: { stroke: 'stroke-emerald-500', fill: 'fill-emerald-500/15', dot: 'fill-emerald-500' },
    indigo: { stroke: 'stroke-indigo-500', fill: 'fill-indigo-500/15', dot: 'fill-indigo-500' },
    blue: { stroke: 'stroke-blue-500', fill: 'fill-blue-500/15', dot: 'fill-blue-500' },
  };
  const { stroke, fill, dot } = palette[color] || palette.emerald;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img">
      {yTicks.map((t, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={t.y} y2={t.y}
                className="stroke-slate-100" strokeWidth="1" />
          <text x={padL - 6} y={t.y + 4} textAnchor="end"
                className="fill-slate-400" fontSize="10">
            {t.val}
          </text>
        </g>
      ))}
      <path d={areaPath} className={fill} />
      <path d={linePath} className={`${stroke} fill-none`}
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="3"
                className={`${dot} stroke-white`} strokeWidth="1.5">
          <title>
            {(p.d.fullLabel || p.d.label)}: {p.d.count}
          </title>
        </circle>
      ))}
      {points.map((p, i) => {
        if (i % labelStride !== 0 && i !== points.length - 1) return null;
        return (
          <text key={i} x={p.x} y={H - 8} textAnchor="middle"
                className="fill-slate-500" fontSize="10">
            {p.d.label}
          </text>
        );
      })}
    </svg>
  );
}

function TrendSummary({ data, perLabel }) {
  const total = data.reduce((s, d) => s + d.count, 0);
  const peak = data.reduce((best, d) => (d.count > best.count ? d : best), data[0]);
  const avg = data.length ? total / data.length : 0;
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-500 mt-2">
      <span><span className="text-slate-700 font-semibold">{total}</span> total</span>
      <span>
        avg <span className="text-slate-700 font-semibold">{avg.toFixed(1)}</span> / {perLabel}
      </span>
      {peak && peak.count > 0 && (
        <span>
          peak <span className="text-slate-700 font-semibold">{peak.count}</span>
          {' '}on {peak.fullLabel || peak.label}
        </span>
      )}
    </div>
  );
}

export default function WorkerProductivityCharts({ workers, tasks }) {
  const [selected, setSelected] = useState(null);
  const validSelection = selected && workers.some((w) => w.employee === selected)
    ? selected : null;

  const trendTasks = useMemo(
    () => (validSelection
      ? tasks.filter((t) => t.assignee === validSelection)
      : tasks),
    [tasks, validSelection]
  );

  const rows = useMemo(() => aggregateByWorker(workers, tasks), [workers, tasks]);
  const trend = useMemo(() => approvedByDay(trendTasks), [trendTasks]);
  const monthlyTrend = useMemo(
    () => approvedByDay(trendTasks, 30, { month: 'short', day: 'numeric' }),
    [trendTasks]
  );
  const yearlyTrend = useMemo(() => approvedByMonth(trendTasks, 12), [trendTasks]);

  if (workers.length === 0) {
    return (
      <div className="bg-white rounded-xl shadow-sm border p-4">
        <h3 className="font-semibold text-sm text-slate-600">Productivity</h3>
        <p className="text-sm text-slate-400 italic mt-2">
          Add a worker to see productivity insights.
        </p>
      </div>
    );
  }

  const maxTotal = Math.max(1, ...rows.map((r) => r.total));
  const maxTrend = Math.max(1, ...trend.map((d) => d.count));
  const trendTotal = trend.reduce((s, d) => s + d.count, 0);

  const withWork = rows.filter((r) => r.total > 0);
  const bestRate = withWork.length
    ? [...withWork].sort((a, b) => b.completionRate - a.completionRate)[0]
    : null;
  const withCycle = rows.filter((r) => r.avgCycleHours != null);
  const fastest = withCycle.length
    ? [...withCycle].sort((a, b) => a.avgCycleHours - b.avgCycleHours)[0]
    : null;

  const scopeLabel = validSelection ? validSelection : 'team';
  const isDim = (employee) => validSelection && employee !== validSelection;
  const toggle = (employee) =>
    setSelected((cur) => (cur === employee ? null : employee));

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl shadow-sm border p-4">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <h3 className="font-semibold text-sm text-slate-600">
            Filter by employee
          </h3>
          {validSelection && (
            <span className="text-xs text-slate-500">
              Showing <span className="font-semibold text-slate-700">{validSelection}</span>
              {' '}only · click again to clear
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <SlicerChip active={!validSelection} onClick={() => setSelected(null)}>
            All team
          </SlicerChip>
          {rows.map((r) => (
            <SlicerChip
              key={r.employee}
              active={validSelection === r.employee}
              onClick={() => toggle(r.employee)}
            >
              {r.employee}
              <span className="ml-1 text-[10px] opacity-70">{r.total}</span>
            </SlicerChip>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border p-4">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h3 className="font-semibold text-sm text-slate-600">
            Workload &amp; progress
          </h3>
          <div className="flex items-center gap-3 text-xs text-slate-500 flex-wrap">
            {Object.entries(STATUS_LABELS).map(([s, label]) => (
              <span key={s} className="flex items-center gap-1">
                <span className={`w-2.5 h-2.5 rounded-sm inline-block ${STATUS_COLORS[s]}`} />
                {label}
              </span>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          {rows.map((r) => (
            <button
              key={r.employee}
              type="button"
              onClick={() => toggle(r.employee)}
              className={`w-full flex items-center gap-3 text-left rounded p-1 -m-1
                          transition-opacity hover:bg-slate-50
                          ${isDim(r.employee) ? 'opacity-40' : ''}`}
            >
              <div className="w-32 shrink-0">
                <div className="text-sm font-medium truncate">{r.employee}</div>
                <div className="text-xs text-slate-400">
                  {r.total} task{r.total === 1 ? '' : 's'}
                </div>
              </div>
              <div className="flex-1 h-7 bg-slate-50 rounded overflow-hidden">
                {r.total === 0 ? (
                  <div className="h-full flex items-center justify-center text-xs text-slate-400 italic">
                    No tasks assigned
                  </div>
                ) : (
                  <div className="flex h-full"
                       style={{ width: `${Math.max(8, (r.total / maxTotal) * 100)}%` }}>
                    {Object.keys(STATUS_LABELS).map((s) => {
                      const c = r.counts[s] || 0;
                      if (!c) return null;
                      const pct = (c / r.total) * 100;
                      return (
                        <div key={s}
                             className={`${STATUS_COLORS[s]} h-full flex items-center justify-center text-[11px] font-medium text-white`}
                             style={{ width: `${pct}%` }}
                             title={`${STATUS_LABELS[s]}: ${c}`}>
                          {pct >= 12 ? c : ''}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl shadow-sm border p-4">
          <h3 className="font-semibold text-sm text-slate-600 mb-3">
            Completion rate
          </h3>
          <div className="space-y-2">
            {rows.map((r) => (
              <button
                key={r.employee}
                type="button"
                onClick={() => toggle(r.employee)}
                className={`w-full flex items-center gap-3 text-left rounded p-1 -m-1
                            transition-opacity hover:bg-slate-50
                            ${isDim(r.employee) ? 'opacity-40' : ''}`}
              >
                <div className="w-28 truncate text-sm">{r.employee}</div>
                <div className="flex-1 h-3 rounded-full overflow-hidden bg-slate-100">
                  <div className="h-full bg-emerald-500 transition-[width] duration-500"
                       style={{ width: `${r.completionRate * 100}%` }} />
                </div>
                <div className="w-20 text-right text-xs text-slate-500 tabular-nums">
                  {r.total === 0
                    ? '—'
                    : `${(r.completionRate * 100).toFixed(0)}% · ${r.counts.approved}/${r.total}`}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-sm text-slate-600">
              Approved by {scopeLabel} · last 7 days
            </h3>
            <span className="text-xs text-slate-400">{trendTotal} total</span>
          </div>
          <div className="flex items-end gap-2 h-32">
            {trend.map((d) => {
              const heightPct = (d.count / maxTrend) * 100;
              return (
                <div key={d.key} className="flex-1 flex flex-col items-center justify-end h-full">
                  <div className="text-[10px] text-slate-600 tabular-nums h-4">
                    {d.count || ''}
                  </div>
                  <div className="w-full flex-1 flex items-end">
                    <div className="w-full bg-emerald-500 rounded-t transition-[height] duration-500"
                         style={{ height: `${heightPct}%`, minHeight: d.count ? '4px' : '0' }}
                         title={`${d.date.toLocaleDateString()}: ${d.count}`} />
                  </div>
                  <div className="text-xs text-slate-500 mt-1">{d.label}</div>
                </div>
              );
            })}
          </div>
          {trendTotal === 0 && (
            <p className="text-xs text-slate-400 italic mt-2">
              No tasks approved in the last 7 days yet.
            </p>
          )}
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border p-4">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h3 className="font-semibold text-sm text-slate-600">
            Monthly productivity · {scopeLabel}
          </h3>
          <span className="text-xs text-slate-400">
            Approved tasks · last 30 days
          </span>
        </div>
        <LineChart data={monthlyTrend} color="indigo" maxLabels={6} />
        <TrendSummary data={monthlyTrend} perLabel="day" />
      </div>

      <div className="bg-white rounded-xl shadow-sm border p-4">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h3 className="font-semibold text-sm text-slate-600">
            Yearly productivity · {scopeLabel}
          </h3>
          <span className="text-xs text-slate-400">
            Approved tasks · last 12 months
          </span>
        </div>
        <LineChart data={yearlyTrend} color="blue" maxLabels={12} />
        <TrendSummary data={yearlyTrend} perLabel="month" />
      </div>

      {!validSelection && (bestRate || fastest) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {bestRate && (
            <div className="bg-white rounded-xl shadow-sm border-l-4 border-emerald-300 p-3">
              <div className="text-xs text-slate-500">Highest completion rate</div>
              <div className="text-lg font-bold">{bestRate.employee}</div>
              <div className="text-xs text-slate-500">
                {(bestRate.completionRate * 100).toFixed(0)}% ·
                {' '}{bestRate.counts.approved} of {bestRate.total} approved
              </div>
            </div>
          )}
          {fastest && (
            <div className="bg-white rounded-xl shadow-sm border-l-4 border-blue-300 p-3">
              <div className="text-xs text-slate-500">Fastest avg turnaround</div>
              <div className="text-lg font-bold">{fastest.employee}</div>
              <div className="text-xs text-slate-500">
                {formatHours(fastest.avgCycleHours)} from start → approved
                {' '}({fastest.cycleHours.length} sample{fastest.cycleHours.length === 1 ? '' : 's'})
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SlicerChip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
        active
          ? 'bg-indigo-600 text-white border-indigo-600'
          : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:border-slate-300'
      }`}
    >
      {children}
    </button>
  );
}
