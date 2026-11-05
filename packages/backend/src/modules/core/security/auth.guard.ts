import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  HttpStatus,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { ConfigService } from '../config/config.service.js';
import { allowsDesignFrameRender } from './design-frame-token.js';
import { allowsOfficeEngineRequest } from '../../tools/files/office-engine.service.js';

/**
 * AuthGuard - HTTP REST 可选鉴权（默认关闭）
 *
 * 与 WebSocketGateway 的 Token 认证保持同一套配置来源：
 *   - config.json `security.auth.mode` / `security.auth.token`
 *   - 环境变量 SKYALYTICWING_AUTH_TOKEN（由 ConfigService.applyEnvOverrides
 *     自动映射为 security.auth.token + security.auth.mode='token'）
 *
 * 行为：
 *   - mode !== 'token'（默认 'none'）→ 直接放行，与无 Guard 现状完全一致
 *   - mode === 'token' 且 token 已配置 → 校验请求头：
 *       · Authorization: Bearer <token>
 *       · X-Auth-Token: <token>
 *     使用 timingSafeEqual 常量时间比较，失败返回 401
 *   - mode === 'token' 但 token 为空 → fail-close，拒绝访问（对齐设计文档 §9.1）
 *
 * 白名单（不鉴权）：
 *   - /health                     健康检查
 *   - 非 /api/ 前缀路径            前端静态资源（页面壳本身不含敏感数据，
 *                                数据均经 /api/* 提供，由本 Guard 保护）
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      path?: string;
      url?: string;
      headers?: Record<string, string | string[] | undefined>;
      method?: string;
    }>();
    const path = request.path || request.url || '/';


    if (this.isWhitelisted(path)) return true;
    if (allowsDesignFrameRender(request.url || path, request.method || 'GET')) return true;
    if (allowsOfficeEngineRequest(request.url || path, request.method || 'GET')) return true;

    let authMode = 'none';
    let authToken = '';
    try {
      const security = this.config.get<Record<string, unknown>>('security');
      const auth = (security['auth'] || {}) as Record<string, unknown>;
      authMode = typeof auth['mode'] === 'string' ? auth['mode'] : 'none';
      authToken = typeof auth['token'] === 'string' ? auth['token'] : '';
    } catch {
      // 配置缺失视为开放模式（与 WebSocketGateway 行为一致）
    }

    if (authMode !== 'token') return true;
    if (!authToken) {
      // fail-close：配置了 token 模式但未配置 token
      this.logger.warn('Token auth configured but no token set, rejecting request');
      throw new HttpException('Token auth configured but no token set', HttpStatus.UNAUTHORIZED);
    }

    const provided = this.extractToken(request.headers || {});
    if (!provided) {
      throw new HttpException('Missing token', HttpStatus.UNAUTHORIZED);
    }

    const providedBuf = Buffer.from(provided);
    const expectedBuf = Buffer.from(authToken);
    if (
      providedBuf.length !== expectedBuf.length ||
      !timingSafeEqual(providedBuf, expectedBuf)
    ) {
      throw new HttpException('Invalid token', HttpStatus.UNAUTHORIZED);
    }
    return true;
  }

  /** 白名单路径判断（/health、非 /api/ 前缀的静态资源） */
  private isWhitelisted(path: string): boolean {
    // Express routes are case-insensitive by default; guard matching must agree.
    path = path.split('?')[0]!.toLowerCase();
    if (path === '/health' || path === '/health/') return true;
    // 非 /api/ 前缀：前端静态资源（/、/assets/*、/api-docs 等 Swagger 归 /api-docs 不匹配 /api/ 前缀则放行）
    return path !== '/api' && !path.startsWith('/api/');
  }

  /** 从请求头提取 token：Authorization: Bearer <token> 或 X-Auth-Token */
  private extractToken(headers: Record<string, string | string[] | undefined>): string {
    const authHeader = headers['authorization'];
    if (authHeader) {
      const authStr = Array.isArray(authHeader) ? authHeader[0] || '' : authHeader;
      const m = authStr.match(/^bearer\s+(.+)$/i);
      if (m && m[1]) return m[1];
    }
    const xToken = headers['x-auth-token'];
    if (xToken) {
      return Array.isArray(xToken) ? xToken[0] || '' : xToken;
    }
    return '';
  }
}
