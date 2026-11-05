# 社交媒体 & 社区

小红书、Twitter/X、B站、V2EX、Reddit、Facebook、Instagram。

## V2EX (原生工具，无需认证)

```
v2ex_hot({ action: "hot", limit: 20 })              // 热门主题
v2ex_hot({ action: "node", node_name: "python" })   // 节点主题 (python/tech/jobs/qna)
v2ex_hot({ action: "topic", topic_id: 1234567 })    // 主题详情
v2ex_hot({ action: "replies", topic_id: 1234567 })  // 主题回复
v2ex_hot({ action: "member", username: "Livid" })   // 用户信息
```

节点列表: https://www.v2ex.com/planes

## B站搜索 (原生工具，零登录)

```
bilibili_search({ keyword: "AI教程", limit: 10 })
```

返回标题/UP主/播放量/BV号/链接。自动获取cookie。

> B站字幕、热门排行、视频详情等完整功能用 bili-cli:
> ```bash
> bili video BVxxx
> bili hot -n 10
> bili rank -n 10
> opencli bilibili subtitle BVxxx   # 字幕(需桌面Chrome)
> ```

## 小红书 / XiaoHongShu（需登录态，OpenCLI）

```bash
opencli xiaohongshu search "query" -f yaml
opencli xiaohongshu note "NOTE_URL" -f yaml
opencli xiaohongshu comments NOTE_ID -f yaml
opencli xiaohongshu feed -f yaml
opencli xiaohongshu user USER_ID -f yaml
```

> 要求 Chrome 打开且装了 OpenCLI 扩展。报 AUTH_REQUIRED 说明浏览器里没登录小红书。
> **xsec_token 限制**: 不能直接用裸 note_id 去读。先搜索/feed 拿结果，再用结果中的完整 URL/ID 去读。

## Twitter/X (twitter-cli，需Cookie)

```bash
twitter feed -n 20                          # 首页时间线(最稳定)
twitter tweet URL_OR_ID                     # 读取单条推文(含回复)
twitter user-posts @username -n 20          # 用户时间线
twitter user @username                      # 用户资料
twitter search "query" -n 10                # 搜索(可能不稳定)
```

### search 失败时的重试链

1. 直接重试一次：`twitter search "query" -n 10`
2. 换 OpenCLI 备选：`opencli twitter search "query" -f yaml`
3. 改用 `twitter feed` / `twitter user-posts` 等稳定命令绕路

> **认证**: 用 Cookie-Editor 导出后设置环境变量 `TWITTER_AUTH_TOKEN` + `TWITTER_CT0`。
> **IP 风控**: 不要在 VPS/数据中心 IP 上频繁调用，有封号风险。

## Reddit（必须登录态）

**Reddit 没有零配置路径**。

```bash
opencli reddit search "query" -f yaml       # 桌面(复用浏览器登录态)
opencli reddit read POST_ID -f yaml
opencli reddit subreddit LocalLLaMA -f yaml
opencli reddit hot -f yaml

rdt search "query" --limit 10               # 服务器/存量
rdt read POST_ID
```

> 中国大陆访问需代理。

## Facebook（OpenCLI，必须登录态）

```bash
opencli facebook search "query" -f yaml
opencli facebook profile zuck -f yaml
opencli facebook feed --limit 10 -f yaml
opencli facebook groups --limit 20 -f yaml
```

> 要求 Chrome 打开且装了 OpenCLI 扩展，并已登录 facebook.com。

## Instagram（OpenCLI，必须登录态）

```bash
opencli instagram search "query" -f yaml    # 搜用户
opencli instagram profile nasa -f yaml
opencli instagram user nasa --limit 12 -f yaml
opencli instagram explore --limit 20 -f yaml
```

> `instagram search` 是用户搜索；读帖子需先确定 username，再用 `instagram user USERNAME`。
