import { desktopEdition, SOURCE_EDITION } from '../../src/modules/core/utils/desktop-edition';
import { getDefaultDataDir, resolveWebDataDir } from '../../src/modules/core/utils/web-data.util';
import { join } from 'node:path';
describe('standalone desktop identity', () => {
  const env = {...process.env};
  afterEach(() => {process.env = {...env};});
  it('cannot switch edition using environment variables', () => {
    process.env['SKYALYTICWING_EDITION']='enterprise';
    expect(desktopEdition()).toBe('community');
    expect(SOURCE_EDITION).toBe('community');
  });
  it('uses the community data directory', () => {
    delete process.env['SKYALYTICWING_DATA_DIR']; delete process.env['SKYALYTICCLAW_DATA_DIR']; delete process.env['SKYALYTICWING_WEB_DATA_DIR'];
    expect(getDefaultDataDir()).toContain('SkyalyticWingCommunity');
    expect(resolveWebDataDir()).toBe(join(getDefaultDataDir(),'web'));
  });
});
