# 视频/播客

YouTube、B站、小宇宙播客的字幕和转录。

## B站搜索 (原生工具，零登录)

```
bilibili_search({ keyword: "AI教程", limit: 10 })
```

返回标题/UP主/播放量/BV号/链接。

## YouTube (yt-dlp，需安装)

### 获取视频元数据
```bash
yt-dlp --dump-json "URL"
```

### 下载字幕
```bash
yt-dlp --write-sub --write-auto-sub --sub-lang "zh-Hans,zh,en" --skip-download -o "/tmp/%(id)s" "URL"
# 然后读取 .vtt 文件
```

### 搜索视频
```bash
yt-dlp --dump-json "ytsearch5:query"
```

### 无字幕兜底：Whisper 音频转写
```bash
agent-reach transcribe "https://www.youtube.com/watch?v=VIDEO_ID"
```
需配置: `agent-reach configure groq-key gsk_xxx` (免费, console.groq.com)

## B站完整版 (bili-cli，只读无需登录)

> ⚠️ **不要用 yt-dlp 读 B站**：B站风控已全面 412 拦截 yt-dlp。

```bash
bili video BVxxx              # 视频详情
bili search "query" --type video -n 5
bili hot -n 10                # 热门
bili rank -n 10               # 排行榜
bili audio BVxxx              # 下载音频(配合transcribe转写)

opencli bilibili subtitle BVxxx   # 字幕(需桌面Chrome)
```

> 安装: `pipx install bilibili-cli`

## 小宇宙播客 / Xiaoyuzhou Podcast

```bash
# 转录单集播客(可选 --polish 增强标点)
~/.agent-reach/tools/xiaoyuzhou/transcribe.sh --polish "https://www.xiaoyuzhoufm.com/episode/EPISODE_ID"
```

### 前置要求
1. **ffmpeg**: 系统安装
2. **Groq API Key** (免费): https://console.groq.com/keys
3. **配置 Key**: `agent-reach configure groq-key YOUR_KEY`
4. **首次运行**: `agent-reach install --env=auto` 安装工具

## 选择指南

| 场景 | 推荐工具 |
|-----|---------|
| B站搜索 | `bilibili_search` (原生) |
| B站视频详情/热门 | `bili` CLI (bash) |
| B站字幕 | `opencli bilibili subtitle` |
| YouTube 字幕 | yt-dlp |
| 播客转录 | 小宇宙 transcribe.sh |
| 无字幕音视频 | `agent-reach transcribe` |
