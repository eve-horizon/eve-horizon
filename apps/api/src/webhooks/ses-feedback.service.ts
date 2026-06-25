import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, createVerify } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import type { Db } from '@eve/db';
import { emailDeliveryEventQueries } from '@eve/db';

export type SnsMessage = {
  Type?: string;
  MessageId?: string;
  Token?: string;
  TopicArn?: string;
  Message?: string;
  Timestamp?: string;
  Subject?: string;
  SubscribeURL?: string;
  Signature?: string;
  SignatureVersion?: string;
  SigningCertURL?: string;
  UnsubscribeURL?: string;
};

export class SesFeedbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SesFeedbackError';
  }
}

/**
 * In-repo SNS HTTPS message verifier + SES feedback persister.
 *
 * Follows the AWS SNS message signing spec:
 * https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
 *
 * Trust chain:
 *   1. `SigningCertURL` must be HTTPS, host must match `sns.<region>.amazonaws.com`
 *      (or `sns.<region>.amazonaws.com.cn` for China partitions).
 *   2. `TopicArn` must match the configured `EVE_SES_FEEDBACK_TOPIC_ARN` (when set).
 *   3. Signature must verify against the fetched cert with the documented
 *      canonical string and SHA256 / SHA1 algorithm based on `SignatureVersion`.
 */
@Injectable()
export class SesFeedbackService {
  private readonly logger = new Logger(SesFeedbackService.name);
  private readonly events: ReturnType<typeof emailDeliveryEventQueries>;
  private readonly expectedTopicArn?: string;

  constructor(@Inject('DB') db: Db) {
    this.events = emailDeliveryEventQueries(db);
    this.expectedTopicArn = process.env.EVE_SES_FEEDBACK_TOPIC_ARN || undefined;
  }

  async handle(payload: SnsMessage): Promise<{ status: string; persisted?: number }> {
    if (!payload || typeof payload !== 'object') {
      throw new SesFeedbackError('Empty SNS payload');
    }

    this.validateTopicArn(payload);
    await this.verifySignature(payload);

    const type = payload.Type;
    if (type === 'SubscriptionConfirmation') {
      await this.confirmSubscription(payload);
      return { status: 'subscription_confirmed' };
    }
    if (type === 'UnsubscribeConfirmation') {
      this.logger.warn({
        event: 'sns.unsubscribe_confirmation',
        topic_arn: payload.TopicArn,
        message_id: payload.MessageId,
      });
      return { status: 'unsubscribe_logged' };
    }
    if (type === 'Notification') {
      const count = await this.persistNotification(payload);
      return { status: 'notification_persisted', persisted: count };
    }
    throw new SesFeedbackError(`Unsupported SNS message Type: ${String(type)}`);
  }

  private validateTopicArn(payload: SnsMessage): void {
    if (!payload.TopicArn) {
      throw new SesFeedbackError('TopicArn missing');
    }
    if (this.expectedTopicArn && payload.TopicArn !== this.expectedTopicArn) {
      throw new SesFeedbackError(
        `TopicArn mismatch: got=${payload.TopicArn} expected=${this.expectedTopicArn}`,
      );
    }
  }

  private async verifySignature(payload: SnsMessage): Promise<void> {
    const signatureVersion = payload.SignatureVersion;
    if (signatureVersion !== '1' && signatureVersion !== '2') {
      throw new SesFeedbackError(`Unsupported SignatureVersion: ${signatureVersion}`);
    }
    const certUrl = payload.SigningCertURL;
    if (!certUrl) {
      throw new SesFeedbackError('SigningCertURL missing');
    }
    const parsed = (() => {
      try {
        return new URL(certUrl);
      } catch {
        throw new SesFeedbackError('SigningCertURL is not a valid URL');
      }
    })();
    if (parsed.protocol !== 'https:') {
      throw new SesFeedbackError('SigningCertURL must use HTTPS');
    }
    if (!/^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(parsed.hostname)) {
      throw new SesFeedbackError(`SigningCertURL host not allowed: ${parsed.hostname}`);
    }
    if (!payload.Signature) {
      throw new SesFeedbackError('Signature missing');
    }

    const cert = await this.fetchCert(parsed.toString());
    const stringToSign = this.buildStringToSign(payload);
    const algorithm = signatureVersion === '2' ? 'SHA256' : 'SHA1';
    const verify = createVerify(algorithm);
    verify.update(stringToSign, 'utf-8');
    verify.end();
    const ok = verify.verify(cert, payload.Signature, 'base64');
    if (!ok) {
      throw new SesFeedbackError('SNS signature verification failed');
    }
  }

  private buildStringToSign(payload: SnsMessage): string {
    const type = payload.Type;
    const parts: string[] = [];
    const push = (key: string, value: string | undefined) => {
      if (value === undefined) return;
      parts.push(key);
      parts.push(value);
    };

    if (type === 'Notification') {
      push('Message', payload.Message);
      push('MessageId', payload.MessageId);
      push('Subject', payload.Subject);
      push('Timestamp', payload.Timestamp);
      push('TopicArn', payload.TopicArn);
      push('Type', payload.Type);
    } else if (type === 'SubscriptionConfirmation' || type === 'UnsubscribeConfirmation') {
      push('Message', payload.Message);
      push('MessageId', payload.MessageId);
      push('SubscribeURL', payload.SubscribeURL);
      push('Timestamp', payload.Timestamp);
      push('Token', payload.Token);
      push('TopicArn', payload.TopicArn);
      push('Type', payload.Type);
    } else {
      throw new SesFeedbackError(`Unsupported SNS Type for signing: ${String(type)}`);
    }

    // Each key/value separated by newline, plus trailing newline.
    return parts.join('\n') + '\n';
  }

  private async fetchCert(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = httpsRequest(url, { method: 'GET' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new SesFeedbackError(`Cert fetch failed: status ${res.statusCode}`));
            return;
          }
          resolve(Buffer.concat(chunks).toString('utf-8'));
        });
        res.on('error', (err) => reject(err));
      });
      req.on('error', (err) => reject(err));
      req.end();
    });
  }

  private async confirmSubscription(payload: SnsMessage): Promise<void> {
    if (!payload.SubscribeURL) {
      throw new SesFeedbackError('SubscribeURL missing on SubscriptionConfirmation');
    }
    const parsed = new URL(payload.SubscribeURL);
    if (parsed.protocol !== 'https:') {
      throw new SesFeedbackError('SubscribeURL must use HTTPS');
    }
    if (!/^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(parsed.hostname)) {
      throw new SesFeedbackError(`SubscribeURL host not allowed: ${parsed.hostname}`);
    }
    this.logger.log({
      event: 'sns.subscription_confirming',
      topic_arn: payload.TopicArn,
    });
    await this.fetchCert(parsed.toString()); // GET to confirm; ignore body
    this.logger.log({
      event: 'sns.subscription_confirmed',
      topic_arn: payload.TopicArn,
    });
  }

  private async persistNotification(payload: SnsMessage): Promise<number> {
    if (!payload.Message) {
      throw new SesFeedbackError('Notification Message body missing');
    }
    let ses: Record<string, unknown>;
    try {
      ses = JSON.parse(payload.Message) as Record<string, unknown>;
    } catch (err) {
      throw new SesFeedbackError(
        `Notification Message body is not JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const eventType = (ses.eventType ?? ses.notificationType ?? 'Unknown') as string;
    const mail = (ses.mail ?? {}) as Record<string, unknown>;
    const sesMessageId = (mail.messageId as string | undefined) ?? undefined;
    const headers = (mail.headers as Array<{ name?: string; value?: string }> | undefined) ?? [];
    const rfcMessageId = headers.find((h) => h?.name?.toLowerCase() === 'message-id')?.value;

    const recipients = this.extractRecipients(eventType, ses, mail);
    if (recipients.length === 0) {
      this.logger.warn({
        event: 'ses.feedback_no_recipients',
        ses_event_type: eventType,
        sns_message_id: payload.MessageId,
      });
      return 0;
    }

    const bounceType = ((ses.bounce as Record<string, unknown> | undefined)?.bounceType as
      | string
      | undefined) ?? undefined;
    const bounceSubtype = ((ses.bounce as Record<string, unknown> | undefined)?.bounceSubType as
      | string
      | undefined) ?? undefined;

    let persisted = 0;
    for (const { recipient, diagnostic } of recipients) {
      const id = this.buildIdempotentId(payload.MessageId ?? '', eventType, recipient);
      const inserted = await this.events.createIdempotent({
        id,
        recipient: recipient.toLowerCase(),
        ses_message_id: sesMessageId ?? null,
        rfc_message_id: rfcMessageId ?? null,
        event_type: eventType,
        bounce_type: bounceType ?? null,
        bounce_subtype: bounceSubtype ?? null,
        diagnostic: diagnostic ?? null,
        raw_payload: ses,
      });
      if (inserted) {
        persisted += 1;
        this.logger.log({
          event: 'ses.feedback_persisted',
          ses_event_type: eventType,
          ses_message_id: sesMessageId,
          recipient,
          bounce_type: bounceType,
          bounce_subtype: bounceSubtype,
        });
      } else {
        this.logger.debug?.({
          event: 'ses.feedback_duplicate',
          ses_event_type: eventType,
          ses_message_id: sesMessageId,
          recipient,
        });
      }
    }
    return persisted;
  }

  private extractRecipients(
    eventType: string,
    ses: Record<string, unknown>,
    mail: Record<string, unknown>,
  ): Array<{ recipient: string; diagnostic?: string }> {
    const lower = eventType.toLowerCase();
    if (lower === 'bounce') {
      const bounce = (ses.bounce as Record<string, unknown> | undefined) ?? {};
      const list = (bounce.bouncedRecipients as Array<Record<string, unknown>> | undefined) ?? [];
      return list
        .map((r) => ({
          recipient: (r.emailAddress as string | undefined) ?? '',
          diagnostic: (r.diagnosticCode as string | undefined) ?? undefined,
        }))
        .filter((r) => r.recipient);
    }
    if (lower === 'complaint') {
      const complaint = (ses.complaint as Record<string, unknown> | undefined) ?? {};
      const list = (complaint.complainedRecipients as Array<Record<string, unknown>> | undefined) ?? [];
      return list
        .map((r) => ({
          recipient: (r.emailAddress as string | undefined) ?? '',
          diagnostic: (complaint.complaintFeedbackType as string | undefined) ?? undefined,
        }))
        .filter((r) => r.recipient);
    }
    if (lower === 'delivery') {
      const delivery = (ses.delivery as Record<string, unknown> | undefined) ?? {};
      const list = (delivery.recipients as string[] | undefined) ?? [];
      return list.map((recipient) => ({ recipient }));
    }
    // Fallback: use mail.destination
    const dest = (mail.destination as string[] | undefined) ?? [];
    return dest.map((recipient) => ({ recipient }));
  }

  private buildIdempotentId(snsMessageId: string, eventType: string, recipient: string): string {
    const hash = createHash('sha256');
    hash.update(snsMessageId);
    hash.update('|');
    hash.update(eventType);
    hash.update('|');
    hash.update(recipient.toLowerCase());
    return `ede_${hash.digest('hex').slice(0, 24)}`;
  }
}
