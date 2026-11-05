import { mergeConfig } from 'vitest/config';
import base from './vite.config';
export default mergeConfig(base, { resolve: { dedupe: ['react', 'react-dom'] }, test: { include: ['test/OfficialConsolePayments.test.tsx', 'test/OrganizationUsagePanel.test.tsx'] } });
