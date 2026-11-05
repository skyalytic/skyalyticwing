import { issueDesignFrameToken, allowsDesignFrameRender } from '../../src/modules/core/security/design-frame-token.js';

describe('design frame render capability', () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const path = `/api/files/design-frame/${id}`;
  afterEach(() => jest.useRealTimers());
  it('allows only the signed frame GET, not another frame, API or method', () => {
    const token = issueDesignFrameToken(id);
    expect(allowsDesignFrameRender(`${path}?renderToken=${token}`, 'GET')).toBe(true);
    expect(allowsDesignFrameRender(`${path}?renderToken=${token}`, 'POST')).toBe(false);
    expect(allowsDesignFrameRender(`/api/files/read?renderToken=${token}`, 'GET')).toBe(false);
    expect(allowsDesignFrameRender(`${path.replace('9abc', '9abd')}?renderToken=${token}`, 'GET')).toBe(false);
    expect(allowsDesignFrameRender(`${path}?renderToken=${token.slice(0, -1)}X`, 'GET')).toBe(false);
    expect(allowsDesignFrameRender(path, 'GET')).toBe(false);
  });
  it('expires after five minutes', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-09T10:00:00Z'));
    const token = issueDesignFrameToken(id);
    jest.advanceTimersByTime(300001);
    expect(allowsDesignFrameRender(`${path}?renderToken=${token}`, 'GET')).toBe(false);
  });
});
