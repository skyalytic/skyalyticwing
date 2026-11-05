import type { ToolDefinition } from '@skyalyticwing/shared';
import type { SecurityManagerService } from '../modules/core/security/security-manager.service.js';
import type { SafetyManagerService } from '../modules/core/security/safety-manager.service.js';
import type { HttpClientService } from '../modules/core/http/http-client.service.js';
import type { WebSocketService } from '../modules/core/websocket/websocket.service.js';
import type { ConfigService } from '../modules/core/config/config.service.js';
import type { ServiceResolver } from '../modules/tools/executor/built-in/service-resolver.js';

/** Application-owned extension ABI. External plugins continue through the permissioned plugin host. */
export interface ExtensionHost {
  security: SecurityManagerService;
  safety: SafetyManagerService;
  http: HttpClientService;
  ws: WebSocketService;
  config: ConfigService;
  resolve: ServiceResolver;
}
export interface ExtensionInstance {
  tools: ToolDefinition[];
  dispose?: () => void | Promise<void>;
}
export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: 1;
  entry: string;
  guides: string[];
  platformGuides?: Partial<Record<NodeJS.Platform, string[]>>;
  /** Static inventory: listing uninstalled tools never executes package entry points. */
  tools?: Array<{ name: string; description: string; category: string; dangerous: boolean; platforms?: NodeJS.Platform[] }>;
}
