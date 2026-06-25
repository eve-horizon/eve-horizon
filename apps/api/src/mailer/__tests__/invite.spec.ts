import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MailerService } from '../mailer.service.js';
import { renderAuthActionEmail, renderInviteEmail } from '../templates/invite.js';

const sendMail = vi.fn();

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail })),
  },
}));

describe('renderInviteEmail', () => {
  it('renders default Eve Horizon branding', () => {
    const rendered = renderInviteEmail({
      branding: null,
      actionLink: 'http://auth.eve.lvh.me/verify?token=abc',
      expiresAt: new Date('2026-05-10T12:00:00.000Z'),
    });

    expect(rendered.fromName).toBe('Eve Horizon');
    expect(rendered.subject).toBe('You have been invited to Eve Horizon');
    expect(rendered.html).not.toContain('<img');
    expect(rendered.html).toContain('#0a0a0a');
    expect(rendered.text).toContain('You have been invited to Eve Horizon');
  });

  it('renders ACME Portal branding', () => {
    const rendered = renderInviteEmail({
      branding: {
        app_name: 'ACME Portal',
        app_logo_url: 'https://sandbox.acme.example/assets/logo.svg',
        primary_color: '#1f6feb',
        email_from_name: 'ACME Portal',
        reply_to_email: 'support@acme.example',
        support_email: 'support@acme.example',
        support_url: 'https://acme.example/help',
      },
      actionLink: 'http://auth.eve.lvh.me/verify?token=abc',
      expiresAt: new Date('2026-05-10T12:00:00.000Z'),
    });

    expect(rendered.fromName).toBe('ACME Portal');
    expect(rendered.replyTo).toBe('support@acme.example');
    expect(rendered.subject).toBe('You have been invited to ACME Portal');
    expect(rendered.html).toContain('https://sandbox.acme.example/assets/logo.svg');
    expect(rendered.html).toContain('#1f6feb');
    expect(rendered.text).toContain('ACME Portal');
    expect(rendered.text).toContain('support@acme.example');
  });

  it('renders ACME Portal magic link copy with the shared branding shell', () => {
    const rendered = renderAuthActionEmail({
      kind: 'magic_link',
      branding: {
        app_name: 'ACME Portal',
        app_logo_url: 'https://sandbox.acme.example/assets/logo.svg',
        primary_color: '#1f6feb',
        email_from_name: 'ACME Portal',
        reply_to_email: 'support@acme.example',
        support_email: 'support@acme.example',
        support_url: 'https://acme.example/help',
      },
      actionLink: 'http://auth.eve.lvh.me/verify?token=magic',
      expiresAt: null,
    });

    expect(rendered.fromName).toBe('ACME Portal');
    expect(rendered.replyTo).toBe('support@acme.example');
    expect(rendered.subject).toBe('Sign in to ACME Portal');
    expect(rendered.html).toContain('https://sandbox.acme.example/assets/logo.svg');
    expect(rendered.html).toContain('#1f6feb');
    expect(rendered.html).toContain('Sign in');
    expect(rendered.text).toContain('Sign in: http://auth.eve.lvh.me/verify?token=magic');
    expect(rendered.text).toContain('This sign-in link expires soon.');
  });

  it('omits non-HTTPS logo URLs from email HTML', () => {
    const rendered = renderInviteEmail({
      branding: {
        app_name: 'Local App',
        app_logo_url: 'http://example.com/logo.svg',
      },
      actionLink: 'http://auth.eve.lvh.me/verify?token=abc',
      expiresAt: null,
    });

    expect(rendered.html).not.toContain('<img');
    expect(rendered.html).not.toContain('http://example.com/logo.svg');
  });
});

describe('MailerService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MAILER_FROM_ADDRESS;
    delete process.env.GOTRUE_SMTP_ADMIN_EMAIL;
    sendMail.mockResolvedValue({
      messageId: '<test@example>',
      response: '250 Ok message-id-xyz',
    });
  });

  it('sends with structured from and reply-to', async () => {
    process.env.GOTRUE_SMTP_ADMIN_EMAIL = 'noreply@eve.local';
    const service = new MailerService();

    await service.send({
      to: 'invitee@example.com',
      fromName: 'ACME Portal',
      replyTo: 'support@acme.example',
      subject: 'You have been invited to ACME Portal',
      html: '<p>Hello</p>',
      text: 'Hello',
    });

    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: { name: 'ACME Portal', address: 'noreply@eve.local' },
      replyTo: 'support@acme.example',
      to: 'invitee@example.com',
      subject: 'You have been invited to ACME Portal',
    }));
  });

  it('rejects header newlines', async () => {
    const service = new MailerService();

    await expect(service.send({
      to: 'invitee@example.com',
      fromName: 'Bad\r\nBcc: attacker@example.com',
      subject: 'Invite',
      html: '<p>Hello</p>',
      text: 'Hello',
    })).rejects.toThrow('fromName must not contain newline characters');
  });
});
