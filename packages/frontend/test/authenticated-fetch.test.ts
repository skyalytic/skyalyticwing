import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticatedFetch } from '../src/services/authenticated-fetch';
import { setAuthToken } from '../src/services/auth-token';

describe('authenticated raw requests', () => {
  afterEach(() => { setAuthToken(''); vi.unstubAllGlobals(); });
  it('adds auth for protected local feature pages and preserves caller headers', async () => {
    setAuthToken('test-session-secret');
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await authenticatedFetch('/api/memory/knowledge', { headers: { 'Content-Type': 'application/json' } });
    const headers = fetchMock.mock.calls[0]?.[1].headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer test-session-secret');
    expect(headers.get('Content-Type')).toBe('application/json');
  });
  it('does not send the local login token to another origin', async () => {
    setAuthToken('test-session-secret');
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await authenticatedFetch('https://other.example/api/memory');
    expect((fetchMock.mock.calls[0]?.[1].headers as Headers).has('Authorization')).toBe(false);
  });
});
