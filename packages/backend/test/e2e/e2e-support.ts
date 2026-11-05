import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import { ConfigModule } from '../../src/modules/core/config/config.module.js';
import { LoggerModule } from '../../src/modules/core/logger/logger.module.js';
import { HttpModule } from '../../src/modules/core/http/http.module.js';
import { SecurityModule } from '../../src/modules/core/security/security.module.js';
import { WebSocketModule } from '../../src/modules/core/websocket/websocket.module.js';
import { SystemModule } from '../../src/modules/core/system/system.module.js';
import { ToolExecutorModule } from '../../src/modules/tools/executor/tool-executor.module.js';
import { ChatModule } from '../../src/modules/ai/chat/chat.module.js';
import { AgentLoopService } from '../../src/modules/ai/agent/agent-loop.service.js';
import { browserOriginMiddleware } from '../../src/modules/core/security/browser-origin.util.js';

/**
 * integration 层 e2e 共享启动逻辑（设计 §7.2 integration/ 三 spec 复用）。
 *
 * 与 main.ts 保持一致的全局前缀（api）与 WsAdapter；AgentLoop 以桩替代真实
 * LLM 调用（e2e 不依赖外部 API）；数据写入独立临时目录。
 * 完整 AppModule（Channels/Daemon/Automation 等外部副作用）在 e2e 环境
 * 编译启动成本过高，维持核心+Chat 组合（见 app.e2e-spec.ts 头部说明）。
 */

/** AgentLoop 桩：固定回复一条 assistant_message 后结束 */
const agentLoopStub = {
  run: async function* (): AsyncGenerator<{ type: string; content?: string }> {
    yield { type: 'assistant_message', content: 'e2e-mock-reply' };
    yield { type: 'done' };
  },
} as unknown as AgentLoopService;

export interface E2eApp {
  app: INestApplication;
  httpPort: number;
  dataDir: string;
  close: () => Promise<void>;
}

export async function createE2eApp(): Promise<E2eApp> {
  const dataDir = mkdtempSync(join(tmpdir(), 'backend-e2e-'));
  process.env['SKYALYTICWING_DATA_DIR'] = dataDir;

  const moduleFixture = await Test.createTestingModule({
    imports: [
      EventEmitterModule.forRoot(),
      ConfigModule,
      LoggerModule,
      HttpModule,
      SecurityModule,
      ToolExecutorModule,
      WebSocketModule,
      SystemModule,
      ChatModule,
    ],
  })
    .overrideProvider(AgentLoopService)
    .useValue(agentLoopStub)
    .compile();

  const app = moduleFixture.createNestApplication();
  app.use(browserOriginMiddleware);
  app.useWebSocketAdapter(new WsAdapter(app));
  app.setGlobalPrefix('api', { exclude: ['/', '/health', '/ws'] });
  // 与 main.ts 对齐的全局校验管道（否则 e2e 环境的 DTO 校验行为与生产不一致）
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );
  await app.init();
  // WS 用例需要真实监听端口（supertest 的临时绑定不支持 upgrade）
  await app.listen(0);
  const httpPort = (app.getHttpServer().address() as AddressInfo).port;

  return {
    app,
    httpPort,
    dataDir,
    close: async () => {
      try {
        await app.close();
      } catch {
        // 关闭阶段（WsAdapter/子进程清理）可能抛错，不影响测试结果
      }
      rmSync(dataDir, { recursive: true, force: true });
      delete process.env['SKYALYTICWING_DATA_DIR'];
    },
  };
}

/** 轮询等待条件成立（默认 5s） */
export async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
