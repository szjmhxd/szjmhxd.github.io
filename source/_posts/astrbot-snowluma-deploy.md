---
title: 放弃 QQ 官方机器人：用 SnowLuma + AstrBot 自建 QQ 机器人
date: 2026-11-02 13:50:00
updated: 2026-11-02 13:50:00
categories:
  - 折腾记录
tags:
  - AstrBot
  - SnowLuma
  - QQ机器人
  - OneBot
  - Docker
description: QQ 官方机器人对个人开发者限制太多，NapCat 又有封号风险，最终迁移到 SnowLuma + AstrBot。记录迁移动机、部署过程，以及官方文档没讲清的三件事。
cover: cover.svg
top_img: banner.svg
abbrlink: e421246e
---

## 一、为什么要换掉官方机器人

起点是 QQ 官方机器人。用了几个月，三个问题绕不过去：

**1. 能力按开发者类型分级。** 个人认证开发者有一大批接口直接不给，界面上只留一句话：

{% asset_img qq-official-grayscale.png 个人认证开发者功能灰度中 %}

**2. 好友私聊不可用，群聊也受限。** 官方机器人的定位是"频道/群内的服务号"，不是"一个能跟你私聊的号"。想把它当普通好友来用，做不到。

**3. 卡片消息在 TIM 上直接失效。** 这条最影响体验 —— 机器人返回的卡片类消息，手机 QQ 上还能看，TIM 桌面端就变成一串占位：

{% asset_img qq-official-unsupported-card.png TIM 无法显示卡片消息 %}

一句话：官方机器人是**给企业做服务入口**的产品，不是给个人做"AI 群友"的工具。目标不一致，越用越别扭。

## 二、为什么是 SnowLuma，而不是 NapCat

自建路线的主流方案是 NapCat 这类协议端。问题是我之前用 NapCat 吃过封号，账号是有成本的，不敢再赌一次。

SnowLuma 的路子和 NapCat 不同：它不是重新实现 QQ 协议，而是**在容器里跑一个真实的 QQ 客户端，再用 `ptrace` 把 hook 注入进去**。对腾讯侧来说，这就是一个正常的客户端在跑。

社区反馈普遍是"比 NapCat 稳"，我实际用下来也没出现异常掉线。但必须说清楚：**这仍然是第三方注入，没有任何人给你安全承诺，风险自负。别拿主号玩。**

真正让我决定切换的是两个细节：

- 自带 noVNC，扫码登录直接在浏览器里完成，不需要本地装 QQ
- 有完整的 OneBot v11 实现，AstrBot、NoneBot 这类框架都能直接接

## 三、架构：两半，加一个方向

{% asset_img astrbot-snowluma-arch.svg AstrBot + SnowLuma 架构图 %}

- **SnowLuma** 负责 QQ 接入，把客户端包装成 OneBot v11 接口
- **AstrBot** 负责对话，调模型、跑插件、管人设
- 两者之间用 WebSocket 连

数据流：`QQ ← 进程注入 ← SnowLuma ←WS→ AstrBot → 大模型 API`

端口分工：

| 端口 | 归属 | 用途 | 是否映射到宿主机 |
|---|---|---|---|
| 6185 | AstrBot | WebUI 管理面板 | 是 |
| 6199 | AstrBot | OneBot v11 反向 WS 服务端 | **否**（走 docker 内网） |
| 6081 | SnowLuma | noVNC 远程桌面，扫码登录用 | 是 |
| 5099 | SnowLuma | SnowLuma WebUI | 是 |
| 3000 / 3001 | SnowLuma | OneBot HTTP / WS 服务端 | **否**（本方案用不到） |

注意最后一行：SnowLuma 自带的 3000/3001 在这套方案里**完全不需要暴露**，少开两个口就是少两个入口。

## 四、官方文档没讲清的三件事

这一节是本文的核心。SnowLuma 的 Docker 部署文档写得很规范，但它只覆盖了"SnowLuma 自己对外提供 OneBot 服务"这一种用法。接 AstrBot 需要的信息，三处都缺。

### 1. 文档只讲它当服务端，没讲它能当客户端

文档的端口表很明确：容器内 `3000` 是 OneBot HTTP、`3001` 是 OneBot WebSocket，compose 示例也默认映射这两个。

很自然就会想：既然 SnowLuma 有 WS 服务端，那就让 AstrBot 去连 `ws://snowluma:3001`。

**这条路走不通。** AstrBot 的 OneBot v11 适配器（`aiocqhttp`）在设计上就是一个**反向 WebSocket 服务端**，没有主动外连的能力 —— 它的配置项只有「反向 WebSocket 主机 / 端口 / Token」，根本没有"填写对端地址"的字段。

而 SnowLuma 的 docker 文档里，**一次都没有提到 `wsClients`**（反向 WS 客户端）。这个能力只出现在 WebUI 的「OneBot 协议端点 → WS 客户端」页，以及 `config/onebot_<uin>.json` 的字段里。

正确的方向恰好是反的：

```
❌ AstrBot(客户端) ──连接──> SnowLuma:3001(WS 服务端)
✅ SnowLuma(WS 客户端，出站) ──> AstrBot:6199/ws(WS 服务端)
```

**判断依据只有一条：看哪一端有"填写对方地址"的输入框，哪一端就是客户端。** 别看到"服务端"三个字就默认它是被连的一方。

### 2. 文档让你手改 JSON，其实 WebUI 里有现成入口

文档给出的修改方式是：

```bash
docker exec -it snowluma bash -c "vi /app/data/config/onebot_<uin>.json"
docker restart snowluma
```

照着改也能成，但这是**绕远路**，而且有三个额外风险：

- JSON 少一个逗号，整份配置失效，容器起来了但 OneBot 不工作
- 文件是 0600 权限、属主是容器内的 `node`，用 root 随手编辑会把属主改掉
- 配置是 `"mode": "overlay"`，账号级文件 `onebot_<uin>.json` 会覆盖基础文件 `onebot.json`，改错文件等于白改

实际上 WebUI 里早就有图形界面：**OneBot 协议端点 → WS 客户端 → 新建 WS 客户端**，填 URL、Token、消息格式，点保存即可，应用自己落盘。

**结论：所有 OneBot 侧配置优先走 WebUI，改文件只作为兜底。**

### 3. 两个容器怎么互通，文档完全没涉及

AstrBot 和 SnowLuma 是两份独立的 compose，各自创建了独立的 bridge 网络，**互相不认识**。文档默认读者自己会处理这一层，但这是最容易卡住的地方 —— 两边配置都对，就是连不上。

解法是自己建一个共享网络，把两个运行中的容器接进去，见第六节。

## 五、部署

### AstrBot

已有环境，从简。关键一点：**`6199` 不要写进 `ports`**，交给 docker 网络解决。

```yaml
services:
  astrbot:
    image: astrbot-pw:local
    container_name: astrbot
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    ports:
      - "6185:6185"
    environment:
      - TZ=Asia/Shanghai
    volumes:
      - /vol1/1000/docker/astrbot/data:/AstrBot/data
```

### SnowLuma

```yaml
services:
  snowluma:
    image: motricseven7/snowluma:latest
    container_name: snowluma
    restart: unless-stopped

    shm_size: 1gb
    ulimits:
      nofile:
        soft: 65536
        hard: 1048576

    cap_add:
      - SYS_PTRACE
    security_opt:
      - seccomp=unconfined

    environment:
      TZ: Asia/Shanghai
      VNC_PASSWD: ${VNC_PASSWD}
      SNOWLUMA_UID: 1000
      SNOWLUMA_GID: 1000
      SNOWLUMA_WEBUI_HOST: 0.0.0.0
      SNOWLUMA_WEBUI_PORT: 5099
      SNOWLUMA_HOOK_AUTOLOAD: 1

    ports:
      - "6081:6081"
      - "5099:5099"

    volumes:
      - /vol1/1000/docker/snowluma/data:/app/data
      - /vol1/1000/docker/snowluma/config:/app/.config
      - /vol1/1000/docker/snowluma/share:/app/.local/share
```

四个参数不能省：

| 参数 | 作用 | 省了会怎样 |
|---|---|---|
| `cap_add: SYS_PTRACE` | hook 依赖 ptrace 注入 QQ 进程 | 挂不上，QQ 在跑但收不到消息 |
| `security_opt: seccomp=unconfined` | 默认 seccomp 会拦 ptrace | 同上 |
| `shm_size: 1gb` | QQ 基于 Chromium，依赖 `/dev/shm` | QQ 启动几秒后随机崩 |
| `SNOWLUMA_HOOK_AUTOLOAD: 1` | 扫码后自动加载 hook | 每次都要去 WebUI 手动 Load |

启动后先验证注入能力，别急着扫码：

```bash
docker exec snowluma getcap /usr/local/bin/node
# 期望包含 cap_sys_ptrace=ep
```

### 扫码登录

`http://<NAS_IP>:6081/`，密码即 compose 里的 `VNC_PASSWD`。远程桌面里 QQ 已自动启动，直接扫码。

然后开 `http://<NAS_IP>:5099/`，首次凭据在日志里：

```bash
docker logs snowluma 2>&1 | grep -E "initial credentials" | tail -1
```

这密码只显示一次，进去先同意 EULA，立刻改掉。

注入成功的日志长这样：

```
[preload] succeeded. /opt/QQ/resources/app/major.node
[Hook] pipe connected: PID=86
```

## 六、组网：把两个容器接进同一个网络

```bash
docker network create botnet
docker network connect botnet astrbot
docker network connect botnet snowluma

docker network inspect botnet | grep -E '"Name"|"IPv4Address"'
```

应该看到两者在同一网段：

```
"Name": "astrbot",   "IPv4Address": "172.25.0.2/16"
"Name": "snowluma",  "IPv4Address": "172.25.0.3/16"
```

**先验证网络层，再动配置：**

```bash
docker exec snowluma node -e "require('net').connect(6199,'astrbot').on('connect',()=>{console.log('6199 OK');process.exit(0)}).on('error',e=>{console.log('FAIL',e.code);process.exit(1)})"
```

输出 `6199 OK` 才继续。这一步能提前排除绝大多数"配置都对但连不上"的情况。

## 七、两端配置

### AstrBot 侧

WebUI（6185）→ 机器人 → 创建机器人 → OneBot v11：

| 字段 | 值 |
|---|---|
| 反向 WebSocket 主机 | `0.0.0.0` |
| 反向 WebSocket 端口 | `6199` |
| 反向 WebSocket Token | 一个随机串 |

**主机必须是 `0.0.0.0`。** 填 `127.0.0.1` 时容器只监听 loopback，别的容器连不进来。

### SnowLuma 侧

WebUI（5099）→ OneBot 协议端点 → **WS 客户端** → 新建：

| 字段 | 值 |
|---|---|
| 名称 | `astrbot` |
| URL | `ws://astrbot:6199/ws` |
| Token | 与 AstrBot 侧完全一致 |
| 消息格式 | 数组 |
| 角色 | Universal |

URL 用**容器名**而不是 IP —— 容器重建后 IP 会变，容器名不变。保存后状态应立刻变成 `正常 · 已连接`：

{% asset_img astrbot-snowluma-ws-client.png SnowLuma WS 客户端已连接 %}

## 八、验证

```bash
docker logs --tail 30 astrbot | grep -i aiocqhttp
```

出现这行就通了：

```
[aiocqhttp.aiocqhttp_platform_adapter:107]: aiocqhttp(OneBot v11) 适配器已连接。
```

再用另一个号发条消息，AstrBot 日志会打印事件：

```
[core.event_bus:117]: [default] [snowluma(aiocqhttp)] 昵称/QQ号:消息内容
```

## 九、其他踩过的坑

### 1. `docker compose build` 没有任何输出

compose 文件里**只有 `image:` 没有 `build:` 段**，`build` 是空操作，直接返回 0。真正耗时的是 `docker compose up -d` 在拉镜像（约 2GB）。

另外 `--progress` 是全局 flag，位置不能错：

```bash
docker compose --progress plain build   # 正确
docker compose build --progress=plain   # 会被警告
```

### 2. `.env` 没传上去，密码变空串

```
level=warning msg="The \"VNC_PASSWD\" variable is not set. Defaulting to a blank string."
```

`.env` 是点开头的隐藏文件，`ls` 看不到，复制时容易漏。用 `ls -la` 确认，再用 `docker compose config` 检查变量是否展开。

### 3. `401 Unauthorized` 不是故障

用 curl 探测端口时返回：

```
HTTP/1.1 401
server: hypercorn-h11
```

这是**端口完全正常**的证据。没带 token 被拒绝，说明 TCP 通、HTTP 通、WS 路由也在。判读方式：

| 返回 | 含义 |
|---|---|
| `401` | 服务正常，只是 token 不对 |
| `Connection refused` | 端口没映射到宿主机 |
| 超时 | 被防火墙/安全组拦了 |

### 4. `wsClients` 是空数组

如果 AstrBot 显示 adapter 加载成功但没有"已连接"，先看这一行：

```bash
docker exec snowluma sh -c "cat /app/data/config/onebot*.json"
```

`"wsClients": []` 意味着客户端**压根没建过**，根本没发起连接。这时候查端口，是在查一个不存在的问题。

### 5. 容器里没有 `ss` / `netstat`

两个镜像都是精简版，`sh: 1: ss: not found`。三种替代：

```bash
# ① 宿主机看映射
docker port astrbot

# ② 直接 TCP 探测（AstrBot 是 Python 应用）
docker exec astrbot python -c "import socket;socket.create_connection(('127.0.0.1',6199),3);print('OPEN');s.close()"

# ③ 什么都不装：读 /proc/net/tcp，端口为十六进制
docker exec astrbot sh -c 'grep ":1837" /proc/net/tcp'
```

③ 输出第 4 列是 `0A` 即 LISTEN。常用端口对照：

| 端口 | hex | 端口 | hex |
|---|---|---|---|
| 3000 | `0BB8` | 5099 | `13EB` |
| 3001 | `0BB9` | 6081 | `17C1` |
| 6185 | `1829` | 6199 | `1837` |

### 6. 别照抄网上的教程

踩到两处：

- 某教程的 SnowLuma 卷路径写 `/app/snowluma-data`，**官方文档是 `/app/data`**。照抄的话配置和登录态会存进一个没人读的目录，重启全丢。
- 某教程写 URL 用"`ws://AstrBotDocker网段:6199/ws`"，那只是占位符，不是让你真的填网段。填容器名或具体 IP。

### 7. `docker network connect` 不持久

容器一被重建（`docker compose up -d` 检测到 compose 变化就会重建），手动 connect 的网络连接就丢了，连接器又变回连不上。

要一劳永逸，在 compose 里声明外部网络：

```yaml
networks:
  default:
    name: botnet
    external: true
```

### 8. `Client private-message reporting is unavailable`

```
[QQHook.Runtime] Client private-message reporting is unavailable: PID=86 status=-1 reason=1
```

未登录状态下的正常输出，扫码成功后自行消失。若登录后仍持续出现，说明私聊消息收不到（群消息不受影响），需要核对 SnowLuma 与 QQ 客户端版本是否匹配。

## 十、安全

这套组合的风险点和普通 Web 服务不同：

- **`6081` 等于一台能操作你 QQ 的远程桌面。** 端口一暴露，扫到的人可以直接接管账号。别裸放公网，远程访问套反代加认证，或者走 Tailscale / WireGuard。
- **`6199` 不映射宿主机**，只在 `botnet` 内网可见，比"映射到宿主机"少一层暴露。
- **Token 不要留空**（前提是端口映射过）。留空等于允许任何能连上该端口的人接入。
- **`share` 卷存的是 QQ 登录态**，删了要重新扫码。
- **第三方协议端有封号风险。** 这是这条技术路线的固有成本，不是配置能消除的。别用主号。

## 十一、速查

```bash
# 状态
docker compose ps
docker exec snowluma supervisorctl status
docker exec snowluma getcap /usr/local/bin/node

# 网络
docker network inspect botnet | grep -E '"Name"|"IPv4Address"'
docker exec snowluma node -e "require('net').connect(6199,'astrbot').on('connect',()=>{console.log('OK');process.exit(0)}).on('error',e=>{console.log(e.code);process.exit(1)})"

# 日志
docker logs --tail 50 astrbot  | grep -i aiocqhttp
docker logs --tail 50 snowluma | grep -iE "hook|onebot|ws-client"
```

最终成功的两组日志：

```
snowluma: [OneBot.WS-Client] [astrbot] connected ws://astrbot:6199/ws
astrbot:  aiocqhttp(OneBot v11) 适配器已连接。
```

## 小结

这次迁移真正的成本不在部署，在**信息缺口**：官方文档只覆盖了一半的用法，剩下的部分得靠试错补。

三条经验：

1. **反向 WebSocket 里，"被动方"才是服务端。** 判断客户端看有没有"填对方地址"的输入框，不看功能名。
2. **能用图形界面就别改配置文件。** WebUI 里有的入口，改文件只会多出权限、格式、overlay 覆盖三重风险。
3. **先验证网络层，再动上层配置。** 顺序反了，时间全花在错误的地方。
