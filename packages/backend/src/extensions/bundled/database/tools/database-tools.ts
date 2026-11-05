import type { ToolDefinition } from '@skyalyticwing/shared';
import { DatabaseService } from '../../../../modules/tools/files/database.service.js';
import type { ServiceResolver } from '../../../../modules/tools/executor/built-in/service-resolver.js';
export function createDatabaseTools(resolve: ServiceResolver): ToolDefinition[] {
  return [false, true].map((write) => ({
    name: write ? 'database_execute' : 'database_query',
    category: 'file',
    dangerous: write,
    description: write
      ? '在授权的本地 SQLite 数据库执行一条写入 SQL 或创建数据库；自动备份，事务执行，禁止附加其他数据库。'
      : '读取本地 SQLite 表结构或执行只读 SQL。最多返回 1000 行，支持参数绑定。',
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' as const, description: '数据库绝对路径' },
        sql: { type: 'string' as const },
        params: { type: 'array' as const, items: {} },
        schema: { type: 'boolean' as const },
        create: { type: 'boolean' as const },
      },
      required: ['path'],
    },
    async execute(raw: unknown) {
      const service = resolve<DatabaseService>(DatabaseService);
      if (!service) return { success: false, error: '数据库服务不可用' };
      try {
        const args = raw as {
          path: string;
          sql?: string;
          params?: unknown[];
          schema?: boolean;
          create?: boolean;
        };
        const data = await service.run({ ...args, write, create: write && args.create === true });
        return { success: true, data, output: JSON.stringify(data) };
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  }));
}
