---
name: weather
description: "☔ 天气查询 - 通过wttr.in或OpenWeatherMap获取当前天气、预报和气象信息，支持IP自动定位"
emoji: ☔
---

# Weather Skill

查询全球任意地点的天气信息，包括当前天气、多日预报、气象警报等。支持 IP 自动定位，当用户未指定城市时自动获取用户位置。

## 使用场景

- 查询某城市当前天气状况
- 获取未来几天的天气预报
- 检查出行目的地的天气情况
- 查询特定地区的气象数据（温度、湿度、风速、降水等）
- 用户说"今天天气怎么样"等未指定城市时，自动定位并查询

## 操作步骤

1. **判断用户是否指定了城市**
   - 如果用户明确指定了城市，直接使用 `weather` 工具查询
   - 如果用户未指定城市（如"今天天气怎么样"、"外面冷吗"），先进行 IP 自动定位

2. **IP 自动定位方法**（当用户未指定城市时）
   - 使用 `bash` 工具执行 `curl -s https://ipapi.co/json/` 获取位置信息
   - 如果 ipapi.co 请求失败，尝试 `curl -s https://ipinfo.io/json`
   - 从返回的 JSON 中提取城市名称（`city` 字段）或坐标（`loc` / `latitude,longitude` 字段）
   - 将定位结果作为 `location` 参数传入 `weather` 工具

3. **IP 定位失败时的处理**
   - 如果两个 IP 定位服务均失败，向用户询问所在城市
   - 示例回复："抱歉，无法自动获取您的位置，请告诉我您想查询哪个城市的天气？"

4. 使用 `weather` 工具查询天气信息
5. 参数说明：
   - `location`: 城市名称或坐标（如 "Beijing"、"40.71,-74.01"）。**可不填**，不填时自动通过 IP 定位
   - `days`: 预报天数（1-7），默认1
   - `units`: 单位制 - "metric"（公制，默认）、"imperial"（英制）
6. 解析返回的天气数据并格式化呈现给用户

## 示例

```
用户: 北京今天天气怎么样？
执行: weather({ location: "Beijing", units: "metric" })

用户: 纽约未来3天天气预报
执行: weather({ location: "New York", days: 3, units: "metric" })

用户: 今天天气怎么样？（未指定城市）
步骤1: bash({ command: "curl -s https://ipapi.co/json/" })
步骤2: 从返回结果中提取 city 字段（如 "Shanghai"）
步骤3: weather({ location: "Shanghai", units: "metric" })

用户: 外面冷吗？（未指定城市）
步骤1: bash({ command: "curl -s https://ipapi.co/json/" })
步骤2: 假设定位到 "Guangzhou"
步骤3: weather({ location: "Guangzhou", units: "metric" })
步骤4: 回复: "根据您的位置（广州），当前温度 XX°C，..."

用户: 天气如何？（IP定位失败时）
步骤1: bash({ command: "curl -s https://ipapi.co/json/" }) → 失败
步骤2: bash({ command: "curl -s https://ipinfo.io/json" }) → 失败
步骤3: 回复: "抱歉，无法自动获取您的位置，请告诉我您想查询哪个城市的天气？"
```

## IP 定位返回数据示例

**ipapi.co 返回：**
```json
{
  "city": "Shanghai",
  "region": "Shanghai",
  "country_name": "China",
  "latitude": 31.0449,
  "longitude": 121.4012
}
```

**ipinfo.io 返回：**
```json
{
  "city": "Shanghai",
  "region": "Shanghai",
  "country": "CN",
  "loc": "31.0449,121.4012"
}
```

## 数据源

- **wttr.in**（默认）: 免费开源，无需API密钥
- **OpenWeatherMap**: 需配置 OPENWEATHER_API_KEY 环境变量，提供更详细数据
