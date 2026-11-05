import { authHeaders } from './auth-token';

/** Raw same-origin API requests; keeps Response semantics for legacy feature pages. */
export function authenticatedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(path, window.location.href);
  const headers = new Headers(init.headers);
  if (url.origin === window.location.origin && url.pathname.startsWith('/api/')) {
    for (const [name, value] of Object.entries(authHeaders())) {
      if (!headers.has(name)) headers.set(name, value);
    }
  }
  return fetch(path, { ...init, headers });
}
