import type { Request, Response, NextFunction } from 'express';
import type { IncomingHttpHeaders } from 'node:http';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Local HTTP/WS services must not trust arbitrary web pages, even with auth disabled. */
export function isTrustedBrowserRequest(
  headers: IncomingHttpHeaders,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const origin = headers.origin;
  try {
    const allowed = (env['SKYALYTICWING_ALLOWED_ORIGINS'] || '').split(',').map((value) => value.trim()).filter(Boolean);
    const target = headers.host ? new URL(`http://${headers.host}`) : undefined;
    // Also reject DNS rebinding GETs, which can omit Origin entirely.
    if (target && !LOOPBACK_HOSTS.has(target.hostname) && !allowed.some((value) => {
      try { return new URL(value).host === target.host; } catch { return false; }
    })) return false;
    // CLI and native clients do not send Origin. This check does not replace token auth.
    if (origin === undefined) return true;
    if (typeof origin !== 'string' || origin === 'null') return false;
    const source = new URL(origin);
    if (!['http:', 'https:'].includes(source.protocol) || source.origin !== origin) return false;
    if (allowed.includes(origin)) return true;

    if (!target || !LOOPBACK_HOSTS.has(source.hostname) || !LOOPBACK_HOSTS.has(target.hostname)) return false;
    if (source.port === target.port && source.protocol === 'http:') return true;
    // Vite development proxy uses port 1420; production must opt in explicitly.
    return env['NODE_ENV'] !== 'production' && source.protocol === 'http:' && source.port === '1420';
  } catch {
    return false;
  }
}

/** Reject requests themselves: CORS alone does not prevent cross-origin mutations. */
export function browserOriginMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isTrustedBrowserRequest(req.headers)) {
    res.status(403).json({ success: false, error: 'Untrusted browser origin' });
    return;
  }
  next();
}
