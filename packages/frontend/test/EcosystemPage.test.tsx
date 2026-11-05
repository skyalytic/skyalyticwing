import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EcosystemPage } from '@/modules/account/EcosystemPage';
import { authenticatedFetch } from '@/services/authenticated-fetch';
import { showConfirm } from '@/components/modals/ConfirmDialog';
import i18n from '@/i18n';
vi.mock('@/services/authenticated-fetch', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('@/components/modals/ConfirmDialog', () => ({ showConfirm: vi.fn().mockResolvedValue(true) }));
const item = { id: 'office', name: 'Office connector', kind: 'mcp', description: 'Office tasks', publisher: 'Vendor', version: '1.0.0', license: 'MIT', source: 'https://example.com/source', permissions: ['read calendar'], install: { envKeys: ['APP_KEY'] } };
const mock = vi.mocked(authenticatedFetch);
let installed = false, offline = false;
const response = (data: unknown, ok = true) => ({ ok, json: async () => data }) as Response;
beforeEach(() => {
  void i18n.changeLanguage('zh-CN');
  vi.clearAllMocks(); installed = false; offline = false;
  mock.mockImplementation(async (url, options) => {
    const path = String(url);
    if (path.endsWith('/installed')) return response({ items: installed ? [item] : [] });
    if (path.endsWith('/connections')) return response({items:installed?[{id:item.id,enabled:false,status:'stopped'}]:[]});
    if (path.endsWith('/configuration')) return response({source:item.source,description:item.description,fields:[{key:'APP_KEY',label:'APP_KEY',help:'填写应用密钥',secret:true,type:'text',required:true,configured:false,value:''}]});
    if (path.includes('/catalog')) return offline ? response({ message: '官网离线' }, false) : response({ items: [item], installed: installed ? [item] : [] });
    if (path.endsWith('/install')) { installed = true; return response({ note: '已安装' }); }
    if (options?.method === 'DELETE') { installed = false; return response({ success: true }); }
    return response({ note: '已连接', toolCount: 3 });
  });
});
const open = () => render(<MemoryRouter future={{v7_startTransition:true,v7_relativeSplatPath:true}}><EcosystemPage /></MemoryRouter>);
describe('official ecosystem UI', () => {
  it.each([
    ['agent', ['expert', 'team']],
    ['skill', ['skill']],
    ['mcp', ['mcp', 'plugin']],
  ] as const)('shows the returned resources in the %s surface with install actions', async (resourceKind, expectedKinds) => {
    const names: Record<string, string> = { skill: '办公技能', mcp: '日程连接器', plugin: '本地工具', expert: '写作助手', team: '运营团队' };
    const catalog = ['skill', 'mcp', 'plugin', 'expert', 'team'].map(kind => ({ ...item, id: 'resource-' + kind, name: names[kind], kind }));
    const normal = mock.getMockImplementation()!;
    mock.mockImplementation((url, options) => String(url).includes('/catalog') ? Promise.resolve(response({ items: catalog })) : normal(url, options));
    render(<MemoryRouter><EcosystemPage resourceKind={resourceKind} /></MemoryRouter>);
    await screen.findByText(names[expectedKinds[0]]);
    for (const entry of catalog) {
      if ((expectedKinds as readonly string[]).includes(entry.kind)) expect(screen.getByText(entry.name)).toBeInTheDocument();
      else expect(screen.queryByText(entry.name)).toBeNull();
    }
    expect(screen.getAllByRole('button', { name: '安装', exact: true })).toHaveLength(expectedKinds.length);
    expect(screen.queryByText('暂无可用资源')).toBeNull();
  });
  it('shows provenance and permissions before installing, then allows uninstall', async () => {
    open(); await screen.findByText(item.name);
    expect(screen.getByText(/Vendor · MIT/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '安装' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '卸载' })).toBeInTheDocument());
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', {name:'取消'}));
    expect(showConfirm).toHaveBeenCalledWith(expect.stringContaining('read calendar'), expect.anything());
    fireEvent.click(screen.getByRole('button', { name: '卸载' }));
    await screen.findByRole('button', { name: '安装' });
    expect(mock.mock.calls.every(([url]) => String(url).startsWith('/api/ecosystem'))).toBe(true);
  });
  it('keeps installed resources available offline', async () => {
    installed = true; offline = true; open();
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: '已安装 · 1' }));
    expect(await screen.findByText(item.name)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '卸载' })).toBeInTheDocument();
  });
  it('sends credentials only to the local configuration endpoint and clears the form', async () => {
    installed = true; open();
    fireEvent.click(await screen.findByRole('button', { name: '授权连接' }));
    const dialog = await screen.findByRole('dialog');
    const field = within(dialog).getByLabelText('APP_KEY');
    expect(field).toHaveAttribute('type', 'password');
    fireEvent.change(field, { target: { value: 'local-secret' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存并连接' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const secretCalls = mock.mock.calls.filter(([, options]) => String(options?.body).includes('local-secret'));
    expect(secretCalls).toHaveLength(1);
    expect(secretCalls[0][0]).toBe('/api/ecosystem/office/configure');
  });
  it('retains the configuration form and displays failed authorization', async () => {
    installed = true; const normal = mock.getMockImplementation()!;
    mock.mockImplementation(async (url, options) => String(url).endsWith('/configure') ? response({ message: '连接验证失败' }, false) : normal(url, options));
    open(); fireEvent.click(await screen.findByRole('button', { name: '授权连接' }));
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText('APP_KEY'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并连接' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('连接验证失败');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
  it('edits public fields and reuses a saved key without exposing it in the form', async () => {
    installed=true;const normal=mock.getMockImplementation()!;
    mock.mockImplementation(async(url,options)=>String(url).endsWith('/configuration')?response({source:item.source,fields:[
      {key:'APP_KEY',label:'应用密钥',secret:true,type:'text',required:true,configured:true,value:''},
      {key:'SMTP_PORT',label:'SMTP 端口',secret:false,type:'port',required:false,configured:true,value:'465'},
      {key:'SMTP_SECURE',label:'SMTP TLS',secret:false,type:'boolean',required:false,configured:true,value:'true'},
    ]}):normal(url,options));
    open();fireEvent.click(await screen.findByRole('button',{name:'授权连接'}));
    await screen.findByRole('dialog');
    expect(screen.getByLabelText('应用密钥')).not.toBeRequired();
    expect(screen.getByLabelText('应用密钥')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('SMTP 端口'),{target:{value:'587'}});
    fireEvent.change(screen.getByLabelText('SMTP TLS'),{target:{value:'false'}});
    fireEvent.click(screen.getByRole('button',{name:'保存并连接'}));
    await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const call=mock.mock.calls.find(([url])=>String(url).endsWith('/configure'))!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({env:{APP_KEY:'',SMTP_PORT:'587',SMTP_SECURE:'false'}});
  });
  it('explains keyless setup and distinguishes plugin connection from account authorization', async () => {
    installed=true;const normal=mock.getMockImplementation()!;
    mock.mockImplementation(async(url,options)=>String(url).endsWith('/configuration')?response({source:item.source,fields:[]}):String(url).endsWith('/connections')?response({items:[{id:item.id,status:'running',enabled:true}]}):normal(url,options));
    open();await screen.findByText('插件已连接 · 账号权限待任务验证');
    fireEvent.click(screen.getByRole('button',{name:'授权连接'}));
    await screen.findByText('此连接器无需填写 API 密钥，点击下方按钮启动并检测。');
    fireEvent.click(screen.getByRole('button',{name:'保存并连接'}));
    await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
