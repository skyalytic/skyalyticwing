const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'.test-runtime-data/mcp-marketplace',String(Date.now()));fs.mkdirSync(dir,{recursive:true});
Object.assign(process.env,{NODE_ENV:'test',SKYALYTICWING_DATA_DIR:dir,SKYALYTICWING_WEB_DATA_DIR:dir,APPDATA:dir,LOCALAPPDATA:dir});
const req=createRequire(path.join(root,'packages/backend/package.json'));req('reflect-metadata');
const {McpService}=require('../packages/backend/dist/modules/tools/mcp/mcp.service.js');
const service=new McpService();const checks=[];
(async()=>{
 for(const item of [{id:'mail',package:'mcp-mail-server@2.1.0',args:[],env:{IMAP_HOST:'mail.invalid',SMTP_HOST:'mail.invalid',EMAIL_USER:'fixture@example.invalid',EMAIL_ADDRESS:'fixture@example.invalid',EMAIL_PASS:'test-only-no-real-account',IMAP_SECURE:'true',SMTP_SECURE:'true',IMAP_PORT:'993',SMTP_PORT:'465'}},{id:'tapd',package:'tapd-mcp@1.0.10',args:[],env:{TAPD_API_TOKEN:'test-only-no-real-token'}},{id:'notion',package:'@notionhq/notion-mcp-server@2.5.2',args:[],env:{NOTION_TOKEN:'ntn_test_fixture_no_real_access'}},{id:'playwright',package:'@playwright/mcp@0.0.83',args:['--headless','--isolated','--browser','msedge'],env:{}}]){
  service.addServer({id:item.id,name:item.id,command:'npx',args:['--yes',item.package,...item.args],env:item.env,enabled:true});
  await service.startServer(item.id);const tools=await service.listTools(item.id);assert(tools.length>0);checks.push({id:item.id,handshake:true,toolCount:tools.length,businessAuthorizationTested:false});
  if(item.id==='playwright'){
   const result=await service.callTool(item.id,'browser_navigate',{url:'https://skyalytic.com/ecosystem/'});assert(result.success,JSON.stringify(result));assert(JSON.stringify(result).includes('Skyalytic'));checks.push({id:'playwright-browser-navigation',passed:true});
  }
  service.stopServer(item.id);
 }
 fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(checks,null,2));console.log(JSON.stringify({passed:true,checks,dir}));
})().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>service.onModuleDestroy());
