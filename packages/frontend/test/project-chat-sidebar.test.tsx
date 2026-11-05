import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ProjectChatSidebar } from '../src/components/layout/ProjectChatSidebar';
import { useSessionStore } from '../src/stores/session-store';
import { apiClient } from '../src/services/api-client';
import i18n from '../src/i18n';
import { showConfirm } from '../src/components/modals/ConfirmDialog';

vi.mock('../src/components/modals/ConfirmDialog', () => ({showConfirm: vi.fn()}));

vi.mock('../src/services/api-client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(showConfirm).mockResolvedValue(true);
  localStorage.clear();
  await i18n.changeLanguage('en');
  useSessionStore.setState({ sessions: [], currentSessionId: null, error: null });
  vi.mocked(apiClient.get).mockImplementation(async (path) =>
    path === '/files/projects'
      ? [{ name: 'sample', path: 'E:/sample' }]
      : path === '/sessions/recovery'
        ? null
        : [],
  );
  vi.mocked(apiClient.post).mockImplementation(async (path) =>
    path === '/sessions'
      ? { id: 'new', title: 'New chat', createdAt: 1, updatedAt: 1, messageCount: 0 }
      : { path: 'E:/sample' },
  );
});
describe('project and conversation navigation', () => {
  it('keeps the navigation usable on invalid project data and local preferences',async()=>{
    localStorage.setItem('wing-projects-collapsed','{}');
    vi.mocked(apiClient.get).mockImplementation(async path=>path==='/files/projects'?{}:null);
    render(<MemoryRouter><ProjectChatSidebar onClose={()=>{}} /></MemoryRouter>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid project list');
    expect(screen.getByRole('textbox',{name:'Search conversations'})).toBeInTheDocument();
  });
  it('opens project actions by right-click and renames only the project display name', async () => {
    render(<MemoryRouter><ProjectChatSidebar onClose={()=>{}} /></MemoryRouter>);
    fireEvent.contextMenu(await screen.findByText('sample'));
    fireEvent.click(screen.getByRole('menuitem',{name:'Rename project'}));
    expect(screen.getByRole('dialog',{name:'Rename project'})).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox',{name:'Name'}),{target:{value:'My display name'}});
    fireEvent.click(screen.getByRole('button',{name:'Save',exact:true}));
    await waitFor(()=>expect(apiClient.post).toHaveBeenCalledWith('/files/projects',{path:'E:/sample',name:'My display name'}));
    expect(apiClient.delete).not.toHaveBeenCalled();
  });
  it('removes a project via its more menu while preserving the active chat', async () => {
    useSessionStore.setState({currentSessionId:'keep',sessions:[{id:'keep',title:'Keep chat',projectDir:'E:/sample',createdAt:1,updatedAt:1,messageCount:1}]});
    let removed=false;
    vi.mocked(apiClient.get).mockImplementation(async path=>path==='/files/projects'&&!removed?[{name:'sample',path:'E:/sample'}]:path==='/sessions/recovery'?null:[]);
    vi.mocked(apiClient.delete).mockImplementation(async()=>{removed=true;return {removed:true};});
    render(<MemoryRouter><ProjectChatSidebar onClose={()=>{}} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button',{name:'Project actions: sample'}));
    fireEvent.click(screen.getByRole('menuitem',{name:'Delete project'}));
    await waitFor(()=>expect(screen.queryByText('sample')).not.toBeInTheDocument());
    expect(apiClient.delete).toHaveBeenCalledWith('/files/projects?path=E%3A%2Fsample');
    expect(useSessionStore.getState().currentSessionId).toBe('keep');
    expect(useSessionStore.getState().sessions).toHaveLength(1);
    expect(screen.getByRole('button',{name:'Keep chat'})).toBeInTheDocument();
  });
  it('does not remove a cancelled project, and keeps the project visible when deletion fails', async () => {
    vi.mocked(showConfirm).mockResolvedValueOnce(false);
    render(<MemoryRouter><ProjectChatSidebar onClose={()=>{}} /></MemoryRouter>);
    fireEvent.contextMenu(await screen.findByText('sample'));
    fireEvent.click(screen.getByRole('menuitem',{name:'Delete project'}));
    await waitFor(()=>expect(showConfirm).toHaveBeenCalledTimes(1));
    expect(apiClient.delete).not.toHaveBeenCalled();
    vi.mocked(apiClient.delete).mockRejectedValueOnce(Error('Project save failed'));
    fireEvent.contextMenu(screen.getByText('sample'));
    fireEvent.click(screen.getByRole('menuitem',{name:'Delete project'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Project save failed');
    expect(screen.getByText('sample')).toBeInTheDocument();
  });
  it('binds a project chat before selecting it, while a generic new chat has no binding', async () => {
    render(
      <MemoryRouter>
        <ProjectChatSidebar onClose={() => {}} />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'New chat in project: sample' }));
    await waitFor(() => expect(useSessionStore.getState().currentSessionId).toBe('new'));
    expect(apiClient.post).toHaveBeenCalledWith('/files/project', {
      path: 'E:/sample',
      sessionId: 'new',
    });
    expect(useSessionStore.getState().sessions[0]?.projectDir).toBe('E:/sample');
    vi.mocked(apiClient.post).mockClear();
    vi.mocked(apiClient.post).mockResolvedValueOnce({
      id: 'ordinary',
      title: 'New chat',
      messageCount: 0,
      createdAt: 2,
      updatedAt: 2,
    });
    fireEvent.click(screen.getByRole('button', { name: /^New chat ＋$/ }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/sessions', {}));
    expect(apiClient.post).not.toHaveBeenCalledWith('/files/project', expect.anything());
  });
  it('keeps the active chat unchanged when a project binding fails', async () => {
    useSessionStore.setState({ currentSessionId: 'previous' });
    vi.mocked(apiClient.post).mockImplementation(async (path) => {
      if (path === '/files/project') throw Error('Folder unavailable');
      return { id: 'new', title: 'New chat' };
    });
    expect(await useSessionStore.getState().createSession(undefined, 'missing')).toBeNull();
    expect(useSessionStore.getState().currentSessionId).toBe('previous');
    expect(apiClient.delete).toHaveBeenCalledWith('/sessions/new');
  });
  it('renames a chat without changing its project and opens an accessible actions menu', async () => {
    useSessionStore.setState({
      sessions: [
        {
          id: 's1',
          title: 'First task',
          projectDir: 'E:/sample',
          createdAt: 1,
          updatedAt: 1,
          messageCount: 1,
        },
      ],
    });
    render(
      <MemoryRouter>
        <ProjectChatSidebar onClose={() => {}} />
      </MemoryRouter>,
    );
    fireEvent.click(
      (await screen.findAllByRole('button', { name: 'Chat actions: First task' }))[0]!,
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Updated task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() =>
      expect(apiClient.put).toHaveBeenCalledWith('/sessions/s1/meta', { title: 'Updated task' }),
    );
    expect(useSessionStore.getState().sessions[0]?.projectDir).toBe('E:/sample');
  });
});
