import { beforeEach, expect, it, vi } from 'vitest';
import { apiClient } from '@/services/api-client';
import { useDesignCanvas } from '@/stores/design-store';
import { useProjectPanel } from '@/stores/project-panel-store';
vi.mock('@/services/api-client', () => ({ apiClient: { get: vi.fn() } }));
beforeEach(() => {
  vi.clearAllMocks();
  useDesignCanvas.setState({ docs: [], current: null, selected: null, zoom: 1 });
});
it.each(['/work/designs', 'C:\\work\\designs'])('preserves path separators for %s', async (root) => {
  useProjectPanel.setState({ projectDir: root });
  vi.mocked(apiClient.get).mockResolvedValue({ children: [{ name: 'nested', type: 'dir', children: [{ name: 'draft.html', type: 'file' }] }] });
  await useDesignCanvas.getState().loadDocs();
  const separator = root.startsWith('/') ? '/' : '\\';
  expect(useDesignCanvas.getState().docs[0]?.path).toBe(`${root}${separator}nested${separator}draft.html`);
});
it('ignores an old folder response after a folder switch', async () => {
  let finish!: (value: unknown) => void;
  useProjectPanel.setState({ projectDir: '/old' });
  vi.mocked(apiClient.get).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const old = useDesignCanvas.getState().loadDocs();
  useProjectPanel.setState({ projectDir: '/new' });
  vi.mocked(apiClient.get).mockResolvedValueOnce({ children: [{ name: 'new.html', type: 'file' }] });
  await useDesignCanvas.getState().loadDocs();
  finish({ children: [{ name: 'old.html', type: 'file' }] });
  await old;
  expect(useDesignCanvas.getState().docs[0]?.path).toBe('/new/new.html');
});
it('ignores invalid zoom instead of breaking the canvas transform', () => {
  useDesignCanvas.getState().setZoom(NaN);
  expect(useDesignCanvas.getState().zoom).toBe(1);
});
