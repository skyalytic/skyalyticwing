---
name: spotify-player
description: "🎵 Spotify播放器 - 控制音乐播放、搜索和播放列表管理"
emoji: 🎵
requires: { bins: ["spotify_player"] }
install: "https://github.com/aome510/spotify-player#installation"
---

# Spotify Player Skill

通过 spotify_player CLI 控制 Spotify 音乐播放，包括播放/暂停/跳过、搜索音乐、创建播放列表和获取推荐。

## 使用场景

- 播放、暂停、跳过音乐
- 搜索歌曲、专辑、艺术家
- 创建和管理播放列表
- 获取个性化音乐推荐
- 查看当前播放状态

## 前置要求

- 需要安装 spotify_player 或 spotify-tui CLI
- 需要 Spotify Premium 账户
- 首次使用需通过浏览器授权 OAuth
- 配置文件位于 `~/.config/spotify-player/app.toml`

## 命令

### spotify_play

播放音乐。

- `uri` (可选): Spotify URI（如 "spotify:track:xxx"）
- `context` (可选): 播放上下文 URI（专辑/播放列表）
- `device` (可选): 播放设备 ID
- `shuffle` (可选): 是否随机播放，默认 false

### spotify_pause

暂停当前播放。

- 无参数

### spotify_next

跳到下一首。

- 无参数

### spotify_search

搜索 Spotify 内容。

- `query` (必填): 搜索关键词
- `type` (可选): 搜索类型，"track"（默认）、"album"、"artist"、"playlist"
- `limit` (可选): 返回数量，默认 20
- `market` (可选): 市场/地区代码，如 "CN"

### spotify_playlist_create

创建新的播放列表。

- `name` (必填): 播放列表名称
- `description` (可选): 描述
- `public` (可选): 是否公开，默认 false
- `tracks` (可选): 初始曲目 URI 列表

### spotify_recommend

获取音乐推荐。

- `seed_artists` (可选): 种子艺术家 ID（最多5个种子总计）
- `seed_tracks` (可选): 种子曲目 ID
- `seed_genres` (可选): 种子流派，如 "pop,rock,jazz"
- `limit` (可选): 返回数量，默认 20
- `target_tempo` (可选): 目标节拍 BPM
- `target_energy` (可选): 目标能量值 0-1

## 示例

```
用户: 播放周杰伦的歌
执行: spotify_search({ query: "周杰伦", type: "track", limit: 5 })
执行: spotify_play({ uri: "spotify:track:xxx" })

用户: 暂停音乐
执行: spotify_pause()

用户: 下一首
执行: spotify_next()

用户: 搜索"Bohemian Rhapsody"
执行: spotify_search({ query: "Bohemian Rhapsody", type: "track" })

用户: 创建一个"工作专注"播放列表
执行: spotify_playlist_create({ name: "工作专注", description: "专注工作时听的纯音乐" })

用户: 推荐一些轻音乐
执行: spotify_recommend({ seed_genres: "classical,ambient", target_energy: 0.3, limit: 10 })
```

## 注意事项

- 需要 Spotify Premium 账户才能使用播放控制
- OAuth 授权令牌会过期，需定期重新授权
- 搜索和推荐 API 有请求频率限制
- 播放操作需要至少一个活跃的 Spotify 设备
- 部分功能可能因地区限制不可用
