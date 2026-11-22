/**
 * 批量生成全部文章的封面 / 横幅。
 *
 * 两条硬规矩：
 *   1. 主图标用文章主题的**官方 logo**（矢量优先），没有官方矢量的才用线条图标兜底；
 *   2. 背景色由主图标的品牌主色推导，不再所有文章共用一个深蓝。
 *
 * 同一个品牌有多篇时（AHK×2、KOOK×2、Hexo×2、Windows×2），色相没法区分，
 * 用 tone 分档：deep 更沉、vivid 更亮，首页连着两张才不会像同一张图。
 *
 * 用法：
 *   node tools/gen-all-covers.js                 全部重生成
 *   node tools/gen-all-covers.js --png           顺带导出 cover.png / banner.png
 *   node tools/gen-all-covers.js --only a,b      只做指定几篇（逗号分隔目录名）
 *   node tools/gen-all-covers.js --dry           只打印要做什么
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const POSTS_DIR = path.join(ROOT, 'source', '_posts');
const FORGE = path.join(__dirname, 'cover-forge.js');
const ICONS = process.env.COVER_ICONS || 'E:/test/brand-icons';

const icon = (name) => path.join(ICONS, name);

/**
 * 每篇文章的配方。
 *
 * brand  主图标的官方品牌色（写死，不猜）
 * tone   同品牌多篇时的明度分档
 * main   主图标：官方 logo > 线条图标
 * sub    副图标：这篇文章对主题做了什么
 */
const POSTS = [
  {
    dir: 'Ubuntu 22.04 Samba 共享配置与踩坑实录',
    coverTitle: 'Samba 共享',
    coverSub: 'Ubuntu 22.04 · 共享配置踩坑',
    main: 'ubuntu.svg', sub: 'ui-share-2.svg',
    brand: '#E95420', tone: 'normal',
  },
  {
    dir: 'Windows更新无法使用-CBS服务栈损坏修复',
    coverTitle: 'CBS 服务栈修复',
    coverSub: 'Windows Update 彻底失效',
    main: 'windows.svg', sub: 'ui-rotate-ccw.svg',
    brand: '#0078D4', tone: 'vivid',
  },
  {
    dir: 'astrbot-plugin-qweather',
    coverTitle: 'AstrBot 天气插件',
    coverSub: '和风天气 · Python · 12 次提交',
    main: 'astrbot.svg', sub: 'ui-cloud-sun.svg',
    brand: '#2F86BD', tone: 'deep',
  },
  {
    dir: 'astrbot-snowluma-deploy',
    coverTitle: 'SnowLuma + AstrBot',
    coverSub: '放弃官方机器人 · 自建 QQ 机器人',
    main: 'snowluma.svg', sub: 'astrbot.svg',
    brand: '#7E14FF', tone: 'vivid',
  },
  {
    dir: 'blog-cover-design-guide',
    coverTitle: '封面生成规则',
    coverSub: '630×487 是怎么算出来的',
    bannerSub: '630×487 与 1600×400 的来历 · butterfly 三层实测',
    main: 'hexo.svg', sub: 'ui-panel-top.svg',
    brand: '#0E83CD', tone: 'normal',
  },
  {
    dir: 'blog-kook-bot-activity',
    coverTitle: 'KOOK 活动状态',
    coverSub: '开放平台 · 接口实测',
    main: 'kook.svg', mainKeepColors: true,
    sub: 'ui-bot.svg',
    brand: '#87EB00', tone: 'vivid',
  },
  {
    dir: 'blog-kook-voice-channel-debug',
    coverTitle: 'KOOK 语音频道',
    coverSub: '接口默认值 · 同一个假设',
    main: 'kook.svg', mainKeepColors: true,
    sub: 'ui-mic.svg',
    brand: '#87EB00', tone: 'deep',
  },
  {
    dir: 'jypt-server-php 部署排障记录（Docker-1Panel-OpenResty）',
    coverTitle: 'Laravel 部署排障',
    coverSub: '1Panel · OpenResty · Laravel 11',
    main: 'laravel.svg', mainKeepColors: true,
    sub: '1panel.svg',
    brand: '#FF2D20', tone: 'normal',
  },
  {
    dir: 'mishare-mouse-gesture',
    coverTitle: '妙享投屏补上鼠标手势',
    coverSub: 'AutoHotkey v2 · 鼠标手势映射',
    bannerSub: 'AutoHotkey v2 · 右键返回 / 中键桌面 / 长按最近任务',
    main: 'autohotkey.svg', sub: 'ui-mouse.svg',
    brand: '#B7B7B7', tone: 'deep',
  },
  {
    dir: 'wechat-ime-mathinput',
    coverTitle: '按 = 出答案',
    coverSub: 'AutoHotkey v2 · 任意输入框里算算式',
    main: 'autohotkey.svg', sub: 'ui-calculator.svg',
    brand: '#B7B7B7', tone: 'vivid',
  },
  {
    dir: '使用Docker部署RustDesk服务器',
    coverTitle: 'RustDesk 服务器',
    coverSub: 'Docker 部署 · 自建中继',
    main: 'docker.svg', sub: 'rustdesk.svg',
    brand: '#2496ED', tone: 'normal',
  },
  {
    dir: '博客重建全程复盘-从61篇旧站到个人技术博客',
    coverTitle: '博客重建复盘',
    coverSub: 'Hexo · Butterfly · GitHub Pages',
    main: 'hexo.svg', sub: 'ui-git-branch.svg',
    brand: '#0E83CD', tone: 'deep',
  },
  {
    dir: '用软链接让 DSH Desktop 使用网络挂载盘（SMB 共享）作工作区',
    coverTitle: 'DSH 使用网络盘',
    coverSub: '软链接 · 两道墙 · 沙箱',
    main: 'deepseek.svg', sub: 'ui-folder-symlink.svg',
    brand: '#4D6BFE', tone: 'vivid',
  },
  {
    dir: '美化Win11任务栏-徽标靠左图标居中全屏磁贴',
    coverTitle: 'Win11 任务栏美化',
    coverSub: 'StartAllBack + ExplorerPatcher',
    main: 'windows11.svg', sub: 'ui-wand-sparkles.svg',
    brand: '#0078D4', tone: 'deep',
  },
];

function parseFlags(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only' && argv[i + 1]) { o.only = argv[++i]; continue; }
    if (a.startsWith('--')) o[a.slice(2)] = true;
  }
  return o;
}

function main() {
  const flags = parseFlags(process.argv.slice(2));
  const only = typeof flags.only === 'string'
    ? flags.only.split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const list = POSTS.filter((p) => !only || only.includes(p.dir));
  if (!list.length) {
    console.error('没有匹配的文章。可用目录名：\n  ' + POSTS.map((p) => p.dir).join('\n  '));
    return 1;
  }

  let fail = 0;
  for (const p of list) {
    const dir = path.join(POSTS_DIR, p.dir);
    console.log(`\n================ ${p.dir}   (${p.brand} · ${p.tone})`);

    if (!fs.existsSync(dir)) { console.log('  ⚠ 目录不存在，跳过'); fail++; continue; }
    if (flags.dry) { console.log('  （dry run）'); continue; }

    const args = [
      FORGE, dir,
      '--title', p.coverTitle,
      '--cover-title', p.coverTitle,
      '--sub', p.coverSub,
      '--cover-sub', p.coverSub,
      '--banner-title', p.coverTitle,
      '--banner-sub', p.bannerSub || p.coverSub,
      '--main', icon(p.main),
      '--sub-icon', icon(p.sub),
      '--brand-color', p.brand,
      '--tone', p.tone,
    ];
    if (p.mainKeepColors) args.push('--keep-colors-main');
    if (flags.png) args.push('--png');

    const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
    if (r.status !== 0) fail++;
  }

  console.log('\n' + (fail ? `✗ ${fail} 篇失败` : `✓ ${list.length} 篇封面与横幅已重生成`));
  return fail ? 1 : 0;
}

process.exit(main());
