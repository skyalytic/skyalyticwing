import type { ToolDefinition, ToolResult } from '@skyalyticwing/shared';
import { platform } from 'node:os';
import { SecurityManagerService } from '../../../../modules/core/security/security-manager.service.js';
import type { ServiceResolver } from '../../../../modules/tools/executor/built-in/service-resolver.js';
import { DaemonService } from '../../../../modules/channels/daemon/daemon.service.js';
import { BindingService } from '../../../../modules/channels/binding.service.js';
import { jsonOut } from '../../reach/tools/agent-reach.js';

function fail(error: string): ToolResult {
  return { success: false, error };
}

/**
 * 守护进程 / 配对 / 安全审计 / 沙箱 / 路由绑定域内置工具（移植自旧版 misc.cjs）：
 * daemon_install / daemon_uninstall / daemon_status / pairing_generate / pairing_list /
 * security_audit / sandbox_run / binding_add / binding_list。
 *
 * - DaemonService / BindingService 位于非全局模块，经 ServiceResolver 懒解析
 * - pairing / audit / sandbox 直接桥接全局 SecurityManagerService
 */
export function createDaemonTools(
  security: SecurityManagerService,
  resolve: ServiceResolver,
): ToolDefinition[] {
  return [
    // ═══ daemon_install ═══
    {
      name: 'daemon_install',
      description:
        '将 SkyalyticWing 安装为系统守护服务（开机自启）。支持 macOS(launchd)/Linux(systemd)/Windows(schtasks)。',
      category: 'system',
      dangerous: true,
      parameters: {
        type: 'object',
        properties: {
          autoStart: { type: 'boolean', description: '是否开机自启，默认 true' },
          name: { type: 'string', description: '服务名称，默认 skyalyticwing' },
        },
        required: [],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = (args || {}) as { autoStart?: boolean; name?: string };
        const daemon = resolve(DaemonService);
        if (!daemon) return fail('DaemonService 未初始化');
        try {
          await daemon.install({
            name: a.name || 'skyalyticwing',
            displayName: 'SkyalyticWing Gateway',
            description: 'SkyalyticWing AI 助手网关服务',
            autoStart: a.autoStart !== false,
          });
          return jsonOut({ installed: true, platform: platform(), name: a.name || 'skyalyticwing' });
        } catch (err) {
          return fail(`服务安装失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },

    // ═══ daemon_uninstall ═══
    {
      name: 'daemon_uninstall',
      description: '卸载系统守护服务。',
      category: 'system',
      dangerous: false,
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(): Promise<ToolResult> {
        const daemon = resolve(DaemonService);
        if (!daemon) return fail('DaemonService 未初始化');
        try {
          await daemon.uninstall();
          return jsonOut({ uninstalled: true });
        } catch (err) {
          return fail(`服务卸载失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },

    // ═══ daemon_status ═══
    {
      name: 'daemon_status',
      description: '查看系统守护服务状态（安装、运行、平台、管理器等）。',
      category: 'system',
      dangerous: false,
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(): Promise<ToolResult> {
        const daemon = resolve(DaemonService);
        if (!daemon) return fail('DaemonService 未初始化');
        try {
          return jsonOut({ ...daemon.getStatus(), platform: platform() });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ pairing_generate ═══
    {
      name: 'pairing_generate',
      description: '生成设备配对码（6 位，默认 5 分钟有效）。用于验证新的消息发送者，防止未授权访问。',
      category: 'system',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          senderId: { type: 'string', description: '发送者标识（如 Telegram 用户 ID）' },
          channel: { type: 'string', description: '消息渠道（可选）' },
          expiresIn: { type: 'number', description: '有效时长（毫秒），默认 300000' },
        },
        required: ['senderId'],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = (args || {}) as { senderId?: string; channel?: string; expiresIn?: number };
        if (typeof a.senderId !== 'string' || a.senderId.length === 0) {
          return fail('Parameter "senderId" is required');
        }
        try {
          const r = security.generatePairingCode(
            a.senderId,
            {
              ...(a.channel ? { channel: a.channel } : {}),
              ...(typeof a.expiresIn === 'number' && a.expiresIn > 0 ? { expiresIn: a.expiresIn } : {}),
            },
          );
          return jsonOut({ code: r.code, expiresAt: r.expiresAt, senderId: a.senderId });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ pairing_list ═══
    {
      name: 'pairing_list',
      description: '列出所有已配对的设备。',
      category: 'system',
      dangerous: false,
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(): Promise<ToolResult> {
        try {
          const devices = security.listPairedDevices();
          return jsonOut({ total: devices.length, devices });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ security_audit ═══
    {
      name: 'security_audit',
      description:
        '运行安全审计：检查文件权限、配置安全、API 密钥暴露等，可选择自动修复发现的问题。',
      category: 'system',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          fix: { type: 'boolean', description: '是否自动修复发现的问题，默认 false' },
        },
        required: [],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = (args || {}) as { fix?: boolean };
        try {
          const findings = security.runAudit();
          const result: Record<string, unknown> = {
            findings: findings.map((f) => ({
              id: f.id,
              severity: f.severity,
              area: f.area,
              description: f.description,
              fixable: f.fixable,
            })),
            report: security.getAuditReport(),
          };
          if (a.fix) {
            result['fixes'] = security.fixAllFindings();
          }
          return jsonOut(result);
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ═══ sandbox_run ═══
    {
      name: 'sandbox_run',
      description:
        '在隔离沙箱中执行命令（Docker 或 SSH），用于运行不受信任的代码。auto 模式自动选择可用沙箱。',
      category: 'system',
      dangerous: true,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          sandboxType: {
            type: 'string',
            enum: ['docker', 'ssh', 'auto'],
            description: '沙箱类型，默认 auto',
          },
        },
        required: ['command'],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = (args || {}) as { command?: string; sandboxType?: 'docker' | 'ssh' | 'auto' };
        if (typeof a.command !== 'string' || a.command.length === 0) {
          return fail('Parameter "command" is required');
        }
        const type = a.sandboxType || 'auto';
        try {
          if (type === 'docker' || (type === 'auto' && (await security.isDockerAvailable()))) {
            const r = await security.runInDocker(a.command);
            return jsonOut({ sandbox: 'docker', ...r });
          }
          if (type === 'ssh') {
            const r = await security.runInSsh(a.command);
            return jsonOut({ sandbox: 'ssh', ...r });
          }
          return fail('无可用沙箱：未检测到 Docker，SSH 沙箱需显式指定 sandboxType=ssh 并完成配置。');
        } catch (err) {
          return fail(`沙箱执行失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },

    // ═══ binding_add ═══
    {
      name: 'binding_add',
      description:
        '添加 Agent 路由绑定：将匹配指定渠道/账户/对端/群组/团队的消息路由到指定 Agent。',
      category: 'system',
      dangerous: false,
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: '目标 Agent ID' },
          matchChannel: { type: 'string', description: '匹配渠道（如 telegram/discord/feishu，* 表示全部）' },
          matchAccountId: { type: 'string', description: '匹配账户 ID（可选）' },
          matchPeerId: { type: 'string', description: '匹配对端 ID（可选）' },
          matchGuildId: { type: 'string', description: '匹配 Guild ID（可选）' },
          matchTeamId: { type: 'string', description: '匹配 Team ID（可选）' },
        },
        required: ['agentId', 'matchChannel'],
      },
      async execute(args: unknown): Promise<ToolResult> {
        const a = (args || {}) as {
          agentId?: string; matchChannel?: string; matchAccountId?: string;
          matchPeerId?: string; matchGuildId?: string; matchTeamId?: string;
        };
        if (typeof a.agentId !== 'string' || a.agentId.length === 0) {
          return fail('Parameter "agentId" is required');
        }
        if (typeof a.matchChannel !== 'string' || a.matchChannel.length === 0) {
          return fail('Parameter "matchChannel" is required');
        }
        const binding = resolve(BindingService);
        if (!binding) return fail('BindingService 未初始化');
        try {
          const created = binding.addBinding({
            agentId: a.agentId,
            matchChannel: a.matchChannel,
            ...(a.matchAccountId ? { matchAccountId: a.matchAccountId } : {}),
            ...(a.matchPeerId ? { matchPeerId: a.matchPeerId } : {}),
            ...(a.matchGuildId ? { matchGuildId: a.matchGuildId } : {}),
            ...(a.matchTeamId ? { matchTeamId: a.matchTeamId } : {}),
          });
          return jsonOut({ binding: created });
        } catch (err) {
          return fail(`添加绑定失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },

    // ═══ binding_list ═══
    {
      name: 'binding_list',
      description: '列出所有 Agent 路由绑定。',
      category: 'system',
      dangerous: false,
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(): Promise<ToolResult> {
        const binding = resolve(BindingService);
        if (!binding) return fail('BindingService 未初始化');
        try {
          const bindings = binding.listBindings();
          return jsonOut({ total: bindings.length, bindings });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];
}
