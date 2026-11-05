import { Module } from '@nestjs/common';
import { EcosystemModule } from './modules/ecosystem/ecosystem.module.js';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'node:path';

import { ConfigModule } from './modules/core/config/config.module.js';
import { LocalResourcePolicyModule } from './modules/core/security/local-resource-policy.module.js';
import { LoggerModule } from './modules/core/logger/logger.module.js';
import { RedactInterceptor } from './modules/core/logger/redact.interceptor.js';
import { HttpModule } from './modules/core/http/http.module.js';
import { SecurityModule } from './modules/core/security/security.module.js';
import { PythonModule } from './modules/core/python/python.module.js';
import { WebSocketModule } from './modules/core/websocket/websocket.module.js';
import { SystemModule } from './modules/core/system/system.module.js';
import { QueueModule } from './modules/core/queue/queue.module.js';
import { RemoteModule } from './modules/core/remote/remote.module.js';
import { BackupModule } from './modules/core/backup/backup.module.js';
import { WorkspaceModule } from './modules/core/workspace/workspace.module.js';
import { VersionModule } from './modules/core/version/version.module.js';

import { ChatModule } from './modules/ai/chat/chat.module.js';
import { AgentModule } from './modules/ai/agent/agent.module.js';
import { AcpModule } from './modules/ai/acp/acp.module.js';
import { SwarmModule } from './modules/ai/swarm/swarm.module.js';
import { VectorsModule } from './modules/ai/vectors/vectors.module.js';
import { BackgroundTaskModule } from './modules/ai/background/background-task.module.js';

import { ToolExecutorModule } from './modules/tools/executor/tool-executor.module.js';
import { PluginModule } from './modules/tools/plugin/plugin.module.js';
import { McpModule } from './modules/tools/mcp/mcp.module.js';
import { SandboxModule } from './modules/tools/sandbox/sandbox.module.js';
import { CustomToolsModule } from './modules/tools/custom-tools/custom-tools.module.js';
import { LspModule } from './modules/tools/lsp/lsp.module.js';
import { FilesModule } from './modules/tools/files/files.module.js';
import { SkillMarketplaceModule } from './modules/tools/skill-marketplace/skill-marketplace.module.js';

import { SessionModule } from './modules/session/session.module.js';
import { WebhookModule } from './modules/webhook/webhook.module.js';
import { ChannelsModule } from './modules/channels/channels.module.js';
import { CronModule } from './modules/channels/cron/cron.module.js';
import { DaemonModule } from './modules/channels/daemon/daemon.module.js';
import { WechatModule } from './modules/channels/wechat/wechat.module.js';
import { MemoryModule } from './modules/memory/memory.module.js';
import { WorkflowModule } from './modules/workflow/workflow.module.js';

import { AutomationModule } from './modules/automation/automation.module.js';
import { BrowserModule } from './modules/browser/browser.module.js';
import { TerminalModule } from './modules/terminal/terminal.module.js';
import { MonitorModule } from './modules/monitor/monitor.module.js';

// 架构约束：顶层 require 重命名为 dynamicRequire
const dynamicRequire: NodeRequire = require;

const frontendDist = (() => {
  const candidates = [
    // Self-contained server deployment, independent of repository/cwd.
    join(__dirname, '..', 'frontend'),
    // 开发态：__dirname = packages/backend/dist → packages/frontend/dist
    join(__dirname, '..', '..', 'frontend', 'dist'),
    // 打包态：__dirname = packages/backend/deploy/dist → 上溯 4 级到 packages → frontend/dist
    join(__dirname, '..', '..', '..', '..', 'frontend', 'dist'),
    // cwd = packages/backend（sidecar current_dir）→ ../frontend/dist
    join(process.cwd(), '..', 'frontend', 'dist'),
    // monorepo 根目录启动
    join(process.cwd(), 'packages', 'frontend', 'dist'),
  ];
  const fs = dynamicRequire('node:fs') as typeof import('node:fs');
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0]!;
})();

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    ServeStaticModule.forRoot({
      rootPath: frontendDist,
      exclude: ['/api/(.*)', '/ws', '/health'],
    }),
    ConfigModule,
    LocalResourcePolicyModule,
    LoggerModule,
    PythonModule,
    HttpModule,
    SecurityModule,
    WebSocketModule,
    SystemModule,
    QueueModule,
    RemoteModule,
    BackupModule,
    WorkspaceModule,
    VersionModule,
    ChatModule,
    AgentModule,
    AcpModule,
    SwarmModule,
    VectorsModule,
    BackgroundTaskModule,
    ToolExecutorModule,
    PluginModule,
    McpModule,
    SandboxModule,
    CustomToolsModule,
    LspModule,
    FilesModule,
    SkillMarketplaceModule,
    EcosystemModule,
    SessionModule,
    WebhookModule,
    ChannelsModule,
    CronModule,
    DaemonModule,
    WechatModule,
    MemoryModule,
    WorkflowModule,
    AutomationModule,
    BrowserModule,
    TerminalModule,
    MonitorModule,
  ],
  providers: [
    // 全局响应脱敏拦截器：经 APP_INTERCEPTOR 注册走 Nest DI 容器，
    // RedactInterceptor 由 LoggerModule 提供，对全部路由响应递归脱敏
    // （authToken/apiKey/tls.key/password/secret/token/hooks.url 等）。
    {
      provide: APP_INTERCEPTOR,
      useClass: RedactInterceptor,
    },
  ],
})
export class AppModule {}
