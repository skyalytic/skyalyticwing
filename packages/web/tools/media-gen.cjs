/**
 * SkyalyticWing 1.4.0 媒体生成工具模块
 *
 * 提供 generate_image 和 generate_video 两个工具，供 AI 自动调用：
 *   - generate_image: 文生图 / 图生图
 *   - generate_video: 文生视频 / 图生视频
 *
 * 工具执行流程：
 *   1. 解析 model 参数 → 未指定则通过 findMediaModel 查找已配置的 image/video 模型
 *   2. 解析 provider（复用 resolveProviderForModel）获取 apiKey/baseUrl
 *   3. 根据 provider.id 选择适配器（media-gen-adapters.cjs）
 *   4. 调用适配器 generate()
 *   5. 返回结果（含 _inlineImage 或 _inlineVideo）
 *
 * 上下文 (ctx) 需提供:
 *   configStore, resolveProviderForModel, getActiveProvider,
 *   getModelModality, findMediaModel, sanitizeApiKey,
 *   PROVIDER_DEFAULT_URLS, log, DATA_DIR, fs, path
 */

var MediaAdapters = require("./media-gen-adapters.cjs");

module.exports = [

  // ════════════════════════════════════════════════════════════
  // generate_image: 文生图 / 图生图
  // ════════════════════════════════════════════════════════════
  {
    name: "generate_image",
    description:
      "文生图/图生图。根据文字描述生成图片，或基于参考图片生成新图片。当用户说'画一张/生成图片/创建图片/画一只猫'等时调用此工具。支持国内外厂商：OpenAI(DALL-E3/GPT-Image)、通义万相、智谱CogView、火山引擎Seedream、Azure等。",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "图片描述（中英文均可，越详细效果越好）",
        },
        model: {
          type: "string",
          description: "图片生成模型ID（如dall-e-3/gpt-image-1/wan2.7-image-pro/cogview-4-plus/doubao-seedream-5.0-lite）。留空则自动选择已配置的图片生成模型",
        },
        size: {
          type: "string",
          description: "图片尺寸，如1024x1024、1792x1024、1024x1792。留空使用模型默认尺寸",
        },
        n: {
          type: "number",
          description: "生成图片数量，默认1",
        },
        reference_images: {
          type: "array",
          items: { type: "string" },
          description: "参考图URL或本地文件路径（图生图时提供，如['D:\\\\photo.jpg']或['https://example.com/img.jpg']）",
        },
      },
      required: ["prompt"],
    },
    category: "media",
    dangerous: false,
    execute: async function (args, ctx) {
      return await _executeGenerate("image", args, ctx);
    },
  },

  // ════════════════════════════════════════════════════════════
  // generate_video: 文生视频 / 图生视频
  // ════════════════════════════════════════════════════════════
  {
    name: "generate_video",
    description:
      "文生视频/图生视频。根据文字描述生成视频，或基于图片生成视频。当用户说'生成视频/制作视频/创建一段视频'等时调用此工具。支持国内外厂商：OpenAI Sora、通义万相、智谱CogVideoX、火山引擎即梦/Seedance、快手可灵Kling、MiniMax海螺、腾讯混元等。视频生成耗时较长（几十秒到几分钟），请耐心等待。",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "视频内容描述（中英文均可，越详细效果越好）",
        },
        model: {
          type: "string",
          description: "视频生成模型ID（如sora-2/wan2.7-video/cogvideox-2/jimeng-3.0/seedance-1.0-pro/kling-v2.1/video-01/hunyuan-video）。留空则自动选择已配置的视频生成模型",
        },
        duration: {
          type: "number",
          description: "视频时长（秒），默认5秒。部分模型仅支持固定时长",
        },
        reference_images: {
          type: "array",
          items: { type: "string" },
          description: "参考图URL或本地文件路径（图生视频时提供）",
        },
        size: {
          type: "string",
          description: "视频分辨率/尺寸（部分模型支持），如1920x1080",
        },
      },
      required: ["prompt"],
    },
    category: "media",
    dangerous: false,
    execute: async function (args, ctx) {
      return await _executeGenerate("video", args, ctx);
    },
  },
];

// ════════════════════════════════════════════════════════════
// 统一生成执行函数
// ════════════════════════════════════════════════════════════
async function _executeGenerate(modality, args, ctx) {
  var log = ctx.log || function (level, tag, msg) { console.log("[" + level + "][" + tag + "] " + msg); };
  var configStore = ctx.configStore || {};
  var resolveProviderForModel = ctx.resolveProviderForModel;
  var findMediaModel = ctx.findMediaModel;
  var getModelModality = ctx.getModelModality;
  var sanitizeApiKey = ctx.sanitizeApiKey || function (k) { return k; };
  var fs = ctx.fs;
  var path = ctx.path;
  var SecurityManager = ctx.SecurityManager;

  args = args || {};
  var prompt = args.prompt || "";
  var model = args.model || "";
  var refImages = args.reference_images || [];

  if (!prompt) {
    return { ok: false, error: "请提供描述文字（prompt参数）" };
  }

  // 验证参考图存在
  if (refImages.length > 0 && fs) {
    for (var ri = 0; ri < refImages.length; ri++) {
      var refImg = refImages[ri];
      if (!refImg.startsWith("http://") && !refImg.startsWith("https://") && !refImg.startsWith("data:")) {
        var _refResolved = path.resolve(process.cwd(), refImg);
        // fix(第十轮): 添加路径验证，防止读取敏感文件
        if (SecurityManager && typeof SecurityManager.isPathAllowed === 'function') {
          if (!SecurityManager.isPathAllowed(_refResolved, 'read')) {
            return { ok: false, error: '参考图路径被安全策略拒绝: ' + _refResolved };
          }
        }
        if (!fs.existsSync(_refResolved)) {
          return { ok: false, error: "参考图文件不存在: " + refImg };
        }
      }
    }
  }

  // 解析 provider 和 model
  var provider = null;
  if (model) {
    // 用户指定了模型，解析 provider
    var modalityCheck = getModelModality(model);
    if (modalityCheck !== "unknown" && modalityCheck !== modality) {
      log("WARN", "media-gen", "模型 " + model + " 的类型为 " + modalityCheck + "，与请求的 " + modality + " 不匹配");
    }
    var resolved = resolveProviderForModel ? resolveProviderForModel(model) : null;
    if (resolved) {
      provider = {
        providerId: resolved.id,
        apiKey: resolved.apiKey,
        baseUrl: resolved.baseUrl,
        model: resolved.model || model,
      };
    } else {
      return {
        ok: false,
        error: "模型 " + model + " 未找到已配置的 provider。请先通过 provider_config 工具配置对应厂商的 API Key。",
      };
    }
  } else {
    // 未指定模型，自动查找已配置的 image/video 模型
    provider = findMediaModel ? findMediaModel(modality) : null;
    if (!provider) {
      return {
        ok: false,
        error: "未找到已配置的" + (modality === "image" ? "图片生成" : "视频生成") + "模型。请：1) 通过 provider_config(action=set) 配置对应厂商的API Key（如openai/qwen/glm/doubao/kling/minimax/hunyuan）；2) 或通过 provider_config(action=add_model, modality=" + modality + ") 添加自定义" + (modality === "image" ? "图片" : "视频") + "生成模型。支持的厂商：OpenAI(DALL-E/GPT-Image/Sora)、通义万相(wan2.7)、智谱(CogView/CogVideoX)、火山引擎(Seedream/即梦/Seedance)、快手可灵(Kling)、MiniMax(海螺)、腾讯混元。",
      };
    }
  }

  log("INFO", "media-gen", "开始" + (modality === "image" ? "图片" : "视频") + "生成: provider=" + provider.providerId + " model=" + provider.model + " prompt=" + prompt.substring(0, 80));

  // 调用适配器
  var genParams = {
    prompt: prompt,
    model: provider.model,
    size: args.size || "",
    n: args.n || 1,
    duration: args.duration || 5,
    reference_images: refImages,
  };

  var result;
  try {
    if (modality === "image") {
      result = await MediaAdapters.generateImage(genParams, provider);
    } else {
      result = await MediaAdapters.generateVideo(genParams, provider);
    }
  } catch (e) {
    log("ERROR", "media-gen", "生成异常: " + (e.message || String(e)));
    return { ok: false, error: "生成失败: " + (e.message || String(e)) };
  }

  if (result.error) {
    return { ok: false, error: result.error };
  }

  // 处理图片结果
  if (modality === "image" && result.images && result.images.length > 0) {
    var _allImages = [];
    for (var _ii = 0; _ii < result.images.length; _ii++) {
      var _cur = result.images[_ii];
      var _curData = _cur.b64 ? "data:image/png;base64," + _cur.b64 : _cur.url;
      _allImages.push({ url: _cur.url || "", data: _curData });
    }
    // _inlineImage 保留首图（兼容截图注入与旧前端单图渲染），_inlineImages 含全部图片
    var imageData = _allImages[0].data;
    log("INFO", "media-gen", "图片生成成功: " + provider.model + " (" + result.images.length + "张)");
    return {
      ok: true,
      content: "已使用 " + provider.model + " 生成" + result.images.length + "张图片。\n\n描述: " + prompt + (refImages.length > 0 ? "\n参考图: " + refImages.length + "张" : ""),
      model: provider.model,
      provider: provider.providerId,
      imageCount: result.images.length,
      imageUrl: _allImages[0].url,
      _inlineImage: imageData,
      _inlineImages: _allImages,
    };
  }

  // 处理视频结果
  if (modality === "video" && result.videos && result.videos.length > 0) {
    var vid = result.videos[0];
    log("INFO", "media-gen", "视频生成成功: " + provider.model + " url=" + (vid.url || "").substring(0, 80));
    return {
      ok: true,
      content: "已使用 " + provider.model + " 生成视频。\n\n描述: " + prompt + (refImages.length > 0 ? "\n参考图: " + refImages.length + "张" : ""),
      model: provider.model,
      provider: provider.providerId,
      videoUrl: vid.url || "",
      _inlineVideo: {
        url: vid.url || "",
        cover: vid.cover || null,
      },
    };
  }

  return { ok: false, error: "生成完成但未获取到结果（图片或视频URL为空）" };
}
