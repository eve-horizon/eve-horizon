import type { CloudCostCoverage } from '@eve/db';

export type CloudCostScopeType = 'cluster' | 'environment' | 'account' | 'project';
export type CloudCostConfidence = 'estimate' | 'reconciled' | 'unavailable';

export interface CloudCostScopeConfig {
  provider: string;
  source: string;
  accountId?: string;
  billingAccountId?: string;
  scopeType: CloudCostScopeType;
  scopeKey: string;
  scopeLabel: string;
  currency: string;
  coverage: CloudCostCoverage;
  filter: Record<string, unknown>;
}

export interface CloudCostResult {
  amount: number;
  projectedAmount: number | null;
  currency: string;
  windowStart: Date;
  windowEnd: Date;
  mtdThrough: string | null;
  confidence: CloudCostConfidence;
  coverage: CloudCostCoverage;
  filter: Record<string, unknown>;
  breakdown: Record<string, unknown>;
}

export interface CloudCostProvider {
  readonly provider: string;
  readonly source: string;
  fetchMonthToDate(scope: CloudCostScopeConfig, now: Date): Promise<CloudCostResult | null>;
}

export function monthStartUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
}

export function utcDateString(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

export function addUtcDays(date: Date, days: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days, 0, 0, 0, 0));
}

export function daysInUtcMonth(date: Date): number {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

export function wholeUtcDaysBetween(start: Date, end: Date): number {
  return Math.floor((Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate())
    - Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())) / 86_400_000);
}
