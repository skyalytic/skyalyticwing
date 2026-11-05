import { LocalResourcePolicy } from '../../core/security/local-resource-policy.service.js';
import { getDefaultDataDir } from '../../core/utils/web-data.util.js';
import { checkedMemoryPath, writeMemoryText } from '../../memory/memory-files.js';
import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,

} from 'node:fs';
import { join } from 'node:path';
import { LoggerService } from '../../core/logger/logger.service.js';

/**
 * MemorySystem (代理记忆) - NestJS TypeScript 重写
 *
 * 移植自 packages/web/start.cjs 第 930-1682 行的 MemorySystem。
 *
 * 核心能力：
 *   - 记忆存储 / 检索 / 搜索（短期日记 + 长期 MEMORY.md）
 *   - 加权搜索（MEMORY.md 权重最高，今日/昨日笔记次之，其他记忆文件最低）
 *   - 记忆过期策略（短期晋升长期：dream cycle）
 *   - 摘要辅助函数（未自动接入会话，不自动保存全部对话）
 *   - 心跳机制（30 分钟间隔，3AM 触发深度 dream，含健康检查自愈）
 *
 * 记忆以 Markdown 文件形式持久化到账号/企业身份对应的用户数据目录：
 *   - data/MEMORY.md             长期记忆
 *   - data/memory/YYYY-MM-DD.md  每日日记
 *   - data/workspaces/<agent>/MEMORY.md  代理工作区记忆
 */

/** 心跳间隔（30 分钟） */
const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;

/** 记忆搜索结果条目 */
export interface MemorySearchResult {
  path: string;
  section: string;
  content: string;
  score: number;
  lineStart: number;
}

/** 记忆读取结果（分段） */
export interface MemoryGetResult {
  path?: string;
  content?: string;
  totalLines?: number;
  fromLine?: number;
  toLine?: number;
  hasMore?: boolean;
  error?: string;
}

/** 会话消息（自动摘要入参） */
export interface MemorySessionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | string;
  content: string;
}

@Injectable()
export class MemoryService implements OnModuleInit, OnModuleDestroy {
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private healthCheckTimer: ReturnType<typeof setInterval> | undefined;
  private lastHeartbeatTime = 0;

  constructor(private readonly logger: LoggerService, @Optional() private readonly resourcePolicy?: LocalResourcePolicy) {}

  private get dataDir(): string {
    const root = getDefaultDataDir();
    return this.resourcePolicy?.localMemoryRoot(root) ?? root;
  }
  private get memoryDir(): string { return checkedMemoryPath(this.dataDir, join(this.dataDir, 'memory')); }
  private workspaceMemory(agentId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(agentId)) throw new Error('无效的智能体标识');
    return checkedMemoryPath(this.dataDir, join(this.dataDir, 'workspaces', agentId, 'MEMORY.md'));
  }

  /** 模块初始化：初始化记忆文件 + 启动心跳 */
  onModuleInit(): void {
    this.init();
    this.startHeartbeat();
  }

  onModuleDestroy(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }

  /** 获取今日日记文件路径 */
  private _getTodayFile(): string {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return checkedMemoryPath(this.dataDir, join(this.memoryDir, `${y}-${m}-${day}.md`));
  }

  /** 获取昨日日记文件路径 */
  private _getYesterdayFile(): string {
    const d = new Date(Date.now() - 86_400_000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return checkedMemoryPath(this.dataDir, join(this.memoryDir, `${y}-${m}-${day}.md`));
  }

  /** 获取长期记忆 MEMORY.md 路径 */
  private _getMemoryMdPath(): string {
    return checkedMemoryPath(this.dataDir, join(this.dataDir, 'MEMORY.md'));
  }

  /**
   * 初始化：创建默认 MEMORY.md 与今日日记
   */
  init(): void {
    try {
      if (!existsSync(this._getMemoryMdPath())) {
        writeMemoryText(
          this._getMemoryMdPath(),
          '# 长期记忆\n\n此文件存储经过验证的重要信息，每次会话自动加载。\n\n## 用户偏好\n\n## 重要决策\n\n## 关键信息\n\n## 常用模式\n',
        );
      }
      const todayFile = this._getTodayFile();
      if (!existsSync(todayFile)) {
        const d = new Date();
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        writeMemoryText(todayFile, `# ${y}-${m}-${day} 日记\n\n## 观察\n\n## 待办\n\n## 备注\n`);
      }
      this.logger.info('memory: Memory system initialized', {
        memoryMd: existsSync(this._getMemoryMdPath()),
        today: existsSync(todayFile),
      });
    } catch (e) {
      this.logger.warn('memory: Init failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * 搜索记忆
   * - 加权：MEMORY.md(2.0) > 工作区记忆(1.8) > 今日(1.5) > 昨日(1.2) > 其他(1.0)
   * - 按 markdown 章节切分并评分
   * - 返回按分数倒序的 top N
   */
  search(query: string, maxResults = 10, agentId?: string): MemorySearchResult[] {
    const results: MemorySearchResult[] = [];
    if (!query.trim()) return [];
    maxResults = Number.isFinite(maxResults) ? Math.max(1, Math.min(100, Math.floor(maxResults))) : 10;
    const queryLower = query.trim().toLowerCase();
    const queryWords = queryLower
      .split(/[\s,，。.!?！？]+/)
      .filter((w) => w.length > 1);

    interface FileCandidate {
      path: string;
      full: string;
      weight: number;
    }
    const files: FileCandidate[] = [];

    const memMd = this._getMemoryMdPath();
    if (existsSync(memMd)) files.push({ path: 'MEMORY.md', full: memMd, weight: 2.0 });

    if (agentId && agentId !== 'main') {
      const wsMemPath = this.workspaceMemory(agentId);
      if (existsSync(wsMemPath)) {
        files.push({
          path: `workspaces/${agentId}/MEMORY.md`,
          full: wsMemPath,
          weight: 1.8,
        });
      }
    }

    const todayFile = this._getTodayFile();
    if (existsSync(todayFile)) {
      files.push({ path: 'memory/' + (todayFile.split(/[\\/]/).pop() || 'today.md'), full: todayFile, weight: 1.5 });
    }
    const yesterdayFile = this._getYesterdayFile();
    if (existsSync(yesterdayFile)) {
      files.push({
        path: 'memory/' + (yesterdayFile.split(/[\\/]/).pop() || 'yesterday.md'),
        full: yesterdayFile,
        weight: 1.2,
      });
    }

    try {
      const allFiles = readdirSync(this.memoryDir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .reverse();
      for (const f of allFiles) {
        const full = join(this.memoryDir, f);
        if (files.some((ef) => ef.full === full)) continue;
        files.push({ path: `memory/${f}`, full, weight: 1.0 });
      }
    } catch {
      // memory 目录不存在
    }

    for (const file of files) {
      try {
        const content = readFileSync(checkedMemoryPath(this.dataDir, file.full), 'utf-8');
        const lines = content.split('\n');
        let currentSection = '';
        let sectionLines: string[] = [];
        for (let li = 0; li < lines.length; li++) {
          if (/^#{1,3}\s/.test(lines[li])) {
            if (sectionLines.length > 0) {
              const sectionText = sectionLines.join('\n');
              const score = this._scoreText(sectionText, queryLower, queryWords);
              if (score > 0) {
                results.push({
                  path: file.path,
                  section: currentSection,
                  content: sectionText.substring(0, 500),
                  score: score * file.weight,
                  lineStart: li - sectionLines.length + 1,
                });
              }
            }
            currentSection = lines[li].replace(/^#+\s*/, '');
            sectionLines = [lines[li]];
          } else {
            sectionLines.push(lines[li]);
          }
        }
        if (sectionLines.length > 0) {
          const lastText = sectionLines.join('\n');
          const lastScore = this._scoreText(lastText, queryLower, queryWords);
          if (lastScore > 0) {
            results.push({
              path: file.path,
              section: currentSection,
              content: lastText.substring(0, 500),
              score: lastScore * file.weight,
              lineStart: lines.length - sectionLines.length + 1,
            });
          }
        }
      } catch {
        // 读取失败跳过
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  /** 评分：完整查询命中 +10，每个分词命中 +3 */
  private _scoreText(text: string, queryLower: string, queryWords: string[]): number {
    const textLower = text.toLowerCase();
    let score = 0;
    if (textLower.indexOf(queryLower) >= 0) score += 10;
    for (const w of queryWords) {
      if (textLower.indexOf(w) >= 0) score += 3;
    }
    return score;
  }

  /**
   * 读取记忆文件（支持分段）
   * - 路径安全校验：禁止逃逸 this.dataDir
   * - relPath 为空时读取 MEMORY.md 全文
   */
  get(relPath?: string, fromLine?: number, numLines?: number): string | MemoryGetResult {
    if (!relPath) {
      try {
        return readFileSync(this._getMemoryMdPath(), 'utf-8');
      } catch {
        return '';
      }
    }
    let fullPath: string;
    try {
      const name = relPath.replace(/\\/g, '/');
      if (/^memory\.md$/i.test(name)) fullPath = this._getMemoryMdPath();
      else if (/^workspaces\/[a-zA-Z0-9_-]{1,160}\/MEMORY\.md$/.test(name)) fullPath = this.workspaceMemory(name.split('/')[1]!);
      else {
        const file = name.startsWith('memory/') ? name.slice(7) : name;
        if (!/^[^/\\:\0]+\.md$/i.test(file) || file.includes('..')) return {error:'仅允许读取记忆 Markdown 文件'};
        fullPath = checkedMemoryPath(this.dataDir, join(this.memoryDir, file));
      }
    } catch (err) { return {error: err instanceof Error ? err.message : String(err)}; }
    if (!existsSync(fullPath)) return { error: `文件不存在: ${relPath}` };
    try {
      const content = readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');
      const start = Math.max(0, Math.floor(Number.isFinite(fromLine) ? fromLine! : 1) - 1);
      const count = Math.max(1, Math.min(1000, Math.floor(Number.isFinite(numLines) ? numLines! : 120)));
      const selected = lines.slice(start, start + count);
      const hasMore = start + count < lines.length;
      return {
        path: relPath,
        content: selected.join('\n'),
        totalLines: lines.length,
        fromLine: start + 1,
        toLine: start + selected.length,
        hasMore,
      };
    } catch (e) {
      return { error: `读取失败: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /** 追加内容到今日日记 */
  appendToToday(text: string): { ok: boolean; error?: string } {
    const todayFile = this._getTodayFile();
    try {
      let content = '';
      if (existsSync(todayFile)) content = readFileSync(todayFile, 'utf-8');
      if (!content.endsWith('\n')) content += '\n';
      content += text + '\n';
      writeMemoryText(todayFile, content);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * 追加内容到长期记忆 MEMORY.md
   * - 若指定 agentId（非 main），只追加到该代理工作区，避免污染全局记忆
   */
  appendToMemory(text: string, agentId?: string): { ok: boolean; error?: string } {
    try {
      const memMd = agentId && agentId !== 'main' ? this.workspaceMemory(agentId) : this._getMemoryMdPath();
      let content = existsSync(memMd) ? readFileSync(memMd, 'utf8') : '';
      if (!content.endsWith('\n')) content += '\n';
      writeMemoryText(memMd, content + text + '\n');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * 为 prompt 构建记忆上下文
   * - 代理工作区记忆（若有）
   * - 全局长期记忆 MEMORY.md
   * - 今日笔记
   * - 昨日笔记（截断前 1000 字符）
   */
  getContextForPrompt(agentId?: string): string {
    const parts: string[] = [];
    const activeAgent = agentId && agentId !== 'main' ? agentId : null;

    if (activeAgent) {
      const wsMemPath = this.workspaceMemory(activeAgent);
      if (existsSync(wsMemPath)) {
        try {
          const wsContent = readFileSync(wsMemPath, 'utf-8');
          if (wsContent.trim().length > 5) {
            parts.push(
              `## 代理记忆 (workspaces/${activeAgent}/MEMORY.md)\n${wsContent}`,
            );
          }
        } catch {
          // 忽略
        }
      }
    }

    const memMd = this._getMemoryMdPath();
    if (existsSync(memMd)) {
      try {
        const content = readFileSync(memMd, 'utf-8');
        if (content.trim().length > 5) {
          parts.push(`## 全局长期记忆 (MEMORY.md)\n${content}`);
        }
      } catch {
        // 忽略
      }
    }

    const todayFile = this._getTodayFile();
    if (existsSync(todayFile)) {
      try {
        const todayContent = readFileSync(todayFile, 'utf-8');
        if (todayContent.trim().length > 20) {
          parts.push(`## 今日笔记\n${todayContent}`);
        }
      } catch {
        // 忽略
      }
    }

    const yesterdayFile = this._getYesterdayFile();
    if (existsSync(yesterdayFile)) {
      try {
        const ydContent = readFileSync(yesterdayFile, 'utf-8');
        if (ydContent.trim().length > 20) {
          parts.push(`## 昨日笔记\n${ydContent.substring(0, 1000)}`);
        }
      } catch {
        // 忽略
      }
    }

    return parts.length > 0 ? `\n\n${parts.join('\n\n').slice(-8000)}` : '';
  }

  /**
   * 自动摘要会话
   * - 从消息中提取用户偏好（关键词 + 正则匹配）
   * - 提取重要决策
   * - 提取对话主题（基于关键词列表）
   * - 写入今日笔记的会话摘要章节
   * - 用户偏好/决策同步晋升到 MEMORY.md 对应章节
   *
   * 注意：不再提取"自我纠正/道歉"类内容（原 .cjs 注释说明：道歉消息
   * 被摘要进今日笔记 → 新会话继承 → AI 再次道歉，造成困惑）
   */
  autoSummarize(sessionId: string, messages: MemorySessionMessage[]): void {
    this.logger.info('memory: autoSummarize called', {
      sessionId,
      msgCount: messages.length,
    });
    if (!messages || messages.length < 2) return;

    const userMsgs = messages.filter((m) => m.role === 'user');
    const assistantMsgs = messages.filter((m) => m.role === 'assistant' && m.content);
    if (userMsgs.length === 0) return;

    const userPreferences: string[] = [];
    const decisions: string[] = [];

    for (const m of messages) {
      const c = String(m.content || '').toLowerCase();
      if (m.role === 'user') {
        let prefMatched = false;
        // 关键词匹配
        if (
          c.indexOf('我喜欢') >= 0 ||
          c.indexOf('我偏好') >= 0 ||
          c.indexOf('我习惯') >= 0 ||
          c.indexOf('请记住') >= 0 ||
          c.indexOf('不要') >= 0 ||
          c.indexOf('以后') >= 0 ||
          c.indexOf('记住') >= 0 ||
          c.indexOf('总是') >= 0 ||
          c.indexOf('每次') >= 0 ||
          c.indexOf('i like') >= 0 ||
          c.indexOf('i prefer') >= 0 ||
          c.indexOf('remember') >= 0 ||
          c.indexOf('always') >= 0 ||
          c.indexOf('never') >= 0
        ) {
          prefMatched = true;
        }
        // 正则匹配
        if (!prefMatched) {
          const prefPatterns = [
            /我.{0,4}喜欢/,
            /我.{0,4}偏好/,
            /我.{0,4}偏爱/,
            /我.{0,4}习惯/,
            /更喜欢/,
            /比较喜欢/,
            /prefer\s+to/,
            /prefer\s+\w+/,
            /i\s+usually/,
          ];
          for (const p of prefPatterns) {
            if (p.test(c)) {
              prefMatched = true;
              break;
            }
          }
        }
        if (prefMatched) {
          userPreferences.push(String(m.content || '').substring(0, 200));
        }
        if (
          c.indexOf('决定') >= 0 ||
          c.indexOf('选择') >= 0 ||
          c.indexOf('方案') >= 0 ||
          c.indexOf('decided') >= 0 ||
          c.indexOf('choose') >= 0 ||
          c.indexOf('decision') >= 0
        ) {
          decisions.push(String(m.content || '').substring(0, 200));
        }
      }
    }

    // 主题关键词
    const topicKeywords = [
      '定时任务', 'cron', '浏览器', 'browser', '知识库', '文件', '发送', '搜索',
      '打开', '创建', '删除', '代码', '编程', '代理', 'agent', '工作区', '记忆',
      'memory: 模型', '配置', '工具', '桌面', 'desktop', '子代理', 'subagent', '蜂群', 'swarm',
    ];
    let topicStr = '';
    for (let ti = 0; ti < messages.length && ti < 20; ti++) {
      const t = String(messages[ti].content || '').substring(0, 200);
      for (const kw of topicKeywords) {
        if (t.indexOf(kw) >= 0 && topicStr.indexOf(kw) < 0) {
          topicStr += (topicStr ? '、' : '') + kw;
          if (topicStr.split('、').length >= 5) break;
        }
      }
    }
    if (!topicStr) topicStr = '一般对话';

    const now = new Date();
    const timestamp =
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ` +
      `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    let summary = `\n### 会话摘要 [${timestamp}]\n`;
    summary += `\n**对话主题**: ${topicStr}\n`;
    summary += `\n**消息数**: ${messages.length} (用户:${userMsgs.length} 助手:${assistantMsgs.length})\n`;
    if (userPreferences.length > 0) {
      summary += '\n**用户偏好发现**:\n';
      for (const p of userPreferences) summary += `- ${p}\n`;
    }
    if (decisions.length > 0) {
      summary += '\n**重要决策**:\n';
      for (const d of decisions) summary += `- ${d}\n`;
    }
    this.appendToToday(summary);
    this.logger.info('memory: Auto-summarized session', {
      sessionId,
      prefs: userPreferences.length,
      decisions: decisions.length,
      topics: topicStr,
    });

    if (userPreferences.length > 0) {
      let prefText = '';
      for (const p of userPreferences) prefText += `- ${p}\n`;
      this._appendToMemorySection('## 用户偏好\n', prefText);
    }
    if (decisions.length > 0) {
      let decText = '';
      for (const d of decisions) decText += `- ${d}\n`;
      this._appendToMemorySection('## 重要决策\n', decText);
    }
  }

  /**
   * 向 MEMORY.md（及当前代理工作区记忆）的指定章节追加内容
   * - 章节存在：在章节末尾（下一个 ## 之前）插入
   * - 章节不存在：在文件末尾追加章节
   */
  private _appendToMemorySection(sectionHeader: string, text: string, agentId?: string): void {
    const paths: string[] = agentId && agentId !== 'main' ? [] : [this._getMemoryMdPath()];
    if (agentId && agentId !== 'main') {
      const wsMemPath = this.workspaceMemory(agentId);
      if (!paths.includes(wsMemPath)) paths.push(wsMemPath);
    }
    for (const memPath of paths) {
      try {
        let existing = '';
        if (existsSync(memPath)) existing = readFileSync(memPath, 'utf-8');
        if (existing.indexOf(sectionHeader) >= 0) {
          let sectionEnd = existing.indexOf(
            '\n##',
            existing.indexOf(sectionHeader) + sectionHeader.length,
          );
          if (sectionEnd < 0) sectionEnd = existing.length;
          existing =
            existing.substring(0, sectionEnd) + text + existing.substring(sectionEnd);
        } else {
          existing += '\n' + sectionHeader + text;
        }
        const dir = join(memPath, '..');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeMemoryText(memPath, existing);
      } catch (e) {
        this.logger.warn('memory: Failed to write section', {
          path: memPath,
          error: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
    }
  }

  /**
   * Dream Cycle（记忆巩固）
   * - 从今日笔记中筛选"用户偏好发现/重要决策"章节作为晋升候选
   * - 将候选条目晋升到长期 MEMORY.md 对应章节（去重）
   * - 不向其他代理工作区复制记忆
   */
  runDreamCycle(): void {
    const today = this._getTodayFile();
    if (!existsSync(today)) return;
    // Only explicit candidate sections are eligible. Never broadcast one agent's notes to all agents.
    const lines = readFileSync(today,'utf8').split('\n');
    let section = '';
    const candidates = new Map<string, Set<string>>();
    for (const line of lines) {
      if (line.startsWith("**用户偏好发现**")) section = '## 用户偏好\n';
      else if (line.startsWith("**重要决策**")) section = '## 重要决策\n';
      else if (/^(#|\*\*)/.test(line)) section = '';
      else if (section && /^- .{5,}$/.test(line.trim())) {
        const values = candidates.get(section) ?? new Set<string>();
        values.add(line.trim()); candidates.set(section, values);
      }
    }
    for (const [header, values] of candidates) {
      const current = String(this.get());
      const fresh = [...values].filter(line => !current.split('\n').includes(line));
      if (fresh.length) this._appendToMemorySection(header, fresh.join('\n') + '\n');
    }
  }
  /**
   * 启动心跳
   * - 30 分钟间隔执行 dream cycle
   * - 凌晨 3 点触发深度 dream
   * - 健康检查：超过 2.5 倍间隔无心跳则自动重启
   */
  startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.lastHeartbeatTime = Date.now();
    this.heartbeatTimer = setInterval(() => {
      try {
        this.lastHeartbeatTime = Date.now();
        this.logger.info('memory: Heartbeat tick (interval=30min)');
        this.runDreamCycle();
        const now = new Date();
        if (now.getHours() === 3 && now.getMinutes() < 5) {
          this.logger.info('memory: Deep dream cycle triggered at 3AM');
          this.runDreamCycle();
        }
      } catch (e) {
        this.logger.warn('memory: Heartbeat error', {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }, HEARTBEAT_INTERVAL_MS);

    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
    this.healthCheckTimer = setInterval(() => {
      const elapsed = Date.now() - this.lastHeartbeatTime;
      if (elapsed > HEARTBEAT_INTERVAL_MS * 2.5) {
        this.logger.warn(`memory: Heartbeat health check: no tick for ${Math.round(elapsed / 60000)}min, restarting`);
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
        this.startHeartbeat();
      }
    }, HEARTBEAT_INTERVAL_MS);

    // 不阻塞进程退出
    if (this.heartbeatTimer && typeof this.heartbeatTimer.unref === 'function') {
      this.heartbeatTimer.unref();
    }
    if (this.healthCheckTimer && typeof this.healthCheckTimer.unref === 'function') {
      this.healthCheckTimer.unref();
    }
    this.logger.info(`memory: Memory heartbeat started (interval=${HEARTBEAT_INTERVAL_MS / 60000}min, healthCheck=on)`);
  }
}


