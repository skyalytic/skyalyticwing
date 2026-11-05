import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { EcosystemPage } from '../src/modules/account/EcosystemPage';
import { authenticatedFetch } from '../src/services/authenticated-fetch';
import i18n from '../src/i18n';
vi.mock('../src/services/authenticated-fetch', () => ({ authenticatedFetch: vi.fn() }));
beforeEach(async () => {
  await i18n.changeLanguage('en');
  const items = ['skill', 'mcp', 'expert', 'team'].map((kind) => ({
    id: kind,
    kind,
    name: `Sample ${kind}`,
    description: 'Resource fixture',
    version: '1',
    publisher: 'Fixture',
    permissions: [],
    source: 'https://example.com',
    license: 'MIT',
  }));
  vi.mocked(authenticatedFetch).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify({
          success: true,
          data: { items: String(url).includes('/connections') ? [] : items, installed: items },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
});
describe('module resource boundaries', () => {
  it.each([
    ['skill', 'Sample skill'],
    ['mcp', 'Sample mcp'],
    ['agent', 'Sample agent'],
  ] as const)(
    'limits the %s catalog and installed list to its resource type',
    async (kind, name) => {
      render(
        <MemoryRouter>
          <EcosystemPage resourceKind={kind} />
        </MemoryRouter>,
      );
      expect(await screen.findByRole('heading', { name })).toBeInTheDocument();
      expect(screen.queryByRole('combobox', { name: 'Resource type' })).toBeNull();
      if (kind !== 'skill')
        expect(screen.queryByRole('heading', { name: 'Sample skill' })).toBeNull();
      if (kind !== 'mcp') expect(screen.queryByRole('heading', { name: 'Sample mcp' })).toBeNull();
      if (kind === 'agent')
        expect(screen.getByRole('heading', { name: 'Sample team' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /Installed/ }));
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
      if (kind !== 'skill')
        expect(screen.queryByRole('heading', { name: 'Sample skill' })).toBeNull();
    },
  );
});
