/**
 * SkyalyticWing 1.4.0 媒体生成厂商适配器
 *
 * 统一接口: async function generate(params, provider) → { images:[{url,b64}], videos:[{url,cover}], error }
 *
 * 支持厂商:
 *   - openaiCompatible: OpenAI(DALL-E3/GPT-Image)、Azure、火山引擎Seedream
 *   - dashscopeImage:   阿里通义万相 文生图/图生图
 *   - dashscopeVideo:   阿里通义万相 文生视频/图生视频
 *   - zhipuImage:       智谱 CogView
 *   - zhipuVideo:       智谱 CogVideoX
 *   - volcVideo:        火山引擎 即梦/Seedance
 *   - klingVideo:       快手可灵
 *   - minimaxVideo:     MiniMax 海螺
 *   - openaiVideo:      OpenAI Sora
 *   - hunyuanVideo:     腾讯混元视频
 *
 * 库模块（非工具模块），由 media-gen.cjs 工具调用
 */

module.exports = {
  _notTools: true, // 标记为库模块，避免工具加载警告
  generateImage: generateImage,
  generateVideo: generateVideo,
  pollTaskResult: pollTaskResult,
  httpRequest: httpRequest,
  fileToBase64: fileToBase64,
};

var fs = require("fs");
var https = require("https");
var http = require("http");
var url = require("url");
var path = require("path");

// fileToBase64 任意文件读取防护——白名单目录校验
// 仅允许工作区目录与输出目录下的文件被读取转 base64，避免任意路径读取。
// 通过 require 获取 SecurityManager（在 start.cjs 注入或全局），
// 若不可用则退化为工作区目录前缀校验。
var _MEDIA_ALLOWED_DIRS = null;
function _isMediaPathAllowed(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  try {
    var resolved = path.resolve(filePath);
    // 优先复用 SecurityManager.isPathAllowed（与文件工具一致的安全策略）
    try {
      var SecurityManager = global.SecurityManager || (global.__skyalyticwing_ctx && global.__skyalyticwing_ctx.SecurityManager);
      if (SecurityManager && typeof SecurityManager.isPathAllowed === 'function') {
        return SecurityManager.isPathAllowed(resolved, 'read');
      }
    } catch (e) {}
    // 退化为目录白名单：工作区目录 + DATA_DIR + WORKSPACE_OUTPUT_DIR
    if (!_MEDIA_ALLOWED_DIRS) {
      var cwd = process.cwd();
      _MEDIA_ALLOWED_DIRS = [cwd];
      // 允许常见的输出/数据目录
      var dataDir = process.env.SKYALYTICWING_DATA_DIR || path.join(cwd, 'data');
      var outDir = process.env.SKYALYTICWING_OUTPUT_DIR || path.join(cwd, 'output');
      _MEDIA_ALLOWED_DIRS.push(dataDir, outDir);
      var tmpDir = require('os').tmpdir();
      _MEDIA_ALLOWED_DIRS.push(tmpDir);
    }
    var lower = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    for (var i = 0; i < _MEDIA_ALLOWED_DIRS.length; i++) {
      var allowed = _MEDIA_ALLOWED_DIRS[i];
      var allowedLower = process.platform === 'win32' ? path.resolve(allowed).toLowerCase() : path.resolve(allowed);
      if (lower === allowedLower || lower.indexOf(allowedLower + path.sep) === 0) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

// ════════════════════════════════════════════════════════════
// 通用 HTTP 请求函数
// ════════════════════════════════════════════════════════════
function httpRequest(opts) {
  return new Promise(function (resolve, reject) {
    opts = opts || {};
    var u = opts.url;
    if (!u) return reject(new Error("httpRequest: 缺少 url 参数"));
    var method = (opts.method || "GET").toUpperCase();
    var headers = opts.headers || {};
    var body = opts.body;
    var timeout = opts.timeout || 30000;
    var uObj = url.parse(u);
    var mod = uObj.protocol === "https:" ? https : http;
    var reqOpts = {
      hostname: uObj.hostname,
      port: uObj.port || (uObj.protocol === "https:" ? 443 : 80),
      path: uObj.path,
      method: method,
      headers: headers,
    };
    if (body && !headers["Content-Length"]) {
      var bodyStr = typeof body === "string" ? body : JSON.stringify(body);
      headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }
    var req = mod.request(reqOpts, function (resp) {
      var chunks = [];
      resp.on("data", function (c) { chunks.push(c); });
      resp.on("end", function () {
        var data = Buffer.concat(chunks).toString("utf8");
        var parsed = null;
        try { parsed = JSON.parse(data); } catch (e) {}
        resolve({
          statusCode: resp.statusCode || 0,
          headers: resp.headers || {},
          data: data,
          json: parsed,
        });
      });
    });
    req.on("error", function (e) { reject(e); });
    req.setTimeout(timeout, function () {
      req.destroy(new Error("HTTP请求超时 (" + timeout + "ms): " + u));
    });
    if (body) {
      req.write(typeof body === "string" ? body : JSON.stringify(body));
    }
    req.end();
  });
}

// ════════════════════════════════════════════════════════════
// 文件转 base64（图生图/图生视频参考图）
// ════════════════════════════════════════════════════════════
function fileToBase64(filePath) {
  try {
    // 路径白名单校验——防止任意文件读取
    if (!_isMediaPathAllowed(filePath)) {
      return null;
    }
    if (!fs.existsSync(filePath)) return null;
    var ext = (filePath.split(".").pop() || "png").toLowerCase();
    var mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
      : ext === "gif" ? "image/gif"
      : ext === "webp" ? "image/webp"
      : "image/png";
    var data = fs.readFileSync(filePath);
    return "data:" + mime + ";base64," + data.toString("base64");
  } catch (e) {
    return null;
  }
}

// ════════════════════════════════════════════════════════════
// 异步轮询通用函数
// 提交任务 → 获取 task_id → 轮询状态 → 返回结果
// ════════════════════════════════════════════════════════════
async function pollTaskResult(queryUrl, headers, opts) {
  opts = opts || {};
  var maxWait = opts.maxWait || 300000; // 默认5分钟超时
  var interval = opts.interval || 3000; // 默认3秒轮询一次
  var statusPath = opts.statusPath || "output.task_status"; // 状态字段路径
  var resultPath = opts.resultPath || "output.results"; // 结果字段路径
  var doneStatus = opts.doneStatus || "SUCCEEDED";
  var failStatus = opts.failStatus || "FAILED";
  var startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    try {
      var resp = await httpRequest({
        url: queryUrl,
        method: "GET",
        headers: headers,
        timeout: 15000,
      });
      if (resp.statusCode !== 200) {
        throw new Error("轮询HTTP " + resp.statusCode + ": " + (resp.data || "").substring(0, 200));
      }
      var json = resp.json || {};
      // 获取状态（支持嵌套路径如 "output.task_status"）
      var status = _getPath(json, statusPath);
      if (status === doneStatus || status === "succeeded" || status === "SUCCESS" || status === "success") {
        return { ok: true, data: json, result: _getPath(json, resultPath) };
      }
      if (status === failStatus || status === "failed" || status === "FAIL" || status === "error") {
        var errMsg = _getPath(json, "output.message") || _getPath(json, "output.error") || JSON.stringify(json).substring(0, 300);
        return { ok: false, error: "任务失败: " + errMsg, data: json };
      }
      // 仍在处理中，等待
      await new Promise(function (r) { setTimeout(r, interval); });
    } catch (e) {
      // 网络错误等，等待后重试
      await new Promise(function (r) { setTimeout(r, interval); });
    }
  }
  return { ok: false, error: "任务超时（等待" + Math.round(maxWait / 1000) + "秒未完成）", data: null };
}

// 从对象中按点分路径取值
function _getPath(obj, path) {
  if (!obj || !path) return undefined;
  var parts = path.split(".");
  var cur = obj;
  for (var i = 0; i < parts.length; i++) {
    if (cur == null) return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

// ════════════════════════════════════════════════════════════
// 图片生成入口（根据 providerId 选择适配器）
// ════════════════════════════════════════════════════════════
async function generateImage(params, provider) {
  params = params || {};
  provider = provider || {};
  var pid = provider.providerId || provider.id || "";
  try {
    switch (pid) {
      case "openai":
      case "azure":
        return await _openaiCompatibleImage(params, provider);
      case "doubao":
        // 火山引擎 Seedream 走 OpenAI 兼容 /images/generations
        return await _volcSeedreamImage(params, provider);
      case "qwen":
        return await _dashscopeImage(params, provider);
      case "glm":
        return await _zhipuImage(params, provider);
      case "custom":
        // 自定义模型：根据 baseUrl 判断，默认走 OpenAI 兼容
        return await _openaiCompatibleImage(params, provider);
      default:
        // 其他 provider 尝试 OpenAI 兼容格式
        return await _openaiCompatibleImage(params, provider);
    }
  } catch (e) {
    return { images: [], error: "图片生成失败(" + pid + "): " + (e.message || String(e)) };
  }
}

// ════════════════════════════════════════════════════════════
// 视频生成入口（根据 providerId 选择适配器）
// ════════════════════════════════════════════════════════════
async function generateVideo(params, provider) {
  params = params || {};
  provider = provider || {};
  var pid = provider.providerId || provider.id || "";
  try {
    switch (pid) {
      case "openai":
        return await _openaiVideo(params, provider);
      case "qwen":
        return await _dashscopeVideo(params, provider);
      case "glm":
        return await _zhipuVideo(params, provider);
      case "doubao":
        return await _volcVideo(params, provider);
      case "kling":
        return await _klingVideo(params, provider);
      case "minimax":
        return await _minimaxVideo(params, provider);
      case "hunyuan":
        return await _hunyuanVideo(params, provider);
      case "custom":
        // 自定义模型视频生成：默认走 OpenAI 兼容格式
        return await _openaiVideo(params, provider);
      default:
        return await _openaiVideo(params, provider);
    }
  } catch (e) {
    return { videos: [], error: "视频生成失败(" + pid + "): " + (e.message || String(e)) };
  }
}

// ════════════════════════════════════════════════════════════
// 适配器1: OpenAI 兼容图片生成（DALL-E3, GPT-Image, Azure）
// POST {baseUrl}/images/generations
// ════════════════════════════════════════════════════════════
async function _openaiCompatibleImage(params, provider) {
  var baseUrl = (provider.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  var apiKey = provider.apiKey || "";
  var model = provider.model || params.model || "dall-e-3";
  var prompt = params.prompt || "";
  var n = params.n || 1;
  var size = params.size || "1024x1024";
  var refImages = params.reference_images || [];

  var headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + apiKey,
  };
  // Azure 使用 api-key header
  if (provider.providerId === "azure" || provider.id === "azure") {
    headers["api-key"] = apiKey;
    delete headers["Authorization"];
  }

  var body;
  // GPT-Image 和 DALL-E 3 支持 b64_json
  if (model.indexOf("gpt-image") >= 0) {
    body = { model: model, prompt: prompt, n: n, size: size };
  } else {
    // DALL-E 3
    body = { model: model, prompt: prompt, n: n, size: size, response_format: "b64_json" };
  }

  // 注意：OpenAI /images/edits 端点要求 multipart/form-data 上传图片文件，
  // 无法通过当前 JSON body + data URI 方式实现。DALL-E 2 已被 OpenAI 淘汰，
  // 图生图请使用 GPT-Image 系列模型。此处移除失效的 DALL-E 2 图生图分支，
  // 避免 editUrl 死变量与静默退化为纯文生图的问题。

  var apiUrl = baseUrl + "/images/generations";
  var resp = await httpRequest({
    url: apiUrl,
    method: "POST",
    headers: headers,
    body: body,
    timeout: 120000,
  });
  if (resp.statusCode !== 200) {
    throw new Error("HTTP " + resp.statusCode + ": " + (resp.data || "").substring(0, 300));
  }
  var json = resp.json || {};
  var dataList = json.data || [];
  var images = [];
  for (var i = 0; i < dataList.length; i++) {
    if (dataList[i].b64_json) {
      images.push({ b64: dataList[i].b64_json, url: "data:image/png;base64," + dataList[i].b64_json });
    } else if (dataList[i].url) {
      images.push({ url: dataList[i].url, b64: null });
    }
  }
  return { images: images, error: null };
}

// ════════════════════════════════════════════════════════════
// 适配器2: 火山引擎 Seedream 图片生成（OpenAI 兼容格式）
// POST {baseUrl}/images/generations
// ════════════════════════════════════════════════════════════
async function _volcSeedreamImage(params, provider) {
  // 火山引擎 Seedream 兼容 OpenAI /images/generations 格式
  return await _openaiCompatibleImage(params, provider);
}

// ════════════════════════════════════════════════════════════
// 适配器3: 阿里通义万相 文生图/图生图（DashScope 异步轮询）
// POST /api/v1/services/aigc/text2image/image-synthesis
// ════════════════════════════════════════════════════════════
async function _dashscopeImage(params, provider) {
  var baseUrl = (provider.baseUrl || "").replace(/\/compatible-mode\/v1$/, "");
  if (!baseUrl) baseUrl = "https://dashscope.aliyuncs.com";
  baseUrl = baseUrl.replace(/\/$/, "");
  var apiKey = provider.apiKey || "";
  var model = provider.model || params.model || "wan2.7-image-pro";
  var prompt = params.prompt || "";
  var n = params.n || 1;
  var size = params.size || "1024*1024";
  var refImages = params.reference_images || [];

  var headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + apiKey,
    "X-DashScope-Async": "enable",
  };

  // 判断是文生图还是图生图
  var apiUrl, body;
  if (refImages.length > 0) {
    // 图生图：wan2.1-imageedit
    var refUrl = refImages[0];
    if (!refUrl.startsWith("http") && !refUrl.startsWith("data:")) {
      // 本地文件需先上传或转 base64（DashScope 图生图需要 URL）
      refUrl = fileToBase64(refUrl);
    }
    apiUrl = baseUrl + "/api/v1/services/aigc/image2image/image-synthesis";
    body = {
      model: model,
      input: { prompt: prompt, image: refUrl },
      parameters: { size: size, n: n },
    };
  } else {
    apiUrl = baseUrl + "/api/v1/services/aigc/text2image/image-synthesis";
    body = {
      model: model,
      input: { prompt: prompt },
      parameters: { size: size, n: n },
    };
  }

  // 提交任务
  var resp = await httpRequest({
    url: apiUrl,
    method: "POST",
    headers: headers,
    body: body,
    timeout: 30000,
  });
  if (resp.statusCode !== 200) {
    throw new Error("HTTP " + resp.statusCode + ": " + (resp.data || "").substring(0, 300));
  }
  var json = resp.json || {};
  var taskId = json.output && json.output.task_id;
  if (!taskId) {
    throw new Error("未获取到task_id: " + JSON.stringify(json).substring(0, 300));
  }

  // 轮询结果
  var pollResult = await pollTaskResult(
    baseUrl + "/api/v1/tasks/" + taskId,
    { "Authorization": "Bearer " + apiKey },
    {
      maxWait: 300000,
      interval: 3000,
      statusPath: "output.task_status",
      resultPath: "output.results",
      doneStatus: "SUCCEEDED",
      failStatus: "FAILED",
    }
  );
  if (!pollResult.ok) {
    return { images: [], error: pollResult.error };
  }
  var results = pollResult.result || [];
  var images = [];
  for (var i = 0; i < results.length; i++) {
    if (results[i].url) {
      images.push({ url: results[i].url, b64: null });
    } else if (results[i].b64_image) {
      images.push({ b64: results[i].b64_image, url: "data:image/png;base64," + results[i].b64_image });
    }
  }
  return { images: images, error: null };
}

// ════════════════════════════════════════════════════════════
// 适配器4: 智谱 CogView 图片生成（同步）
// POST /api/paas/v4/images/generations
// ════════════════════════════════════════════════════════════
async function _zhipuImage(params, provider) {
  var baseUrl = (provider.baseUrl || "https://open.bigmodel.cn/api/paas/v4").replace(/\/$/, "");
  var apiKey = provider.apiKey || "";
  var model = provider.model || params.model || "cogview-4-plus";
  var prompt = params.prompt || "";
  var n = params.n || 1;
  var size = params.size || "1024x1024";

  var headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + apiKey,
  };
  var body = { model: model, prompt: prompt, n: n, size: size };

  var resp = await httpRequest({
    url: baseUrl + "/images/generations",
    method: "POST",
    headers: headers,
    body: body,
    timeout: 120000,
  });
  if (resp.statusCode !== 200) {
    throw new Error("HTTP " + resp.statusCode + ": " + (resp.data || "").substring(0, 300));
  }
  var json = resp.json || {};
  var dataList = json.data || [];
  var images = [];
  for (var i = 0; i < dataList.length; i++) {
    if (dataList[i].url) {
      images.push({ url: dataList[i].url, b64: null });
    } else if (dataList[i].b64_json) {
      images.push({ b64: dataList[i].b64_json, url: "data:image/png;base64," + dataList[i].b64_json });
    }
  }
  return { images: images, error: null };
}

// ════════════════════════════════════════════════════════════
// 适配器5: 阿里通义万相 视频生成（DashScope 异步轮询）
// POST /api/v1/services/aigc/video-generation/video-synthesis
// ════════════════════════════════════════════════════════════
async function _dashscopeVideo(params, provider) {
  var baseUrl = (provider.baseUrl || "").replace(/\/compatible-mode\/v1$/, "");
  if (!baseUrl) baseUrl = "https://dashscope.aliyuncs.com";
  baseUrl = baseUrl.replace(/\/$/, "");
  var apiKey = provider.apiKey || "";
  var model = provider.model || params.model || "wan2.7-video";
  var prompt = params.prompt || "";
  var duration = params.duration || 5;
  var refImages = params.reference_images || [];

  var headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + apiKey,
    "X-DashScope-Async": "enable",
  };

  var apiUrl, body;
  if (refImages.length > 0) {
    // 图生视频
    var refUrl = refImages[0];
    if (!refUrl.startsWith("http") && !refUrl.startsWith("data:")) {
      refUrl = fileToBase64(refUrl);
    }
    apiUrl = baseUrl + "/api/v1/services/aigc/video-generation/image-synthesis";
    body = {
      model: model,
      input: { prompt: prompt, img_url: refUrl },
      parameters: { duration: duration },
    };
  } else {
    // 文生视频
    apiUrl = baseUrl + "/api/v1/services/aigc/video-generation/video-synthesis";
    body = {
      model: model,
      input: { prompt: prompt },
      parameters: { duration: duration },
    };
  }

  var resp = await httpRequest({
    url: apiUrl,
    method: "POST",
    headers: headers,
    body: body,
    timeout: 30000,
  });
  if (resp.statusCode !== 200) {
    throw new Error("HTTP " + resp.statusCode + ": " + (resp.data || "").substring(0, 300));
  }
  var json = resp.json || {};
  var taskId = json.output && json.output.task_id;
  if (!taskId) {
    throw new Error("未获取到task_id: " + JSON.stringify(json).substring(0, 300));
  }

  var pollResult = await pollTaskResult(
    baseUrl + "/api/v1/tasks/" + taskId,
    { "Authorization": "Bearer " + apiKey },
    {
      maxWait: 600000, // 视频生成超时10分钟
      interval: 5000,
      statusPath: "output.task_status",
      resultPath: "output.video_url",
      doneStatus: "SUCCEEDED",
      failStatus: "FAILED",
    }
  );
  if (!pollResult.ok) {
    return { videos: [], error: pollResult.error };
  }
  var videoUrl = pollResult.result;
  if (typeof videoUrl === "string") {
    return { videos: [{ url: videoUrl, cover: null }], error: null };
  }
  // 结果可能是数组
  if (Array.isArray(videoUrl)) {
    var vids = [];
    for (var i = 0; i < videoUrl.length; i++) {
      vids.push({ url: videoUrl[i].url || videoUrl[i], cover: videoUrl[i].cover || null });
    }
    return { videos: vids, error: null };
  }
  return { videos: [], error: "未获取到视频URL: " + JSON.stringify(pollResult.data).substring(0, 300) };
}

// ════════════════════════════════════════════════════════════
// 适配器6: 智谱 CogVideoX 视频生成（异步提交+轮询）
// POST /api/paas/v4/videos/generations
// ════════════════════════════════════════════════════════════
async function _zhipuVideo(params, provider) {
  var baseUrl = (provider.baseUrl || "https://open.bigmodel.cn/api/paas/v4").replace(/\/$/, "");
  var apiKey = provider.apiKey || "";
  var model = provider.model || params.model || "cogvideox-2";
  var prompt = params.prompt || "";
  var refImages = params.reference_images || [];

  var headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + apiKey,
  };
  var body = { model: model, prompt: prompt };
  if (refImages.length > 0) {
    var refUrl = refImages[0];
    if (!refUrl.startsWith("http") && !refUrl.startsWith("data:")) {
      refUrl = fileToBase64(refImages[0]);
    }
    body.image = refUrl;
  }

  // 提交任务
  var resp = await httpRequest({
    url: baseUrl + "/videos/generations",
    method: "POST",
    headers: headers,
    body: body,
    timeout: 30000,
  });
  if (resp.statusCode !== 200) {
    throw new Error("HTTP " + resp.statusCode + ": " + (resp.data || "").substring(0, 300));
  }
  var json = resp.json || {};
  var taskId = json.id || json.task_id || (json.data && json.data.task_id);
  if (!taskId) {
    // 某些版本直接返回结果
    if (json.video_result && json.video_result[0] && json.video_result[0].url) {
      return { videos: [{ url: json.video_result[0].url, cover: json.video_result[0].cover_image || null }], error: null };
    }
    throw new Error("未获取到task_id: " + JSON.stringify(json).substring(0, 300));
  }

  // 轮询结果
  var pollResult = await pollTaskResult(
    baseUrl + "/async-result/" + taskId,
    { "Authorization": "Bearer " + apiKey },
    {
      maxWait: 600000,
      interval: 5000,
      statusPath: "task_status",
      resultPath: "video_result",
      doneStatus: "SUCCESS",
      failStatus: "FAIL",
    }
  );
  if (!pollResult.ok) {
    return { videos: [], error: pollResult.error };
  }
  var results = pollResult.result || [];
  var videos = [];
  if (Array.isArray(results)) {
    for (var i = 0; i < results.length; i++) {
      if (results[i].url) {
        videos.push({ url: results[i].url, cover: results[i].cover_image || null });
      }
    }
  } else if (results && results.url) {
    videos.push({ url: results.url, cover: results.cover_image || null });
  }
  return { videos: videos, error: null };
}

// ════════════════════════════════════════════════════════════
// 适配器7: 火山引擎 即梦/Seedance 视频生成（异步轮询）
// POST /api/v3/contents/generations/tasks
// ════════════════════════════════════════════════════════════
async function _volcVideo(params, provider) {
  var baseUrl = (provider.baseUrl || "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, "");
  var apiKey = provider.apiKey || "";
  var model = provider.model || params.model || "doubao-seedance-1-0-pro-250528";
  var prompt = params.prompt || "";
  var duration = params.duration || 5;
  var refImages = params.reference_images || [];

  var headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + apiKey,
  };

  // 火山引擎 content 格式
  var content = [{ type: "text", text: prompt }];
  // 图生视频
  if (refImages.length > 0) {
    var refUrl = refImages[0];
    if (!refUrl.startsWith("http") && !refUrl.startsWith("data:")) {
      refUrl = fileToBase64(refImages[0]);
    }
    content.push({ type: "image_url", image_url: { url: refUrl } });
  }

  var body = {
    model: model,
    content: content,
  };

  // 提交任务
  var resp = await httpRequest({
    url: baseUrl + "/contents/generations/tasks",
    method: "POST",
    headers: headers,
    body: body,
    timeout: 30000,
  });
  if (resp.statusCode !== 200) {
    throw new Error("HTTP " + resp.statusCode + ": " + (resp.data || "").substring(0, 300));
  }
  var json = resp.json || {};
  var taskId = json.id;
  if (!taskId) {
    throw new Error("未获取到task_id: " + JSON.stringify(json).substring(0, 300));
  }

  // 轮询结果
  var pollResult = await pollTaskResult(
    baseUrl + "/contents/generations/tasks/" + taskId,
    { "Authorization": "Bearer " + apiKey },
    {
      maxWait: 600000,
      interval: 5000,
      statusPath: "status",
      resultPath: "content.video_url",
      doneStatus: "succeeded",
      failStatus: "failed",
    }
  );
  if (!pollResult.ok) {
    return { videos: [], error: pollResult.error };
  }
  var videoUrl = pollResult.result;
  if (typeof videoUrl === "string") {
    // 尝试获取封面
    var coverUrl = _getPath(pollResult.data, "content.cover_image_url");
    return { videos: [{ url: videoUrl, cover: coverUrl || null }], error: null };
  }
  return { videos: [], error: "未获取到视频URL: " + JSON.stringify(pollResult.data).substring(0, 300) };
}

// ════════════════════════════════════════════════════════════
// 适配器8: 快手可 Kling 视频生成（异步轮询）
// POST /v1/videos/text2video (文生) / /v1/videos/image2video (图生)
// ════════════════════════════════════════════════════════════
async function _klingVideo(params, provider) {
  var baseUrl = (provider.baseUrl || "https://api.klingai.com").replace(/\/$/, "");
  var apiKey = provider.apiKey || "";
  var model = provider.model || params.model || "kling-v2.1";
  var prompt = params.prompt || "";
  var duration = params.duration || 5;
  var refImages = params.reference_images || [];

  var headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + apiKey,
  };

  var apiUrl, body;
  if (refImages.length > 0) {
    // 图生视频
    var refUrl = refImages[0];
    if (!refUrl.startsWith("http") && !refUrl.startsWith("data:")) {
      refUrl = fileToBase64(refImages[0]);
    }
    apiUrl = baseUrl + "/v1/videos/image2video";
    body = {
      model: model,
      image: refUrl,
      prompt: prompt,
      duration: duration,
    };
  } else {
    apiUrl = baseUrl + "/v1/videos/text2video";
    body = {
      model: model,
      prompt: prompt,
      duration: duration,
    };
  }

  // 提交任务
  var resp = await httpRequest({
    url: apiUrl,
    method: "POST",
    headers: headers,
    body: body,
    timeout: 30000,
  });
  if (resp.statusCode !== 200) {
    throw new Error("HTTP " + resp.statusCode + ": " + (resp.data || "").substring(0, 300));
  }
  var json = resp.json || {};
  var taskId = json.data && json.data.task_id;
  if (!taskId) {
    throw new Error("未获取到task_id: " + JSON.stringify(json).substring(0, 300));
  }

  // 轮询结果（图生视频任务必须用 image2video 端点查询，文生视频用 text2video）
  var _klingQueryPath = refImages.length > 0 ? "/v1/videos/image2video/" : "/v1/videos/text2video/";
  var pollResult = await pollTaskResult(
    baseUrl + _klingQueryPath + taskId,
    { "Authorization": "Bearer " + apiKey },
    {
      maxWait: 600000,
      interval: 5000,
      statusPath: "data.task_status",
      resultPath: "data.videos",
      doneStatus: "succeed",
      failStatus: "failed",
    }
  );
  if (!pollResult.ok) {
    return { videos: [], error: pollResult.error };
  }
  var results = pollResult.result || [];
  var videos = [];
  if (Array.isArray(results)) {
    for (var i = 0; i < results.length; i++) {
      if (results[i].url) {
        videos.push({ url: results[i].url, cover: results[i].cover || null });
      }
    }
  }
  return { videos: videos, error: null };
}

// ════════════════════════════════════════════════════════════
// 适配器9: MiniMax 海螺视频生成（异步轮询）
// POST /v1/video_generation
// ════════════════════════════════════════════════════════════
async function _minimaxVideo(params, provider) {
  var baseUrl = (provider.baseUrl || "https://api.minimaxi.com/v1").replace(/\/$/, "");
  var apiKey = provider.apiKey || "";
  var model = provider.model || params.model || "video-01";
  var prompt = params.prompt || "";
  var refImages = params.reference_images || [];

  var headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + apiKey,
  };
  var body = { model: model, prompt: prompt };
  if (refImages.length > 0) {
    var refUrl = refImages[0];
    if (!refUrl.startsWith("http") && !refUrl.startsWith("data:")) {
      refUrl = fileToBase64(refImages[0]);
    }
    body.first_frame_image = refUrl;
  }

  // 提交任务
  var resp = await httpRequest({
    url: baseUrl + "/video_generation",
    method: "POST",
    headers: headers,
    body: body,
    timeout: 30000,
  });
  if (resp.statusCode !== 200) {
    throw new Error("HTTP " + resp.statusCode + ": " + (resp.data || "").substring(0, 300));
  }
  var json = resp.json || {};
  var taskId = json.task_id || (json.data && json.data.task_id);
  if (!taskId) {
    throw new Error("未获取到task_id: " + JSON.stringify(json).substring(0, 300));
  }

  // 轮询结果
  var pollResult = await pollTaskResult(
    baseUrl + "/query/video_generation?task_id=" + taskId,
    { "Authorization": "Bearer " + apiKey },
    {
      maxWait: 600000,
      interval: 5000,
      statusPath: "status",
      resultPath: "file_id",
      doneStatus: "Success",
      failStatus: "Failed",
    }
  );
  if (!pollResult.ok) {
    return { videos: [], error: pollResult.error };
  }
  var fileId = pollResult.result;
  // MiniMax 需要通过 file_id 获取视频下载链接
  if (fileId) {
    var fileResp = await httpRequest({
      url: baseUrl + "/files/retrieve?file_id=" + fileId,
      method: "GET",
      headers: headers,
      timeout: 15000,
    });
    if (fileResp.statusCode === 200 && fileResp.json && fileResp.json.file && fileResp.json.file.download_url) {
      return { videos: [{ url: fileResp.json.file.download_url, cover: fileResp.json.file.cover_image_url || null }], error: null };
    }
  }
  // 某些版本直接返回 download_url
  var dlUrl = _getPath(pollResult.data, "download_url");
  if (dlUrl) {
    return { videos: [{ url: dlUrl, cover: null }], error: null };
  }
  return { videos: [], error: "未获取到视频URL: " + JSON.stringify(pollResult.data).substring(0, 300) };
}

// ════════════════════════════════════════════════════════════
// 适配器10: OpenAI Sora 视频生成（异步轮询）
// POST /v1/videos
// ════════════════════════════════════════════════════════════
async function _openaiVideo(params, provider) {
  var baseUrl = (provider.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  var apiKey = provider.apiKey || "";
  var model = provider.model || params.model || "sora-2";
  var prompt = params.prompt || "";
  var duration = params.duration || 5;
  var refImages = params.reference_images || [];

  var headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + apiKey,
  };
  var body = {
    model: model,
    prompt: prompt,
    size: params.size || "1024x1024",
    duration: duration,
  };
  if (refImages.length > 0) {
    var refUrl = refImages[0];
    if (!refUrl.startsWith("http") && !refUrl.startsWith("data:")) {
      refUrl = fileToBase64(refImages[0]);
    }
    body.input = [refUrl];
  }

  // 提交任务
  var resp = await httpRequest({
    url: baseUrl + "/videos",
    method: "POST",
    headers: headers,
    body: body,
    timeout: 30000,
  });
  if (resp.statusCode !== 200) {
    throw new Error("HTTP " + resp.statusCode + ": " + (resp.data || "").substring(0, 300));
  }
  var json = resp.json || {};
  var taskId = json.id || json.task_id;
  if (!taskId) {
    throw new Error("未获取到task_id: " + JSON.stringify(json).substring(0, 300));
  }

  // 轮询结果
  var pollResult = await pollTaskResult(
    baseUrl + "/videos/" + taskId,
    { "Authorization": "Bearer " + apiKey },
    {
      maxWait: 600000,
      interval: 5000,
      statusPath: "status",
      resultPath: "output",
      doneStatus: "completed",
      failStatus: "failed",
    }
  );
  if (!pollResult.ok) {
    return { videos: [], error: pollResult.error };
  }
  var output = pollResult.result;
  if (Array.isArray(output)) {
    var videos = [];
    for (var i = 0; i < output.length; i++) {
      if (output[i].url) {
        videos.push({ url: output[i].url, cover: null });
      }
    }
    return { videos: videos, error: null };
  }
  if (typeof output === "string") {
    return { videos: [{ url: output, cover: null }], error: null };
  }
  return { videos: [], error: "未获取到视频URL: " + JSON.stringify(pollResult.data).substring(0, 300) };
}

// ════════════════════════════════════════════════════════════
// 适配器11: 腾讯混元视频生成（异步轮询）
// POST /v1/hunyuan-video/tasks
// ════════════════════════════════════════════════════════════
async function _hunyuanVideo(params, provider) {
  var baseUrl = (provider.baseUrl || "https://api.hunyuan.cloud.tencent.com/v1").replace(/\/$/, "");
  var apiKey = provider.apiKey || "";
  var model = provider.model || params.model || "hunyuan-video";
  var prompt = params.prompt || "";
  var refImages = params.reference_images || [];

  var headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + apiKey,
  };
  var body = { model: model, prompt: prompt };
  if (refImages.length > 0) {
    var refUrl = refImages[0];
    if (!refUrl.startsWith("http") && !refUrl.startsWith("data:")) {
      refUrl = fileToBase64(refImages[0]);
    }
    body.image = refUrl;
  }

  // 提交任务
  var resp = await httpRequest({
    url: baseUrl + "/hunyuan-video/tasks",
    method: "POST",
    headers: headers,
    body: body,
    timeout: 30000,
  });
  if (resp.statusCode !== 200) {
    throw new Error("HTTP " + resp.statusCode + ": " + (resp.data || "").substring(0, 300));
  }
  var json = resp.json || {};
  var taskId = json.id || json.task_id;
  if (!taskId) {
    throw new Error("未获取到task_id: " + JSON.stringify(json).substring(0, 300));
  }

  // 轮询结果
  var pollResult = await pollTaskResult(
    baseUrl + "/hunyuan-video/tasks/" + taskId,
    { "Authorization": "Bearer " + apiKey },
    {
      maxWait: 600000,
      interval: 5000,
      statusPath: "status",
      resultPath: "result.video_url",
      doneStatus: "success",
      failStatus: "failed",
    }
  );
  if (!pollResult.ok) {
    return { videos: [], error: pollResult.error };
  }
  var videoUrl = pollResult.result;
  if (typeof videoUrl === "string") {
    return { videos: [{ url: videoUrl, cover: null }], error: null };
  }
  return { videos: [], error: "未获取到视频URL: " + JSON.stringify(pollResult.data).substring(0, 300) };
}
