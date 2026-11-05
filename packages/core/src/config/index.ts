import { z } from 'zod';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import type { AppConfig } from '../types/index.js';

const ConfigSchema = z.object({
  gateway: z.object({
    port: z.number().default(18789),
    host: z.string().default('127.0.0.1'),
    tls: z.object({ enabled: z.boolean().default(false), cert: z.string().optional(), key: z.string().optional() }).optional(),
    bindMode: z.enum(['auto', 'lan', 'loopback', 'custom']).optional(),
  }).default({ port: 18789, host: '127.0.0.1' }),
  auth: z.object({
    mode: z.enum(['none', 'token', 'password']).default('token'),
    token: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    session: z.object({ ttl: z.number().default(3600) }).optional(),
  }).default({ mode: 'token' }),
  database: z.object({
    type: z.enum(['sqlite', 'postgresql']).default('sqlite'),
    path: z.string().optional(),
    url: z.string().optional(),
  }).default({ type: 'sqlite', path: './data/skyalyticwing.db' }),
  agents: z.record(z.object({
    id: z.string(),
    name: z.string(),
    model: z.string(),
    provider: z.string(),
    maxTokens: z.number().optional(),
    temperature: z.number().optional(),
    permissionMode: z.enum(['auto', 'ask', 'deny']).optional(),
    systemPrompt: z.string().optional(),
    tools: z.array(z.string()).optional(),
    workspace: z.string().optional(),
  }).strip()).default({}),
  channels: z.array(z.object({ name: z.string(), enabled: z.boolean().default(false), config: z.record(z.unknown()).optional() })).default([]),
  logging: z.object({ level: z.string().default('info'), format: z.string().default('json') }).default({ level: 'info', format: 'json' }),
  // TS-2 fix: 补全 AppConfig 声明但 ConfigSchema 缺失的字段，避免 .strip() 静默移除
  models: z.array(z.object({
    id: z.string(),
    provider: z.string(),
    name: z.string(),
    apiBase: z.string().optional(),
    apiKey: z.string().optional(),
    maxTokens: z.number().optional(),
    supportsStreaming: z.boolean().optional(),
    supportsVision: z.boolean().optional(),
    supportsTools: z.boolean().optional(),
  })).optional(),
  tools: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    enabled: z.boolean(),
    profile: z.enum(['minimal', 'coding', 'messaging', 'full']).optional(),
  })).optional(),
  memory: z.object({
    enabled: z.boolean(),
    provider: z.string(),
    path: z.string().optional(),
    embeddingModel: z.string().optional(),
  }).optional(),
  cron: z.object({
    enabled: z.boolean(),
    jobs: z.array(z.object({
      id: z.string(),
      name: z.string(),
      schedule: z.string(),
      agent: z.string(),
      message: z.string(),
      enabled: z.boolean(),
    })).optional(),
  }).optional(),
  hooks: z.object({
    enabled: z.boolean(),
    url: z.string().optional(),
    events: z.array(z.string()).optional(),
  }).optional(),
  security: z.object({
    ssrfProtection: z.boolean(),
    commandApproval: z.enum(['auto', 'ask', 'deny']),
    sandboxEnabled: z.boolean(),
    pathPolicy: z.object({ allowed: z.array(z.string()), denied: z.array(z.string()) }).optional(),
  }).optional(),
  plugins: z.object({
    enabled: z.boolean(),
    directories: z.array(z.string()).optional(),
    autoLoad: z.boolean().optional(),
  }).optional(),
  daemon: z.object({
    enabled: z.boolean(),
    type: z.enum(['systemd', 'launchd', 'schtasks']).optional(),
  }).optional(),
  acp: z.object({
    enabled: z.boolean(),
    port: z.number().optional(),
  }).optional(),
  mcp: z.object({
    enabled: z.boolean(),
    servers: z.array(z.object({
      name: z.string(),
      command: z.string(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string()).optional(),
    })).optional(),
  }).optional(),
}).strip();

export function loadConfig(configPath: string): AppConfig {
  // 移除 existsSync + readFileSync 的 TOCTOU 竞态。
  // 直接 readFileSync 并捕获 ENOENT 错误，避免 existsSync 检查与 readFileSync 之间文件被替换/删除。
  let content: string;
  try {
    content = readFileSync(configPath, 'utf-8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return getDefaultConfig();
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch (error) {
    throw new Error(`Failed to parse config file ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return ConfigSchema.parse(parsed) as AppConfig;
}

export function getDefaultConfig(): AppConfig {
  return {
    gateway: { port: 18789, host: '127.0.0.1', tls: { enabled: false } },
    auth: { mode: 'token', session: { ttl: 3600 } },
    database: { type: 'sqlite', path: './data/skyalyticwing.db' },
    agents: {
      default: {
        id: 'default',
        name: '天爪',
        model: 'claude-sonnet-4',
        provider: 'anthropic',
        maxTokens: 4096,
        temperature: 0.7,
        permissionMode: 'ask',
      },
    },
    channels: [{ name: 'cli', enabled: true }],
    logging: { level: 'info', format: 'json' },
  };
}

export function writeConfig(configPath: string, config: AppConfig): void {
  const content = YAML.stringify(config);
  const tmpPath = configPath + '.tmp';
  writeFileSync(tmpPath, content, 'utf-8');
  try {
    renameSync(tmpPath, configPath);
  } catch (e) {
    try { unlinkSync(tmpPath); } catch {}
    throw e;
  }
}

export function validateConfig(config: unknown): { valid: boolean; errors?: z.ZodError } {
  const result = ConfigSchema.safeParse(config);
  if (result.success) return { valid: true };
  return { valid: false, errors: result.error };
}

export function resolveConfigPath(baseDir: string, env?: string): string {
  if (env) {
    // 校验 env 值不含路径穿越字符（`..`）和路径分隔符，避免攻击者通过 env 变量
    // 注入 `../../etc/passwd` 等路径逃逸 config 目录读取任意文件。
    if (typeof env !== 'string' || env.length === 0) {
      throw new Error('resolveConfigPath: env must be a non-empty string');
    }
    if (env.includes('\0')) {
      throw new Error(`resolveConfigPath: env contains null byte: ${env}`);
    }
    const segments = env.split(/[\\/]/);
    if (segments.includes('..')) {
      throw new Error(`resolveConfigPath: env contains path traversal segment '..'': ${env}`);
    }
    if (/^[a-zA-Z]:/.test(env) || env.startsWith('\\\\') || env.startsWith('/')) {
      throw new Error(`resolveConfigPath: env must not be an absolute path: ${env}`);
    }
    return join(baseDir, 'config', `${env}.yaml`);
  }
  return join(baseDir, 'config', 'default.yaml');
}
