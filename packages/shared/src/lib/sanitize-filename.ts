/** Strip path separators, control chars, and truncate to 255 chars. */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\.{2,}/g, '.')
    .slice(0, 255);
}
