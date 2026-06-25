import type { ProjectBranding } from '@eve/shared';

export type InviteEmailInput = {
  branding?: ProjectBranding | null;
  actionLink: string;
  expiresAt?: Date | string | null;
};

export type AuthActionEmailKind = 'invite' | 'magic_link';

export type AuthActionEmailInput = InviteEmailInput & {
  kind: AuthActionEmailKind;
};

export type AuthActionEmailRender = {
  fromName: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
};

type ResolvedBranding = {
  appName: string;
  logoUrl?: string;
  primaryColor: string;
  fromName: string;
  replyTo?: string;
  supportEmail?: string;
  supportUrl?: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isHttpsUrl(value: string | undefined): value is string {
  return typeof value === 'string' && value.toLowerCase().startsWith('https://');
}

function formatExpiry(value: Date | string | null | undefined, noun: string): string {
  if (!value) return `This ${noun} expires soon.`;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return `This ${noun} expires soon.`;
  return `This ${noun} expires on ${date.toISOString()}.`;
}

export function resolveInviteBranding(branding?: ProjectBranding | null): ResolvedBranding {
  const appName = branding?.app_name?.trim() || 'Eve Horizon';
  return {
    appName,
    logoUrl: isHttpsUrl(branding?.app_logo_url) ? branding.app_logo_url : undefined,
    primaryColor: branding?.primary_color ?? '#0a0a0a',
    fromName: branding?.email_from_name?.trim() || appName,
    replyTo: branding?.reply_to_email,
    supportEmail: branding?.support_email,
    supportUrl: branding?.support_url,
  };
}

export function renderAuthActionEmail(input: AuthActionEmailInput): AuthActionEmailRender {
  const resolved = resolveInviteBranding(input.branding);
  const appName = escapeHtml(resolved.appName);
  const actionLink = escapeHtml(input.actionLink);
  const isMagicLink = input.kind === 'magic_link';
  const actionNoun = isMagicLink ? 'sign-in link' : 'invite';
  const subject = isMagicLink
    ? `Sign in to ${resolved.appName}`
    : `You have been invited to ${resolved.appName}`;
  const heading = isMagicLink
    ? `Sign in to ${resolved.appName}`
    : `You have been invited to ${resolved.appName}`;
  const intro = isMagicLink
    ? `Use this secure link to sign in to ${resolved.appName}.`
    : 'Accept the invite to finish setting up your account.';
  const button = isMagicLink ? 'Sign in' : 'Accept invite';
  const textLead = isMagicLink
    ? `Sign in to ${resolved.appName}.`
    : `You have been invited to ${resolved.appName}.`;
  const textAction = isMagicLink ? 'Sign in' : 'Accept invite';
  const expires = escapeHtml(formatExpiry(input.expiresAt, actionNoun));
  const supportBits = [
    resolved.supportEmail ? `Email ${resolved.supportEmail}` : null,
    resolved.supportUrl ? `Visit ${resolved.supportUrl}` : null,
  ].filter(Boolean);
  const supportText = supportBits.length > 0
    ? `Need help? ${supportBits.join(' or ')}.`
    : 'Need help? Contact the person who invited you.';
  const escapedSupportText = escapeHtml(supportText);
  const logoHtml = resolved.logoUrl
    ? `<img src="${escapeHtml(resolved.logoUrl)}" alt="${appName}" width="160" style="display:block;max-width:160px;height:auto;margin:0 0 24px 0;">`
    : '';

  return {
    fromName: resolved.fromName,
    replyTo: resolved.replyTo,
    subject,
    text: [
      textLead,
      '',
      `${textAction}: ${input.actionLink}`,
      '',
      formatExpiry(input.expiresAt, actionNoun),
      supportText,
      '',
      `Sent by ${resolved.appName} via Eve Horizon.`,
    ].join('\n'),
    html: `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;color:#151515;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f5f5;margin:0;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:600px;max-width:100%;background:#ffffff;border:1px solid #e6e6e6;">
            <tr>
              <td style="padding:32px;">
                ${logoHtml}
                <h1 style="font-size:24px;line-height:32px;margin:0 0 16px 0;color:#151515;">${escapeHtml(heading)}</h1>
                <p style="font-size:16px;line-height:24px;margin:0 0 24px 0;color:#333333;">${escapeHtml(intro)}</p>
                <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 24px 0;">
                  <tr>
                    <td style="background:${resolved.primaryColor};padding:12px 20px;">
                      <a href="${actionLink}" style="color:#ffffff;text-decoration:none;font-size:16px;line-height:20px;font-weight:bold;">${escapeHtml(button)}</a>
                    </td>
                  </tr>
                </table>
                <p style="font-size:13px;line-height:20px;margin:0 0 16px 0;color:#555555;">${expires}</p>
                <p style="font-size:13px;line-height:20px;margin:0 0 24px 0;color:#555555;">${escapedSupportText}</p>
                <p style="font-size:12px;line-height:18px;margin:0;color:#777777;">Sent by ${appName} via Eve Horizon.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`,
  };
}

export type InviteEmailRender = AuthActionEmailRender;

export function renderInviteEmail(input: InviteEmailInput): InviteEmailRender {
  return renderAuthActionEmail({ ...input, kind: 'invite' });
}
