import type { Db } from '../client.js';

export interface OrgBalance {
  org_id: string;
  balance: string;
  currency: string;
  lifetime_in: string;
  lifetime_out: string;
  updated_at: Date;
}

export interface BalanceTransaction {
  id: string;
  org_id: string;
  type: string;
  amount: string;
  currency: string;
  description: string | null;
  source_type: string;
  source_id: string;
  created_at: Date;
}

export type BalanceTransactionType = 'credit' | 'charge' | 'refund' | 'adjustment';
export type BalanceSourceType = 'receipt' | 'payment' | 'manual' | 'promo' | 'usage_record';

export interface CreateTransactionInput {
  id: string;
  org_id: string;
  type: BalanceTransactionType;
  amount: string;
  currency: string;
  description?: string | null;
  source_type: BalanceSourceType;
  source_id: string;
}

export interface ListTransactionsOptions {
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
}

export function balanceLedgerQueries(db: Db) {
  return {
    /**
     * Get the current balance for an org. Returns null if no balance row exists.
     */
    async getBalance(orgId: string): Promise<OrgBalance | null> {
      const [row] = await db<OrgBalance[]>`
        SELECT * FROM org_balances WHERE org_id = ${orgId}
      `;
      return row ?? null;
    },

    /**
     * Ensure an org_balances row exists with default 0 balance.
     * If the row already exists, returns it unchanged.
     * Currency changes are disallowed if any transactions exist for the org.
     */
    async ensureBalance(orgId: string, currency: string): Promise<OrgBalance> {
      const normalized = currency.toLowerCase();

      // Check for existing row first.
      const [existing] = await db<OrgBalance[]>`
        SELECT * FROM org_balances WHERE org_id = ${orgId}
      `;

      if (existing) {
        // If the currency differs, verify there are no transactions before allowing a change.
        if (existing.currency !== normalized) {
          const [txCount] = await db<{ count: number }[]>`
            SELECT COUNT(*)::int AS count FROM balance_transactions WHERE org_id = ${orgId}
          `;
          if (txCount && txCount.count > 0) {
            throw new Error(
              `Cannot change currency from '${existing.currency}' to '${normalized}' for org ${orgId}: ${txCount.count} transaction(s) already exist`,
            );
          }
          // No transactions yet — safe to update currency.
          const [updated] = await db<OrgBalance[]>`
            UPDATE org_balances
            SET currency = ${normalized}, updated_at = NOW()
            WHERE org_id = ${orgId}
            RETURNING *
          `;
          return updated;
        }
        return existing;
      }

      // Insert new row.
      const [row] = await db<OrgBalance[]>`
        INSERT INTO org_balances (org_id, balance, currency, lifetime_in, lifetime_out)
        VALUES (${orgId}, 0, ${normalized}, 0, 0)
        ON CONFLICT (org_id) DO NOTHING
        RETURNING *
      `;

      // ON CONFLICT DO NOTHING may return nothing in a race; re-read.
      if (!row) {
        const [raceRow] = await db<OrgBalance[]>`
          SELECT * FROM org_balances WHERE org_id = ${orgId}
        `;
        return raceRow;
      }

      return row;
    },

    /**
     * Create a balance transaction and atomically update the org balance.
     *
     * Uses an explicit SQL transaction with FOR UPDATE on org_balances for
     * concurrency safety. The UNIQUE(org_id, source_type, source_id) constraint
     * provides idempotency — duplicate inserts raise a unique violation.
     *
     * Returns the created transaction, or the existing one if idempotent.
     */
    async createTransaction(input: CreateTransactionInput): Promise<BalanceTransaction> {
      // Check for existing transaction first (idempotency fast path).
      const [existing] = await db<BalanceTransaction[]>`
        SELECT * FROM balance_transactions
        WHERE org_id = ${input.org_id}
          AND source_type = ${input.source_type}
          AND source_id = ${input.source_id}
      `;
      if (existing) return existing;

      // Compute balance delta and lifetime buckets based on transaction type.
      const amount = input.amount;
      let balanceDelta: string;
      let lifetimeInDelta = '0';
      let lifetimeOutDelta = '0';

      switch (input.type) {
        case 'credit':
        case 'refund':
          // Adds to balance, adds to lifetime_in.
          balanceDelta = amount;
          lifetimeInDelta = amount;
          break;
        case 'charge':
          // Subtracts from balance, adds to lifetime_out.
          balanceDelta = `-${amount}`;
          lifetimeOutDelta = amount;
          break;
        case 'adjustment':
          // Positive adjustments add to balance + lifetime_in;
          // negative adjustments subtract from balance + add to lifetime_out.
          // The sign of `amount` determines direction.
          balanceDelta = amount;
          // If the amount is negative, it goes into lifetime_out as the absolute value.
          // If positive, it goes into lifetime_in.
          // We let SQL handle the math: GREATEST/LEAST split.
          break;
        default:
          throw new Error(`Unknown transaction type: ${input.type}`);
      }

      const description = input.description ?? null;

      // Use a SQL transaction for atomicity.
      // Cast tx to Db to satisfy TypeScript (postgres.js TransactionSql is structurally compatible).
      const results = await db.begin(async (rawTx) => {
        const tx = rawTx as unknown as Db;

        // Lock the org_balances row for update.
        const [lockedBalance] = await tx<OrgBalance[]>`
          SELECT * FROM org_balances
          WHERE org_id = ${input.org_id}
          FOR UPDATE
        `;

        if (!lockedBalance) {
          throw new Error(
            `No org_balances row for org ${input.org_id}. Call ensureBalance() first.`,
          );
        }

        // Verify currency matches.
        if (lockedBalance.currency !== input.currency.toLowerCase()) {
          throw new Error(
            `Currency mismatch: org balance is '${lockedBalance.currency}' but transaction uses '${input.currency.toLowerCase()}'`,
          );
        }

        // Insert the transaction.
        const [txRow] = await tx<BalanceTransaction[]>`
          INSERT INTO balance_transactions (id, org_id, type, amount, currency, description, source_type, source_id)
          VALUES (
            ${input.id},
            ${input.org_id},
            ${input.type},
            ${input.amount},
            ${input.currency.toLowerCase()},
            ${description},
            ${input.source_type},
            ${input.source_id}
          )
          RETURNING *
        `;

        // Update org_balances atomically.
        if (input.type === 'adjustment') {
          // For adjustments, amount can be positive or negative.
          await tx`
            UPDATE org_balances
            SET
              balance = balance + ${input.amount}::numeric,
              lifetime_in = lifetime_in + GREATEST(${input.amount}::numeric, 0),
              lifetime_out = lifetime_out + ABS(LEAST(${input.amount}::numeric, 0)),
              updated_at = NOW()
            WHERE org_id = ${input.org_id}
          `;
        } else {
          await tx`
            UPDATE org_balances
            SET
              balance = balance + ${balanceDelta}::numeric,
              lifetime_in = lifetime_in + ${lifetimeInDelta}::numeric,
              lifetime_out = lifetime_out + ${lifetimeOutDelta}::numeric,
              updated_at = NOW()
            WHERE org_id = ${input.org_id}
          `;
        }

        return txRow;
      });

      return results;
    },

    /**
     * List balance transactions for an org with optional pagination and date filters.
     */
    async listTransactions(
      orgId: string,
      opts?: ListTransactionsOptions,
    ): Promise<BalanceTransaction[]> {
      const limit = opts?.limit && Number.isFinite(opts.limit) ? Math.max(1, Math.floor(opts.limit)) : 50;
      const offset = opts?.offset && Number.isFinite(opts.offset) ? Math.max(0, Math.floor(opts.offset)) : 0;
      const since = opts?.since ?? null;
      const until = opts?.until ?? null;

      return db<BalanceTransaction[]>`
        SELECT * FROM balance_transactions
        WHERE org_id = ${orgId}
          AND (${since}::timestamptz IS NULL OR created_at >= ${since}::timestamptz)
          AND (${until}::timestamptz IS NULL OR created_at <= ${until}::timestamptz)
        ORDER BY created_at DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `;
    },

    /**
     * Look up a transaction by its source for idempotency checks.
     */
    async getTransactionBySource(
      orgId: string,
      sourceType: string,
      sourceId: string,
    ): Promise<BalanceTransaction | null> {
      const [row] = await db<BalanceTransaction[]>`
        SELECT * FROM balance_transactions
        WHERE org_id = ${orgId}
          AND source_type = ${sourceType}
          AND source_id = ${sourceId}
      `;
      return row ?? null;
    },
  };
}
