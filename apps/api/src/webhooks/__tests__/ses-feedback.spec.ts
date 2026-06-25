import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, createSign } from 'node:crypto';

const createdEvents: Record<string, unknown>[] = [];

// Generate a real RSA keypair for SHA256-RSA signing — exercises the verifier path.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const certPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

vi.mock('@eve/db', () => ({
  emailDeliveryEventQueries: vi.fn(() => ({
    createIdempotent: vi.fn(async (input: Record<string, unknown>) => {
      // Simulate ON CONFLICT DO NOTHING: only insert if id not already seen.
      const existing = createdEvents.find((e) => e.id === input.id);
      if (existing) return null;
      const row = { ...input, received_at: new Date('2026-05-11T12:00:00.000Z') };
      createdEvents.push(row);
      return row;
    }),
    list: vi.fn(async () => createdEvents),
    findById: vi.fn(async (id: string) => createdEvents.find((e) => e.id === id) ?? null),
  })),
}));

const VALID_TOPIC = 'arn:aws:sns:us-west-2:111122223333:eve-ses-feedback';

function signNotification(extra?: Partial<Record<string, string>>): Record<string, string> {
  const base = {
    Type: 'Notification',
    MessageId: 'msg-test-001',
    TopicArn: VALID_TOPIC,
    Subject: 'AWS Email Receiving',
    Message: JSON.stringify({
      eventType: 'Bounce',
      bounce: {
        bounceType: 'Permanent',
        bounceSubType: 'General',
        bouncedRecipients: [
          { emailAddress: 'admin@example.com', diagnosticCode: 'smtp; 550 5.1.1' },
        ],
        timestamp: '2026-05-11T09:28:17.364Z',
        feedbackId: 'fb-001',
      },
      mail: {
        messageId: 'ses-abc-123',
        headers: [{ name: 'Message-ID', value: '<rfc-id@example>' }],
        destination: ['admin@example.com'],
      },
    }),
    Timestamp: '2026-05-11T12:00:00.000Z',
    SignatureVersion: '2',
    SigningCertURL: 'https://sns.us-west-2.amazonaws.com/SimpleNotificationService-test.pem',
    ...extra,
  };
  // Canonical string per SNS spec for a Notification: pairs of (key, value)
  // in this order joined by \n with trailing \n.
  const stringToSign =
    `Message\n${base.Message}\n` +
    `MessageId\n${base.MessageId}\n` +
    `Subject\n${base.Subject}\n` +
    `Timestamp\n${base.Timestamp}\n` +
    `TopicArn\n${base.TopicArn}\n` +
    `Type\n${base.Type}\n`;
  const signer = createSign('SHA256');
  signer.update(stringToSign, 'utf-8');
  signer.end();
  const signature = signer.sign(privateKey, 'base64');
  return { ...base, Signature: signature };
}

// Stub https.request to return our generated cert when the verifier fetches it.
vi.mock('node:https', async () => {
  return {
    request(_url: string | URL, _opts: unknown, cb?: (res: unknown) => void) {
      const handler = typeof _opts === 'function' ? (_opts as typeof cb) : cb;
      const listeners: Record<string, (chunk?: unknown) => void> = {};
      const res = {
        statusCode: 200,
        on(event: string, fn: (chunk?: unknown) => void) {
          listeners[event] = fn;
          return res;
        },
      };
      // Defer to next tick so caller can chain.
      setImmediate(() => {
        handler?.(res);
        listeners.data?.(Buffer.from(certPem));
        listeners.end?.();
      });
      return { on() { return this; }, end() {}, write() {} };
    },
  };
});

async function freshService() {
  const { SesFeedbackService } = await import('../ses-feedback.service.js');
  return new SesFeedbackService({} as never);
}

describe('SesFeedbackService', () => {
  beforeEach(() => {
    createdEvents.length = 0;
    process.env.EVE_SES_FEEDBACK_TOPIC_ARN = VALID_TOPIC;
  });

  afterEach(() => {
    delete process.env.EVE_SES_FEEDBACK_TOPIC_ARN;
    vi.resetModules();
  });

  it('persists a Bounce notification when signed correctly', async () => {
    const svc = await freshService();
    const result = await svc.handle(signNotification() as never);
    expect(result.status).toBe('notification_persisted');
    expect(result.persisted).toBe(1);
    expect(createdEvents).toHaveLength(1);
    const row = createdEvents[0] as Record<string, unknown>;
    expect(row.recipient).toBe('admin@example.com');
    expect(row.event_type).toBe('Bounce');
    expect(row.bounce_type).toBe('Permanent');
    expect(row.bounce_subtype).toBe('General');
    expect(row.ses_message_id).toBe('ses-abc-123');
    expect(row.rfc_message_id).toBe('<rfc-id@example>');
  });

  it('is idempotent under SNS retries (same MessageId)', async () => {
    const svc = await freshService();
    const payload = signNotification();
    await svc.handle(payload as never);
    const second = await svc.handle(payload as never);
    expect(second.persisted).toBe(0);
    expect(createdEvents).toHaveLength(1);
  });

  it('rejects when TopicArn does not match EVE_SES_FEEDBACK_TOPIC_ARN', async () => {
    const svc = await freshService();
    const payload = signNotification({ TopicArn: 'arn:aws:sns:us-west-2:111122223333:other-topic' });
    await expect(svc.handle(payload as never)).rejects.toThrow(/TopicArn mismatch/);
    expect(createdEvents).toHaveLength(0);
  });

  it('rejects when SigningCertURL host is not sns.<region>.amazonaws.com', async () => {
    const svc = await freshService();
    const payload = signNotification({
      SigningCertURL: 'https://attacker.example.com/cert.pem',
    });
    await expect(svc.handle(payload as never)).rejects.toThrow(/SigningCertURL host/);
    expect(createdEvents).toHaveLength(0);
  });

  it('rejects when SigningCertURL is not HTTPS', async () => {
    const svc = await freshService();
    const payload = signNotification({
      SigningCertURL: 'http://sns.us-west-2.amazonaws.com/cert.pem',
    });
    await expect(svc.handle(payload as never)).rejects.toThrow(/HTTPS/);
    expect(createdEvents).toHaveLength(0);
  });

  it('rejects when SignatureVersion is unsupported', async () => {
    const svc = await freshService();
    const payload = signNotification({ SignatureVersion: '3' });
    await expect(svc.handle(payload as never)).rejects.toThrow(/SignatureVersion/);
    expect(createdEvents).toHaveLength(0);
  });

  it('rejects when the signature does not verify', async () => {
    const svc = await freshService();
    const payload = signNotification();
    // Tamper after signing.
    (payload as Record<string, string>).Message = JSON.stringify({ eventType: 'Tampered' });
    await expect(svc.handle(payload as never)).rejects.toThrow(/signature verification/i);
    expect(createdEvents).toHaveLength(0);
  });
});
