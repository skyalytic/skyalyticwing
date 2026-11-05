---
name: openhue
description: "💡 Philips Hue - 智能家居灯光控制"
emoji: 💡
requires: { env: ["HUE_BRIDGE_IP", "HUE_API_KEY"] }
install: "https://developers.meethue.com/develop/get-started-2/"
---

# OpenHue Skill

通过 Philips Hue Bridge API 控制智能家居灯光，包括灯光控制、场景管理、分组控制和传感器读取。

## 使用场景

- 开关和调节灯光亮度、颜色
- 激活预设场景
- 按房间/分组控制灯光
- 读取传感器数据（温度、光照等）
- 创建自动化灯光方案

## 前置要求

- 需要配置 `HUE_BRIDGE_IP` 环境变量（Hue Bridge 的 IP 地址）
- 需要配置 `HUE_API_KEY` 环境变量（Hue Bridge 的用户名/API密钥）
- Hue Bridge 需要与控制设备在同一网络
- 首次使用需在 Bridge 上按按钮完成配对获取 API Key

## 命令

### hue_list_lights

列出所有灯光及其状态。

- `filter` (可选): 筛选条件，"all"、"on"（仅开启的）、"off"（仅关闭的）
- `group` (可选): 按分组筛选

### hue_set_light

设置灯光属性。

- `light_id` (必填): 灯光 ID（可以是逗号分隔的多个 ID）
- `on` (可选): 开关状态，true/false
- `brightness` (可选): 亮度，0-254
- `hue` (可选): 色调，0-65535
- `saturation` (可选): 饱和度，0-254
- `color_temp` (可选): 色温，153-500（单位：mired）
- `xy` (可选): CIE xy 色彩坐标，如 [0.3, 0.3]
- `transition` (可选): 过渡时间（秒），默认 0.4
- `alert` (可选): 闪烁模式，"none"、"select"、"lselect"

### hue_list_scenes

列出所有可用场景。

- `group` (可选): 按分组筛选场景

### hue_activate_scene

激活指定场景。

- `scene_id` (必填): 场景 ID
- `group` (可选): 应用到的分组
- `transition` (可选): 过渡时间（秒），默认 1

### hue_list_groups

列出所有灯光分组。

- 无参数

### hue_set_group

设置分组灯光属性。

- `group_id` (必填): 分组 ID
- `on` (可选): 开关状态
- `brightness` (可选): 亮度，0-254
- `color_temp` (可选): 色温
- `scene` (可选): 应用场景 ID
- `transition` (可选): 过渡时间（秒）

## 示例

```
用户: 列出所有灯光
执行: hue_list_lights()

用户: 打开客厅灯并设置暖光
执行: hue_set_light({ light_id: "1", on: true, color_temp: 350, brightness: 200 })

用户: 关闭所有灯光
执行: hue_set_group({ group_id: "0", on: false })

用户: 激活"日落"场景
执行: hue_activate_scene({ scene_id: "scene_xxx" })

用户: 列出所有分组
执行: hue_list_groups()

用户: 把卧室灯光调暗到30%
执行: hue_set_group({ group_id: "2", brightness: 76, transition: 2 })
```

## 注意事项

- Bridge IP 可能因路由器 DHCP 变化，建议设置静态 IP
- 亮度值 0-254，不是百分比
- 色温单位是 mired（越小越冷，越大越暖）
- 快速频繁切换可能影响灯泡寿命
- 部分灯泡不支持颜色调节，仅支持色温
