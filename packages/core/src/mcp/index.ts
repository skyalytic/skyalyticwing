import { createLogger, type Logger } from '@skyalyticwing/shared';
import type { MCPServerConfig } from '../types/index.js';

export class MCPManager {
  private logger: Logger;
  private servers: Map<string, MCPServerConfig> = new Map();

  constructor(logger?: Logger) {
    this.logger = logger ?? createLogger({ name: 'mcp' });
  }

  registerServer(config: MCPServerConfig): void {
    this.servers.set(config.name, config);
    this.logger.info({ server: config.name }, 'MCP server registered');
  }

  listServers(): MCPServerConfig[] {
    return Array.from(this.servers.values());
  }

  async connect(name: string): Promise<void> {
    const config = this.servers.get(name);
    if (!config) throw new Error(`MCP server not found: ${name}`);
    this.logger.info({ server: name }, 'MCP server connecting');
    // TS-13 fix: 抛出未实现错误而非静默成功
    throw new Error('MCPManager.connect not implemented yet');
  }
}
