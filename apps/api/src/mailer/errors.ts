export class EmailSuppressedError extends Error {
  readonly to: string;
  readonly reason: string;
  readonly lastUpdate: string;

  constructor(to: string, reason: string, lastUpdate: string) {
    super(`Recipient ${to} is on SES suppression list (reason=${reason}, since=${lastUpdate})`);
    this.name = 'EmailSuppressedError';
    this.to = to;
    this.reason = reason;
    this.lastUpdate = lastUpdate;
  }
}
