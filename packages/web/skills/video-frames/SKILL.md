---
name: video-frames
description: "🎬 视频帧提取 - 从视频中提取帧、片段和元数据"
emoji: 🎬
---

# Video Frames Skill

使用 ffmpeg 从视频中提取帧、片段，获取视频元数据和缩略图。

## 使用场景

- 从视频提取关键帧
- 截取视频片段
- 生成视频缩略图
- 获取视频元数据（分辨率、时长、编码等）
- 批量处理视频文件

## 前置要求

- 需要安装 ffmpeg（`winget install ffmpeg` / `apt install ffmpeg` / `brew install ffmpeg`）

## 操作步骤

1. **获取视频信息**
   ```bash
   ffprobe -v quiet -print_format json -show_format -show_streams "video.mp4"
   ```

2. **提取帧**
   ```bash
   ffmpeg -i "video.mp4" -vf "fps=1" output_frame_%04d.png
   ```

3. **截取片段**
   ```bash
   ffmpeg -i "video.mp4" -ss 00:01:30 -to 00:02:00 -c copy clip.mp4
   ```

4. **生成缩略图**
   ```bash
   ffmpeg -i "video.mp4" -vf "thumbnail,scale=320:-1" -frames:v 1 thumb.jpg
   ```

5. **转换格式**
   ```bash
   ffmpeg -i "input.avi" -c:v libx264 -c:a aac output.mp4
   ```

6. **提取音频**
   ```bash
   ffmpeg -i "video.mp4" -vn -c:a libmp3lame audio.mp3
   ```

## 示例

```
用户: 获取这个视频的信息
执行: bash({ command: "ffprobe -v quiet -print_format json -show_format -show_streams 'video.mp4'" })

用户: 从视频中每秒提取一帧
执行: bash({ command: "ffmpeg -i 'video.mp4' -vf 'fps=1' frame_%04d.png" })

用户: 截取视频第2分钟到第3分钟
执行: bash({ command: "ffmpeg -i 'video.mp4' -ss 00:02:00 -to 00:03:00 -c copy clip.mp4" })
```
