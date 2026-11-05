---
name: songsee
description: "🌊 音频可视化 - 生成音频频谱图和波形可视化"
emoji: 🌊
---

# SongSee Skill

生成音频文件的频谱图、波形图和可视化内容。

## 使用场景

- 生成音频频谱图
- 创建波形可视化
- 分析音频特征
- 批量生成音频缩略图

## 前置要求

- 需要安装 ffmpeg 和 Python matplotlib
- `pip install matplotlib numpy`

## 操作步骤

1. **生成频谱图**
   使用 Python 脚本：
   ```python
   import subprocess, numpy as np, matplotlib
   matplotlib.use('Agg')
   import matplotlib.pyplot as plt

   audio_file = "input.mp3"
   wav_file = "temp.wav"
   subprocess.run(["ffmpeg", "-i", audio_file, "-vn", "-ac", "1", wav_file], capture_output=True)

   with open(wav_file, 'rb') as f:
       f.read(44)  # skip WAV header
       data = np.frombuffer(f.read(), dtype=np.int16)

   plt.figure(figsize=(12, 4))
   plt.specgram(data, Fs=44100, NFFT=1024, noverlap=512, cmap='viridis')
   plt.ylabel('Frequency (Hz)')
   plt.xlabel('Time (s)')
   plt.colorbar(label='Intensity (dB)')
   plt.tight_layout()
   plt.savefig('spectrogram.png', dpi=150)
   ```

2. **生成波形图**
   ```python
   plt.figure(figsize=(12, 3))
   plt.plot(data[:44100*10])
   plt.ylabel('Amplitude')
   plt.xlabel('Sample')
   plt.tight_layout()
   plt.savefig('waveform.png', dpi=150)
   ```

3. **获取音频信息**
   ```bash
   ffprobe -v quiet -print_format json -show_format -show_streams "input.mp3"
   ```

## 示例

```
用户: 生成这个音频文件的频谱图
执行: code_execution({ language: "python", code: "频谱图生成脚本" })

用户: 显示音频波形
执行: code_execution({ language: "python", code: "波形图生成脚本" })

用户: 获取音频文件信息
执行: bash({ command: "ffprobe -v quiet -print_format json -show_format 'audio.mp3'" })
```
