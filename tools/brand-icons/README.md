# brand-icons —— 封面图标的取材清单

封面上的图标只有两类来源，没有第三种：

1. **官方 logo 矢量**（优先）：品牌官网 / 项目仓库里的原始 SVG。
2. **线条图标兜底**：主题不是某个品牌（比如"修好 Windows Update""把封面规则写下来"），
   或者该品牌确实拿不到矢量，就用 [Lucide](https://github.com/lucide-icons/lucide)（ISC 许可）的图标。

`ui-` 前缀的是 Lucide，没有前缀的是品牌 logo。这个前缀不是装饰 —— 渲染方式不同：
品牌 logo 是填充图形，Lucide 是 `fill="none"` + `stroke` 的线条图，`cover-forge` 靠根节点属性
判断，线条图会走描边模式（`stroke` 取配色里的白/强调色），否则描边会被吃掉、只剩一堆糊住的碎块。

## 品牌 logo

| 文件 | 品牌 | 官方主色 | 来源 |
| --- | --- | --- | --- |
| `autohotkey.svg` | AutoHotkey | `#B7B7B7` 金属灰 | 官网 <https://www.autohotkey.com/> 的 `ahk_logo_no_text.svg` 同图，Simple Icons 路径 |
| `hexo.svg` | Hexo | `#0E83CD` | 官网 <https://hexo.io/logo.svg> |
| `ubuntu.svg` | Ubuntu | `#E95420` | Simple Icons |
| `docker.svg` | Docker | `#2496ED` | Simple Icons |
| `laravel.svg` | Laravel | `#FF2D20` | Simple Icons |
| `1panel.svg` | 1Panel | `#1BAF6C` 系 | Simple Icons |
| `deepseek.svg` | DeepSeek | `#4D6BFE` | Simple Icons |
| `rustdesk.svg` | RustDesk | `#024F91` 系 | Simple Icons |
| `astrbot.svg` | AstrBot | `#2F86BD` 系 | 官方 512 视口 logo |
| `snowluma.svg` | SnowLuma | `#7E14FF` | 项目自带图标 |
| `kook.svg` | KOOK | `#87EB00` | 官方 1024px 图标 <https://img.kookapp.cn/assets/logo_1024.png>，转 256px PNG 内嵌 |
| `windows.svg` | Windows | `#0078D4` | 透视四方块，按官方标志比例手绘 |
| `windows11.svg` | Windows 11 | `#0078D4` | 四个等大平板方块，即 Win11 标志本身 |

`kook.svg` 是这批里唯一的位图：KOOK 官网、开放平台、文档站都只给 PNG/ICO，
没有可用的 SVG 路径；`logo_1024.png` 是能找到的最高清官方件，缩到 256px 后 3 KB，
175px 显示尺寸下不会糊。哪天官方放矢量了直接替换同名文件即可。

## 线条图标（Lucide，ISC）

`ui-bot` `ui-calculator` `ui-cloud-sun` `ui-folder-symlink` `ui-git-branch` `ui-mic`
`ui-mouse` `ui-panel-top` `ui-rotate-ccw` `ui-share-2` `ui-wand-sparkles`

取用规则：副图标回答"这篇文章对主题做了什么"，所以优先动词类图标（修好、分享、迁移、量一量），
不要拿第二个品牌 logo 凑数 —— 一张封面只允许有一个视觉主角。

## 加新图标

1. 先找官方 SVG（官网 `<link rel="icon">`、`/logo.svg`、项目仓库根目录、Simple Icons）。
2. 找不到再在 [iconfont](https://www.iconfont.cn/) 或 Lucide 里挑一个同语义的。
3. 品牌 logo 命名就是品牌名；第三方线条图标一律加 `ui-` 前缀。
4. 主色写进本文表格，同时写进 `tools/gen-all-covers.js` 的 `brand` 字段 —— 别让下一个人靠肉眼估色。

多色 logo（KOOK、SnowLuma 这类自带底色的）在封面里用 `--keep-colors-main` 保留原色，
并要求底色有足够对比；单色 logo 一律由配色引擎统一上色，避免"一个封面里三套颜色"。
