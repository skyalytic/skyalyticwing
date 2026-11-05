import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentService } from '../../src/modules/ai/agent/agent.service';

describe('expert persistence', () => {
  let root: string, prior: string | undefined;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'wing-experts-')); prior = process.env['SKYALYTICWING_DATA_DIR']; process.env['SKYALYTICWING_DATA_DIR'] = root; });
  afterEach(() => { if (prior === undefined) delete process.env['SKYALYTICWING_DATA_DIR']; else process.env['SKYALYTICWING_DATA_DIR'] = prior; rmSync(root, { recursive: true, force: true }); });
  it('retains expert role, team leader and tools across restart', () => {
    const a = new AgentService(); a.onModuleInit();
    const expert = a.createAgent({ name: 'review', model: 'local-model', systemPrompt: 'review policy', tools: ['read_file'] });
    const team = a.createTeam({ name: 'office', memberIds: ['agent', expert.id], leadId: expert.id });
    const b = new AgentService(); b.onModuleInit();
    expect(b.getAgent(expert.id).systemPrompt).toBe('review policy');
    expect(b.getAgent(expert.id).tools).toEqual(['read_file']);
    expect(b.getTeam(team.id).leadId).toBe(expert.id);
  });
  it('recovers a corrupt primary from the last valid backup without erasing the store', () => {
    const a = new AgentService(); a.onModuleInit();
    const expert = a.createAgent({ name: 'review', model: 'local' });
    a.updateAgent(expert.id, { name: 'new review' });
    writeFileSync(join(root, 'custom-agents.json'), '{bad');
    const b = new AgentService(); b.onModuleInit();
    expect(b.getAgent(expert.id).name).toBe('review');
    expect(readFileSync(join(root, 'custom-agents.json'), 'utf8')).toBe('{bad');
  });
  it('reports unrecoverable corruption instead of silently returning an empty account', () => {
    writeFileSync(join(root, 'custom-agents.json'), '{bad');
    expect(() => new AgentService().onModuleInit()).toThrow();
  });
  it('rolls back in-memory creation when disk persistence fails', () => {
    const service = new AgentService(); service.onModuleInit();
    // A regular file cannot be used as a directory, on Windows or Unix.
    const blocker = join(root, 'blocked'); writeFileSync(blocker, 'file');
    (service as unknown as { customAgentsFile: string }).customAgentsFile = join(blocker, 'custom-agents.json');
    expect(() => service.createAgent({ name: 'lost', model: '' })).toThrow();
    expect(service.listAgents().map(a => a.name)).toEqual(['Agent']);
  });
});
