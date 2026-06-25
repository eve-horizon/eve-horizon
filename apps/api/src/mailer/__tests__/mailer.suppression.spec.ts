import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMail = vi.fn();
const sesSend = vi.fn();

class GetSuppressedDestinationCommand {
  readonly input: { EmailAddress: string };
  constructor(input: { EmailAddress: string }) {
    this.input = input;
  }
}

class NotFoundException extends Error {
  override readonly name = 'NotFoundException';
}

class ThrottlingException extends Error {
  override readonly name = 'ThrottlingException';
}

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail })),
  },
}));

vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: vi.fn(() => ({ send: sesSend })),
  GetSuppressedDestinationCommand,
}));

const TEMPLATE = {
  fromName: 'Eve Horizon',
  subject: 'Sign in to Eve Horizon',
  html: '<p>link</p>',
  text: 'link',
} as const;

async function makeMailer() {
  // Dynamic import so the singleton uses the mocked envs and modules.
  const { MailerService } = await import('../mailer.service.js');
  return new MailerService();
}

function resetSesEnv() {
  for (const k of [
    'GOTRUE_SMTP_HOST',
    'GOTRUE_SMTP_USER',
    'GOTRUE_SMTP_PASS',
    'EVE_MAILER_CHECK_SUPPRESSION',
    'EVE_MAILER_SES_REGION',
    'EVE_SES_CONFIGURATION_SET',
    'MAILER_FROM_ADDRESS',
    'GOTRUE_SMTP_ADMIN_EMAIL',
  ]) {
    delete process.env[k];
  }
}

describe('MailerService SES suppression', () => {
  beforeEach(() => {
    sendMail.mockReset();
    sesSend.mockReset();
    resetSesEnv();
    sendMail.mockResolvedValue({
      messageId: '<abc@example>',
      response: '250 Ok 0101019e1626b83d-deadbeef-cafe',
    });
  });

  afterEach(() => {
    resetSesEnv();
    vi.resetModules();
  });

  it('skips suppression check for non-SES host (Mailpit / local)', async () => {
    process.env.GOTRUE_SMTP_HOST = 'mailpit';
    const mailer = await makeMailer();
    await mailer.send({ ...TEMPLATE, to: 'user@example.com' });
    expect(sesSend).not.toHaveBeenCalled();
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('passes when address is not suppressed (NotFoundException)', async () => {
    process.env.GOTRUE_SMTP_HOST = 'email-smtp.us-west-2.amazonaws.com';
    sesSend.mockRejectedValueOnce(new NotFoundException('not suppressed'));
    const mailer = await makeMailer();
    await mailer.send({ ...TEMPLATE, to: 'User@Example.COM' });
    // Recipient is normalised to lower-case before the lookup and before SMTP.
    expect(sesSend).toHaveBeenCalledTimes(1);
    const cmd = sesSend.mock.calls[0]?.[0] as GetSuppressedDestinationCommand;
    expect(cmd.input.EmailAddress).toBe('user@example.com');
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0]?.[0]?.to).toBe('user@example.com');
  });

  it('throws EmailSuppressedError and does NOT call SMTP when suppressed', async () => {
    process.env.GOTRUE_SMTP_HOST = 'email-smtp.us-west-2.amazonaws.com';
    const lastUpdate = new Date('2026-05-11T09:28:17.364Z');
    sesSend.mockResolvedValueOnce({
      SuppressedDestination: {
        Reason: 'BOUNCE',
        LastUpdateTime: lastUpdate,
      },
    });
    const mailer = await makeMailer();
    const { EmailSuppressedError } = await import('../errors.js');
    await expect(mailer.send({ ...TEMPLATE, to: 'admin@example.com' })).rejects.toBeInstanceOf(
      EmailSuppressedError,
    );
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('fails open (warn, still send) when suppression check fails non-NotFound', async () => {
    process.env.GOTRUE_SMTP_HOST = 'email-smtp.us-west-2.amazonaws.com';
    sesSend.mockRejectedValueOnce(new ThrottlingException('rate limited'));
    const mailer = await makeMailer();
    await mailer.send({ ...TEMPLATE, to: 'user@example.com' });
    expect(sesSend).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('passes X-SES-CONFIGURATION-SET header when EVE_SES_CONFIGURATION_SET is set', async () => {
    process.env.GOTRUE_SMTP_HOST = 'email-smtp.us-west-2.amazonaws.com';
    process.env.EVE_SES_CONFIGURATION_SET = 'eve-default';
    sesSend.mockRejectedValueOnce(new NotFoundException('not suppressed'));
    const mailer = await makeMailer();
    await mailer.send({ ...TEMPLATE, to: 'user@example.com' });
    const arg = sendMail.mock.calls[0]?.[0] as { headers?: Record<string, string> };
    expect(arg.headers).toEqual({ 'X-SES-CONFIGURATION-SET': 'eve-default' });
  });

  it('respects explicit EVE_MAILER_CHECK_SUPPRESSION=false even on SES host', async () => {
    process.env.GOTRUE_SMTP_HOST = 'email-smtp.us-west-2.amazonaws.com';
    process.env.EVE_MAILER_CHECK_SUPPRESSION = 'false';
    const mailer = await makeMailer();
    await mailer.send({ ...TEMPLATE, to: 'user@example.com' });
    expect(sesSend).not.toHaveBeenCalled();
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('respects explicit EVE_MAILER_CHECK_SUPPRESSION=true on non-SES host', async () => {
    process.env.GOTRUE_SMTP_HOST = 'mailpit';
    process.env.EVE_MAILER_CHECK_SUPPRESSION = 'true';
    process.env.EVE_MAILER_SES_REGION = 'us-west-2';
    sesSend.mockRejectedValueOnce(new NotFoundException('not suppressed'));
    const mailer = await makeMailer();
    await mailer.send({ ...TEMPLATE, to: 'user@example.com' });
    expect(sesSend).toHaveBeenCalledTimes(1);
  });
});
