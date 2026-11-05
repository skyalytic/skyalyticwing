import { Injectable } from '@nestjs/common';

/** 命令分类决策结果 */
export interface YoloDecision {
  /** 决策：allow 放行 / deny 拒绝 / ask 询问用户 */
  decision: 'allow' | 'deny' | 'ask';
  /** 置信度 0~1 */
  confidence: number;
  /** 决策原因 */
  reason: string;
}

/**
 * YoloClassifierService - 安全命令分类器
 *
 * 从 packages/web/start.cjs YoloClassifier 全量移植。
 *
 * 职责：
 *   - 对 shell 命令进行安全分级（allow / deny / ask）
 *   - 30+ 安全只读命令前缀匹配 → allow（置信度 0.95）
 *   - 20+ 危险命令模式子串匹配 → deny（置信度 0.98）
 *   - 低风险文件操作（cd/mkdir/touch）→ allow（0.85）
 *   - Git 写操作（add/commit/push/pull）→ allow（0.8）
 *   - 包安装（install/npm/pip）→ ask（0.6）
 *   - 写入操作（write/>/>>）→ ask（0.7）
 *   - 未知命令 → ask（0.5）
 */
@Injectable()
export class YoloClassifierService {
  /** 安全只读命令列表（前缀匹配） */
  private readonly _safeCommands: readonly string[] = [
    'ls',
    'dir',
    'cat',
    'head',
    'tail',
    'grep',
    'find',
    'which',
    'where',
    'echo',
    'pwd',
    'whoami',
    'hostname',
    'date',
    'uname',
    'df',
    'du',
    'free',
    'top',
    'ps',
    'env',
    'printenv',
    'type',
    'get-command',
    'git status',
    'git log',
    'git diff',
    'git branch',
    'git remote',
    'node -v',
    'npm -v',
    'python --version',
    'python3 --version',
  ];

  /** 危险命令模式列表（子串匹配） */
  private readonly _dangerousCommands: readonly string[] = [
    'rm -rf',
    'del /s',
    'format',
    'mkfs',
    'dd if=',
    'chmod 777',
    'chown',
    '> /etc/',
    'curl.*|.*sh',
    'wget.*|.*sh',
    ':(){:|:&};:',
    'shutdown',
    'reboot',
    'halt',
    'poweroff',
    'taskkill /f',
    'reg delete',
    'reg add',
    'net user',
    'net localgroup',
  ];

  /** 内置安全命令清单（只读，供权限管理页展示"内置白名单"） */
  getSafeCommands(): string[] {
    return [...this._safeCommands];
  }

  /**
   * 对命令进行安全分类。
   *
   * 匹配顺序（与 .cjs 原始实现一致）：
   *   1. 空命令 → allow（1.0）
   *   2. 安全命令前缀 → allow（0.95）
   *   3. 危险命令子串 → deny（0.98）
   *   4. 低风险文件操作（cd/mkdir/touch）→ allow（0.85）
   *   5. Git 写操作 → allow（0.8）
   *   6. 包安装 → ask（0.6）
   *   7. 写入操作 → ask（0.7）
   *   8. 未知 → ask（0.5）
   */
  classify(command: string | null | undefined): YoloDecision {
    if (!command || typeof command !== 'string') {
      return { decision: 'allow', confidence: 1.0, reason: '空命令' };
    }

    const cmd = command.trim().toLowerCase();

    // 危险命令模式子串匹配
    for (const pattern of this._dangerousCommands) {
      if (cmd.indexOf(pattern.toLowerCase()) >= 0) {
        return {
          decision: 'deny',
          confidence: 0.98,
          reason: '危险命令模式: ' + pattern,
        };
      }
    }

    if (/[;&|><\n\r\x60]/.test(cmd) || cmd.includes('$(')) {
      return { decision: 'ask', confidence: 0.9, reason: '复合命令、重定向或命令替换需要确认' };
    }
    // 安全只读命令前缀匹配
    for (const safe of this._safeCommands) {
      if ((cmd === safe || cmd.startsWith(safe + ' '))) {
        return {
          decision: 'allow',
          confidence: 0.95,
          reason: '安全只读命令: ' + safe,
        };
      }
    }

    // 低风险文件操作
    if (
      cmd.startsWith('cd ') ||
      cmd.startsWith('mkdir ') ||
      cmd.startsWith('touch ')
    ) {
      return { decision: 'allow', confidence: 0.85, reason: '低风险文件操作' };
    }

    // Git 写操作（低风险）
    if (
      cmd.startsWith('git add') ||
      cmd.startsWith('git commit')
    ) {
      return {
        decision: 'allow',
        confidence: 0.8,
        reason: 'Git写操作(低风险)',
      };
    }

    // 包安装操作（需确认）
    if (
      cmd.indexOf('install') >= 0 ||
      cmd.indexOf('npm ') >= 0 ||
      cmd.indexOf('pip ') >= 0
    ) {
      return { decision: 'ask', confidence: 0.6, reason: '包安装操作(需确认)' };
    }

    // 写入操作（需确认）
    if (
      cmd.indexOf('write') >= 0 ||
      cmd.indexOf('>') >= 0 ||
      cmd.indexOf('>>') >= 0
    ) {
      return { decision: 'ask', confidence: 0.7, reason: '写入操作(需确认)' };
    }

    // 未知命令（需确认）
    return { decision: 'ask', confidence: 0.5, reason: '未知命令(需确认)' };
  }
}
