import { mcpCommand } from '../../src/modules/tools/mcp/mcp-command';
import { spawnSync } from 'node:child_process';
import { McpService } from '../../src/modules/tools/mcp/mcp.service';
describe('MCP npm launcher',()=>{
 it('runs bundled npx without cmd interpolation and keeps secret placeholders literal',()=>{
  const args=['mcp-remote@0.14.3','https://example.com/mcp','--header','Authorization:${AUTH_HEADER}'];
  const result=mcpCommand('npx',args,{AUTH_HEADER:'Bearer test-only'});
  expect(result.command).toBe(process.execPath);expect(result.args.slice(1)).toEqual(args);
  expect(result.args.join(' ')).not.toContain('Bearer test-only');
  const version=spawnSync(result.command,[result.args[0]!,'--version'],{env:result.env,encoding:'utf8',windowsHide:true});
  expect(version.status).toBe(0);expect(version.stdout.trim()).toBe(require('npm/package.json').version);
 });
 it('keeps executable launches unchanged',()=>{expect(mcpCommand('python',['server.py'],{}).command).toBe('python');});
 it('requires approval for MCP writes and unknown tools instead of marking every connector safe',()=>{
  const service=new McpService();
  expect((service as any).toToolDefinition('test',{name:'send_email'}).dangerous).toBe(true);
  expect((service as any).toToolDefinition('test',{name:'read',annotations:{readOnlyHint:true}}).dangerous).toBe(false);
  service.onModuleDestroy();
 });
});
