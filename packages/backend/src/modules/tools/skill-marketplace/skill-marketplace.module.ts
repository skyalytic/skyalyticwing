import { Module } from '@nestjs/common';
import { SkillMarketplaceService } from './skill-marketplace.service.js';
import { SkillMarketplaceController } from './skill-marketplace.controller.js';
import { EcosystemModule } from '../../ecosystem/ecosystem.module.js';

/**
 * SkillMarketplaceModule - 技能市场模块
 *
 * 依赖 LoggerService / HttpClientService / SecurityManagerService（全局模块提供）。
 *
 * Controllers:
 *   - SkillMarketplaceController: /api/skill-marketplace/search|install|sources
 */
@Module({
  imports: [EcosystemModule],
  providers: [SkillMarketplaceService],
  controllers: [SkillMarketplaceController],
  exports: [SkillMarketplaceService],
})
export class SkillMarketplaceModule {}
