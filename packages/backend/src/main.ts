import { prepareExtensionSelection } from './extensions/extension-selection.service.js';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { migrateLegacyAppData, seedPresetWorkspaces } from './modules/core/utils/web-data.util.js';
import type { Logger } from '@skyalyticwing/shared';
import { browserOriginMiddleware } from './modules/core/security/browser-origin.util.js';
import { updateMaintenance } from './modules/core/system/update-maintenance.js';

/** DocumentBuilder 链式构造器（依赖未安装时仍可编译） */
interface DocumentBuilderLike {
  setTitle(title: string): this;
  setDescription(description: string): this;
  setVersion(version: string): this;
  addBearerAuth(): this;
  build(): Record<string, unknown>;
}

/** @nestjs/swagger 的最小类型描述（依赖未安装时仍可编译） */
interface SwaggerModuleLike {
  DocumentBuilder: new () => DocumentBuilderLike;
  SwaggerModule: {
    createDocument(
      app: INestApplication,
      config: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Record<string, unknown>;
    setup(path: string, app: INestApplication, document: unknown): void;
  };
}

/**
 * 挂载 Swagger API 文档（/api-docs）
 *
 * 出于安全考虑，仅非生产环境或显式设置 ENABLE_SWAGGER=1 时启用。
 * 通过运行时动态 import 加载 @nestjs/swagger（模块名拼接可避免
 * TypeScript 静态解析未安装依赖导致编译失败）；
 * 依赖未安装时记录警告并跳过，不影响服务启动。
 */
async function setupSwaggerDocs(
  app: INestApplication,
  port: number,
  logger: Logger,
): Promise<void> {
  if (process.env['NODE_ENV'] === 'production' && process.env['ENABLE_SWAGGER'] !== '1') {
    return;
  }
  try {
    const swaggerMod = (await import('@nestjs' + '/swagger')) as unknown as SwaggerModuleLike;
    const DocumentBuilder = swaggerMod.DocumentBuilder;
    const SwaggerModule = swaggerMod.SwaggerModule;

    const config = new DocumentBuilder()
      .setTitle('SkyalyticWing API')
      .setDescription('SkyalyticWing Backend API')
      .setVersion('2.0.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api-docs', app, document);
    logger.info(`Swagger API docs available at http://127.0.0.1:${port}/api-docs`);
  } catch {
    logger.warn('@nestjs/swagger 未安装，已跳过 API 文档挂载（请执行 pnpm install 后重启）');
  }
}

/**
 * process 级异常兜底（对齐旧版 start.cjs:44648-44662）：
 * 漏网的异常只记日志不退出——Node 15+ 默认 unhandledRejections=throw 会
 * 崩溃整个后端（桌面端 sidecar 三次后被 app.exit(1)）。
 */
function installProcessGuards(logger: Logger): void {
  process.on('uncaughtException', (err) => {
    logger.error(`uncaughtException: ${err.stack || err.message}`);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error(
      `unhandledRejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`,
    );
  });
}

async function bootstrap(): Promise<void> {
  const logger = {
    name: 'backend',
    info: (msg: unknown) => console.log('[INFO]', msg),
    warn: (msg: unknown) => console.warn('[WARN]', msg),
    error: (msg: unknown) => console.error('[ERROR]', msg),
    debug: (msg: unknown) => console.debug('[DEBUG]', msg),
    child: () => logger,
  } as unknown as Logger;

  installProcessGuards(logger);
  const host = process.env['SKYALYTICWING_HOST'] || '127.0.0.1';
  if (
    !['127.0.0.1', 'localhost', '::1'].includes(host) &&
    (process.env['SKYALYTICWING_AUTH_TOKEN']?.length ?? 0) < 32
  ) {
    throw new Error(
      'Non-loopback binding requires a 32+ character auth token',
    );
  }

  // 历史数据目录迁移链（com.skyalyticclaw.desktop → SkyalyticClaw → SkyalyticWing，
  // 见 web-data.util.ts migrateLegacyAppData），必须在任何服务读盘前执行
  migrateLegacyAppData();

  // 预设代理工作区种子拷贝（对齐旧版 start.cjs 启动时 data/workspaces → 用户目录）
  prepareExtensionSelection();
  seedPresetWorkspaces();

  const port = (() => {
    const args = process.argv;
    const portIdx = args.indexOf('--port');
    if (portIdx !== -1 && args[portIdx + 1]) {
      const p = parseInt(args[portIdx + 1]!, 10);
      if (!isNaN(p) && p > 0 && p < 65536) return p;
    }
    return parseInt(process.env['PORT'] || '19111', 10);
  })();

  // Child terminals must connect to this instance, including development ports.
  process.env['PORT'] = String(port);

  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  // Protect REST and static routes before CORS and business handlers are installed.
  app.use(browserOriginMiddleware);
  app.use(updateMaintenance.middleware);

  // JSON body 上限提升到 2MB（Express 默认 100KB）：智能体/团队头像为 base64 dataURL
  // （前端压缩后 ≤200KB），默认限制会导致带头像创建/保存时报 HTTP 413 Payload Too Large
  // A 5 MiB text can expand sixfold when JSON-escaped; other routes retain 2 MiB.
  app.use('/api/files/write', json({ limit: '31mb' }));
  app.use('/api/cli/turn', json({ limit: '24mb' }));
  app.use(json({ limit: '2mb' }));

  app.setGlobalPrefix('api', {
    exclude: ['/', '/health', '/ws'],
  });

  // /api/health 兼容路由：全局前缀 exclude 已将 'health' 注册为无前缀 /health
  // （Tauri 启动探测/测试依赖），此处以 express 原生路由补齐旧版前端轮询路径
  // /api/health（Layout checkHealth），不走 Nest 路由层，无需 Guard 放行。
  app.getHttpAdapter().get('/api/health', (_req, res) => {
    res.status(200).json({ success: true, data: { status: 'ok' } });
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  app.enableCors({
    origin: true,
    credentials: true,
  });

  app.useWebSocketAdapter(new WsAdapter(app));

  // 优雅退出：SIGINT/SIGTERM 触发 onModuleDestroy（渠道断开/定时器清理/
  // MCP 子进程 close），对齐旧版 LifecycleManager.stopAll 语义
  app.enableShutdownHooks();
  updateMaintenance.shutdown = async () => { await app.close(); process.exit(0); };

  (app as { useStaticAssets?: unknown }).useStaticAssets = undefined;

  await setupSwaggerDocs(app, port, logger);

  // 重量级依赖预热（对齐旧版 monolith 启动即全量 require 的行为）：
  // sharp/canvas 等原生模块与 pdfjs/playwright 等大型 JS 库由各服务在
  // 首个请求时懒加载；安装后首次运行时 Defender 对新文件实时扫描，
  // 单库首次加载可阻塞事件循环数秒——端口已开但 /health 与 WS 握手
  // 排队超时，前端表现为"未连接"，加载完成后自行恢复。
  // 在 listen 之前统一加载，把阻塞吸收进加载页等待期（加载页轮询 60s）。
  // Optional capability dependencies are loaded by their installed extension.

  // A port number does not prove process ownership. Never terminate its occupant.
  try {
    await app.listen(port, host);
  } catch (err) {
    if ((err as { code?: string }).code === 'EADDRINUSE') {
      logger.error(
        `Port ${port} is already in use. Close the existing instance or choose another --port.`,
      );
    }
    await app.close();
    throw err;
  }

  logger.info(`SkyalyticWing backend listening on http://${host}:${port}`);
}

bootstrap().catch((err) => {
  console.error('Failed to bootstrap backend:', err);
  process.exit(1);
});
