/**
 * Shared formatting helpers for CLI commands.
 *
 * These are hoisted from per-command duplicates; every function here must
 * remain byte-identical in output to the copies it replaced.
 */

export function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === '') return;
    search.set(key, String(value));
  });
  const query = search.toString();
  return query ? `?${query}` : '';
}

export function parseSinceValue(since: string): string {
  // If it looks like an ISO date, return as-is
  if (since.includes('T') || since.includes('-')) {
    return since;
  }

  const match = since.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(`Invalid time format: "${since}". Use formats like "10m", "2h", "7d", or ISO timestamp.`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const now = new Date();
  switch (unit) {
    case 's':
      now.setSeconds(now.getSeconds() - value);
      break;
    case 'm':
      now.setMinutes(now.getMinutes() - value);
      break;
    case 'h':
      now.setHours(now.getHours() - value);
      break;
    case 'd':
      now.setDate(now.getDate() - value);
      break;
  }

  return now.toISOString();
}

export function parseFutureIsoOrDuration(raw: string, flagName: string): string {
  const trimmed = raw.trim();
  const durationMatch = trimmed.match(/^(\d+)([smhd])$/i);
  if (durationMatch) {
    const value = Number.parseInt(durationMatch[1], 10);
    const unit = durationMatch[2].toLowerCase();
    const ms = unit === 's'
      ? 1000
      : unit === 'm'
        ? 60_000
        : unit === 'h'
          ? 3_600_000
          : 86_400_000;
    return new Date(Date.now() + (value * ms)).toISOString();
  }

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${flagName}: ${raw}. Use ISO timestamp or duration like 30d.`);
  }
  return date.toISOString();
}

export function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleString();
  } catch {
    return dateStr;
  }
}

export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Render a simple left-aligned table: each cell is padded with padEnd to its
 * column width and cells are concatenated with no separator. Columns without
 * a width (typically the last) are emitted as-is. Returns the header line
 * followed by one line per row.
 */
export function renderTable(
  columns: Array<{ header: string; width?: number }>,
  rows: string[][],
): string[] {
  const renderRow = (cells: string[]): string =>
    cells
      .map((cell, index) => {
        const width = columns[index]?.width;
        return width === undefined ? cell : cell.padEnd(width);
      })
      .join('');
  return [renderRow(columns.map((column) => column.header)), ...rows.map(renderRow)];
}
