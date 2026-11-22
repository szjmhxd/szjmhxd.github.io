# cover-forge —— butterfly 封面/横幅生成器

一条命令，从「文章标题 + 两个图标」生成两张图，并且**在生成时就卡住三个必踩的坑**。

## 为什么需要它

这个博客每篇文章都要两张自绘图：

| | 尺寸 | 用在哪 |
|---|---|---|
| 封面 cover | 630×487 | 首页卡片左侧图框（348×269） |
| 横幅 banner | 1600×400 | 文章页顶部 `#page-header.post-bg`（400px 高） |

这两个数字不是拍脑袋，是从 CSS 反推的。但**知道数字 ≠ 画对**，实际有三个坑：

1. **比例不匹配会被裁**：封面若用 1200×500（2.4:1），放进 348×269（1.294:1）的卡片会被 `object-fit: cover` 裁掉左右各 149px。
2. **横幅两侧 + 底部都有禁区**：`background-size: cover` 在 1280 宽下横向裁 ±160px，2560 宽下纵向裁 ±120px；而主题标题会压在底部，长标题在 1280 下折两行，标题文字上沿抬到 y=214。自绘内容必须全部躲进 `x∈[182,1420] × y<200`。
3. **图标自带 fill 会在深色底上隐形**：很多 SVG（尤其是国内图标站导出的）内层有 `fill="#000000"`，深色封面上一贴就"消失"。

`cover-forge` 把这三条规则写死在代码里，并且会**自动判断标题会不会折行**来选横幅版式。

## 前置

```bash
npm i -g playwright
npx playwright install chromium
```

图标库默认放在 `E:\test\brand-icons\`（可用 `--brand` 覆盖），已收录：

```
autohotkey  hexo  docker  laravel  ubuntu  rustdesk  1panel
astrbot  snowluma  snowflake  wand(魔法棒)  ...
```

缺图标从 simple-icons 官方仓库取：

```bash
curl -o brand-icons/<name>.svg \
  https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/<name>.svg
```

## 快速开始

```bash
cd E:\test\hexo

# 1) 为新文章建骨架（生成 md + 素材目录）
node tools/cover-forge.js --init source/_posts/my-new-post --title "文章标题"

# 2) 生成封面 + 横幅（自动判定版式）
node tools/cover-forge.js "source/_posts/my-new-post" \
  --title "横幅上的短标题" \
  --banner-sub "副标题 · 关键技术点" \
  --main E:/test/brand-icons/docker.svg \
  --theme blue

# 3) 出位图（掘金等平台需要 PNG）
node tools/cover-forge.js "source/_posts/my-new-post" ... --png

# 4) 目检图（原尺寸 / 卡片裁切 / 横幅 三连）
node tools/cover-forge.js "source/_posts/my-new-post" ... --preview E:/tmp/preview

# 5) 多视口碰撞验收（需先 npx hexo server 或已 hexo generate + 本地站）
node tools/cover-forge.js --check "source/_posts/my-new-post"
```

## 参数

### 内容

| 参数 | 说明 |
|---|---|
| `--title <文>` | 横幅主标题，同时作为封面标题默认值 |
| `--banner-title` | 单独指定横幅主标题 |
| `--banner-sub` | 单独指定横幅副标题 |
| `--cover-title` | 单独指定封面大标题 |
| `--cover-sub` | 单独指定封面小标题 |
| `--sub` | 副标题（封面/横幅共用） |
| `--theme <名>` | `blue` `purple` `teal` `green` `orange` `slate` `ink` |
| `--c1 --c2 --accent` | 自定义配色，覆盖 `--theme` |
| `--post-title` | 显式指定用于判定折行的文章标题（默认从同名 md 的 front matter 读） |

### 图标

| 参数 | 说明 |
|---|---|
| `--main <svg>` | 主图标 = 文章主题的官方矢量（默认 `hexo.svg`） |
| `--sub-icon <svg>` | 副图标 = 这篇文章对该主题做了什么（默认 `wand.svg`） |
| `--brand <目录>` | 图标库目录（默认 `source/_posts/../../../../brand-icons`） |

### 输出 / 验收

| 参数 | 说明 |
|---|---|
| `--png` | 额外导出 `cover.png` / `banner.png` |
| `--preview <目录>` | 导出目检图 |
| `--check` | 多视口碰撞验收（要传文章目录） |
| `--url <地址>` | 配 `--check`，默认 `http://127.0.0.1:4000` |
| `--id <abbrlink>` | 配 `--check`，默认从 md 读 |
| `--force-tight` | 强制矮版横幅 |

## 两个图标怎么选

**主图标 = 文章主题的官方矢量。** 讲 Docker 就放 Docker 官方图标，必须是原版，不要自己重画。

**副图标 = 这篇文章对该主题做了什么。** 固定用「魔法棒」，语义是**改造 / 修补 / 自定义**——把官方机器人换成自建、给输入法补一个缺失的能力，都是「改造」。同一语义用同一形状，读者扫一眼首页就知道这类文章属于"折腾记录"。

判断标准：**副图标要选和本文动作对应的形状，而不是"这个项目还有哪些图标没用过"。**

反面例子：曾有一篇写 SnowLuma 的，副图标放了 SnowLuma 的 favicon，被否——理由是「favicon 不是 logo，而且跟这篇文章讲的『放弃官方方案』毫无关系」。

## 版式是怎么定的（全部实测）

### 封面 630×487

| 元素 | 参数 |
|---|---|
| 主图标 | `x=265, y=92, size=175` |
| 副图标 | `x=448, y=180, size=95` |
| 标题竖条 | `rect x=58 y=288 w=6 h=58 rx=3` |
| 主标题 | `text x=82 y=332 font-size=46 bold` |
| 副标题 | `text x=84 y=378 font-size=23` |

约束：图标最低点不得越过 `y=288`（`92+175=267`、`180+95=275`，留 13~21px 呼吸）。

### 横幅 1600×400 的安全框

用 Playwright 量了 1280/1440/1600/1920/2560 五个视口：

| 视口 | `cover` 横向裁 | `cover` 纵向裁 |
|---|---|---|
| 1280 | ±160 | 0 |
| 1440 | ±80 | 0 |
| 1600 | 0 | 0 |
| 1920 | 0 | ±40 |
| 2560 | 0 | ±120 |

主题标题文字上沿（决定下界）：

| 情况 | 图坐标 |
|---|---|
| 单行标题 | y 266 |
| **两行标题（1280 + 长标题）** | **y 214** ← 最严 |

所以安全框是 `x∈[182,1420] × y∈[100,200]`（折行）或 `y∈[100,245]`（单行）。

**关键认知：最严的不是最宽的屏，也不是最窄的屏，而是「窄屏 + 长标题」这个组合。**

两档版式：

| 元素 | 矮版（会折行） | 常规版（始终单行） |
|---|---|---|
| 主图标 | `(1218, 100, 96)` | `(1164, 104, 128)` |
| 副图标 | `(1334, 118, 66)` | `(1312, 126, 88)` |
| 标题竖条 | `x=182 y=110 w=5 h=48` | `x=182 y=112 w=5 h=52` |
| 主标题 | `x=206 y=148 fs=40` | `x=206 y=152 fs=44` |
| 副标题 | `x=208 y=188 fs=20` | `x=208 y=194 fs=21` |

> 坐标是**图标方框的左上角**，不是墨迹边界。`place()` 会把图标等比居中进 `size` 见方的框。

### 折行判定

用真实字体栈复刻 `#post-info` 的盒模型量标题宽度：

```
字体: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue",
      Lato, Roboto, "PingFang SC", "Microsoft YaHei", sans-serif
盒子: max-width 1200px, margin 0 40px, padding 0 30px  → 内容宽 1140px
字号: 35px / 字重 400
```

**宽度 > 1120px 视为折行**（1140 内容宽留 20px 余量）。实测校准：1092px → 单行，1157px → 两行。

## `--check` 在验什么

它把 `banner.svg` 渲染成 1600×400，取每个绘制元素的**真实屏幕框**，再按各视口的 `cover` 映射求交，逐视口报告：

- **重叠**：自绘内容与主题标题文字的交集面积（应恒为 0）
- **出框**：超出视口可见区的像素（应恒为 0）

```
  vw=1280 sc=1.00 offX=160 | 重叠 0px² | 出框 0px
  vw=1440 sc=1.00 offX=80  | 重叠 0px² | 出框 0px
  ...
  ✓ 全部视口通过（0 重叠 / 0 出框）
```

> ⚠️ 实现上必须用 `getBoundingClientRect()`，**不能用 `getBBox()`**：后者返回元素自身坐标系的框，不含祖先 `transform`，图标 path 里的 `0~24` 会被当成画布坐标，得出一整批假警报。

## 发布流程

```bash
# 生成
node tools/cover-forge.js "source/_posts/xxx" --title "..." --theme blue

# 构建 + 验收
npx hexo generate
node tools/cover-forge.js --check "source/_posts/xxx"

# 推送两仓（源码仓 + Pages 仓）
.\deploy.ps1 -Message "新增：xxx"
```

## 已知边界

- **只适用于 butterfly 主题**。换主题，`.post_cover` 的 42%/16.8em、`#page-header` 的 400px 全变，整套数值作废。
- **只适用于「图标 + 双行文字」版式**。要放照片、要放截图，这套模板不够。
- **SVG 里烘焙的文字改不了**。文章标题改名后要重新生成。
- **字体依赖系统**。SVG 写的是 `Microsoft YaHei, PingFang SC, sans-serif`，在没装这些字体的机器（比如 CI）上渲染会 fallback，字宽会变。要跨平台稳定得把文字转 path 或直接截成 PNG。
- **折行阈值是经验值**。含全角标点的标题，浏览器换行点的选择可能让实测宽度偏乐观——阈值取 1120px 而非 1140px 就是为这个留余量。
