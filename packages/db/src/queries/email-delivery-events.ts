import type { Db } from '../client.js';

export interface EmailDeliveryEvent {
  id: string;
  recipient: string;
  ses_message_id: string | null;
  rfc_message_id: string | null;
  event_type: string;
  bounce_type: string | null;
  bounce_subtype: string | null;
  diagnostic: string | null;
  raw_payload: Record<string, unknown>;
  received_at: Date;
}

export interface CreateEmailDeliveryEventInput {
  id: string;
  recipient: string;
  ses_message_id?: string | null;
  rfc_message_id?: string | null;
  event_type: string;
  bounce_type?: string | null;
  bounce_subtype?: string | null;
  diagnostic?: string | null;
  raw_payload: Record<string, unknown>;
}

export interface ListEmailDeliveryEventsOptions {
  recipient?: string;
  recipients?: string[];
  eventTypes?: string[];
  limit?: number;
  since?: Date;
}

export function emailDeliveryEventQueries(db: Db) {
  return {
    async createIdempotent(input: CreateEmailDeliveryEventInput): Promise<EmailDeliveryEvent | null> {
      // ON CONFLICT (id) DO NOTHING — SNS retries are idempotent.
      const rows = await db<EmailDeliveryEvent[]>`
        INSERT INTO email_delivery_events (
          id,
          recipient,
          ses_message_id,
          rfc_message_id,
          event_type,
          bounce_type,
          bounce_subtype,
          diagnostic,
          raw_payload
        )
        VALUES (
          ${input.id},
          ${input.recipient},
          ${input.ses_message_id ?? null},
          ${input.rfc_message_id ?? null},
          ${input.event_type},
          ${input.bounce_type ?? null},
          ${input.bounce_subtype ?? null},
          ${input.diagnostic ?? null},
          ${db.json(input.raw_payload as never)}
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING *
      `;
      return rows[0] ?? null;
    },

    async list(options: ListEmailDeliveryEventsOptions = {}): Promise<EmailDeliveryEvent[]> {
      const limit = options.limit ?? 50;
      const conditions = [db`1 = 1`];

      if (options.recipient) {
        conditions.push(db`recipient = ${options.recipient.toLowerCase()}`);
      }
      if (options.recipients?.length) {
        const lowered = options.recipients.map((r) => r.toLowerCase());
        conditions.push(db`recipient = ANY(${lowered})`);
      }
      if (options.eventTypes?.length) {
        conditions.push(db`event_type = ANY(${options.eventTypes})`);
      }
      if (options.since) {
        conditions.push(db`received_at >= ${options.since}`);
      }

      const whereClause = conditions.reduce((acc, cond, i) =>
        i === 0 ? cond : db`${acc} AND ${cond}`
      );

      return db<EmailDeliveryEvent[]>`
        SELECT *
        FROM email_delivery_events
        WHERE ${whereClause}
        ORDER BY received_at DESC
        LIMIT ${limit}
      `;
    },

    async findById(id: string): Promise<EmailDeliveryEvent | null> {
      const [row] = await db<EmailDeliveryEvent[]>`
        SELECT *
        FROM email_delivery_events
        WHERE id = ${id}
        LIMIT 1
      `;
      return row ?? null;
    },
  };
}
