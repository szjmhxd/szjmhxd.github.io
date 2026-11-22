---
title: KOOK 机器人为什么看不到群友在玩什么
categories:
  - 折腾记录
tags:
  - KOOK
  - AstrBot
  - 插件开发
  - API 排查
description: >-
  想在 KOOK 语音欢迎语里带上「新成员正在玩的游戏」，结果从文档读到实测，一路证明这条路不存在。附两条顺带完成的事：不用 Pillow 纯 Python
  画插件 logo，以及 push 被代理挡住时用 Git Data API 提交。
cover: cover.svg
top_img: banner.svg
abbrlink: 14f6182
date: 2026-10-30 14:46:07
updated: 2026-10-30 14:46:07
---

写 KOOK 语音欢迎插件的时候冒出一个想法：成员进语音频道，机器人合成欢迎语，如果能顺口带一句「他正在玩《英雄联盟》」，这个体验会比干巴巴的「欢迎 xxx」有意思得多。

于是我花了点时间确认这件事到底能不能做。结论是**不能**——但不是查一眼文档就下的判断。这篇记录完整的过程：文档怎么排除、客户端的「在玩」状态从哪来、以及最后怎么用实测把「读不到」这件事钉死。

如果你只是想拿结论：**KOOK 开放平台不向机器人下发任何用户的「正在玩 / 正在听」状态，也没有任何查询他人活动的接口。** 客户端能看到，是因为客户端用的是用户身份加本地进程 hook，与 API 无关。

<!-- more -->

## 0. 先看清「能看见」是谁在报

刚开始想这件事的时候，我先去看了 KOOK 客户端的实际表现：某个用户的个人资料卡上确实写着「正在玩 Warframe」。

但这句话不是服务器算出来的，是**那台 PC 上的 KOOK 客户端**报上去的。整条链路是：

```
游戏进程启动
   ↓
KOOK 客户端（kmhook）扫描本机进程
   ↓
与官方游戏库比对（按 process_name 匹配）
   ↓
命中 → 用「当前登录用户的身份」调上报接口
   ↓
服务器记录，其他客户端可见
```

三个细节能佐证这个链路：

1. `object-game` 里有 `process_name` 和 `product_name` 两个数组，还有 `kmhook_admin`（是否以管理员权限启动 KOOK）。前两个是给客户端做本地进程匹配用的，最后那个说明部分游戏必须提权才能 hook 到。
2. 客户端设置里有「在个人动态中显示游戏动态」开关，关掉状态立刻消失——因为客户端停止上报了，服务端没数据。
3. 识别不到的游戏需要用户去官方「活动中心」的识别频道提交，官方把游戏加进游戏库后才会被识别。这说明是**白名单匹配**，不是通用进程嗅探。

关键点在这里：**上报的身份是用户自己**。接口长这样：

```http
POST /api/v3/game/activity
{
  "id": 12345,
  "data_type": 1
}
```

参数里没有 `user_id`。身份由 token 决定——用谁的 token，就改谁的显示状态。用机器人 token 调，只会让机器人自己显示「正在玩 XXX」。

所以问题变成：机器人有没有**读**的入口？

## 1. 文档里的四个出口，全堵

把开放平台翻了一遍，所有可能携带活动状态的入口只有四类。

**User 对象**（`/user/view`、`/guild/user-list` 返回的那个）：

```
id, username, nickname, identify_num, online, bot, status,
avatar, vip_avatar, mobile_verified, roles
```

没有 Discord 那种 `presence.activities`。只有 `online`（是否在线）和 `status`（在线状态）。

**服务器成员事件**：`joined_guild`、`exited_guild`、`updated_guild_member`、`guild_member_online`、`guild_member_offline`。这些事件带 `online`、`status`、昵称、角色，没有游戏。

**用户事件**：`joined_channel`、`exited_channel`、`user_updated`、`self_joined_guild`、`self_exited_guild`、`message_btn_click`。`user_updated` 只在改用户名和头像时推送，同样没有。

**game 这一整章**：只有 6 个接口——游戏列表、创建、更新、删除、上报活动、结束活动。**其中没有一个用来读取别人的活动**。

到这一步其实可以下结论了。但「文档没写」和「实际没有」是两件事，KOOK 有过文档外字段的先例。所以还有必要实测。

## 2. 不信文档，直接打接口

写了个只读探测脚本，扫描返回体里有没有 `game` / `activity` / `playing` / `music` / `presence` 这类键，同时打印顶层字段清单。

```bash
curl -s "https://www.kookapp.cn/api/v3/user/me" \
  -H "Authorization: Bot $KOOK_BOT_TOKEN"

curl -s "https://www.kookapp.cn/api/v3/guild/user-list?guild_id=$GUILD_ID&page_size=5" \
  -H "Authorization: Bot $KOOK_BOT_TOKEN"

curl -s "https://www.kookapp.cn/api/v3/user/view?user_id=$USER_ID&guild_id=$GUILD_ID" \
  -H "Authorization: Bot $KOOK_BOT_TOKEN"
```

`/user/me` 回来 27 个字段：

```
avatar, banner, bot, bot_status, client_id, id, identify_num, intent,
invited_count, is_sys, is_vip, kpm_vip, mobile, mobile_prefix,
mobile_verified, nickname, official_guest_rank_top1, online, os, roles,
status, tag_info, username, verified, vip_amp, vip_avatar, wealth_level
```

`/user/view` 回来 21 个：

```
active_time, avatar, banner, bot, id, identify_num, is_sys, is_vip,
joined_at, kpm_vip, mobile_verified, nickname, official_guest_rank_top1,
online, os, roles, status, username, vip_amp, vip_avatar, wealth_level
```

三个接口，**没有一个出现活动相关键**。

为了排除「换个参数就能拿到」的可能，又给每个接口叠了几组猜测的开关参数：`with_activity`、`activity`、`include_activity`、`with_game`。五组跑完，返回字段**一字不差**。服务端直接忽略未知参数。

### 最有说服力的是反向证据

`/user/view` 把 `os`（当前连接方式：PC / 手机 / WebSocket）、`wealth_level`、`kpm_vip`、`official_guest_rank_top1` 这种相当冷门的字段都下发给机器人了，**唯独不下发「正在玩 Warframe」**。

一个字段如果是因为遗漏而缺失，冷门字段不会反而齐全。这是**有意的字段隔离**，不是 bug。

另外 `/guild/user-list` 实际返回里还带着 `abbr`、`color`、`is_master` 这些文档里根本没写的字段——说明 KOOK 并不吝啬给机器人多发字段，唯独 activity 被明确排除在外。多给和少给同时存在，只能是主动筛过的。

## 3. OAuth2 能不能绕过去

有人会问：换成用户授权的 OAuth2 呢？

也不行。OAuth2 全部 scope 只有两个：

| scope | 能力 |
|---|---|
| `get_user_info` | 只能读**自己**的基本信息 |
| `get_user_guilds` | 只能读**自己**加入的服务器列表 |

连别人的昵称都读不到。而且 OAuth 模式下 `/user/me` 返回的字段比 bot token 还少，文档原话是「当发生在 OAuth 访问时，仅返回用户基本信息」。

这是官方唯一合法的用户授权通道，能力比 bot 还窄。

## 4. 那功能到底怎么做

三条路，我的推荐顺序就是从上到下。

**一、Steam Web API（首选，也是唯一能拿到真实数据的合法路径）**

`GetPlayerSummaries` 返回的 `gameextrainfo` 就是当前正在玩什么，`personastate` 是在线状态。只要对方用 `/steam 绑定` 把 SteamID 关联到 KOOK 账号，这条路就成立。

两个坑：

- `gameextrainfo` 只在「正在游戏中」才出现，而且受对方隐私设置影响。对方把「游戏详情」设成「仅好友」时，`personastate` 照常返回，`gameextrainfo` 和 `gameid` 会直接消失。**所以不能把它当布尔判断**，否则会把「在玩但看不到游戏名」误判成「不在玩」。
- `personastate` 取值：0 离线 / 1 在线 / 2 忙碌 / 3 离开 / 4 打盹 / 5 想交易 / 6 想游戏。做「刚上线」推送时，不能只比对 `gameid`，还得看 `personastate` 是否从 0 跳变，否则重复进同一款游戏不会触发。

主机平台就得看运气：PSN 要 npsso，Xbox 得靠 OpenXBL 这类第三方，Epic 和 Battle.net 没有公开接口。

**二、用户自报。** 加一条 `/我在玩 守望先锋`，bot 记下来做状态卡或排行榜。数据干净、不违规、还能覆盖主机玩家。缺点是靠自觉。

**三、抓客户端 token 调内部接口。** 技术上做得到——客户端就是这么干的。但路径和签名要从客户端逆向，token 还会轮换，任何一次改版全废；更别说违反用户协议，账号封禁是真实风险，插件也永远上不了市场。

**不做。**

## 5. 顺手做的两件事

同一轮开发里还有两个跟主问题无关、但值得记的细节。

### 5.1 不用 Pillow 画插件 logo

AstrBot 对插件 Logo 的规范是根目录放 `logo.png`（256x256，1:1，注意不是 `.ico`）。可选项，但缺了市场卡片会是空的。这个环境的 PyPI 访问受限，Pillow 连清华镜像都装不上，报 `No matching distribution`。

于是改成纯标准库手工拼 PNG：用 SDF（signed distance field）算每个像素的覆盖率做抗锯齿，再用 `zlib` + `struct` 按 PNG 规范拼字节流。零依赖，改配色常量重跑即可。

顺手写了两个小工具塞进同一个脚本：

- **最小 PNG 解码器**：解析 IHDR / IDAT，`zlib` 解压后反解 filter，Sub / Up / Average / Paeth 四种全支持。
- **双线性缩放**：把 KOOK 官方 favicon 里内嵌的 256×256 PNG 缩到 44px 当右下角徽章——`favicon.ico` 本身是 ICO 容器，需要先按目录项偏移把内嵌 PNG 抽出来。

最终成品：圆角渐变底（靛蓝 → 紫）+ 白色麦克风 + 左右声波弧，右下角一个白色圆底托着的 KOOK 标识。白色圆底是必要的中间层——直接把绿色方块压紫色渐变上会很脏。

### 5.2 push 被代理挡住时，用 Git Data API 提交

发布 1.0.0 时 `git push` 连续失败：

```
error: RPC failed; curl 7 CONNECT tunnel failed, response 502
fatal: the remote end hung up unexpectedly
```

排查下来：本地代理（`127.0.0.1:14835`）对 `github.com:443` 一律 502，但 `api.github.com`、`codeload.github.com` 完全正常。也就是说代理本身能出网，只是 github.com 那条规则或节点挂了。直连也不通。

既然是代理链路的临时故障，那就绕过去——用 GitHub 的 Git Data API 手工把提交送上去：

```
POST /git/blobs     上传文件内容，拿 blob sha
POST /git/trees     以父提交的 tree 为 base，替换这两个条目
POST /git/commits   用原 author / committer 信息建 commit
PATCH /git/refs/heads/main   force: false，只允许快进
```

为了不让本地和远端历史分叉，我刻意逐字节还原 commit 对象，让远端 SHA 与本地**完全相同**。两个坑：

1. **blob 必须取仓库内的规范化内容。** 工作区 `README.md` 是 CRLF，直接读文件上传得到的 blob 是 `44f7aa10`，而仓库内是 `a19feb01`。要用 `git cat-file blob <sha>` 取仓库版本。
2. **message 必须带结尾换行。** 第一次传不带 `\n`，GitHub 生成了 `7ca4b05`；补上换行才得到与本地一致的 `3d08a5f`。

最后补一下本地的 `refs/remotes/origin/main`，`git status` 就显示已对齐，连 `git fetch` 都不用跑。

**不过**——半小时后再试，`git push` 直接成功了。所以这套绕法是应急手段，不是常规方案。真正该做的是去检查代理里 `github.com` 的规则为什么落在一个失效节点上。

## 结语

这次花的时间主要不在写代码，而在**把「做不到」证明到能说服自己**。

顺序很重要：先读文档排除可能性，再看客户端的实际机制理解数据从哪来，最后用实测堵住「文档没写但实际有」的缝隙。三步走完，结论才站得住。

顺带说一句，最后那条反向证据挺有意思：一个接口愿意下发给机器人 `wealth_level` 和 `official_guest_rank_top1`，却死活不给 activity。这已经不能叫遗漏了，这叫设计。
