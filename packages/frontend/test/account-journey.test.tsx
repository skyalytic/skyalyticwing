import { describe,it,expect,vi,beforeEach } from 'vitest';
import { render,screen,fireEvent,waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/i18n';
import { VideoTasksPanel } from '@/modules/tools/VideoTasksPanel';
import { apiClient } from '@/services/api-client';
vi.mock('@/services/api-client',()=>({apiClient:{get:vi.fn(),post:vi.fn()}}));
beforeEach(async()=>{await i18n.changeLanguage('en');vi.mocked(apiClient.get).mockResolvedValue([]);});
describe('video task journeys',()=>{
  it('shows video progress without a hardcoded vendor submission form',async()=>{
    render(<MemoryRouter><VideoTasksPanel/></MemoryRouter>);
    await waitFor(()=>expect(apiClient.get).toHaveBeenCalled());
    expect(screen.queryByRole('combobox')).toBeNull();expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('link').getAttribute('href')).toBe('/settings?tab=models');
  });
});
