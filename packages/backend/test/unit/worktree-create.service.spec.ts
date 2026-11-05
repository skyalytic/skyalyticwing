import 'reflect-metadata';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeService } from '../../src/modules/tools/worktree.service.js';
import { SecurityManagerService } from '../../src/modules/core/security/security-manager.service.js';
import type { LoggerService } from '../../src/modules/core/logger/logger.service.js';

/** LoggerService mock */
const loggerMock = {
  info: jest.fn(),
  warn: jest.fn(),
} as unknown as LoggerService;

/** SecurityManager mock：isPathAllowed 可控，其余放行 */
function makeService(pathAllowed: boolean): WorktreeService {
  const security = {
    isCommandAllowed: () => true,
    isPathAllowed: (_p: string, _m?: string) => pathAllowed,
  } as unknown as SecurityManagerService;
  return new WorktreeService(loggerMock, security);
}

describe('WorktreeService.createWorktree（POST /api/worktrees 后端防护）', () => {
  it('缺少 path 或 branch 时拒绝', () => {
    const service = makeService(true);
    expect(service.createWorktree('', 'main')).toEqual({
      success: false,
      error: 'path and branch required',
    });
    expect(service.createWorktree(join(tmpdir(), 'wt'), '')).toEqual({
      success: false,
      error: 'path and branch required',
    });
  });

  it('branch 以 - 开头时拒绝（防 git 选项注入）', () => {
    const service = makeService(true);
    const result = service.createWorktree(join(tmpdir(), 'wt-x'), '--force');
    expect(result).toEqual({ success: false, error: 'Invalid branch name' });
  });

  it('path 未通过 PathGuard 校验时拒绝', () => {
    const service = makeService(false);
    const result = service.createWorktree(join(tmpdir(), 'wt-outside'), 'main');
    expect(result).toEqual({
      success: false,
      error: 'Path not allowed by security policy',
    });
  });
});
