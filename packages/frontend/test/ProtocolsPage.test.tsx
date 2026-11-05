// ProtocolsPage 测试：多标签页 / MCP 服务器管理（添加/启停/删除/工具列表） / MCP 市场（通用连接器）
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProtocolsPage } from '@/modules/protocols/ProtocolsPage';
import { McpConnections } from '@/modules/plugins/McpConnections';
import { PluginsPage } from '@/modules/plugins/PluginsPage';
import { MemoryRouter } from 'react-router-dom';
import { apiClient } from '@/services/api-client';
import { toast } from '@/components/ui/Toast';

vi.mock('@/modules/account/EcosystemPage', () => ({
  EcosystemPage: () => <div>Skyalytic 官网生态</div>,
}));

vi.mock('react-i18next', async () => ({
  ...(await vi.importActual<typeof import('react-i18next')>('react-i18next')),
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('@/components/modals/ConfirmDialog', () => ({
  showConfirm: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/services/api-client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('@/components/ui/Toast', () => ({
  toast: {
    show: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    remove: vi.fn(),
  },
}));

const mockedGet = vi.mocked(apiClient.get);
const mockedPost = vi.mocked(apiClient.post);
const mockedDelete = vi.mocked(apiClient.delete);
const mockedToastError = vi.mocked(toast.error);
const mockedToastWarn = vi.mocked(toast.warn);

/** mcporter 端点裸响应（非 ApiResponse 包装，raw 请求） */
const MCPORTER_SERVERS = {
  success: true,
  servers: [{ name: 'alibaba-style-agent', url: 'https://mcp.example.com/a' }, 'raw-string-svc'],
};
/** MCP 市场目录（GET /mcp/market，ApiResponse 已解包 data） */
const MARKET_CATALOG = [
  {
    key: 'amap',
    name: '高德地图',
    description: '地图与路线规划',
    category: '网络与抓取',
    command: 'npx',
    args: ['-y', 'mcp-server-amap'],
    envKeys: [],
    homepage: '',
  },
  {
    key: 'github',
    name: 'GitHub',
    description: '仓库/Issue/PR API 访问',
    category: '开发协作',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    envKeys: ['GITHUB_TOKEN'],
    homepage: '',
  },
];
const MCPORTER_STATUS = { available: true, version: '1.0.0' };

/** apiClient 已解包 ApiResponse：GET /mcp/servers 直接返回 data 数组 */
const MCP_SERVERS = [
  {
    id: 'fs',
    name: 'filesystem',
    url: 'npx -y @modelcontextprotocol/server-filesystem /tmp',
    transport: 'stdio',
    status: 'stopped',
    tools: [{ name: 'read_file', description: 'Read file content' }],
  },
];

/** 按端点分发默认 GET 响应 */
function defaultGetMock(available = true) {
  return (url: string) => {
    if (url === '/mcp/servers') return Promise.resolve(MCP_SERVERS) as never;
    if (url === '/mcp/market') return Promise.resolve(MARKET_CATALOG) as never;
    if (url === '/mcporter/servers') return Promise.resolve(MCPORTER_SERVERS) as never;
    if (url === '/mcporter/status')
      return Promise.resolve({ available, version: available ? '1.0.0' : null }) as never;
    return Promise.resolve(null) as never;
  };
}

describe('ProtocolsPage official ecosystem routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGet.mockImplementation(defaultGetMock());
  });
  it('routes market discovery to Skyalytic instead of the legacy multi-market installer', async () => {
    render(
      <MemoryRouter>
        <PluginsPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'MCP 插件资源' }));
    expect(screen.getByText('Skyalytic 官网生态')).toBeInTheDocument();
    expect(mockedGet).not.toHaveBeenCalledWith('/mcp/market');
    expect(mockedPost).not.toHaveBeenCalled();
  });
  it('keeps protocol hosting in settings without a second marketplace or connection list', () => {
    render(
      <MemoryRouter>
        <ProtocolsPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'MCP Loopback' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ACP 协议' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'MCP 插件资源' })).toBeNull();
    expect(screen.getByRole('link', { name: '打开插件' })).toHaveAttribute(
      'href',
      '/plugins?tab=connections',
    );
    expect(mockedGet).not.toHaveBeenCalledWith('/mcp/servers');
  });
});

describe('ProtocolsPage MCP 服务器 tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGet.mockImplementation(defaultGetMock());
    mockedPost.mockResolvedValue({ success: true, data: {} } as never);
  });

  it('加载并展示服务器列表（状态/地址/工具数）', async () => {
    render(<McpConnections />);
    await waitFor(() => {
      expect(screen.getByText('filesystem')).toBeInTheDocument();
    });
    expect(screen.getByText('stopped')).toBeInTheDocument();
    expect(mockedGet).toHaveBeenCalledWith('/mcp/servers');
  });

  it('添加服务器：POST /mcp/servers 成功后关闭弹窗并刷新', async () => {
    render(<McpConnections />);
    await waitFor(() => {
      expect(screen.getByText('filesystem')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'views.addServer' }));
    const nameInput = screen.getByPlaceholderText(
      'views.serverNamePlaceholder',
    ) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'github' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.add' }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/mcp/servers', {
        name: 'github',
        url: '',
        transport: 'stdio',
      });
    });
    // 弹窗关闭
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('views.serverNamePlaceholder')).not.toBeInTheDocument();
    });
  });

  it('添加服务器失败（HTTP 2xx + success:false）：toast 错误且弹窗保留', async () => {
    mockedPost.mockRejectedValueOnce(new Error('server name already exists') as never);
    render(<McpConnections />);
    await waitFor(() => {
      expect(screen.getByText('filesystem')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'views.addServer' }));
    const nameInput = screen.getByPlaceholderText(
      'views.serverNamePlaceholder',
    ) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'filesystem' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.add' }));

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith(
        'common.addFailed',
        'server name already exists',
      );
    });
    // 弹窗保留供修改
    expect(screen.getByPlaceholderText('views.serverNamePlaceholder')).toBeInTheDocument();
  });

  it('未填写名称直接提交：toast 警告不发请求', async () => {
    render(<McpConnections />);
    await waitFor(() => {
      expect(screen.getByText('filesystem')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'views.addServer' }));
    fireEvent.click(screen.getByRole('button', { name: 'common.add' }));

    expect(mockedToastWarn).toHaveBeenCalledWith('views.mcpNameRequired');
    expect(mockedPost).not.toHaveBeenCalledWith('/mcp/servers', expect.anything());
  });

  it('启动服务器：POST /mcp/servers/:id/start', async () => {
    render(<McpConnections />);
    await waitFor(() => {
      expect(screen.getByText('filesystem')).toBeInTheDocument();
    });

    // stopped 状态显示"连接"按钮
    fireEvent.click(screen.getByRole('button', { name: 'common.connect' }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/mcp/servers/fs/start');
    });
  });

  it('启动失败（success:false）：toast 错误提示', async () => {
    mockedPost.mockRejectedValueOnce(new Error('stdio command not found') as never);
    render(<McpConnections />);
    await waitFor(() => {
      expect(screen.getByText('filesystem')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'common.connect' }));

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith(
        'common.operationFailed',
        'stdio command not found',
      );
    });
  });

  it('停止运行中的服务器：POST /mcp/servers/:id/stop', async () => {
    mockedGet.mockImplementation((url: string) => {
      if (url === '/mcp/servers')
        return Promise.resolve([{ ...MCP_SERVERS[0], status: 'running' }]) as never;
      return defaultGetMock()(url);
    });
    render(<McpConnections />);
    await waitFor(() => {
      expect(screen.getByText('running')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'common.disconnect' }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/mcp/servers/fs/stop');
    });
  });

  it('删除服务器：DELETE /mcp/servers/:id', async () => {
    render(<McpConnections />);
    await waitFor(() => {
      expect(screen.getByText('filesystem')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'common.remove' }));

    await waitFor(() => {
      expect(mockedDelete).toHaveBeenCalledWith('/mcp/servers/fs');
    });
  });

  it('删除失败（success:false）：toast 错误提示', async () => {
    mockedDelete.mockRejectedValueOnce(new Error('server not found') as never);
    render(<McpConnections />);
    await waitFor(() => {
      expect(screen.getByText('filesystem')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'common.remove' }));

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('common.removeFailed', 'server not found');
    });
  });

  it('查看工具：弹窗展示服务器工具列表', async () => {
    render(<McpConnections />);
    await waitFor(() => {
      expect(screen.getByText('filesystem')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'views.viewTools' }));

    await waitFor(() => {
      expect(screen.getByText('read_file')).toBeInTheDocument();
    });
    expect(screen.getByText(/Read file content/)).toBeInTheDocument();
    // 关闭弹窗
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
    await waitFor(() => {
      expect(screen.queryByText('read_file')).not.toBeInTheDocument();
    });
  });
});
