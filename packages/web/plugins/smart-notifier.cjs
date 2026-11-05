const http = require('node:http');
const https = require('node:https');

module.exports = {
  id: 'smart-notifier', name: 'smart-notifier', version: '2.0.0', author: 'SkyalyticWing',
  description: '已配置渠道的错误、长任务和手动摘要通知；按实际投递结果返回状态',
  priority: 20, enabled: true,
  config: { webhookUrl: '', dingtalkBot: '', feishuBot: '', wecomBot: '', channels: ['webhook'], notifyOnError: true, notifyOnLongTask: true, longTaskThreshold: 30000, quietHoursStart: 23, quietHoursEnd: 8, rateLimitMs: 5000 },
  _lastNotifyTime: {}, _todayErrors: 0, _todayTools: 0,
  hooks: {
    async after_tool_failure(data) {
      this._todayErrors++;
      if (this.config.notifyOnError) await this._send('error', '工具调用失败: ' + (data.tool || 'unknown'));
    },
    async after_tool_call(data) {
      this._todayTools++;
      if (this.config.notifyOnLongTask && data.durationMs > this.config.longTaskThreshold) await this._send('slow', '长任务: ' + data.tool + '，耗时 ' + Math.round(data.durationMs / 1000) + ' 秒');
    },
    onLoad(api) { api.log('通知插件已加载；仅使用用户配置的渠道'); },
    onUnload() {},
  },
  _isQuietHour() {
    const h = new Date().getHours(), start = this.config.quietHoursStart, end = this.config.quietHoursEnd;
    return start === end ? false : start < end ? h >= start && h < end : h >= start || h < end;
  },
  _httpPost(target, payload) {
    return new Promise((resolve, reject) => {
      const url = new URL(target);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return reject(new Error('通知地址无效'));
      const body = JSON.stringify(payload);
      const req = (url.protocol === 'https:' ? https : http).request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 10000 }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; if (text.length > 65536) req.destroy(new Error('通知响应过大')); });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('通知服务 HTTP ' + res.statusCode));
          try {
            const data = text ? JSON.parse(text) : {};
            const code = data.errcode ?? data.code ?? data.StatusCode;
            if (code !== undefined && Number(code) !== 0) return reject(new Error('通知服务拒绝请求'));
          } catch { /* Generic webhooks may return plain text. */ }
          resolve();
        });
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('通知超时')));
      req.on('error', () => reject(new Error('通知网络请求失败')));
      req.end(body);
    });
  },
  async _send(type, text) {
    if (this._isQuietHour() && !['error', 'test', 'summary'].includes(type)) return { success: false, error: '静默时段，未发送' };
    const now = Date.now();
    if (now - (this._lastNotifyTime[type] || 0) < this.config.rateLimitMs) return { success: false, error: '通知频率限制，未发送' };
    const tasks = [];
    for (const channel of this.config.channels || []) {
      let target, payload;
      if (channel === 'webhook') { target = this.config.webhookUrl; payload = { text, type, source: 'skyalyticwing' }; }
      if (channel === 'dingtalk' && this.config.dingtalkBot) { target = 'https://oapi.dingtalk.com/robot/send?access_token=' + encodeURIComponent(this.config.dingtalkBot); payload = { msgtype: 'text', text: { content: text } }; }
      if (channel === 'feishu' && this.config.feishuBot) { target = 'https://open.feishu.cn/open-apis/bot/v2/hook/' + encodeURIComponent(this.config.feishuBot); payload = { msg_type: 'text', content: { text } }; }
      if (channel === 'wecom' && this.config.wecomBot) { target = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=' + encodeURIComponent(this.config.wecomBot); payload = { msgtype: 'text', text: { content: text } }; }
      if (target) tasks.push({ channel, target, payload });
    }
    if (!tasks.length) return { success: false, error: '尚未配置可用通知渠道，未发送' };
    this._lastNotifyTime[type] = now;
    const results = await Promise.all(tasks.map(async t => { try { await this._httpPost(t.target, t.payload); return { channel: t.channel, success: true }; } catch (e) { return { channel: t.channel, success: false, error: e.message }; } }));
    return { success: results.every(r => r.success), output: JSON.stringify(results), data: results };
  },
  tools: [
    { name: 'notify_test', description: '向已配置通知渠道发送测试消息', parameters: { type: 'object', properties: { message: { type: 'string' } } }, execute(args) { return this._send('test', args?.message || 'Wing 通知验收'); } },
    { name: 'notify_config', description: '查看通知渠道配置状态；密钥通过插件设置页配置', parameters: { type: 'object', properties: {} }, execute() { return { success: true, output: JSON.stringify({ channels: this.config.channels, webhookConfigured: !!this.config.webhookUrl, dingtalkConfigured: !!this.config.dingtalkBot, feishuConfigured: !!this.config.feishuBot, wecomConfigured: !!this.config.wecomBot }) }; } },
    { name: 'notify_summary', description: '发送本次运行期间的任务统计摘要', parameters: { type: 'object', properties: {} }, execute() { return this._send('summary', '本次运行统计：错误 ' + this._todayErrors + '，工具调用 ' + this._todayTools); } },
  ],
};
