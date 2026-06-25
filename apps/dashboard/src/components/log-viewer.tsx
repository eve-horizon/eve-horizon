import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  Download,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  X,
  Copy,
  Check,
  Clock,
  WrapText,
  Hash,
  RefreshCw,
} from 'lucide-react';
import { createEventSource, api, ApiError } from '@/lib/api';

interface LogViewerProps {
  jobId: string;
  attemptNumber?: number;
  isActive?: boolean;
}

interface LogLine {
  seq: number;
  text: string;
  level?: string;
  timestamp?: string;
}

interface ApiLogEntry {
  sequence?: number;
  timestamp?: string;
  type?: string;
  text?: string;
  line?: {
    stream?: string;
    [key: string]: unknown;
  };
}

type LogHistoryEnvelope = { lines?: LogLine[]; logs?: ApiLogEntry[] };
type LogHistoryResponse = LogHistoryEnvelope | LogLine[] | ApiLogEntry[] | LogLine | ApiLogEntry;

type LogLevel = 'info' | 'warn' | 'error';

const LINE_HEIGHT = 20;
const OVERSCAN = 20; // Extra lines above/below viewport to render

// Simple ANSI to HTML conversion for common codes
function ansiToHtml(text: string): string {
  return text
    .replace(/\x1b\[0m/g, '</span>')
    .replace(/\x1b\[1m/g, '<span class="font-bold">')
    .replace(/\x1b\[31m/g, '<span class="text-red-400">')
    .replace(/\x1b\[32m/g, '<span class="text-green-400">')
    .replace(/\x1b\[33m/g, '<span class="text-yellow-400">')
    .replace(/\x1b\[34m/g, '<span class="text-blue-400">')
    .replace(/\x1b\[35m/g, '<span class="text-purple-400">')
    .replace(/\x1b\[36m/g, '<span class="text-cyan-400">')
    .replace(/\x1b\[90m/g, '<span class="text-gray-500">')
    .replace(/\x1b\[\d+(?:;\d+)*m/g, ''); // strip unhandled codes
}

// Strip ANSI codes for plain-text operations (search, copy)
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[\d+(?:;\d+)*m/g, '');
}

// Detect log level from line content
function detectLevel(text: string): LogLevel {
  const plain = stripAnsi(text).toLowerCase();
  if (/\berror\b|\bfatal\b|\bpanic\b|\bexception\b/.test(plain)) return 'error';
  if (/\bwarn(?:ing)?\b/.test(plain)) return 'warn';
  return 'info';
}

function resolveEntryLevel(entry: ApiLogEntry): LogLevel {
  if (entry.type === 'error') return 'error';
  if (entry.type === 'warning') return 'warn';
  if (entry.type === 'status') return 'info';
  if (entry.line?.stream === 'stderr') {
    return detectLevel(entry.text ?? '') === 'info' ? 'warn' : detectLevel(entry.text ?? '');
  }
  return detectLevel(entry.text ?? '');
}

function normalizeLogResponse(data: LogHistoryResponse): LogLine[] {
  if (Array.isArray(data)) {
    return data.map((entry, index) => normalizeLogEntry(entry, index));
  }

  if ('logs' in data && Array.isArray(data.logs)) {
    return data.logs.map((entry, index) => normalizeLogEntry(entry, index));
  }

  if ('lines' in data && Array.isArray(data.lines)) {
    return data.lines.map((entry, index) => normalizeLogEntry(entry, index));
  }

  return 'text' in data || 'sequence' in data || 'seq' in data
    ? [normalizeLogEntry(data as LogLine | ApiLogEntry, 0)]
    : [];
}

function normalizeLogEntry(entry: LogLine | ApiLogEntry, index: number): LogLine {
  if ('seq' in entry && 'text' in entry) {
    return {
      seq: entry.seq ?? index + 1,
      text: entry.text ?? '',
      level: entry.level ?? detectLevel(entry.text ?? ''),
      timestamp: entry.timestamp,
    };
  }

  return {
    seq: entry.sequence ?? index + 1,
    text: entry.text ?? '',
    level: resolveEntryLevel(entry),
    timestamp: entry.timestamp,
  };
}

function buildSearchRegex(search: string, isRegex: boolean, global = false): RegExp | null {
  if (!search) return null;
  const flags = global ? 'gi' : 'i';
  try {
    return isRegex ? new RegExp(search, flags) : new RegExp(escapeRegex(search), flags);
  } catch {
    return null;
  }
}

function lineMatchesSearch(line: LogLine, searchRegex: RegExp | null): boolean {
  if (!searchRegex) return false;
  const regex = new RegExp(searchRegex.source, searchRegex.flags);
  return regex.test(stripAnsi(line.text));
}

// Highlight search matches in HTML-safe text
function highlightMatches(html: string, search: string, isRegex: boolean, isCurrentMatch: boolean): string {
  if (!search) return html;

  const regex = buildSearchRegex(search, isRegex, true);
  if (!regex) {
    return html;
  }

  return html.replace(regex, (match) => {
    const cls = isCurrentMatch
      ? 'bg-[var(--amber)] text-black rounded-sm px-px'
      : 'bg-[var(--amber-dim)] text-[var(--text-primary)] rounded-sm px-px';
    return `<span class="${cls}">${match}</span>`;
  });
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function LogViewer({ jobId, attemptNumber = 1, isActive = false }: LogViewerProps) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyStatus, setHistoryStatus] = useState<'ok' | 'missing' | 'error'>('ok');
  const [search, setSearch] = useState('');
  const [isRegex, setIsRegex] = useState(false);
  const [autoScroll, setAutoScroll] = useState(isActive);
  const [showTimestamps, setShowTimestamps] = useState(false);
  const [wordWrap, setWordWrap] = useState(true);
  const [showLineNumbers, setShowLineNumbers] = useState(true);
  const [levelFilter, setLevelFilter] = useState<Set<LogLevel>>(new Set(['info', 'warn', 'error']));
  const [copied, setCopied] = useState(false);
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [sseDisconnected, setSseDisconnected] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const reconnectAttempts = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const sseRef = useRef<EventSource | null>(null);

  // Reset state when job/attempt changes
  useEffect(() => {
    setLines([]);
    setHistoryLoading(true);
    setHistoryStatus('ok');
    setSearch('');
    setCurrentMatchIdx(0);
    setAutoScroll(isActive);
    setSseDisconnected(false);
    reconnectAttempts.current = 0;
  }, [jobId, attemptNumber, isActive]);

  // Fetch historical logs
  useEffect(() => {
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryStatus('ok');

    api<LogHistoryResponse>(`/jobs/${jobId}/attempts/${attemptNumber}/logs?after=0`)
      .then((data) => {
        if (cancelled) return;
        setLines(normalizeLogResponse(data));
        setHistoryStatus('ok');
      })
      .catch((error) => {
        if (cancelled) return;
        setLines([]);
        if (error instanceof ApiError && error.status === 404) {
          setHistoryStatus('missing');
          return;
        }
        setHistoryStatus('error');
      })
      .finally(() => {
        if (!cancelled) {
          setHistoryLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [jobId, attemptNumber]);

  // SSE streaming for active jobs with reconnect
  const connectSSE = useCallback(() => {
    if (!isActive) return;
    if (sseRef.current) {
      sseRef.current.close();
    }
    const source = createEventSource(`/jobs/${jobId}/stream`);
    sseRef.current = source;
    setSseDisconnected(false);

    source.onmessage = (e) => {
      reconnectAttempts.current = 0; // Reset on successful message
      try {
        const data = JSON.parse(e.data) as LogHistoryResponse;
        setLines((prev) => [...prev, ...normalizeLogResponse(data)]);
      } catch {
        // ignore parse errors
      }
    };

    source.onerror = () => {
      source.close();
      sseRef.current = null;
      setSseDisconnected(true);

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s max
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30_000);
      reconnectAttempts.current++;

      reconnectTimer.current = setTimeout(() => {
        connectSSE();
      }, delay);
    };
  }, [jobId, isActive]);

  useEffect(() => {
    connectSSE();
    return () => {
      sseRef.current?.close();
      sseRef.current = null;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [connectSSE]);

  // Measure container height via ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Auto-scroll when new lines arrive
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      const el = containerRef.current;
      el.scrollTop = el.scrollHeight - el.clientHeight;
    }
  }, [lines, autoScroll]);

  // Detect manual scroll-up to disengage auto-scroll
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    if (!atBottom && autoScroll) setAutoScroll(false);
    if (atBottom && !autoScroll) setAutoScroll(true);
  }, [autoScroll]);

  // Apply level filtering
  const levelFilteredLines = useMemo(() => {
    if (levelFilter.size === 3) return lines; // All enabled — skip work
    return lines.filter((l) => {
      const level = l.level ? (l.level.toLowerCase() as LogLevel) : detectLevel(l.text);
      return levelFilter.has(level);
    });
  }, [lines, levelFilter]);

  const searchRegex = useMemo(() => buildSearchRegex(search, isRegex), [search, isRegex]);
  const invalidRegex = Boolean(search) && isRegex && searchRegex == null;
  const displayLines = levelFilteredLines;

  const matchingLineIndexes = useMemo(() => {
    if (!searchRegex) return [];

    const indexes: number[] = [];
    displayLines.forEach((line, index) => {
      if (lineMatchesSearch(line, searchRegex)) {
        indexes.push(index);
      }
    });
    return indexes;
  }, [displayLines, searchRegex]);

  const matchingLineSet = useMemo(() => new Set(matchingLineIndexes), [matchingLineIndexes]);
  const totalMatches = matchingLineIndexes.length;
  const showEmptyLogState = !historyLoading && displayLines.length === 0;
  const showNoSearchMatches = !historyLoading && !invalidRegex && Boolean(search) && totalMatches === 0 && displayLines.length > 0;

  // Navigate to next/prev match
  const goToMatch = useCallback((idx: number) => {
    if (matchingLineIndexes.length === 0) return;
    const clamped = ((idx % matchingLineIndexes.length) + matchingLineIndexes.length) % matchingLineIndexes.length;
    setCurrentMatchIdx(clamped);
    const lineIndex = matchingLineIndexes[clamped] ?? 0;
    if (containerRef.current) {
      containerRef.current.scrollTop = lineIndex * LINE_HEIGHT - containerHeight / 2;
    }
  }, [matchingLineIndexes, containerHeight]);

  const nextMatch = useCallback(() => goToMatch(currentMatchIdx + 1), [currentMatchIdx, goToMatch]);
  const prevMatch = useCallback(() => goToMatch(currentMatchIdx - 1), [currentMatchIdx, goToMatch]);

  useEffect(() => {
    if (currentMatchIdx >= matchingLineIndexes.length && matchingLineIndexes.length > 0) {
      setCurrentMatchIdx(0);
    }
  }, [currentMatchIdx, matchingLineIndexes.length]);

  // Keyboard shortcuts for search navigation
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (!search) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        nextMatch();
      } else if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        prevMatch();
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [search, nextMatch, prevMatch]);

  // Virtual scrolling calculations
  const useVirtualScrolling = displayLines.length > 1000 && !wordWrap;
  const totalHeight = displayLines.length * LINE_HEIGHT;
  const visibleStart = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN);
  const visibleEnd = Math.min(displayLines.length, Math.ceil((scrollTop + containerHeight) / LINE_HEIGHT) + OVERSCAN);
  const visibleLines = useVirtualScrolling
    ? displayLines.slice(visibleStart, visibleEnd)
    : displayLines;

  // Download handler
  const handleDownload = () => {
    const text = lines.map((l) => {
      const prefix = l.timestamp && showTimestamps ? `[${l.timestamp}] ` : '';
      return prefix + stripAnsi(l.text);
    }).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${jobId}-attempt-${attemptNumber}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Copy visible content
  const handleCopy = async () => {
    const text = displayLines.map((l) => {
      const prefix = l.timestamp && showTimestamps ? `[${l.timestamp}] ` : '';
      return prefix + stripAnsi(l.text);
    }).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: create a hidden textarea
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Toggle a log level
  const toggleLevel = (level: LogLevel) => {
    setLevelFilter((prev) => {
      const next = new Set(prev);
      if (next.has(level)) {
        // Don't allow disabling all levels
        if (next.size > 1) next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  };

  // Jump to bottom (re-engage auto-scroll)
  const jumpToBottom = () => {
    setAutoScroll(true);
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--bg-1)] flex-shrink-0">
        {/* Search input */}
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <Search size={13} className="text-[var(--color-text-muted)] flex-shrink-0" />
          <input
            type="text"
            placeholder={isRegex ? 'Regex search...' : 'Search logs...'}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setCurrentMatchIdx(0); }}
            className="flex-1 min-w-0 bg-transparent text-body outline-none placeholder:text-[var(--color-text-muted)]"
          />
          {search && (
            <ToolbarButton
              onClick={() => {
                setSearch('');
                setCurrentMatchIdx(0);
              }}
              title="Clear search"
            >
              <X size={12} />
            </ToolbarButton>
          )}
          {invalidRegex && (
            <span className="text-[10px] text-[var(--red)] whitespace-nowrap flex-shrink-0">
              Invalid regex
            </span>
          )}
          {!invalidRegex && search && totalMatches > 0 && (
            <span className="text-[10px] text-[var(--text-muted)] whitespace-nowrap flex-shrink-0">
              {currentMatchIdx + 1} of {totalMatches} matches
            </span>
          )}
          {!invalidRegex && search && totalMatches === 0 && (
            <span className="text-[10px] text-[var(--red)] whitespace-nowrap flex-shrink-0">
              No matches
            </span>
          )}
        </div>

        {/* Search navigation */}
        {search && (
          <>
            <ToolbarButton onClick={prevMatch} title="Previous match (Shift+Enter)" disabled={totalMatches === 0 || invalidRegex}>
              <ArrowUp size={13} />
            </ToolbarButton>
            <ToolbarButton onClick={nextMatch} title="Next match (Enter)" disabled={totalMatches === 0 || invalidRegex}>
              <ArrowDown size={13} />
            </ToolbarButton>
          </>
        )}

        {/* Regex toggle */}
        <ToolbarButton
          onClick={() => setIsRegex((v) => !v)}
          title="Toggle regex search"
          active={isRegex}
        >
          <span className="text-[10px] font-mono font-bold leading-none">.*</span>
        </ToolbarButton>

        <ToolbarSep />

        {/* Level filters */}
        <div className="flex items-center gap-0.5">
          <ToolbarButton
            onClick={() => toggleLevel('info')}
            title="Toggle info lines"
            active={levelFilter.has('info')}
          >
            <span className="text-[10px] font-medium text-[var(--blue)]">Info</span>
          </ToolbarButton>
          <ToolbarButton
            onClick={() => toggleLevel('warn')}
            title="Toggle warning lines"
            active={levelFilter.has('warn')}
          >
            <span className="text-[10px] font-medium text-[var(--amber)]">Warn</span>
          </ToolbarButton>
          <ToolbarButton
            onClick={() => toggleLevel('error')}
            title="Toggle error lines"
            active={levelFilter.has('error')}
          >
            <span className="text-[10px] font-medium text-[var(--red)]">Error</span>
          </ToolbarButton>
        </div>

        <ToolbarSep />

        {/* Display toggles */}
        <ToolbarButton
          onClick={() => setShowTimestamps((v) => !v)}
          title="Toggle timestamps"
          active={showTimestamps}
        >
          <Clock size={13} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => setWordWrap((v) => !v)}
          title="Toggle word wrap"
          active={wordWrap}
        >
          <WrapText size={13} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => setShowLineNumbers((v) => !v)}
          title="Toggle line numbers"
          active={showLineNumbers}
        >
          <Hash size={13} />
        </ToolbarButton>

        <ToolbarSep />

        {/* Actions */}
        <ToolbarButton onClick={handleCopy} title="Copy visible log content">
          {copied ? <Check size={13} className="text-[var(--green)]" /> : <Copy size={13} />}
        </ToolbarButton>
        <ToolbarButton onClick={handleDownload} title="Download full log">
          <Download size={13} />
        </ToolbarButton>

        {/* Line count */}
        <span className="text-[10px] text-[var(--color-text-muted)] ml-1 whitespace-nowrap">
          {displayLines.length === lines.length
            ? `${lines.length} lines`
            : `${displayLines.length}/${lines.length} shown`}
        </span>
      </div>

      {search && !invalidRegex && totalMatches > 0 && (
        <div className="px-3 py-1 border-b border-[var(--color-border)] text-[10px] text-[var(--text-muted)] bg-[var(--bg-1)]">
          Search jumps between matching lines. Press Enter for next, Shift+Enter for previous.
        </div>
      )}

      {/* SSE Reconnect indicator */}
      {sseDisconnected && isActive && (
        <div className="flex items-center gap-2 px-3 py-1 bg-[var(--amber-dim)] border-b border-[var(--amber)] text-[10px] text-[var(--amber)] flex-shrink-0">
          <RefreshCw size={10} className="animate-spin" />
          <span>Stream disconnected. Reconnecting...</span>
        </div>
      )}

      {/* Log Content */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-hidden font-mono text-label leading-[20px] relative"
      >
        {historyLoading && lines.length === 0 ? (
          <div className="flex items-center justify-center h-full text-[var(--color-text-muted)]">
            Loading logs...
          </div>
        ) : showEmptyLogState ? (
          <div className="flex items-center justify-center h-full px-6 text-center text-[var(--color-text-muted)]">
            {historyStatus === 'missing'
              ? 'No logs recorded for this attempt yet.'
              : historyStatus === 'error'
                ? 'Log output is unavailable right now.'
                : displayLines.length === 0 && lines.length === 0
                  ? 'No log lines yet.'
                  : 'No log lines match the current filters.'}
          </div>
        ) : showNoSearchMatches ? (
          <div className="flex items-center justify-center h-full px-6 text-center text-[var(--color-text-muted)]">
            No log lines match the current search.
          </div>
        ) : useVirtualScrolling ? (
          // Virtual scrolling for large logs
          <div style={{ height: totalHeight, position: 'relative' }}>
            <div style={{ position: 'absolute', top: visibleStart * LINE_HEIGHT, left: 0, right: 0 }}>
              {visibleLines.map((line, i) => {
                const lineIdx = visibleStart + i;
                return (
                  <LogLineRow
                    key={line.seq ?? lineIdx}
                    line={line}
                    lineIdx={lineIdx}
                    showLineNumbers={showLineNumbers}
                    showTimestamps={showTimestamps}
                    wordWrap={wordWrap}
                    search={search}
                    isRegex={isRegex}
                    isMatchingLine={matchingLineSet.has(lineIdx)}
                    isCurrentMatch={matchingLineIndexes[currentMatchIdx] === lineIdx}
                  />
                );
              })}
            </div>
          </div>
        ) : (
          // Normal rendering for smaller logs
          displayLines.map((line, i) => (
            <LogLineRow
              key={line.seq ?? i}
              line={line}
              lineIdx={i}
              showLineNumbers={showLineNumbers}
              showTimestamps={showTimestamps}
              wordWrap={wordWrap}
              search={search}
              isRegex={isRegex}
              isMatchingLine={matchingLineSet.has(i)}
              isCurrentMatch={matchingLineIndexes[currentMatchIdx] === i}
            />
          ))
        )}
      </div>

      {/* Jump to Bottom FAB */}
      {!autoScroll && (
        <button
          onClick={jumpToBottom}
          className="absolute bottom-4 right-6 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--bg-4)] border border-[var(--border-bright)] text-label text-[var(--text-secondary)] shadow-lg hover:bg-[var(--bg-3)] hover:text-[var(--text-primary)] transition-all z-10"
        >
          <ChevronDown size={14} />
          Jump to bottom
        </button>
      )}
    </div>
  );
}

/* ── Line Row ── */

interface LogLineRowProps {
  line: LogLine;
  lineIdx: number;
  showLineNumbers: boolean;
  showTimestamps: boolean;
  wordWrap: boolean;
  search: string;
  isRegex: boolean;
  isMatchingLine: boolean;
  isCurrentMatch: boolean;
}

function LogLineRow({
  line,
  lineIdx,
  showLineNumbers,
  showTimestamps,
  wordWrap,
  search,
  isRegex,
  isMatchingLine,
  isCurrentMatch,
}: LogLineRowProps) {
  const level = line.level ? (line.level.toLowerCase() as LogLevel) : detectLevel(line.text);
  const lineNumberWidth = 48; // fixed gutter width

  // Level-based left-border accent
  const levelBorder =
    level === 'error' ? 'border-l-2 border-l-[var(--red)]' :
    level === 'warn' ? 'border-l-2 border-l-[var(--amber)]' :
    '';

  let html = ansiToHtml(line.text);
  if (search && isMatchingLine) {
    html = highlightMatches(html, search, isRegex, isCurrentMatch);
  }

  return (
    <div
      className={`flex hover:bg-[var(--color-surface-raised)] ${levelBorder} ${
        isCurrentMatch ? 'bg-[var(--amber-dim)]' : isMatchingLine ? 'bg-[var(--bg-2)]/70' : ''
      }`}
      style={{ minHeight: LINE_HEIGHT }}
    >
      {showLineNumbers && (
        <span
          className="flex-shrink-0 text-right pr-2 text-[var(--color-text-muted)] select-none border-r border-[var(--border)]"
          style={{ width: lineNumberWidth, paddingLeft: 4, paddingTop: 1 }}
        >
          {line.seq ?? lineIdx + 1}
        </span>
      )}
      {showTimestamps && line.timestamp && (
        <span className="flex-shrink-0 px-2 text-[var(--text-muted)] select-none" style={{ paddingTop: 1 }}>
          {line.timestamp}
        </span>
      )}
      <span
        className={`flex-1 px-3 ${wordWrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre overflow-hidden'}`}
        style={{ paddingTop: 1 }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

/* ── Toolbar Helpers ── */

function ToolbarButton({
  onClick,
  title,
  active,
  disabled,
  children,
}: {
  onClick: () => void;
  title: string;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`p-1 rounded transition-colors flex-shrink-0 ${
        disabled
          ? 'opacity-30 cursor-not-allowed'
          : active
            ? 'bg-[var(--blue-dim)] text-[var(--blue)]'
            : 'hover:bg-[var(--color-surface-raised)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
      }`}
    >
      {children}
    </button>
  );
}

function ToolbarSep() {
  return <div className="w-px h-4 bg-[var(--border)] flex-shrink-0 mx-0.5" />;
}
