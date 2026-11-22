---
title: KOOK「找不到语音频道」：同一个错误假设，我犯了三次
categories:
  - 折腾记录
tags:
  - KOOK
  - AstrBot
  - 插件开发
  - API 排查
  - Python
description: >-
  为了「试听时自动找到语音频道」这一件小事，我从 v0.5.6 修到 v0.5.9。三次根因其实是同一个——以为 KOOK
  的接口会返回全量数据。这篇记录三个具体的坑、为什么「文字频道一直好使」把问题掩盖了，以及 43 项桩测试全过、真机全错的教训。
cover: cover.svg
top_img: banner.svg
abbrlink: 6de062a0
date: 2026-10-30 15:10:00
updated: 2026-10-30 15:10:00
---

我给 KOOK 写了一个语音欢迎插件：成员进语音频道，机器人自动加入，用 TTS 按昵称合成一句欢迎语，播完退出。

功能本身早就跑通了。真正耗掉一天的是另一件看起来更小的事：**在文字频道里发 `/语音欢迎试听`，让它自己找到语音频道**。

这一件事我改了四个版本，每次都觉得「这次肯定对了」。三次根因其实是同一个错误假设——**以为 KOOK 的接口会返回我想要的那部分数据**。

<!-- more -->

## 0. 三个坑，先给结果

如果你只想要结论，这张表就够了：

| 坑 | 你看到的现象 | 真实原因 | 修于 |
|---|---|---|---|
| `/guild/view` 的 `channels` 不含语音频道 | 文字频道解析正常，语音频道「一个都没有」 | 该字段只列文字频道，而代码只在它为空时才去查完整列表——它永远不空 | v0.5.7 |
| `/channel/list` 的 `type` 默认是 1 | 换用完整列表接口，结果还是「没有语音频道」 | `type` 默认 1（文字），不传就只返回文字频道 | v0.5.8 |
| `event.get_group_id()` 给的是频道 ID | 接口报 `code=40000: guild_id 不存在或者你没有权限操作` | KOOK 适配器把频道 ID 塞进了 `group_id`，服务器 ID 在里面根本不存在 | v0.5.9 |

三个坑的共同点：**接口没有报错，它只是给了你一部分数据。** 你在本地按「应该有」的假设做过滤，过滤完是空的，然后你以为服务器里没这个东西。

---

## 1. 起因：先按官方文档做一次规范审查

改这些之前，先做了一件更基础的事：把插件对着 AstrBot 官方插件开发文档逐项体检。

结论不客气：15 项问题，其中 2 项是会出事的那种。

**第一项：用了已废弃的 `@register` 装饰器。** AstrBot 源码里 `register_star` 的 docstring 写着 `[DEPRECATED]`，明说将在未来版本移除。更要紧的是它现在**完全不产生作用**——插件加载顺序是先 import `main.py`（此时 `@register` 写一遍元数据），再用 `metadata.yaml` 逐字段覆盖，源码注释写的是「yaml 文件的元数据优先」。等于花一行代码做了一次无效写入，还给自己埋了个「哪天官方删了导出就 ImportError」的雷。

删掉，改成纯 `metadata.yaml` 声明：

```python
# 之前
from astrbot.api.star import Context, Star, register

@register(PLUGIN_NAME, "szjm", "成员进入 KOOK 语音频道时…", PLUGIN_VERSION)
class KookTtsWelcomePlugin(...):
    ...

# 之后
from astrbot.api.star import Context, Star

class KookTtsWelcomePlugin(...):
    ...
```

**第二项：事件处理器必须写在 `main.py` 里。** 这一条不是风格问题，是静默失效。AstrBot 的 `StarHandlerRegistry` 归集 handler 时用的是精确相等：

```python
handler.handler_module_path == module_name   # 不是 startswith，是 ==
```

`handler_module_path` 取的是函数所在模块。所以 handler 一旦写在 `tts.py` 里，模块路径变成 `xxx.tts`，`star_map` 里没有这个键，handler 会被**静默过滤**——指令不响应、不报错、日志里连痕迹都没有。

我的插件是个 7 层 Mixin 的结构，十几个指令装饰器全在 `main.py` 里才侥幸正常。这种结构最危险的地方不是现在错，而是**下一个来改代码的人自然会想把某个 handler 挪到对应的 Mixin 文件里**，挪完就哑了，还查不出来。

没有重构（把 Mixin 改成组合式服务类的收益远小于没有测试兜底时的风险），但在文件头写了死约束，README 也加了一节。其余的 P1/P2 问题——私有导入、手搓 provider、直连 HTTP 发消息、`create_task` 不保存引用、配置越界静默夹逼——一起处理掉，出了 v0.5.4。

---

## 2. 插曲：指令被拦了，但插件没坏

装上新版本，发第一条管理指令，收到一句：

> 您(ID: 2431745721)的权限不足以使用此指令。通过 /sid 获取 ID 并请管理员添加。

看着像插件报错，其实指令在框架层就被拦了，插件根本没被调用。

AstrBot 的判定链只有三段，我逐段查了源码：

```python
# 1. 事件初始化时的默认值
self.role = "member"

# 2. is_admin() 的全部实现
def is_admin(self):
    return self.role == "admin"

# 3. 唯一把 role 改成 admin 的地方：core/pipeline/waking_check/stage.py
for admin_id in self.ctx.astrbot_config["admins_id"]:
    if str(event.get_sender_id()) == admin_id:
        event.role = "admin"
```

而 KOOK 适配器构造发送者时是这样：

```python
abm.sender = MessageMember(
    user_id=author_id,
    nickname=data.extra.author.username if data.extra.author else "unknown",
)
```

**没有 `role` 参数。** 它在 KOOK 服务器里是服主也好、管理员也好，框架眼里永远是 `member`。只有被登记进全局 `admins_id` 的用户才会被改判。

所以解法是配置，不是代码：把自己的 KOOK UID 加进「访问控制 → 管理员 ID」，纯数字，别写成 `kook:2431745721`。

这件事本身没什么技术含量，但它给了个有用的分界：**报错信息来自哪一层，决定你要去查代码还是查配置。** 为了下次一眼看清，我在 `/语音欢迎` 的状态输出里加了两行自检——「你的权限：管理员 ✓ / 普通成员 ✗」和「你的用户 ID」，加管理员时直接照抄，不用再发一次 `/sid`。这就是 v0.5.5 的全部内容。

---

## 3. 坑一：`/guild/view` 的 channels 里没有语音频道

真正开始修 bug，是在试听这个功能上。

`/语音欢迎试听` 是从**文字频道**发出的指令，事件里没有语音频道上下文，所以它需要一个兜底：服务器里只有一个语音频道，就直接用它。

第一版实现复用了查文字频道的那段逻辑：

```python
guild = await self._api.get_guild(token, guild_id)
channels = guild.get("channels")
...
if not info["channels"]:          # 只有为空才去查完整列表
    info["channels"] = await self._api.get_channels(token, guild_id)
```

结果回复是「这个服务器里没有语音频道」。可服务器里明明有一个叫「语音频道」的。

原因很干脆：`/guild/view` 返回的 `channels` **只包含文字频道**。它不为空（有「文字频道」），所以那句兜底永远不会执行，完整列表接口一次都没被调用过。

更难看的在后面：这个结果被写进了缓存，TTL 3600 秒。**同一个错误答案会在接下来一小时里忠实地重复给你。**

改法是彻底不用它——语音频道一律走 `/channel/list`，独立缓存，`/语音欢迎重载` 时清空。

这里有个值得记的线索：**文字播报从头到尾都正常，因为它要的正好就是文字频道。** 一段代码给 A 用是好使的，把同一段代码给 B 用就坏了——这种不对称本身就是最强的提示，说明问题在「这段代码假设了什么」，而不是「B 不存在」。

---

## 4. 坑二：`/channel/list` 的 `type` 默认是 1

换成 `/channel/list` 之后，回复变成了「接口正常但没有语音频道」。

于是我第一次去认真读 KOOK 的接口文档，参数表是这样的：

| 参数 | 必填 | 说明 |
|---|---|---|
| `guild_id` | 是 | 服务器 id |
| `type` | 否 | 频道类型，`1` 为文字，`2` 为语音，**默认为 `1`** |

最后那个「默认为 1」就是答案。我这样调用：

```python
await self.request("GET", "/channel/list", token,
                   params={"guild_id": guild_id})   # 没有 type
```

拿回来的只有文字频道。再按 `type == 2` 过滤，结果必然是空列表。接口没报错，它严格按默认值执行了。

修法两句话：查语音频道**显式传** `type=2`；顺手把分页补上（返回里带 `meta.page_total`，默认每页 50 条，原来只取第一页，频道多了会静默截断）。

```python
async def get_channels(self, token, guild_id, channel_type=None,
                       page_size=50, max_pages=5):
    """⚠️ /channel/list 的 type 默认是 1（文字频道）。
    不传 type 只会拿回文字频道，语音频道永远查不到。
    """
```

顺手把这段坑写进了 docstring。注释不是写给现在的自己看的，是写给三个月后那个又一次想当然的人看的。

---

## 5. 坑三：`get_group_id()` 给的是频道 ID，不是服务器 ID

前两个坑修完，回复变成了：

> 未指定（查询频道列表失败：KOOK 接口 /channel/list 调用失败（code=40000）：guild_id 不存在或者你没有权限操作）

`40000` 是好东西——它说明这次不是默认值问题，是我传了一个**根本不属于这个参数的 ID**。

去翻 AstrBot 的 KOOK 适配器，`convert_message` 里是这样：

```python
case KookChannelType.GROUP:
    session_id = data.target_id or "unknown"      # target_id = 频道 ID
    abm.type = MessageType.GROUP_MESSAGE
    abm.group = Group(
        group_id=session_id,                      # ← 频道 ID 塞进了 group_id
        group_name=data.extra.channel_name or None,
    )
    abm.session_id = session_id
```

而我的代码写的是：

```python
guild_id = str(getattr(event, "get_group_id", lambda: "")() or "")
```

`group_id` 里装的是 `5787454453386653`（频道），我把它当 `1005678330577681`（服务器）用。拿频道 ID 去查 `guild_id`，KOOK 只能回你「不存在或没权限」。

**连带还有一个更隐蔽的 bug。** `/语音欢迎目标频道` 绑定时走的是另一条路径（能从频道反推真实服务器 ID），存进去的是对的 ID；但试听时用 `_target_channel_for(频道ID)` 去查，永远查不到。也就是说**手动绑定目标频道也一直是失效的**，只是没人发现——因为自动识别刚好在前一个版本被修好了，把这个问题盖住了。

修法：先 `/channel/view` 从当前文字频道反推 `guild_id`，再拿它去查列表。

```python
channel = await self._api.get_channel(token, text_channel_id)
resolved = to_text(channel.get("guild_id"))
```

顺带发现 `/channel/view` 的参数名也写错了：文档要求 `target_id`，我写的是 `channel_id`。改成 `target_id` 优先、失败退回旧写法。

然后是兜底链，任一环成功就停：

1. `/channel/view(当前文字频道)` → 反推真实 `guild_id` → `/channel/list?type=2`
2. 调用方传进来的 `guild_id`（万一它本来就是对的）
3. `/guild/list`——机器人已加入的服务器，只有一个就直接用
4. `/channel/list` 失败时退回 `/guild/view` 的 `channels` 过滤 `type == 2`
5. 本次会话里**最近一次真实事件**用过的语音频道

第 5 条听着像作弊，但它恰恰最可靠：真实进房事件的语音频道 ID 来自网关事件本身，不查任何接口。只要之前有人进过语音频道，这条一定命中。

另外把「异常吞掉返回空列表」这个写法也删了。原来的 `_list_voice_channels` 出错就 `return []`，于是「Token 失效」「网络异常」「权限不足」「服务器真的没有语音频道」在回复里长得一模一样——**这正是我被误导两次的直接原因**。现在异常向上抛，回复里带原始错误码。

这一版是 v0.5.9。装上去，试听出声了。

---

## 6. 43 项桩测试全过，真机全错

这条最值得写，因为它是这次唯一让我改变工作方式的教训。

AstrBot 没装在这台机器上，所以我用桩（stub）模块顶替 `astrbot.*`，写了个冒烟测试，覆盖指令参数剥离、配置夹逼告警、后台任务登记与回收、TTS Provider 取值、框架发送的三条路径（成功 / 返回 False / 抛异常）、HTTP 回退、事件解析、`initialize` → `terminate` 往返。

随着每个 bug 出现，我加一条回归用例。数量是这么长的：

| 阶段 | 用例数 | 结果 |
|---|---|---|
| v0.5.4 规范整改后 | 25 | 全过 |
| v0.5.6 自动选频道 | 30 | 全过 |
| v0.5.7 改走 `/channel/list` | 32 | 全过 |
| v0.5.8 补 `type=2` 与分页 | 36 | 全过 |
| v0.5.9 反推 guild_id | 43 | 全过 |

**每一次都是全过，每一次真机都是错的。**

原因不难想，但当时确实没意识到：桩模块把我的假设一起 stub 掉了。我假设 `/channel/list` 返回全部频道，我的假接口就返回全部频道；我假设 `get_group_id()` 是服务器 ID，我的假事件就给它一个服务器 ID。测试验证的是「我的逻辑在我的世界观里自洽」——而 bug 全部长在「我的世界观」本身。

所以桩测试的边界要说清楚：

- 它能验证：分支覆盖、时序、异常路径、状态机、卸载是否干净。这些确实抓到了 `create_task` 不保存引用、`terminate` 漏取消之类的问题。
- 它不能验证：**你对外部世界的契约理解对不对**。接口的默认值、字段的真实含义、ID 到底是哪个 ID —— 这些只能来自文档和真机。

反过来，如果这个插件有真机集成测试（起一个 KOOK 沙箱服务器，发真请求），三个坑会在半小时内暴露。成本高，但对着「摸黑连修四版」的代价，未必不划算。

---

## 7. 收尾：tag、Release，和一次小的自我校验

功能通了的当天就打标签发版。

这个仓库此前**一个 tag 都没有**，所以 v0.5.9 是第一个：

```bash
git tag -a v0.5.9 -m "规范整改 + KOOK 语音频道解析修复"
git push origin v0.5.9

gh release create v0.5.9 ../astrbot_plugin_kook_tts_welcome_v0.5.9.zip \
  --title "v0.5.9 — 规范整改 + KOOK 语音频道解析修复" \
  --notes-file ../_release_notes_v0.5.9.md \
  --latest
```

上传资产前做了一件事：**把 zip 里每个文件和当前工作树逐文件比对 sha256**。

```python
for name in zipfile.ZipFile(zip_path).namelist():
    assert sha256(zf.read(name)) == sha256(Path(name).read_bytes())
```

理由很简单：在这之前我已经连续打过好几个 zip，很容易把 v0.5.8 的包挂到 v0.5.9 的 Release 上——版本号在文件名里，内容在包里，两者不一致的时候没有任何东西会报警，除了你自己比一遍。

现在插件在 v1.0.0（只是加了 logo、升了版本号，功能冻结，从 v0.5.9 升级不用改任何配置），两个 Release 都在：

- https://github.com/szjmhxd/astrbot_plugin_kook_tts_welcome

---

## 8. 四条能直接拿去用的

**一、接口文档里最贵的字是「默认值」。** 参数表里那个「默认为 1」我读过两遍都没看见，因为我在找「支持什么」，没在找「不给会怎样」。凡是带 `type`、`page`、`state` 这类枚举或分页参数的接口，都要主动问一句：不传的时候它给我什么？

**二、一个能力好用一个不好用，先比代码差异。** 文字频道一直正常、语音频道一直为空，这两个功能在同一段代码里——不对称不是巧合，它就是线索。它精确地指出了「这段代码假设了什么」。

**三、错误信息必须能区分「没有数据」和「查不到数据」。** 我把异常吞成 `[]`，让四种完全不同的故障显示成同一句话，代价是自己被误导两个版本。宁可让用户看到 `code=40000`，也不要给他一句体面但没用的「没有语音频道」。

**四、ID 的语义要写进代码注释，不能只活在你脑子里。** `group_id` 在 KOOK 下就是频道 ID，`session_id` 也是频道 ID，服务器 ID 只能从 `/channel/view.guild_id`、网关事件的 `extra.guild_id` 或 `/guild/list` 拿。这件事我在 v0.5.1 已经因为「把频道 ID 填进目标服务器」踩过一次，然后在 v0.5.9 用另一种形式又踩了一次——同一个概念错误，两次都是因为没把它写进代码里。
