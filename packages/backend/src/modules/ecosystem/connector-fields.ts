/** Presentation for declared fields only. Unknown fields default to secret inputs. */
const labels: Record<string, [string, string, boolean]> = {
  CONTEXT7_API_KEY: ['Context7 API Key', '在 context7.com/dashboard 获取个人 Key；服务额度由 Context7 账号决定。', true],
  TAVILY_API_KEY: ['Tavily API Key', '在 app.tavily.com 获取 API Key，不需要填写 Bearer 前缀；检索与抓取使用你自己的额度。', true],
  FIRECRAWL_API_KEY: ['Firecrawl API Key', '在 firecrawl.dev/app/api-keys 获取 API Key，不需要填写 Bearer 前缀；抓取任务使用你自己的额度。', true],
  NEON_API_KEY: ['Neon API Key', '在 console.neon.tech 的账号设置中创建 API Key；请限制到需要的项目。数据库修改或资源创建可能产生费用。', true],
  MEMORY_FILE_PATH: ['本地记忆文件路径', '填写本机可写的绝对文件路径，例如 D:\\WingData\\memory.jsonl；每位员工单独保存。', false],
  DINGTALK_Client_ID: ['钉钉应用 Client ID', '在钉钉开发者后台创建应用并授予所需权限。', false],
  DINGTALK_Client_Secret: ['钉钉应用 Client Secret', '填写应用密钥。', true],
  APP_ID: ['飞书应用 App ID', '在飞书开放平台创建应用、配置权限并发布可用版本。', false],
  APP_SECRET: ['飞书应用 App Secret', '填写应用密钥。', true],
  AMAP_MAPS_API_KEY: ['高德地图 API Key', '填写高德开放平台提供的 Web 服务 Key。', true],
  NOTION_TOKEN: ['Notion 集成 Token', '还需在 Notion 中向此集成共享目标页面。', true],
  GITHUB_AUTH_HEADER: ['GitHub Authorization', '填写完整的 Bearer <PAT>，权限须覆盖目标仓库。', true],
  TENCENT_DOCS_AUTHORIZATION: ['腾讯文档 Authorization', '按腾讯文档授权页要求填写完整 Authorization 值。', true],
  TAPD_API_TOKEN: ['TAPD API Token', '填写可访问目标项目的 API Token。', true],
  IMAP_HOST: ['IMAP 服务器', '例如 imap.qq.com，不包含协议或端口。', false],
  SMTP_HOST: ['SMTP 服务器', '例如 smtp.qq.com，不包含协议或端口。', false],
  EMAIL_USER: ['邮箱登录用户名', '通常是完整邮箱地址，以邮箱服务商要求为准。', false],
  EMAIL_ADDRESS: ['发件邮箱地址', '填写已授权邮箱地址。', false],
  EMAIL_PASS: ['邮箱授权码', '通常需要在邮箱设置中开启 IMAP/SMTP 并生成授权码。', true],
};
const editableDefaults = new Set(['IMAP_PORT', 'SMTP_PORT', 'IMAP_SECURE', 'SMTP_SECURE']);
export function connectorFields(install: {envKeys: string[]; defaults: Record<string, string>}) {
  return [...new Set([...install.envKeys, ...Object.keys(install.defaults || {}).filter(k => editableDefaults.has(k))])].map(key => {
    const port = key === 'IMAP_PORT' || key === 'SMTP_PORT';
    const boolean = key === 'IMAP_SECURE' || key === 'SMTP_SECURE';
    const known = labels[key];
    return {key, label: known?.[0] || (port ? key.replace('_PORT', ' 端口') : boolean ? key.replace('_SECURE', ' 隐式 TLS') : key),
      help: known?.[1] || (port ? '按邮箱服务商提供的端口填写。' : boolean ? 'true：连接时立即启用 TLS；STARTTLS 端口请按服务商要求设置为 false。' : '填写此连接器要求的授权字段。'),
      secret: known?.[2] ?? !(port || boolean), type: port ? 'port' : boolean ? 'boolean' : 'text',
      required: install.envKeys.includes(key), defaultValue: editableDefaults.has(key) ? install.defaults[key] : undefined};
  });
}
