export function cleanVersion(raw: string): string {
  return raw.replace(/^[\^~>=<\s]+/, '').trim();
}
