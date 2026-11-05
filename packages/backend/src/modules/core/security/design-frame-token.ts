import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Per-process, short-lived render capability. Never an account or API credential.
const secret = randomBytes(32);
const TTL = 5 * 60 * 1000;
function signature(id: string, expires: string): string {
  return createHmac('sha256', secret).update(`design-frame:${id}:${expires}`).digest('hex');
}
export function issueDesignFrameToken(id: string): string {
  const expires = String(Date.now() + TTL);
  return `${expires}.${signature(id, expires)}`;
}
export function allowsDesignFrameRender(url: string, method: string): boolean {
  if (method !== 'GET') return false;
  const parsed = new URL(url, 'http://localhost');
  const match = /^\/api\/files\/design-frame\/([a-f0-9-]{36})$/i.exec(parsed.pathname);
  const token = parsed.searchParams.get('renderToken') || '';
  const parts = /^(\d{13})\.([a-f0-9]{64})$/.exec(token);
  if (!match || !parts || Number(parts[1]) <= Date.now() || Number(parts[1]) > Date.now() + TTL) return false;
  return timingSafeEqual(Buffer.from(parts[2]!, 'hex'), Buffer.from(signature(match[1]!, parts[1]!), 'hex'));
}
