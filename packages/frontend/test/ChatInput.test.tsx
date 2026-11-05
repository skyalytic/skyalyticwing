// ChatInput 组件测试：输入 / 发送按钮 / 回车发送 / Shift+回车换行 / 附件
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '@/components/chat/ChatInput';
import i18n from '@/i18n';
import { attachContext } from '@/services/context-reference';
import { saveLocalSettings } from '@/utils/local-preferences';
import { useSessionStore } from '@/stores/session-store';
import {
  browserAnnotationAttachment,
  BROWSER_ANNOTATION_EVENT,
} from '@/services/browser-annotation';

// ChatInput 内部使用 useNavigate（顶栏跳转）：所有用例包 MemoryRouter
const renderInRouter = (ui: Parameters<typeof render>[0]) =>
  render(<MemoryRouter>{ui}</MemoryRouter>);

vi.mock('react-i18next', async () => ({
  ...(await vi.importActual<typeof import('react-i18next')>('react-i18next')),
  useTranslation: () => ({ t: (k: string) => k }),
}));

describe('ChatInput', () => {
  const annotation = () =>
    browserAnnotationAttachment(
      {
        tag: 'button',
        text: '立即购买',
        selector: '#buy',
        outerHTML: '<button id="buy">立即购买</button>',
        rect: { x: 1, y: 2, w: 80, h: 30 },
      },
      {
        pageId: 'p',
        url: 'https://example.com/',
        title: '测试商品',
        viewport: { width: 800, height: 600 },
        screenshot: '',
        elements: [],
        consoleTail: [],
        markedAt: 0,
      },
    );
  let onSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    void i18n.changeLanguage('zh-CN');
    vi.clearAllMocks();
    localStorage.removeItem('app.settings');
    useSessionStore.setState({ currentSessionId: 'composer-test' });
    onSend = vi.fn();
  });

  it('渲染 textarea 与发送按钮，空内容时发送按钮禁用', () => {
    renderInRouter(<ChatInput onSend={onSend} />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea).toBeInTheDocument();
    expect(textarea.placeholder).toBe('chat.inputPlaceholder（Enter 发送，Shift+Enter 换行）');

    const sendBtn = screen.getByRole('button', { name: 'chat.send' });
    expect(sendBtn).toBeDisabled();
  });

  it('输入内容后发送按钮启用', () => {
    renderInRouter(<ChatInput onSend={onSend} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'hello' } });

    expect(screen.getByRole('button', { name: 'chat.send' })).toBeEnabled();
  });

  it('网页批注是可移除附件，不向输入框插入 DOM 或网址，发送时保留上下文', () => {
    renderInRouter(<ChatInput onSend={onSend} />);
    const attachment = annotation();
    act(() =>
      window.dispatchEvent(
        new CustomEvent(BROWSER_ANNOTATION_EVENT, { detail: { attachment, comment: '' } }),
      ),
    );
    expect(screen.getByText('button')).toBeVisible();
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.queryByText(/<button id/)).toBeNull();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '把这个按钮改成蓝色' } });
    fireEvent.click(screen.getByRole('button', { name: 'chat.send' }));
    expect(onSend).toHaveBeenCalledWith('把这个按钮改成蓝色', [attachment]);
    expect(Buffer.from(attachment.url!.split(',')[1], 'base64').toString()).toContain('#buy');
    expect(screen.queryByText('button')).toBeNull();
  });

  it('批注只插入用户填写的要求，重复添加不重复标签，移除后不发送上下文', () => {
    renderInRouter(<ChatInput onSend={onSend} />);
    const attachment = annotation();
    act(() =>
      window.dispatchEvent(
        new CustomEvent(BROWSER_ANNOTATION_EVENT, { detail: { attachment, comment: '看看这个' } }),
      ),
    );
    act(() =>
      window.dispatchEvent(
        new CustomEvent(BROWSER_ANNOTATION_EVENT, { detail: { attachment, comment: '' } }),
      ),
    );
    expect(screen.getAllByText('button')).toHaveLength(1);
    expect(screen.getByRole('textbox')).toHaveValue('看看这个');
    fireEvent.click(screen.getByRole('button', { name: '移除网页批注' }));
    fireEvent.click(screen.getByRole('button', { name: 'chat.send' }));
    expect(onSend).toHaveBeenCalledWith('看看这个', undefined);
  });

  it('点击发送按钮：trim 后调用 onSend 并清空输入', () => {
    renderInRouter(<ChatInput onSend={onSend} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '  你好世界  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'chat.send' }));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('你好世界', undefined);
    expect(textarea).toHaveValue('');
  });

  it('Enter 触发发送', () => {
    renderInRouter(<ChatInput onSend={onSend} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'via enter' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('via enter', undefined);
  });

  it('Shift+Enter 不发送（用于换行）', () => {
    renderInRouter(<ChatInput onSend={onSend} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'line1' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('line1');
  });

  it('输入法确认不发送；发送快捷键跟随设置即时变化', () => {
    renderInRouter(<ChatInput onSend={onSend} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '中文输入' } });
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
    act(() => {
      saveLocalSettings({ sendOnEnter: false });
    });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(onSend).toHaveBeenCalledWith('中文输入', undefined);
  });

  it('引用去重，点击查看快照，切换会话不误带到另一个对话', () => {
    renderInRouter(<ChatInput onSend={onSend} />);
    const ref = {
      kind: 'selection' as const,
      label: 'file.ts 1–2',
      path: 'D:/file.ts',
      startLine: 1,
      endLine: 2,
      content: '<h1>引用的快照</h1>',
    };
    act(() => {
      attachContext(ref);
      attachContext(ref);
    });
    expect(screen.getAllByRole('button', { name: '查看引用：file.ts 1–2' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '查看引用：file.ts 1–2' }));
    expect(screen.getByText(ref.content)).toBeInTheDocument();
    expect(document.querySelector('.wing-context-detail h1')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    act(() => {
      useSessionStore.setState({ currentSessionId: 'different' });
    });
    expect(screen.queryByRole('button', { name: '查看引用：file.ts 1–2' })).toBeNull();
  });

  it('计划设置允许已确认任务继续执行，并随设置关闭', () => {
    renderInRouter(<ChatInput onSend={onSend} />);
    act(() => {
      saveLocalSettings({ planMode: true });
    });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '确认计划，继续' } });
    fireEvent.click(screen.getByRole('button', { name: 'chat.send' }));
    expect(onSend.mock.calls[0]![0]).toContain('若本轮已确认计划或要求继续');
    act(() => {
      saveLocalSettings({ planMode: false });
    });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '普通消息' } });
    fireEvent.click(screen.getByRole('button', { name: 'chat.send' }));
    expect(onSend.mock.calls[1]![0]).toBe('普通消息');
    expect(screen.queryByRole('button', { name: '计划', exact: true })).toBeNull();
  });

  it('空白内容按 Enter 不发送', () => {
    renderInRouter(<ChatInput onSend={onSend} />);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onSend).not.toHaveBeenCalled();
  });

  it('disabled 状态下：显示停止按钮，Enter 与发送均不触发', () => {
    renderInRouter(<ChatInput onSend={onSend} disabled />);

    const textarea = screen.getByRole('textbox');
    expect(textarea).toBeDisabled();
    // 流式生成中：发送按钮被停止按钮替代
    expect(screen.queryByRole('button', { name: 'chat.send' })).toBeNull();
    expect(screen.getByRole('button', { name: 'chat.stop' })).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: 'x' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onSend).not.toHaveBeenCalled();
  });

  it('通过文件选择器添加附件后随消息一并发送', async () => {
    const { container } = renderInRouter(<ChatInput onSend={onSend} />);

    // 隐藏的 file input 位于 toolbar 兄弟节点，直接从容器查询
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['data'], '报告.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { value: [file] });
    fireEvent.change(input);

    // 附件经 FileReader 异步读取后才渲染 chip
    await waitFor(() => expect(screen.getByText(/报告\.txt/)).toBeInTheDocument());

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '看下附件' } });
    fireEvent.click(screen.getByRole('button', { name: 'chat.send' }));

    expect(onSend).toHaveBeenCalledWith('看下附件', [
      expect.objectContaining({ type: 'file', name: '报告.txt', mimeType: 'text/plain' }),
    ]);
  });

  it('可移除已添加的附件', async () => {
    const { container } = renderInRouter(<ChatInput onSend={onSend} />);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [new File(['d'], 'a.png', { type: 'image/png' })],
    });
    fireEvent.change(input);

    // 图片附件经 FileReader 异步读取后渲染为缩略图（alt=文件名）
    await waitFor(() => expect(screen.getByAltText(/a\.png/)).toBeInTheDocument());

    // 缩略图容器上的移除按钮（文本 ×）
    fireEvent.click(screen.getAllByText('×')[0]);

    expect(screen.queryByAltText(/a\.png/)).not.toBeInTheDocument();

    // 附件清空后发送不携带附件
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'chat.send' }));
    expect(onSend).toHaveBeenCalledWith('hi', undefined);
  });
});
