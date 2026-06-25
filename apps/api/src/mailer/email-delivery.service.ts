import { Inject, Injectable } from '@nestjs/common';
import {
  emailDeliveryEventQueries,
  membershipQueries,
  type EmailDeliveryEvent,
  type Db,
} from '@eve/db';

export interface EmailDeliveryEventDto {
  id: string;
  recipient: string;
  ses_message_id: string | null;
  rfc_message_id: string | null;
  event_type: string;
  bounce_type: string | null;
  bounce_subtype: string | null;
  diagnostic: string | null;
  received_at: string;
}

export interface ListOptions {
  recipient?: string;
  recipients?: string[];
  eventTypes?: string[];
  limit?: number;
  since?: Date;
}

@Injectable()
export class EmailDeliveryService {
  private readonly events: ReturnType<typeof emailDeliveryEventQueries>;
  private readonly memberships: ReturnType<typeof membershipQueries>;

  constructor(@Inject('DB') private readonly db: Db) {
    this.events = emailDeliveryEventQueries(db);
    this.memberships = membershipQueries(db);
  }

  async list(options: ListOptions = {}): Promise<EmailDeliveryEventDto[]> {
    const rows = await this.events.list(options);
    return rows.map(toDto);
  }

  /**
   * Recent delivery events filtered to recipients who are members of the given org
   * (or any project under it). Used by `eve env diagnose` to surface bounces that
   * affected actual env stakeholders without leaking unrelated cross-tenant data.
   */
  async listForOrgMembers(orgId: string, limit = 20): Promise<EmailDeliveryEventDto[]> {
    const members = await this.memberships.listOrgMembers(orgId);
    const emails = members
      .map((m) => m.email?.toLowerCase())
      .filter((e): e is string => Boolean(e));
    if (emails.length === 0) return [];
    const rows = await this.events.list({ recipients: emails, limit });
    return rows.map(toDto);
  }

  async listForProjectMembers(projectId: string, limit = 20): Promise<EmailDeliveryEventDto[]> {
    const members = await this.memberships.listProjectMembers(projectId);
    const emails = members
      .map((m) => m.email?.toLowerCase())
      .filter((e): e is string => Boolean(e));
    if (emails.length === 0) return [];
    const rows = await this.events.list({ recipients: emails, limit });
    return rows.map(toDto);
  }
}

function toDto(row: EmailDeliveryEvent): EmailDeliveryEventDto {
  return {
    id: row.id,
    recipient: row.recipient,
    ses_message_id: row.ses_message_id,
    rfc_message_id: row.rfc_message_id,
    event_type: row.event_type,
    bounce_type: row.bounce_type,
    bounce_subtype: row.bounce_subtype,
    diagnostic: row.diagnostic,
    received_at:
      row.received_at instanceof Date ? row.received_at.toISOString() : String(row.received_at),
  };
}
