import { useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import {
  ChevronDown,
  ChevronRight,
  Cloud,
  Cpu,
  HelpCircle,
  Server,
  Sparkles,
} from 'lucide-react';
import { StatCard } from '@/components/stat-card';
import { type SpendSummary } from '@/hooks/use-analytics';
import {
  recentMonths,
  useAdminAppCosts,
  useAdminCloudCost,
  useAppCosts,
  type AppCostApp,
  type AppCostReport,
} from '@/hooks/use-costs';
import { api } from '@/lib/api';
import { formatUsd } from '@/lib/format';
import type { LayoutContext } from '@/components/layout';

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Daily LLM spend trend (7 parallel day buckets — same data the API exposes)
// ---------------------------------------------------------------------------
interface DailyBucket {
  label: string;
  shortLabel: string;
  spend: number;
  attempts: number;
}

function useDailySpend(orgId: string | null) {
  const dayRanges = useMemo(() => {
    const ranges: Array<{ since: string; until: string; date: Date }> = [];
    const now = Date.now();
    for (let i = 6; i >= 0; i--) {
      const dayStart = new Date(now - i * DAY_MS);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart.getTime() + DAY_MS);
      ranges.push({ since: dayStart.toISOString(), until: dayEnd.toISOString(), date: dayStart });
    }
    return ranges;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return useQuery({
    queryKey: ['daily-spend', orgId],
    queryFn: async () => {
      return Promise.all(
        dayRanges.map(async (range) => {
          const base: DailyBucket = {
            label: range.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
            shortLabel: range.date.toLocaleDateString('en-US', { weekday: 'short' }),
            spend: 0,
            attempts: 0,
          };
          try {
            const params = new URLSearchParams({ since: range.since, until: range.until });
            const res = await api<SpendSummary>(`/orgs/${orgId}/spend?${params}`);
            base.spend = parseFloat(res.summary.base_total_usd) || 0;
            base.attempts = res.summary.attempts ?? 0;
          } catch {
            // keep zeroes
          }
          return base;
        }),
      );
    },
    enabled: !!orgId,
    refetchInterval: 120_000,
    staleTime: 60_000,
  });
}

function TrendTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: DailyBucket }> }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]!.payload;
  return (
    <div className="card px-3 py-2" style={{ boxShadow: 'var(--shadow-pop)' }}>
      <div className="text-label font-medium">{d.label}</div>
      <div className="text-emphasis font-semibold font-display" style={{ color: 'var(--purple)' }}>
        {formatUsd(d.spend)}
      </div>
      <div className="text-label" style={{ color: 'var(--text-muted)' }}>
        {d.attempts} runs
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-app stacked bars (custom — full control, responsive, animated)
// ---------------------------------------------------------------------------
function AppCostRow({
  app,
  maxTotal,
  orgLabel,
}: {
  app: AppCostApp;
  maxTotal: number;
  orgLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const cloud = parseFloat(app.cloud_usd) || 0;
  const llm = parseFloat(app.llm_usd) || 0;
  const total = cloud + llm;
  const widthPct = maxTotal > 0 ? Math.max((total / maxTotal) * 100, 1.5) : 0;
  const cloudPct = total > 0 ? (cloud / total) * 100 : 0;
  const hasEnvs = app.environments.length > 0;

  return (
    <div className="border-b last:border-b-0" style={{ borderColor: 'var(--border)' }}>
      <button
        className="w-full py-3 px-1 text-left group focus-ring rounded-lg"
        onClick={() => hasEnvs && setExpanded((v) => !v)}
        style={{ cursor: hasEnvs ? 'pointer' : 'default' }}
      >
        <div className="flex items-center gap-2">
          {hasEnvs ? (
            expanded ? (
              <ChevronDown size={13} style={{ color: 'var(--text-muted)' }} className="flex-shrink-0" />
            ) : (
              <ChevronRight size={13} style={{ color: 'var(--text-muted)' }} className="flex-shrink-0" />
            )
          ) : (
            <span className="w-[13px] flex-shrink-0" />
          )}
          <span className="text-body font-medium truncate">
            {app.project_name ?? app.project_slug ?? app.project_id}
          </span>
          {orgLabel && (
            <span className="badge" style={{ background: 'var(--bg-3)', color: 'var(--text-muted)' }}>
              {orgLabel}
            </span>
          )}
          <span className="ml-auto text-body font-semibold font-display tabular flex-shrink-0">
            {formatUsd(total)}
          </span>
        </div>

        {/* Stacked bar */}
        <div className="mt-2 ml-[21px] h-[14px] rounded-md overflow-hidden flex" style={{ background: 'var(--bg-3)' }}>
          <div
            className="h-full transition-all duration-500 ease-out flex"
            style={{ width: `${widthPct}%` }}
          >
            {cloud > 0 && (
              <div
                className="h-full"
                style={{
                  width: `${cloudPct}%`,
                  background: 'linear-gradient(90deg, var(--horizon-amber), var(--horizon-rose))',
                }}
                title={`Cloud ${formatUsd(cloud)}`}
              />
            )}
            {llm > 0 && (
              <div
                className="h-full"
                style={{
                  width: `${100 - cloudPct}%`,
                  background: 'var(--horizon-violet)',
                  opacity: 0.85,
                }}
                title={`Agents ${formatUsd(llm)}`}
              />
            )}
          </div>
        </div>

        <div className="ml-[21px] mt-1.5 flex items-center gap-4 text-label" style={{ color: 'var(--text-muted)' }}>
          <span>cloud {formatUsd(cloud)}</span>
          <span>agents {formatUsd(llm)}{app.llm_attempts > 0 ? ` · ${app.llm_attempts} runs` : ''}</span>
        </div>
      </button>

      {/* Environment breakdown */}
      {expanded && hasEnvs && (
        <div className="ml-[21px] mb-3 rounded-xl overflow-hidden animate-fade-in" style={{ background: 'var(--bg-2)' }}>
          {app.environments.map((env) => (
            <div
              key={env.environment_id}
              className="flex items-center gap-3 px-3.5 py-2.5 border-b last:border-b-0 text-label"
              style={{ borderColor: 'var(--border)' }}
            >
              <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                {env.env_name ?? env.environment_id.slice(0, 12)}
              </span>
              {env.namespace && (
                <span className="mono truncate hidden sm:inline" style={{ color: 'var(--text-muted)' }}>
                  {env.namespace}
                </span>
              )}
              <span className="ml-auto tabular flex-shrink-0" style={{ color: 'var(--text-secondary)' }}>
                {formatUsd(parseFloat(env.cloud_usd) || 0)}
              </span>
              <span
                className="badge flex-shrink-0"
                style={{ background: 'var(--bg-4)', color: 'var(--text-muted)' }}
                title={`Measured usage estimate: ${formatUsd(parseFloat(env.opencost_usd) || 0)}`}
              >
                {env.confidence}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Methodology panel
// ---------------------------------------------------------------------------
function MethodologyPanel({ report, admin }: { report: AppCostReport; admin: boolean }) {
  const methodLabel =
    report.method === 'bill_allocated_by_opencost'
      ? `Bill-backed: the ${report.bill?.provider?.toUpperCase() ?? 'cloud'} bill is allocated across apps in proportion to measured usage (OpenCost).`
      : report.method === 'opencost_direct'
        ? 'Usage-based estimates (OpenCost). No bill-backed snapshot for this month yet.'
        : 'No cloud cost data for this month.';

  return (
    <div className="card card-pad">
      <div className="flex items-center gap-2 mb-2">
        <HelpCircle size={14} style={{ color: 'var(--text-muted)' }} />
        <h2 className="card-title">How these numbers are made</h2>
      </div>
      <p className="text-label leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        {methodLabel}{' '}
        {admin && report.infra.platform_overhead_usd != null && (
          <>
            Shared infrastructure that serves every app (control plane, networking, monitoring) is shown
            separately as platform overhead — never hidden inside app figures.{' '}
          </>
        )}
        Figures marked <span className="badge" style={{ background: 'var(--bg-3)', color: 'var(--text-secondary)' }}>estimate</span> are
        pre-reconciliation; LLM costs come from per-run receipts and are exact.
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-label" style={{ color: 'var(--text-muted)' }}>
        {report.bill && (
          <span>
            bill: {report.bill.provider} · {report.bill.confidence} · coverage {report.bill.coverage}
          </span>
        )}
        {report.infra.observed_at && (
          <span>
            usage observed {new Date(report.infra.observed_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            {report.infra.stale ? ' (stale)' : ''}
          </span>
        )}
        {admin && report.infra.allocation_factor && <span>allocation factor ×{report.infra.allocation_factor}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Admin bill panel — by-service breakdown
// ---------------------------------------------------------------------------
function BillPanel({ month }: { month?: string }) {
  const { data: cloud } = useAdminCloudCost(true, month);
  const services = cloud?.breakdown?.by_service ?? [];
  const maxAmount = services.length > 0 ? Math.max(...services.map((s) => s.amount)) : 0;

  if (!cloud || cloud.amount == null) return null;

  return (
    <div className="card card-pad">
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-1">
        <h2 className="card-title">AWS bill · {cloud.window.month}</h2>
        <div className="text-label" style={{ color: 'var(--text-muted)' }}>
          {cloud.window.mtd_through ? `through ${cloud.window.mtd_through}` : ''}
        </div>
      </div>
      <div className="flex items-baseline gap-3 mb-4">
        <span className="stat-value">{formatUsd(parseFloat(cloud.amount) || 0)}</span>
        {cloud.projected_amount && (
          <span className="text-label" style={{ color: 'var(--text-muted)' }}>
            projected {formatUsd(parseFloat(cloud.projected_amount) || 0)} by month end
          </span>
        )}
      </div>
      <div className="space-y-2">
        {services.slice(0, 8).map((svc) => (
          <div key={svc.service} className="flex items-center gap-3">
            <span className="text-label truncate w-[42%] sm:w-[35%]" style={{ color: 'var(--text-secondary)' }}>
              {svc.service.replace(/^Amazon |^AWS /, '')}
            </span>
            <div className="flex-1 h-[10px] rounded-md overflow-hidden" style={{ background: 'var(--bg-3)' }}>
              <div
                className="h-full rounded-md transition-all duration-500"
                style={{
                  width: `${maxAmount > 0 ? Math.max((svc.amount / maxAmount) * 100, 2) : 0}%`,
                  background: 'linear-gradient(90deg, var(--horizon-amber), var(--horizon-rose))',
                }}
              />
            </div>
            <span className="text-label tabular flex-shrink-0 w-16 text-right" style={{ color: 'var(--text-secondary)' }}>
              {formatUsd(svc.amount)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export function CostsPage() {
  const { activeOrg, isAdmin, adminScope } = useOutletContext<LayoutContext>();
  const orgId = activeOrg?.id ?? null;
  const adminView = isAdmin && adminScope;

  const months = useMemo(() => recentMonths(6), []);
  const [month, setMonth] = useState<string>(months[0]!.value);
  const [monthOpen, setMonthOpen] = useState(false);

  const orgReport = useAppCosts(adminView ? null : orgId, month);
  const adminReport = useAdminAppCosts(adminView, month);
  const report = adminView ? adminReport.data : orgReport.data;
  const reportLoading = adminView ? adminReport.isLoading : orgReport.isLoading;

  const { data: daily } = useDailySpend(orgId);

  const apps = report?.apps ?? [];
  const maxTotal = apps.length > 0 ? Math.max(...apps.map((a) => parseFloat(a.total_usd) || 0)) : 0;
  const cloudTotal = parseFloat(report?.totals.cloud_usd ?? '0') || 0;
  const llmTotal = parseFloat(report?.totals.llm_usd ?? '0') || 0;
  const overhead = report?.infra.platform_overhead_usd != null
    ? parseFloat(report.infra.platform_overhead_usd) || 0
    : null;

  const orgLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const org of report?.orgs ?? []) {
      map.set(org.org_id, org.org_slug ?? org.org_name ?? org.org_id.slice(0, 12));
    }
    return map;
  }, [report?.orgs]);

  const monthLabel = months.find((m) => m.value === month)?.label ?? month;

  return (
    <div className="page">
      <div className="page-inner space-y-5">
        {/* Header */}
        <div className="rise-in flex items-end justify-between gap-3 flex-wrap">
          <div>
            <h1 className="page-title">Costs</h1>
            <p className="page-subtitle">
              {adminView ? 'Every org, every app, the whole bill' : 'What your apps and agents actually cost'}
            </p>
          </div>

          {/* Month picker */}
          <div className="relative">
            <button
              className="segmented-item active focus-ring"
              style={{ border: '1px solid var(--border)', borderRadius: 10 }}
              onClick={() => setMonthOpen((v) => !v)}
            >
              {monthLabel}
              <ChevronDown size={12} />
            </button>
            {monthOpen && (
              <div className="dropdown-menu" style={{ right: 0, left: 'auto' }}>
                {months.map((m) => (
                  <button
                    key={m.value}
                    className={`dropdown-item ${m.value === month ? 'selected' : ''}`}
                    onClick={() => {
                      setMonth(m.value);
                      setMonthOpen(false);
                    }}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Tiles */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 rise-in" style={{ animationDelay: '40ms' }}>
          <StatCard
            value={formatUsd(cloudTotal + llmTotal)}
            label={`total · ${report?.window.month ?? month}`}
          />
          <StatCard value={formatUsd(cloudTotal)} label="cloud infra" icon={<Cloud size={15} />} />
          <StatCard value={formatUsd(llmTotal)} label="agents · llm" icon={<Sparkles size={15} />} hint={`${report?.llm.attempts ?? 0} runs`} />
          {adminView && overhead != null ? (
            <StatCard value={formatUsd(overhead)} label="platform overhead" icon={<Server size={15} />} />
          ) : (
            <StatCard value={apps.length} label="apps tracked" icon={<Cpu size={15} />} />
          )}
        </div>

        {/* Cost per app */}
        <div className="card card-pad rise-in" style={{ animationDelay: '80ms' }}>
          <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
            <h2 className="card-title">Cost per app</h2>
            <div className="flex items-center gap-4 text-label" style={{ color: 'var(--text-muted)' }}>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ background: 'linear-gradient(90deg, var(--horizon-amber), var(--horizon-rose))' }} />
                cloud
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ background: 'var(--horizon-violet)' }} />
                agents
              </span>
            </div>
          </div>

          {reportLoading ? (
            <div className="py-10 text-center text-label" style={{ color: 'var(--text-muted)' }}>
              Crunching the numbers…
            </div>
          ) : apps.length === 0 ? (
            <div className="py-10 text-center">
              <Cloud size={28} className="mx-auto mb-2" style={{ color: 'var(--text-muted)' }} />
              <div className="text-body font-medium">No cost data for {monthLabel}</div>
              <p className="text-label mt-1" style={{ color: 'var(--text-muted)' }}>
                Costs appear once apps run and usage snapshots are collected.
              </p>
            </div>
          ) : (
            <div className="mt-2">
              {apps.map((app) => (
                <AppCostRow
                  key={app.project_id}
                  app={app}
                  maxTotal={maxTotal}
                  orgLabel={adminView ? orgLabelById.get(app.org_id) : undefined}
                />
              ))}
              {adminView && overhead != null && overhead > 0 && (
                <div className="flex items-center gap-2 pt-3 px-1">
                  <span className="w-[13px]" />
                  <Server size={13} style={{ color: 'var(--text-muted)' }} />
                  <span className="text-body" style={{ color: 'var(--text-secondary)' }}>
                    Platform overhead (shared infra)
                  </span>
                  <span className="ml-auto text-body font-semibold font-display tabular">
                    {formatUsd(overhead)}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Trend + bill */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-5 rise-in" style={{ animationDelay: '120ms' }}>
          {/* Daily agent spend */}
          <div className="card card-pad">
            <h2 className="card-title mb-3">Agent spend · last 7 days</h2>
            {!daily || daily.every((d) => d.spend === 0) ? (
              <div className="h-[180px] flex items-center justify-center text-label" style={{ color: 'var(--text-muted)' }}>
                No agent spend this week
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={daily} margin={{ top: 6, right: 4, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="llmFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--horizon-violet)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--horizon-violet)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="shortLabel"
                    tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v: number) => `$${v}`}
                    width={44}
                  />
                  <Tooltip content={<TrendTooltip />} cursor={{ stroke: 'var(--border-bright)' }} />
                  <Area
                    type="monotone"
                    dataKey="spend"
                    stroke="var(--horizon-violet)"
                    strokeWidth={2}
                    fill="url(#llmFill)"
                    animationDuration={600}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Admin bill panel, or methodology for members */}
          {adminView ? <BillPanel month={month} /> : report ? <MethodologyPanel report={report} admin={false} /> : <div />}
        </div>

        {/* Admin gets methodology too, full width */}
        {adminView && report && (
          <div className="rise-in" style={{ animationDelay: '160ms' }}>
            <MethodologyPanel report={report} admin />
          </div>
        )}
      </div>
    </div>
  );
}
