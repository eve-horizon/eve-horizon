import { Injectable, Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import { EmailSuppressedError } from './errors.js';

export type MailerSendArgs = {
  to: string;
  fromName: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
};

type SesV2ClientLike = {
  send: (command: unknown) => Promise<{
    SuppressedDestination?: {
      Reason?: string;
      LastUpdateTime?: Date;
    };
  }>;
};

function rejectHeaderNewlines(value: string, field: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${field} must not contain newline characters`);
  }
  return value;
}

function getSmtpPort(): number {
  return Number(process.env.GOTRUE_SMTP_PORT || 587);
}

function smtpHostIsSes(host: string | undefined): boolean {
  if (!host) return false;
  return /\.amazonaws\.com$/i.test(host.trim());
}

function parseRegionFromSmtpHost(host: string | undefined): string | undefined {
  if (!host) return undefined;
  // email-smtp.us-west-2.amazonaws.com -> us-west-2
  const match = host.trim().match(/^email-smtp\.([a-z0-9-]+)\.amazonaws\.com$/i);
  return match ? match[1] : undefined;
}

function parseSesMessageId(smtpResponse: string | undefined): string | undefined {
  if (!smtpResponse) return undefined;
  // Successful SES response: "250 Ok 0101019e1626b83d-..." or "250 2.0.0 Ok ..."
  const match = smtpResponse.match(/250(?:\s+\d\.\d\.\d)?\s+Ok\s+([\w-]+)/i);
  return match ? match[1] : undefined;
}

function normalizeRecipient(email: string): string {
  return email.trim().toLowerCase();
}

@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly transport: nodemailer.Transporter<SMTPTransport.SentMessageInfo>;
  private readonly sesRegion?: string;
  private readonly checkSuppression: boolean;
  private readonly configurationSet?: string;
  private sesClient?: SesV2ClientLike;
  private sesClientInitFailed = false;

  constructor() {
    this.transport = nodemailer.createTransport({
      host: process.env.GOTRUE_SMTP_HOST,
      port: getSmtpPort(),
      secure: process.env.GOTRUE_SMTP_SECURE === 'true',
      auth: process.env.GOTRUE_SMTP_USER
        ? {
            user: process.env.GOTRUE_SMTP_USER,
            pass: process.env.GOTRUE_SMTP_PASS ?? '',
          }
        : undefined,
    } satisfies SMTPTransport.Options);

    this.sesRegion =
      process.env.EVE_MAILER_SES_REGION || parseRegionFromSmtpHost(process.env.GOTRUE_SMTP_HOST);

    this.checkSuppression = this.resolveCheckSuppression();
    this.configurationSet = process.env.EVE_SES_CONFIGURATION_SET || undefined;
  }

  async send(args: MailerSendArgs): Promise<void> {
    const fromAddr =
      process.env.MAILER_FROM_ADDRESS ??
      process.env.GOTRUE_SMTP_ADMIN_EMAIL ??
      'noreply@eve.local';

    const to = normalizeRecipient(args.to);
    await this.assertNotSuppressed(to);

    try {
      const info = await this.transport.sendMail({
        from: {
          name: rejectHeaderNewlines(args.fromName, 'fromName'),
          address: rejectHeaderNewlines(fromAddr, 'from address'),
        },
        replyTo: args.replyTo ? rejectHeaderNewlines(args.replyTo, 'replyTo') : undefined,
        to,
        subject: rejectHeaderNewlines(args.subject, 'subject'),
        html: args.html,
        text: args.text,
        headers: this.configurationSet
          ? { 'X-SES-CONFIGURATION-SET': this.configurationSet }
          : undefined,
      });

      const sesMessageId = parseSesMessageId(info.response);
      this.logger.log({
        event: 'mailer.sent',
        to,
        subject: args.subject,
        rfc_message_id: info.messageId,
        ses_message_id: sesMessageId,
        smtp_response: info.response,
      });
    } catch (err) {
      this.logger.error({
        event: 'mailer.smtp_failed',
        to,
        subject: args.subject,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private resolveCheckSuppression(): boolean {
    const raw = (process.env.EVE_MAILER_CHECK_SUPPRESSION || 'auto').trim().toLowerCase();
    if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
    if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
    return smtpHostIsSes(process.env.GOTRUE_SMTP_HOST);
  }

  private async getSesClient(): Promise<SesV2ClientLike | undefined> {
    if (!this.checkSuppression) return undefined;
    if (this.sesClient) return this.sesClient;
    if (this.sesClientInitFailed) return undefined;
    if (!this.sesRegion) {
      this.logger.warn({
        event: 'mailer.suppression_check_disabled',
        reason: 'no_region',
        smtp_host: process.env.GOTRUE_SMTP_HOST,
      });
      this.sesClientInitFailed = true;
      return undefined;
    }
    try {
      const { SESv2Client } = await import('@aws-sdk/client-sesv2');
      this.sesClient = new SESv2Client({ region: this.sesRegion }) as unknown as SesV2ClientLike;
      return this.sesClient;
    } catch (err) {
      this.logger.warn({
        event: 'mailer.suppression_check_disabled',
        reason: 'sdk_load_failed',
        error: err instanceof Error ? err.message : String(err),
      });
      this.sesClientInitFailed = true;
      return undefined;
    }
  }

  private async assertNotSuppressed(to: string): Promise<void> {
    const client = await this.getSesClient();
    if (!client) return;
    try {
      const { GetSuppressedDestinationCommand } = await import('@aws-sdk/client-sesv2');
      const res = await client.send(new GetSuppressedDestinationCommand({ EmailAddress: to }));
      if (res.SuppressedDestination) {
        const reason = res.SuppressedDestination.Reason ?? 'UNKNOWN';
        const lastUpdate = res.SuppressedDestination.LastUpdateTime?.toISOString() ?? 'unknown';
        this.logger.warn({
          event: 'mailer.suppressed',
          to,
          reason,
          last_update: lastUpdate,
        });
        throw new EmailSuppressedError(to, reason, lastUpdate);
      }
    } catch (err) {
      if (err instanceof EmailSuppressedError) throw err;
      // NotFoundException is the success case — address not on the suppression list.
      const name = (err as { name?: string } | null)?.name;
      if (name === 'NotFoundException') return;
      // Any other error (IRSA missing, throttling, network) fails open — log and let SMTP proceed
      // so a misconfigured suppression check never breaks delivery for unsuppressed addresses.
      this.logger.warn({
        event: 'mailer.suppression_check_failed',
        to,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
