import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import i18n from '@/i18n';
import english from '@/i18n/workbench-en.json';
import englishUI from '@/i18n/en';
import chineseUI from '@/i18n/zh-CN';
import { AgentCenterPage } from '@/modules/agents/AgentCenterPage';
import { PluginsPage } from '@/modules/plugins/PluginsPage';
import { ToolForm } from '@/modules/tools/ToolForm';
import { CronCreateModal, explainCron } from '@/components/modals/CronCreateModal';
import { apiClient } from '@/services/api-client';
import type { ToolListItem } from '@/types';

vi.mock('@/services/api-client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}));
vi.mock('@/modules/account/EcosystemPage', () => ({ EcosystemPage: () => <div>Catalog</div> }));
const get = vi.mocked(apiClient.get);
const switchLanguage = (language: string) =>
  act(async () => {
    await i18n.changeLanguage(language);
  });
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('zh-CN');
  get.mockImplementation(async (url) => (url === '/models' ? { models: [] } : []));
});
afterEach(cleanup);

describe('English workbench coverage', () => {
  it('covers the shared Chinese language keys with English values', () => {
    const inspect = (source: Record<string, unknown>, target: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(source)) {
        if (typeof value === 'string') {
          expect(typeof target[key], key).toBe('string');
          expect(target[key], key).not.toMatch(/\p{Script=Han}/u);
        } else {
          expect(target[key], key).toBeDefined();
          inspect(value as Record<string, unknown>, target[key] as Record<string, unknown>);
        }
      }
    };
    inspect(chineseUI, englishUI);
  });
  it('has an English translation for every static source phrase and preserves interpolation variables', () => {
    const dictionary = english as Record<string, string>;
    const problems: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          walk(file);
          continue;
        }
        if (!/\.tsx?$/.test(file)) continue;
        const source = readFileSync(file, 'utf8');
        if (!source.includes('wt(')) continue;
        const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node) && node.expression.getText(tree) === 'wt') {
            const key = node.arguments[0];
            if (
              key &&
              ts.isStringLiteralLike(key) &&
              /\p{Script=Han}/u.test(key.text) &&
              !dictionary[key.text]
            )
              problems.push(key.text);
          }
          ts.forEachChild(node, visit);
        };
        visit(tree);
      }
    };
    walk(resolve(process.cwd(), 'src'));
    expect(problems).toEqual([]);
    const placeholders = (value: string) => [...new Set(value.match(/{{[^}]+}}/g) || [])].sort();
    const entries = Object.entries(dictionary);
    expect(entries.filter(([, translated]) => /\p{Script=Han}/u.test(translated))).toEqual([]);
    expect(
      entries.filter(
        ([source, translated]) =>
          JSON.stringify(placeholders(translated)) !== JSON.stringify(placeholders(source)),
      ),
    ).toEqual([]);
  }, 15000);

  it('switches the agents page and create dialog while preserving user-authored names', async () => {
    get.mockImplementation(async (url) =>
      url === '/agents'
        ? [
            {
              id: 'main',
              name: 'Agent',
              builtin: true,
              description: '内置通用智能体：日常对话、任务执行与多智能体协作调度（队长）',
            },
            { id: 'custom', name: '我的助理', description: '我的自定义说明' },
          ]
        : url === '/models'
          ? { models: [] }
          : [],
    );
    render(
      <MemoryRouter>
        <AgentCenterPage />
      </MemoryRouter>,
    );
    await screen.findByText('我的助理');
    await switchLanguage('en');
    expect(screen.getByRole('heading', { name: 'Agents', exact: true })).toBeInTheDocument();
    expect(screen.getByText('我的助理')).toBeInTheDocument();
    expect(screen.getByText('我的自定义说明')).toBeInTheDocument();
    expect(screen.getByText(/Built-in general-purpose agent/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Create', exact: true })[0]);
    expect(screen.getByRole('heading', { name: 'Create Agent' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter an agent name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel', exact: true })).toBeInTheDocument();
  });

  it('updates cached form labels and cron descriptions without clearing entered values', async () => {
    const tool = { name: 'file_read', id: 'file-read', category: 'file' } as ToolListItem;
    render(
      <>
        <ToolForm tool={tool} onSubmit={vi.fn()} onCancel={vi.fn()} />
        <CronCreateModal open onSave={vi.fn()} onClose={vi.fn()} />
      </>,
    );
    fireEvent.change(screen.getByLabelText('文件路径'), { target: { value: './用户文档.txt' } });
    await switchLanguage('en');
    expect(screen.getByLabelText('File path')).toHaveValue('./用户文档.txt');
    expect(screen.getByText('Run daily at 09:00')).toBeInTheDocument();
    expect(explainCron('0 9 * * 1')).toBe('Run every Monday at 09:00');
    await switchLanguage('zh-CN');
    expect(screen.getByLabelText('文件路径')).toHaveValue('./用户文档.txt');
    expect(screen.getByText('每天 09:00 执行')).toBeInTheDocument();
  });

  it('keeps the selected plugin filter working across language changes', async () => {
    get.mockImplementation(async (url) => url === '/plugins' ? [
      { id: 'on', name: 'Loaded test plugin', version: '1', enabled: true, loaded: true },
      { id: 'off', name: 'Disabled test plugin', version: '1', enabled: false, loaded: false },
    ] : []);
    render(
      <MemoryRouter>
        <PluginsPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: '本地插件' }));
    await screen.findByText('Loaded test plugin');
    fireEvent.click(screen.getByRole('button', { name: '已禁用', exact: true }));
    expect(screen.queryByText('Loaded test plugin')).not.toBeInTheDocument();
    await switchLanguage('en');
    expect(screen.getByText('Disabled test plugin')).toBeInTheDocument();
    expect(screen.queryByText('Loaded test plugin')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All', exact: true }));
    expect(screen.getByText('Loaded test plugin')).toBeInTheDocument();
  });
});
