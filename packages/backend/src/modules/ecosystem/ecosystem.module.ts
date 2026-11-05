import { Module, Controller, Get, Post, Delete, Query, Param, Body } from '@nestjs/common';
import { EcosystemService } from './ecosystem.service.js';
import { McpModule } from '../tools/mcp/mcp.module.js';
import { AgentModule } from '../ai/agent/agent.module.js';
import { TemplateInstallerService } from './template-installer.service.js';
import { ConnectorOAuthService } from './connector-oauth.service.js';
import { BadRequestException } from '@nestjs/common';
import { EcosystemPolicyService } from './ecosystem-policy.service.js';
import { PluginModule } from '../tools/plugin/plugin.module.js';
import { NativeResourceInstaller } from './native-resource-installer.service.js';
@Controller('ecosystem')
class EcosystemController {
  constructor(private readonly service:EcosystemService,private readonly oauth:ConnectorOAuthService,private readonly policy:EcosystemPolicyService){}
  @Get('policy') getPolicy(){return this.policy.get()}
  @Post('policy') setPolicy(@Body() body:Parameters<EcosystemPolicyService['set']>[0]){return this.policy.set(body)}
  @Post(':id/approve') approve(@Param('id') id:string){return this.service.approveVersion(id)}
  @Get('catalog') catalog(@Query('q') q?:string,@Query('kind') kind?:string){return this.service.catalog(q,kind)}
  @Get('installed') installed(){return {items:this.service.installed()}}
  @Get('connections') connections(){return {items:this.service.connectionStatus()}}
  @Get(':id/configuration') configuration(@Param('id') id:string){return this.service.configuration(id)}
  @Post(':id/install') install(@Param('id') id:string){return this.service.install(id)}
  @Post(':id/configure') configure(@Param('id') id:string,@Body() body:{env?:unknown}){return this.service.configure(id,body?.env)}
  @Post(':id/revoke') revoke(@Param('id') id:string){return this.service.revoke(id)}
  @Post(':id/upgrade') upgrade(@Param('id') id:string){return this.service.upgrade(id)}
  @Post(':id/rollback') rollback(@Param('id') id:string){return this.service.rollback(id)}
  @Delete(':id/backup') discardBackup(@Param('id') id:string){return this.service.discardBackup(id)}
  @Post(':id/oauth/start') oauthStart(@Param('id') id:string){const item=this.service.installed().find(i=>i.id===id);if(!item)throw new BadRequestException('资源未安装');this.policy.check(item);return this.oauth.begin(item)}
  @Get(':id/oauth/status') oauthStatus(@Param('id') id:string){return this.oauth.status(id)}
  @Delete(':id') async uninstall(@Param('id') id:string){const item=this.service.installed().find(i=>i.id===id);if(item?.oauth)await this.service.revoke(id);return this.service.uninstall(id)}
}
@Module({imports:[McpModule,AgentModule,PluginModule],controllers:[EcosystemController],providers:[EcosystemService,TemplateInstallerService,ConnectorOAuthService,EcosystemPolicyService,NativeResourceInstaller],exports:[EcosystemService]})
export class EcosystemModule {}
