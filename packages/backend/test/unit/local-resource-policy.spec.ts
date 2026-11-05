import { LocalResourcePolicy } from '../../src/modules/core/security/local-resource-policy.service.js';

describe('standalone local resources', () => {
  const policy=new LocalResourcePolicy();
  it('keeps local storage and credentials independent of accounts', () => {
    expect(policy.localResourceRoot('/fixture')).toBe('/fixture');
    expect(policy.localMemoryRoot('/fixture')).toBe('/fixture');
    expect(policy.credentialIdentity()).toBe('local');
  });
  it('allows local tools but does not expose account-private resources', async () => {
    await expect(policy.assert('skill','local-skill')).resolves.toBeUndefined();
    await expect(policy.assert('mcp','skyalytic:enterprise-private')).rejects.toThrow();
    expect(await policy.filterAvailable('plugin',['local','enterprise-private'],x=>x)).toEqual(['local']);
  });
});
