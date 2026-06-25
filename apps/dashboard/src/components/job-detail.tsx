import { useState, useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle,
  XCircle,
  GitBranch,
  GitCommit,
  Clock,
  Tag,
  ChevronRight,
  ArrowUpRight,
  Cpu,
  DollarSign,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import { SlideOver } from './slide-over';
import { LogViewer } from './log-viewer';
import { PriorityBadge } from './priority-badge';
import { HealthDot } from './health-dot';
import { timeAgo, elapsed, formatUsd } from '@/lib/format';
import { api, ApiError } from '@/lib/api';
import { jobStatusDetail, jobStatusLabel, jobStatusTone, type Job } from '@/hooks/use-jobs';

interface JobDetailProps {
  job: Job | null;
  onClose: () => void;
  /** Called when user clicks a parent/child job id to navigate to it */
  onNavigateJob?: (jobId: string) => void;
}

type Tab = 'summary' | 'attempts' | 'logs' | 'result' | 'cost';

interface Attempt {
  attempt_number: number;
  status: string;
  started_at?: string;
  ended_at?: string;
  duration_ms?: number;
  token_input?: number;
  token_output?: number;
  exit_code?: number;
  cost_usd?: number;
  model?: string;
  error_message?: string;
}

interface JobResult {
  jobId: string;
  status: string;
  exitCode: number | null;
  resultText: string | null;
  resultJson: unknown | null;
  durationMs: number | null;
  tokenUsage?: { input: number; output: number };
  costUsd?: number;
  errorMessage: string | null;
  model?: string;
}

interface ChildJob {
  id: string;
  title: string;
  phase: string;
  priority: number;
}

// Phase-to-status mapping for HealthDot
function phaseToStatus(phase: string): string {
  switch (phase) {
    case 'done': return 'healthy';
    case 'active': return 'running';
    case 'review': return 'warning';
    case 'cancelled': return 'failed';
    case 'failed': return 'failed';
    default: return 'unknown';
  }
}

function attemptToStatus(status: string): string {
  switch (status) {
    case 'succeeded': return 'healthy';
    case 'failed': return 'failed';
    case 'running': return 'running';
    case 'active': return 'running';
    default: return 'unknown';
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSec = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSec}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

function tryFormatJson(text: string): { isJson: boolean; formatted: string } {
  try {
    const parsed = JSON.parse(text);
    return { isJson: true, formatted: JSON.stringify(parsed, null, 2) };
  } catch {
    return { isJson: false, formatted: text };
  }
}

function firstDiagnosticLine(text?: string | null): string | null {
  if (!text) return null;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return null;

  const preferred = lines.find((line) =>
    /http \d+|unauthorized|forbidden|timed out|exception|panic|not found|failed/i.test(line) &&
    !/^command failed:/i.test(line),
  );

  return preferred ?? lines[0] ?? null;
}

function formatFailureDisposition(value?: string | null): string | null {
  if (!value) return null;
  return value.replace(/_/g, ' ');
}

export function JobDetail({ job, onClose, onNavigateJob }: JobDetailProps) {
  const [activeTab, setActiveTab] = useState<Tab>('summary');
  const [selectedAttempt, setSelectedAttempt] = useState<number | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    setActiveTab('summary');
    setSelectedAttempt(null);
    setReviewError(null);
  }, [job?.id]);

  const { data: fullJob } = useQuery({
    queryKey: ['job-detail', job?.id],
    queryFn: () => api<Job>(`/jobs/${job!.id}`),
    enabled: !!job,
  });

  const { data: attemptsData } = useQuery({
    queryKey: ['job-attempts', job?.id],
    queryFn: () => api<{ attempts: Attempt[] } | Attempt[]>(`/jobs/${job!.id}/attempts`),
    enabled: !!job,
    select: (data) => {
      const attempts = Array.isArray(data) ? data : data.attempts ?? [];
      return attempts;
    },
  });

  const { data: resultData, isLoading: resultLoading, error: resultError } = useQuery({
    queryKey: ['job-result', job?.id],
    queryFn: async () => {
      try {
        return await api<JobResult>(`/jobs/${job!.id}/result`);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          return null;
        }
        throw error;
      }
    },
    enabled: !!job && (activeTab === 'result' || activeTab === 'cost'),
  });

  const { data: childrenData } = useQuery({
    queryKey: ['job-children', job?.id],
    queryFn: () => api<{ jobs: ChildJob[] } | ChildJob[]>(`/jobs/${job!.id}/children`).catch(() => []),
    enabled: !!job && activeTab === 'summary',
    select: (data) => (Array.isArray(data) ? data : data.jobs ?? []),
  });

  const handleReview = useCallback(async (action: 'approve' | 'reject') => {
    if (!job) return;
    setReviewLoading(true);
    setReviewError(null);
    try {
      await api(`/jobs/${job.id}/review`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      // Invalidate queries to refresh job state
      queryClient.invalidateQueries({ queryKey: ['job-detail', job.id] });
      queryClient.invalidateQueries({ queryKey: ['project-jobs'] });
      queryClient.invalidateQueries({ queryKey: ['org-jobs'] });
      queryClient.invalidateQueries({ queryKey: ['job', job.id] });
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'Review action failed');
    } finally {
      setReviewLoading(false);
    }
  }, [job, queryClient]);

  const detail = fullJob ?? job;
  if (!detail) return null;

  const isActive = detail.phase === 'active';
  const isReview = detail.phase === 'review';
  const canHaveFinalResult = detail.phase === 'done' || detail.phase === 'cancelled' || detail.phase === 'failed';
  const attempts = attemptsData ?? [];
  const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1]! : null;
  const activeAttemptNumber = selectedAttempt ?? latestAttempt?.attempt_number ?? 1;
  const detailStatusLabel = jobStatusLabel(detail);
  const detailStatusDetail = jobStatusDetail(detail);
  const detailStatusTone = jobStatusTone(detail);
  const latestError = firstDiagnosticLine(latestAttempt?.error_message);
  const closeReason = firstDiagnosticLine(detail.close_reason);

  const diagnosis = (() => {
    if (detail.phase === 'cancelled') {
      const title =
        detail.failure_disposition === 'upstream_failed'
          ? 'Blocked by an upstream failure'
          : detail.failure_disposition === 'failed'
            ? 'Run failed'
            : 'Job stopped';
      const summary = latestError ?? closeReason ?? detailStatusDetail ?? 'This job did not complete.';
      const metadata = [
        detail.env_name ? `Environment: ${detail.env_name}` : null,
        latestAttempt?.attempt_number != null ? `Attempt ${latestAttempt.attempt_number}` : null,
        latestAttempt?.exit_code != null ? `Exit code ${latestAttempt.exit_code}` : null,
      ].filter(Boolean) as string[];
      return { title, summary, metadata };
    }

    if (detail.phase === 'review') {
      return {
        title: 'Awaiting review',
        summary: detailStatusDetail ?? 'Human approval is required before this job can complete.',
        metadata: [
          detail.reviewer ? `Reviewer: ${detail.reviewer}` : null,
          detail.env_name ? `Environment: ${detail.env_name}` : null,
        ].filter(Boolean) as string[],
      };
    }

    if (detail.phase === 'active') {
      return {
        title: 'Run in progress',
        summary: detailStatusDetail ?? 'The latest attempt is still running.',
        metadata: [
          detail.env_name ? `Environment: ${detail.env_name}` : null,
          latestAttempt?.attempt_number != null ? `Attempt ${latestAttempt.attempt_number}` : null,
        ].filter(Boolean) as string[],
      };
    }

    return null;
  })();

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'summary', label: 'Summary' },
    { id: 'attempts', label: 'Attempts', count: attempts.length || undefined },
    { id: 'logs', label: 'Logs' },
    { id: 'result', label: 'Result' },
    { id: 'cost', label: 'Cost' },
  ];

  return (
    <SlideOver open={!!job} onClose={onClose} title={detail.title} subtitle={`${detail.id} · ${detailStatusLabel}`}>
      {/* Review Actions Banner */}
      {isReview && (
        <div className="flex items-center gap-3 px-4 py-3 mb-4 rounded-lg border border-[var(--color-warning)] bg-[var(--amber-dim)]">
          <AlertTriangle size={16} className="text-[var(--amber)] flex-shrink-0" />
          <span className="flex-1 text-body font-medium text-[var(--text-primary)]">
            This job is awaiting review
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => handleReview('approve')}
              disabled={reviewLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-label font-medium bg-[var(--green)] text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {reviewLoading ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle size={12} />}
              Approve
            </button>
            <button
              onClick={() => handleReview('reject')}
              disabled={reviewLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-label font-medium bg-[var(--red)] text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {reviewLoading ? <Loader2 size={12} className="animate-spin" /> : <XCircle size={12} />}
              Reject
            </button>
          </div>
        </div>
      )}
      {reviewError && (
        <div className="mb-4 px-3 py-2 rounded-md bg-[var(--red-dim)] text-[var(--red)] text-label">
          {reviewError}
        </div>
      )}

      {diagnosis && (
        <DiagnosisBanner
          title={diagnosis.title}
          summary={diagnosis.summary}
          metadata={diagnosis.metadata}
          tone={detailStatusTone}
          onViewLogs={
            attempts.length > 0
              ? () => {
                  setSelectedAttempt(activeAttemptNumber);
                  setActiveTab('logs');
                }
              : undefined
          }
          onViewAttempts={
            attempts.length > 0
              ? () => {
                  setActiveTab('attempts');
                }
              : undefined
          }
          onViewResult={
            canHaveFinalResult
              ? () => {
                  setActiveTab('result');
                }
              : undefined
          }
        />
      )}

      {/* Tab Bar */}
      <div className="flex gap-1 border-b border-[var(--color-border)] mb-4">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-3 py-2 text-body font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
              activeTab === tab.id
                ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            {tab.label}
            {tab.count != null && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-surface-raised)]">
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Summary Tab ── */}
      {activeTab === 'summary' && (
        <div className="space-y-6">
          {/* Breadcrumb / parent link */}
          {detail.parent_id && (
            <div className="flex items-center gap-1.5 text-label text-[var(--color-text-muted)]">
              <button
                onClick={() => onNavigateJob?.(detail.parent_id!)}
                className="hover:text-[var(--color-accent)] transition-colors font-mono"
              >
                {detail.parent_id}
              </button>
              <ChevronRight size={12} />
              <span className="font-mono text-[var(--text-primary)]">{detail.id}</span>
            </div>
          )}

          {/* Status Section */}
          <Section title="Status">
            <Row label="Phase">
              <HealthDot status={phaseToStatus(detail.phase)} />
              <span className="ml-1.5">{detailStatusLabel}</span>
            </Row>
            <Row label="Priority"><PriorityBadge priority={detail.priority} /></Row>
            {detail.env_name && <Row label="Environment">{detail.env_name}</Row>}
            {detail.harness && (
              <Row label="Harness">
                <span className="flex items-center gap-1.5">
                  <Cpu size={12} className="text-[var(--text-muted)]" />
                  <span className="font-mono">{detail.harness}</span>
                </span>
              </Row>
            )}
            {detail.assignee && <Row label="Assignee">{detail.assignee}</Row>}
            {detail.reviewer && <Row label="Reviewer">{detail.reviewer}</Row>}
            {detail.review_status && (
              <Row label="Review Status">
                <span className="capitalize">{detail.review_status.replace(/_/g, ' ')}</span>
              </Row>
            )}
            {detail.failure_disposition && (
              <Row label="Outcome">
                <span className="capitalize">{formatFailureDisposition(detail.failure_disposition)}</span>
              </Row>
            )}
            {closeReason && (
              <Row label="Reason">
                <span className="whitespace-pre-wrap break-words">{closeReason}</span>
              </Row>
            )}
          </Section>

          {/* Git Metadata Section */}
          {(detail.git_branch || detail.git_ref) && (
            <Section title="Git">
              {detail.git_branch && (
                <Row label="Branch">
                  <span className="flex items-center gap-1.5 font-mono">
                    <GitBranch size={12} className="text-[var(--text-muted)]" />
                    {detail.git_branch}
                  </span>
                </Row>
              )}
              {detail.git_ref && (
                <Row label="Ref">
                  <span className="flex items-center gap-1.5 font-mono">
                    <GitCommit size={12} className="text-[var(--text-muted)]" />
                    <span title={detail.git_ref}>{detail.git_ref.slice(0, 10)}</span>
                  </span>
                </Row>
              )}
            </Section>
          )}

          {/* Timing Section */}
          <Section title="Timing">
            <Row label="Created">
              <span className="flex items-center gap-1.5">
                <Clock size={12} className="text-[var(--text-muted)]" />
                {timeAgo(detail.created_at)}
              </span>
            </Row>
            {detail.started_at && (
              <Row label={isActive ? 'Running for' : 'Started'}>
                {isActive ? elapsed(detail.started_at) : timeAgo(detail.started_at)}
              </Row>
            )}
            {detail.completed_at && <Row label="Completed">{timeAgo(detail.completed_at)}</Row>}
          </Section>

          {/* Labels */}
          {detail.labels.length > 0 && (
            <Section title="Labels">
              <div className="flex flex-wrap gap-1.5">
                {detail.labels.map((l) => (
                  <span
                    key={l}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--color-surface-raised)] border border-[var(--border)] text-label"
                  >
                    <Tag size={10} className="text-[var(--text-muted)]" />
                    {l}
                  </span>
                ))}
              </div>
            </Section>
          )}

          {/* Description */}
          {detail.description && (
            <Section title="Description">
              <p className="text-body text-[var(--color-text-secondary)] leading-relaxed">
                {detail.description}
              </p>
            </Section>
          )}

          {/* Children */}
          {childrenData && childrenData.length > 0 && (
            <Section title="Child Jobs">
              <div className="space-y-1">
                {childrenData.map((child) => (
                  <button
                    key={child.id}
                    onClick={() => onNavigateJob?.(child.id)}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-md hover:bg-[var(--color-surface-raised)] transition-colors text-left group"
                  >
                    <HealthDot status={phaseToStatus(child.phase)} />
                    <span className="flex-1 text-body truncate">{child.title}</span>
                    <span className="text-label text-[var(--text-muted)] capitalize">{child.phase}</span>
                    <ArrowUpRight size={12} className="text-[var(--text-muted)] opacity-0 group-hover:opacity-100 transition-opacity" />
                  </button>
                ))}
              </div>
            </Section>
          )}
        </div>
      )}

      {/* ── Attempts Tab ── */}
      {activeTab === 'attempts' && (
        <div className="space-y-2">
          {attempts.length > 0 ? (
            attempts.map((a) => {
              const isSelected = a.attempt_number === activeAttemptNumber;
              return (
                <button
                  key={a.attempt_number}
                  onClick={() => {
                    setSelectedAttempt(a.attempt_number);
                    setActiveTab('logs');
                  }}
                  className={`w-full flex items-center justify-between py-3 px-3 rounded-lg border transition-colors text-left ${
                    isSelected
                      ? 'border-[var(--color-accent)] bg-[var(--blue-dim)]'
                      : 'border-[var(--color-border)] hover:border-[var(--border-bright)] hover:bg-[var(--color-surface-raised)]'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <HealthDot status={attemptToStatus(a.status)} size="md" />
                    <div>
                      <span className="font-medium text-body">Attempt {a.attempt_number}</span>
                      <span className="text-label text-[var(--text-muted)] ml-2 capitalize">{a.status}</span>
                      {a.error_message && (
                        <div className="mt-1 max-w-lg text-label text-[var(--red)] line-clamp-2">
                          {firstDiagnosticLine(a.error_message)}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-label text-[var(--color-text-secondary)]">
                    {a.cost_usd != null && (
                      <span className="flex items-center gap-1">
                        <DollarSign size={10} />
                        {formatUsd(a.cost_usd)}
                      </span>
                    )}
                    {a.duration_ms != null && (
                      <span className="flex items-center gap-1">
                        <Clock size={10} />
                        {formatDuration(a.duration_ms)}
                      </span>
                    )}
                    {a.exit_code != null && (
                      <span className={`font-mono ${a.exit_code === 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                        exit {a.exit_code}
                      </span>
                    )}
                    <ArrowUpRight size={12} className="text-[var(--text-muted)]" />
                  </div>
                </button>
              );
            })
          ) : (
            <div className="text-label text-[var(--color-text-muted)] py-8 text-center">
              {isActive ? 'Waiting for first attempt...' : 'No attempts recorded'}
            </div>
          )}
        </div>
      )}

      {/* ── Logs Tab ── */}
      {activeTab === 'logs' && (
        <div className="h-[60vh] -mx-6 -mb-6 border-t border-[var(--color-border)]">
          {/* Attempt selector when multiple attempts exist */}
          {attempts.length > 1 && (
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--bg-2)]">
              <span className="text-label text-[var(--text-muted)]">Attempt:</span>
              {attempts.map((a) => (
                <button
                  key={a.attempt_number}
                  onClick={() => setSelectedAttempt(a.attempt_number)}
                  className={`px-2 py-0.5 rounded text-label font-medium transition-colors ${
                    a.attempt_number === activeAttemptNumber
                      ? 'bg-[var(--color-accent)] text-white'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--color-surface-raised)]'
                  }`}
                >
                  #{a.attempt_number}
                </button>
              ))}
            </div>
          )}
          <LogViewer
            jobId={detail.id}
            attemptNumber={activeAttemptNumber}
            isActive={isActive && activeAttemptNumber === (latestAttempt?.attempt_number ?? 1)}
          />
        </div>
      )}

      {/* ── Result Tab ── */}
      {activeTab === 'result' && (
        <div className="space-y-4">
          {resultLoading ? (
            <div className="text-label text-[var(--color-text-muted)] py-8 text-center">
              Loading result...
            </div>
          ) : resultError ? (
            <div className="text-label text-[var(--red)] py-8 text-center">
              Failed to load result data
            </div>
          ) : resultData ? (
            <>
              {/* Result header with exit code + duration */}
              <div className="flex items-center gap-4 py-3 px-4 rounded-lg bg-[var(--color-surface-raised)] border border-[var(--border)]">
                {resultData.exitCode != null && (
                  <div className="flex items-center gap-2">
                    {resultData.exitCode === 0 ? (
                      <CheckCircle size={16} className="text-[var(--green)]" />
                    ) : (
                      <XCircle size={16} className="text-[var(--red)]" />
                    )}
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Exit Code</div>
                      <div className={`font-mono font-medium ${resultData.exitCode === 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                        {resultData.exitCode}
                      </div>
                    </div>
                  </div>
                )}
                {resultData.durationMs != null && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Duration</div>
                    <div className="font-mono text-body">{formatDuration(resultData.durationMs)}</div>
                  </div>
                )}
                {resultData.costUsd != null && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Cost</div>
                    <div className="font-mono text-body">{formatUsd(resultData.costUsd)}</div>
                  </div>
                )}
                <div className="flex-1" />
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Status</div>
                  <div className="text-body capitalize">{resultData.status}</div>
                </div>
              </div>

              {/* Error message */}
              {resultData.errorMessage && (
                <div className="flex items-start gap-2 px-4 py-3 rounded-lg bg-[var(--red-dim)] border border-[var(--red)]">
                  <AlertTriangle size={14} className="text-[var(--red)] flex-shrink-0 mt-0.5" />
                  <pre className="font-mono text-label text-[var(--red)] whitespace-pre-wrap break-all flex-1">
                    {resultData.errorMessage}
                  </pre>
                </div>
              )}

              {/* Result output */}
              {(resultData.resultText || resultData.resultJson) ? (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-2">Output</div>
                  <pre className="font-mono text-label bg-[var(--color-surface-raised)] border border-[var(--border)] p-4 rounded-lg overflow-auto max-h-[50vh] whitespace-pre-wrap break-all">
                    {resultData.resultJson
                      ? JSON.stringify(resultData.resultJson, null, 2)
                      : resultData.resultText
                        ? tryFormatJson(resultData.resultText).formatted
                        : ''}
                  </pre>
                </div>
              ) : !resultData.errorMessage ? (
                <div className="text-label text-[var(--color-text-muted)] py-4 text-center">
                  No output data
                </div>
              ) : null}
            </>
          ) : canHaveFinalResult ? (
            <div className="text-label text-[var(--color-text-muted)] py-8 text-center">
              No result was recorded for this job.
            </div>
          ) : (
            <div className="text-label text-[var(--color-text-muted)] py-8 text-center">
              Job has not completed yet
            </div>
          )}
        </div>
      )}

      {/* ── Cost Tab ── */}
      {activeTab === 'cost' && (
        <div className="space-y-6">
          {/* Token breakdown from result */}
          {resultLoading ? (
            <div className="text-label text-[var(--color-text-muted)] py-4 text-center">
              Loading cost data...
            </div>
          ) : resultError ? (
            <div className="text-label text-[var(--red)] py-4 text-center">
              Failed to load cost data
            </div>
          ) : resultData?.tokenUsage ? (
            <>
              <Section title="Token Usage">
                <div className="grid grid-cols-2 gap-3">
                  <TokenCard label="Input Tokens" count={resultData.tokenUsage.input} color="blue" />
                  <TokenCard label="Output Tokens" count={resultData.tokenUsage.output} color="green" />
                </div>
                {resultData.model && (
                  <Row label="Model">
                    <span className="font-mono text-body">{resultData.model}</span>
                  </Row>
                )}
                {resultData.durationMs != null && (
                  <Row label="Duration">
                    <span className="font-mono">{formatDuration(resultData.durationMs)}</span>
                  </Row>
                )}
                {resultData.costUsd != null && (
                  <Row label="Total Cost">
                    <span className="font-mono font-medium text-[var(--green)]">{formatUsd(resultData.costUsd)}</span>
                  </Row>
                )}
              </Section>
            </>
          ) : canHaveFinalResult ? (
            <div className="text-label text-[var(--color-text-muted)] py-4 text-center">
              No token usage data available
            </div>
          ) : (
            <div className="text-label text-[var(--color-text-muted)] py-4 text-center">
              Job has not completed yet
            </div>
          )}

          {/* Per-attempt cost comparison */}
          {attempts.length > 1 && attempts.some((a) => a.token_input != null || a.token_output != null || a.cost_usd != null) && (
            <Section title="Cost by Attempt">
              <div className="border border-[var(--border)] rounded-lg overflow-hidden">
                <table className="w-full text-label">
                  <thead>
                    <tr className="bg-[var(--bg-2)] text-[var(--text-muted)]">
                      <th className="text-left py-2 px-3 font-medium">#</th>
                      <th className="text-left py-2 px-3 font-medium">Status</th>
                      <th className="text-right py-2 px-3 font-medium">Input</th>
                      <th className="text-right py-2 px-3 font-medium">Output</th>
                      <th className="text-right py-2 px-3 font-medium">Duration</th>
                      <th className="text-right py-2 px-3 font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attempts.map((a) => (
                      <tr key={a.attempt_number} className="border-t border-[var(--border)] hover:bg-[var(--bg-2)]">
                        <td className="py-2 px-3 font-mono">{a.attempt_number}</td>
                        <td className="py-2 px-3">
                          <span className="flex items-center gap-1.5">
                            <HealthDot status={attemptToStatus(a.status)} />
                            <span className="capitalize">{a.status}</span>
                          </span>
                        </td>
                        <td className="py-2 px-3 text-right font-mono">
                          {a.token_input != null ? formatTokens(a.token_input) : '-'}
                        </td>
                        <td className="py-2 px-3 text-right font-mono">
                          {a.token_output != null ? formatTokens(a.token_output) : '-'}
                        </td>
                        <td className="py-2 px-3 text-right font-mono">
                          {a.duration_ms != null ? formatDuration(a.duration_ms) : '-'}
                        </td>
                        <td className="py-2 px-3 text-right font-mono">
                          {a.cost_usd != null ? formatUsd(a.cost_usd) : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {/* Fallback: raw cost JSON when no structured token data exists */}
          {!resultData?.tokenUsage && attempts.every((a) => a.token_input == null && a.token_output == null) && resultData && (
            <pre className="font-mono text-label bg-[var(--color-surface-raised)] border border-[var(--border)] p-4 rounded-lg overflow-auto max-h-[40vh]">
              {JSON.stringify({
                duration_ms: resultData.durationMs,
                status: resultData.status,
                exit_code: resultData.exitCode,
              }, null, 2)}
            </pre>
          )}
        </div>
      )}
    </SlideOver>
  );
}

/* ── Helper Components ── */

function DiagnosisBanner({
  title,
  summary,
  metadata,
  tone,
  onViewLogs,
  onViewAttempts,
  onViewResult,
}: {
  title: string;
  summary: string;
  metadata: string[];
  tone: 'default' | 'success' | 'info' | 'warning' | 'error';
  onViewLogs?: () => void;
  onViewAttempts?: () => void;
  onViewResult?: () => void;
}) {
  const classes =
    tone === 'error'
      ? 'border-[var(--red)] bg-[var(--red-dim)]/45 text-[var(--red)]'
      : tone === 'warning'
        ? 'border-[var(--amber)] bg-[var(--amber-dim)]/45 text-[var(--amber)]'
        : tone === 'info'
          ? 'border-[var(--blue)] bg-[var(--blue-dim)]/45 text-[var(--blue)]'
          : tone === 'success'
            ? 'border-[var(--green)] bg-[var(--green-dim)]/45 text-[var(--green)]'
            : 'border-[var(--border)] bg-[var(--bg-2)] text-[var(--text-primary)]';

  return (
    <div className={`mb-4 rounded-lg border px-4 py-3 ${classes}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wider font-medium opacity-80">Diagnosis</div>
          <div className="mt-1 text-body font-medium">{title}</div>
          <p className="mt-1 text-label whitespace-pre-wrap break-words text-[var(--text-primary)]">
            {summary}
          </p>
          {metadata.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {metadata.map((item) => (
                <span
                  key={item}
                  className="rounded-full border border-[var(--border)] bg-[var(--bg-1)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]"
                >
                  {item}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {onViewLogs && (
            <button
              onClick={onViewLogs}
              className="rounded-md bg-[var(--text-primary)] px-3 py-1.5 text-label font-medium text-[var(--bg-1)] hover:opacity-90 transition-opacity"
            >
              View logs
            </button>
          )}
          {onViewResult && (
            <button
              onClick={onViewResult}
              className="rounded-md border border-[var(--border)] px-3 py-1.5 text-label font-medium text-[var(--text-primary)] hover:bg-[var(--bg-2)] transition-colors"
            >
              View result
            </button>
          )}
          {onViewAttempts && (
            <button
              onClick={onViewAttempts}
              className="rounded-md border border-[var(--border)] px-3 py-1.5 text-label font-medium text-[var(--text-primary)] hover:bg-[var(--bg-2)] transition-colors"
            >
              Attempts
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2.5">
      <h3 className="text-[10px] uppercase tracking-wider font-medium text-[var(--text-muted)]">{title}</h3>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start">
      <span className="w-24 text-label text-[var(--color-text-muted)] flex-shrink-0">{label}</span>
      <div className="min-w-0 flex-1 text-body">{children}</div>
    </div>
  );
}

function TokenCard({ label, count, color }: { label: string; count: number; color: 'blue' | 'green' }) {
  const bgVar = color === 'blue' ? 'var(--blue-dim)' : 'var(--green-dim)';
  const textVar = color === 'blue' ? 'var(--blue)' : 'var(--green)';
  return (
    <div
      className="rounded-lg p-3 border"
      style={{ background: bgVar, borderColor: `color-mix(in srgb, ${textVar} 30%, transparent)` }}
    >
      <div className="text-[10px] uppercase tracking-wider font-medium" style={{ color: textVar }}>
        {label}
      </div>
      <div className="font-mono text-emphasis font-medium mt-1" style={{ color: textVar }}>
        {formatTokens(count)}
      </div>
      <div className="text-[10px] text-[var(--text-muted)] font-mono mt-0.5">
        {count.toLocaleString()}
      </div>
    </div>
  );
}
