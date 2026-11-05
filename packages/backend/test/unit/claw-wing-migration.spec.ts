import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getDefaultDataDir, migrateLegacyAppData } from '../../src/modules/core/utils/web-data.util';
jest.mock('node:os', () => ({ ...jest.requireActual('node:os'), homedir: jest.fn(), platform: jest.fn() }));

describe('standalone community profile isolation', () => {
  let root: string;
  const oldEnv = { ...process.env };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-migration-'));
    delete process.env['SKYALYTICWING_DATA_DIR'];
    delete process.env['SKYALYTICCLAW_DATA_DIR'];
    process.env['APPDATA'] = root;
    process.env['XDG_CONFIG_HOME'] = root;
    jest.mocked(os.homedir).mockReturnValue(root);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...oldEnv };
    fs.rmSync(root, { recursive: true, force: true });
  });
  it.each(['win32', 'darwin', 'linux'] as const)('does not import a %s legacy profile', platform => {
    jest.mocked(os.platform).mockReturnValue(platform);
    const target = getDefaultDataDir();
    const legacy = path.join(path.dirname(target), platform === 'linux' ? 'skyalyticclaw' : 'SkyalyticClaw');
    fs.mkdirSync(path.join(legacy, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'nested', 'sessions.json'), '{"conversation":"preserve"}');
    migrateLegacyAppData();
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(path.join(legacy, 'nested', 'sessions.json'), 'utf8')).toBe('{"conversation":"preserve"}');
  });
  it('does not import legacy settings into an empty community directory', () => {
    jest.mocked(os.platform).mockReturnValue('win32');
    fs.mkdirSync(path.join(root, 'com.skyalyticclaw.desktop'));
    fs.writeFileSync(path.join(root, 'com.skyalyticclaw.desktop', 'settings.json'), '{}');
    fs.mkdirSync(getDefaultDataDir());
    migrateLegacyAppData();
    expect(fs.readdirSync(getDefaultDataDir())).toEqual([]);
  });
  it('does not migrate real profiles when a custom data directory is configured', () => {
    jest.mocked(os.platform).mockReturnValue('win32');
    process.env['SKYALYTICWING_DATA_DIR'] = path.join(root, 'isolated');
    fs.mkdirSync(path.join(root, 'SkyalyticClaw'));
    migrateLegacyAppData();
    expect(fs.existsSync(getDefaultDataDir())).toBe(false);
  });
});
