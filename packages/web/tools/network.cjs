/**
 * 网络类工具模块 (热加载)
 *
 * 提供API调用、HTTP请求、Webhook发送、天气查询、浏览器打开、通知、消息展示等工具。
 * 从 start.cjs 内置 switch 中提取，逻辑保持不变。
 *
 * 上下文 (ctx) 需提供:
 *   fs, path, os, crypto, execSync, IS_WIN, IS_MAC, PS_BIN, APP_VERSION,
 *   configStore, log, broadcast, SecurityManager
 */

var { spawn, execFileSync } = require('child_process');

module.exports = [

  // ═══ api_call ═══════════════════════════════════════════════
  {
    name: 'api_call',
    description: '调用外部API接口。发送HTTP请求并返回响应。',
    parameters: { type: 'object', properties: {} },
    category: 'network',
    dangerous: true,
    execute: function(args, ctx) {
      var SecurityManager = ctx.SecurityManager;
      return new Promise(function(resolve){
        var targetUrl = args.url || '';
        if (SecurityManager && typeof SecurityManager.checkUrl === 'function') {
          SecurityManager.checkUrl(targetUrl).then(function(_ssrfCheck) {
            if (_ssrfCheck && !_ssrfCheck.safe) {
              return resolve({ success: false, error: 'SSRF防护: ' + (_ssrfCheck.reason || '不允许访问该地址') });
            }
            _doApiCall();
          }).catch(function(e) {
            return resolve({ success: false, error: 'SSRF检查失败，请求被拒绝: ' + e.message });
          });
        } else {
          _doApiCall();
        }
        function _doApiCall() {
          try {
            var httpReq = require(targetUrl.startsWith('https')?'https':'http');
            var options = { method:args.method||'GET', headers:args.headers||{} };
            var req = httpReq.request(args.url||'', options, function(res){
              var body='';res.on('data',function(c){body+=c; if(body.length>1000000){req.destroy();resolve({success:false,error:'响应体过大(>1MB)'});}});res.on('end',function(){resolve({success:true,status:res.statusCode,body:body});});
            });
            req.on('error',function(e){resolve({success:false,error:e.message});});
            req.setTimeout(30000,function(){req.destroy();resolve({success:false,error:'请求超时(30s)'});});
            if(args.body) req.write(args.body);req.end();
          } catch(e) {
            resolve({ success: false, error: e.message });
          }
        }
      });
    }
  },

  // ═══ http_request ═══════════════════════════════════════════
  {
    name: 'http_request',
    description: '发送HTTP请求并返回响应。支持自定义方法、请求头、超时等。',
    parameters: { type: 'object', properties: {} },
    category: 'network',
    dangerous: true,
    execute: function(args, ctx) {
      var SecurityManager = ctx.SecurityManager;
      // 移除 async Promise executor 反模式，改用普通 function + try/catch + .then()/.catch()
      // 原 async executor 中 httpMod.request() 同步抛出时 Promise 永久 pending，导致工具调用框架无限等待
      return new Promise(function(resolve){
        var targetUrl = args.url || '';
        function _doRequest() {
          try {
            var httpMod = require(targetUrl.startsWith('https')?'https':'http');
            var options = { method:(args.method||'GET').toUpperCase(), headers:args.headers||{} };
            if (args.timeout) options.timeout = parseInt(args.timeout);
            var req = httpMod.request(args.url||'', options, function(res){
              var body='';var _hrOversized=false;
              res.on('data',function(c){
                if(_hrOversized)return;
                body+=c;
                if(body.length>1000000){_hrOversized=true;req.destroy();resolve({success:false,error:'响应体过大(>1MB)'});}
              });
              res.on('end',function(){
                resolve({success:true,status:res.statusCode,headers:res.headers,body:body.substring(0,100000)});
              });
              res.on('error',function(e){resolve({success:false,error:'响应错误:'+e.message});});
            });
            req.on('error',function(e){resolve({success:false,error:e.message});});
            req.setTimeout(args.timeout?parseInt(args.timeout):30000, function(){ req.destroy(); resolve({success:false,error:'请求超时('+(args.timeout||30)+'s)'}); });
            if(args.body) req.write(typeof args.body==='string'?args.body:JSON.stringify(args.body));
            req.end();
          } catch(e) {
            resolve({ success: false, error: e.message });
          }
        }
        if (SecurityManager && typeof SecurityManager.checkUrl === 'function') {
          SecurityManager.checkUrl(targetUrl).then(function(_ssrfCheck){
            if (_ssrfCheck && !_ssrfCheck.safe) {
              resolve({ success: false, error: 'SSRF防护: ' + (_ssrfCheck.reason || '不允许访问该地址') });
            } else {
              _doRequest();
            }
          }).catch(function(e){
            // SSRF 检查异常时拒绝请求，避免空 catch 静默放行导致 SSRF 绕过
            resolve({ success: false, error: 'SSRF检查失败: ' + e.message });
          });
        } else {
          _doRequest();
        }
      });
    }
  },

  // ═══ webhook_send ════════════════════════════════════════════
  {
    name: 'webhook_send',
    description: '发送HTTP Webhook请求。向指定URL发送POST请求，用于与外部系统集成。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Webhook URL（仅支持HTTPS）' },
        method: { type: 'string', enum: ['POST','PUT','PATCH','GET'], description: 'HTTP方法，默认POST' },
        headers: { type: 'object', description: '自定义请求头' },
        body: { type: 'object', description: '请求体JSON' },
        secret: { type: 'string', description: 'HMAC签名密钥（可选）' },
        timeout: { type: 'number', description: '超时毫秒数，默认30000' }
      },
      required: ['url']
    },
    category: 'network',
    // dangerous 改为 true，与 api_call/http_request 保持一致，防止未审批数据外传
    dangerous: true,
    execute: async function(args, ctx) {
      var crypto = ctx.crypto;
      var APP_VERSION = ctx.APP_VERSION;
      var SecurityManager = ctx.SecurityManager;
      try {
        var _whUrl = args.url;
        if (!_whUrl) return {ok:false,error:'请提供Webhook URL'};
        // 描述声明"仅支持HTTPS"，代码必须强制 HTTPS——HTTP 明文传输 webhook payload（可能含 secret/敏感数据）
        // 同时也防止中间人篡改 webhook 内容
        if (!_whUrl.toLowerCase().startsWith('https://')) {
          return {ok:false,error:'Webhook URL 必须使用 HTTPS（不支持 HTTP）'};
        }
        if (SecurityManager) { var _ssrfCheck = await SecurityManager.checkUrl(_whUrl); if (_ssrfCheck && !_ssrfCheck.safe) return {ok:false,error:'URL安全检查失败: '+_ssrfCheck.reason}; }
        var _whMethod = (args.method||'POST').toUpperCase();
        var _whHeaders = Object.assign({'Content-Type':'application/json','User-Agent':'SkyalyticWing/'+APP_VERSION}, args.headers||{});
        var _whBody = args.body ? JSON.stringify(args.body) : '';
        if (args.secret) { var _whSig = crypto.createHmac('sha256', args.secret).update(_whBody).digest('hex'); _whHeaders['X-Signature-256'] = 'sha256='+_whSig; }
        var _whResult = await new Promise(function(resolve, reject) {
          // 已强制 HTTPS，固定使用 https 模块（原代码在 startsWith('https') 失败时回退到 http，违反描述）
          var _whMod = require('https');
          var _whReq = _whMod.request(_whUrl, {method:_whMethod,headers:_whHeaders}, function(_whRes) {
            // fix(第二十一轮): 响应体在 .substring(0,2000) 截断前完整累积到内存，
            // 恶意 webhook 端点可返回超大响应导致 OOM。添加 5MB 限制并在超限时销毁连接。
            var _whData = ''; var _whOversized = false;
            _whRes.on('data',function(c){
              if(_whOversized) return;
              _whData += c;
              if(_whData.length > 5*1024*1024) {
                _whOversized = true;
                try { _whRes.destroy(); } catch(e) {}
                resolve({statusCode:_whRes.statusCode, body:'(响应体过大,已截断)', headers:_whRes.headers});
              }
            });
            _whRes.on('end',function(){
              if(_whOversized) return;
              resolve({statusCode:_whRes.statusCode,body:_whData.substring(0,2000),headers:_whRes.headers});
            });
          });
          _whReq.on('error', reject);
          _whReq.setTimeout(args.timeout||30000, function(){_whReq.destroy();reject(new Error('Webhook timeout'));});
          if (_whBody) _whReq.write(_whBody);
          _whReq.end();
        });
        return {ok:true, statusCode:_whResult.statusCode, response:_whResult.body, sentAt:new Date().toISOString()};
      } catch(e) { return {ok:false,error:'Webhook发送失败: '+e.message}; }
    }
  },

  // ═══ weather ═════════════════════════════════════════════════
  {
    name: 'weather',
    description: '查询天气信息。获取指定城市的当前天气和预报。不指定城市时自动通过IP定位获取用户位置。',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: '城市名称（如"北京"、"Tokyo"、"New York"）。不填时自动通过IP定位' },
        days: { type: 'number', description: '预报天数（1-7），默认1' },
        units: { type: 'string', enum: ['metric','imperial'], description: '单位：metric=摄氏,imperial=华氏，默认metric' }
      },
      required: []
    },
    category: 'network',
    dangerous: false,
    execute: function(args, ctx) {
      var configStore = ctx.configStore;
      var _wLoc = args.location || '';
      var _wDays = args.days || 1;
      var _wUnits = args.units || 'metric';
      var _wHttpMod = require('https');

      function _wFetchWeather(loc, resolve) {
        try {
          var _wApiKey = process.env.OPENWEATHER_API_KEY || (configStore.general && configStore.general.openWeatherApiKey) || '';
          // fix(第二十一轮): 添加 HTTP 响应大小限制，防止恶意/异常 API 返回超大响应导致 OOM
          var _wMaxSize = 10 * 1024 * 1024; // 10MB
          if (!_wApiKey) {
            var _wUrl = 'https://wttr.in/' + encodeURIComponent(loc) + '?format=j1';
            _wHttpMod.get(_wUrl,function(_wRes){
              var _wData='';var _wOversized=false;
              _wRes.on('data',function(c){if(_wOversized)return;_wData+=c.toString();if(_wData.length>_wMaxSize){_wOversized=true;_wRes.destroy();resolve({ok:false,error:'天气API响应过大(>10MB)'});}});
              _wRes.on('end',function(){
                if(_wOversized)return;
                try{
                  var _wJ=JSON.parse(_wData);
                  var _wCurrent=_wJ.current_condition&&_wJ.current_condition[0];
                  resolve({ok:true,location:loc,temperature:_wCurrent&&_wCurrent.temp_C?_wCurrent.temp_C+'°C':'N/A',description:_wCurrent&&_wCurrent.weatherDesc&&_wCurrent.weatherDesc[0]&&_wCurrent.weatherDesc[0].value||'N/A',humidity:_wCurrent&&_wCurrent.humidity||'N/A',wind:_wCurrent&&_wCurrent.windspeedKmph?_wCurrent.windspeedKmph+'km/h':'N/A',source:'wttr.in'});
                }catch(e){resolve({ok:false,error:'天气数据解析失败'});}
              });
            }).on('error',function(e){resolve({ok:false,error:'天气查询失败: '+e.message});});
          } else {
            var _wUrl2 = 'https://api.openweathermap.org/data/2.5/weather?q='+encodeURIComponent(loc)+'&appid='+_wApiKey+'&units='+_wUnits;
            _wHttpMod.get(_wUrl2,function(_wRes2){
              var _wData2='';var _wOversized2=false;
              _wRes2.on('data',function(c){if(_wOversized2)return;_wData2+=c.toString();if(_wData2.length>_wMaxSize){_wOversized2=true;_wRes2.destroy();resolve({ok:false,error:'天气API响应过大(>10MB)'});}});
              _wRes2.on('end',function(){
                if(_wOversized2)return;
                try{var _wJ2=JSON.parse(_wData2);resolve({ok:true,location:loc,temperature:_wJ2.main&&_wJ2.main.temp?_wJ2.main.temp+'°':'N/A',description:_wJ2.weather&&_wJ2.weather[0]&&_wJ2.weather[0].description||'N/A',humidity:_wJ2.main&&_wJ2.main.humidity||'N/A',wind:_wJ2.wind&&_wJ2.wind.speed?_wJ2.wind.speed+'m/s':'N/A',source:'openweathermap'});}
                catch(e){resolve({ok:false,error:'天气数据解析失败'});}
              });
            }).on('error',function(e){resolve({ok:false,error:'天气查询失败: '+e.message});});
          }
        } catch(e) { resolve({ok:false,error:e.message}); }
      }

      function _wIpLocate(resolve) {
        var _wIpUrl = 'https://ipapi.co/json/';
        var _wIpMaxSize = 5 * 1024 * 1024; // fix(第二十一轮): 5MB 限制
        _wHttpMod.get(_wIpUrl, function(_wIpRes){
          var _wIpData='';var _wIpOversized=false;
          _wIpRes.on('data',function(c){if(_wIpOversized)return;_wIpData+=c.toString();if(_wIpData.length>_wIpMaxSize){_wIpOversized=true;_wIpRes.destroy();resolve({ok:false,error:'IP定位API响应过大'});}});
          _wIpRes.on('end',function(){
            if(_wIpOversized)return;
            try{
              var _wIpJ=JSON.parse(_wIpData);
              var _wIpCity=_wIpJ.city||(_wIpJ.latitude&&_wIpJ.longitude?_wIpJ.latitude+','+_wIpJ.longitude:'');
              if(_wIpCity){_wFetchWeather(_wIpCity,resolve);}
              else{resolve({ok:false,error:'IP定位未返回城市信息，请提供城市名称'});}
            }catch(e){
              _wIpLocateFallback(resolve);
            }
          });
        }).on('error',function(e){
          _wIpLocateFallback(resolve);
        });
      }

      function _wIpLocateFallback(resolve) {
        var _wIpUrl2 = 'https://ipinfo.io/json';
        var _wIpMaxSize2 = 5 * 1024 * 1024; // fix(第二十一轮): 5MB 限制
        _wHttpMod.get(_wIpUrl2, function(_wIpRes2){
          var _wIpData2='';var _wIpOversized2=false;
          _wIpRes2.on('data',function(c){if(_wIpOversized2)return;_wIpData2+=c.toString();if(_wIpData2.length>_wIpMaxSize2){_wIpOversized2=true;_wIpRes2.destroy();resolve({ok:false,error:'IP定位API响应过大'});}});
          _wIpRes2.on('end',function(){
            if(_wIpOversized2)return;
            try{
              var _wIpJ2=JSON.parse(_wIpData2);
              var _wIpCity2=_wIpJ2.city||_wIpJ2.loc||'';
              if(_wIpCity2){_wFetchWeather(_wIpCity2,resolve);}
              else{resolve({ok:false,error:'IP定位未返回城市信息，请提供城市名称'});}
            }catch(e){resolve({ok:false,error:'IP定位失败，请提供城市名称'});}
          });
        }).on('error',function(e){resolve({ok:false,error:'IP定位失败，请提供城市名称'});});
      }

      return new Promise(function(resolve){
        if(_wLoc){_wFetchWeather(_wLoc,resolve);}
        else{_wIpLocate(resolve);}
      });
    }
  },

  // ═══ browser_open ═══════════════════════════════════════════
  {
    name: 'browser_open',
    description: '使用系统默认浏览器打开指定URL。',
    parameters: { type: 'object', properties: {} },
    category: 'network',
    dangerous: false,
    execute: function(args, ctx) {
      var os = ctx.os;
      var _openUrl = String(args.url || '');
      if (!_openUrl) return { success: false, error: 'URL不能为空' };
      // fix(第二十一轮): URL 未校验协议且 Windows 下 cmd /c start 未对 URL 加引号，
      // URL 中的 & | ; 等 cmd 元字符可导致命令注入（如 http://evil.com&calc.exe）。
      // 1. 仅允许 http/https 协议，阻止 file:///、javascript:、data: 等
      if (!/^https?:\/\//i.test(_openUrl)) {
        return { success: false, error: '仅允许 http/https URL' };
      }
      var _openCmd = os.platform()==='win32'?'cmd':(os.platform()==='darwin'?'open':'xdg-open');
      // fix(第二十一轮): Windows 下用双引号包裹 URL，防止 & | ; 等被 cmd 解析为命令分隔符
      var _openArgs = os.platform()==='win32'?['/c', 'start', '', '"' + _openUrl + '"']:[_openUrl];
      try { spawn(_openCmd, _openArgs, { detached: true, stdio: 'ignore' }).unref(); } catch(e) {}
      return { success:true, url:args.url };
    }
  },

  // ═══ notify ══════════════════════════════════════════════════
  {
    name: 'notify',
    description: '显示桌面通知消息。弹出系统消息框提醒用户。',
    parameters: { type: 'object', properties: {} },
    category: 'network',
    dangerous: false,
    execute: function(args, ctx) {
      var execSync = ctx.execSync;
      var IS_WIN = ctx.IS_WIN;
      var IS_MAC = ctx.IS_MAC;
      var PS_BIN = ctx.PS_BIN;
      var _notifyMsg = String(args.message || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
      if(IS_WIN){
        var notifyPs = "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');[System.Windows.Forms.MessageBox]::Show('"+_notifyMsg.replace(/'/g,"''")+"')";
        execSync(PS_BIN, { encoding:'utf-8', input:notifyPs, shell:true, timeout:10000 });
      } else if(IS_MAC){
        _notifyMsg = (_notifyMsg||'').replace(/\\/g,'\\\\').replace(/"/g,'').replace(/`/g,'').replace(/\$/g,'').replace(/'/g,'');
        try{execFileSync('osascript', ['-e', 'display notification "'+_notifyMsg+'" with title "SkyalyticWing"'], {timeout:5000});}catch(ne){}
      } else {
        // Linux 分支用 execFileSync + 数组参数替代 execSync + shell:true
        // 消除 shell 注入风险（_notifyMsg 即使含 `;`/`&`/`$()` 也不会被解析为命令分隔符）
        // _notifyMsg 的转义也可简化——数组参数模式下无需 shell 转义，直接传原始消息
        var _linuxNotifyMsg = String(args.message || '');
        try{execFileSync('notify-send', ['SkyalyticWing', _linuxNotifyMsg], {timeout:5000, windowsHide:true});}catch(ne2){}
      }
      return { success:true, message:args.message };
    }
  },

  // ═══ show_message ════════════════════════════════════════════
  {
    name: 'show_message',
    description: '显示一条消息。返回消息内容、标题和类型。',
    parameters: { type: 'object', properties: {} },
    category: 'network',
    dangerous: false,
    execute: function(args, ctx) {
      return { success:true, message: args.message||'', title: args.title||'消息', type: args.type||'info' };
    }
  }

];
