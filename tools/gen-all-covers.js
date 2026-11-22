/**
 * 一键给所有（或指定几篇）文章重新生成封面+横幅。
 *
 * 用途：改了配色规范 / 换了副图标 / 批量迁移时，不用一篇篇手敲参数。
 * 每篇文章的标题、图标、配色记在 POSTS 表里（新文章往表里加一行即可）。
 *
 * 用法：
 *   node tools/gen-all-covers.js            只生成 svg
 *   node tools/gen-all-covers.js --png      同时出 PNG
 *   node tools/gen-all-covers.js --check    生成后逐篇跑多视口验收
 *   node tools/gen-all-covers.js --only blog-cover-design-guide,wechat-ime-mathinput
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const POSTS_DIR = path.join(ROOT, 'source', '_posts');
const BRAND = path.resolve(ROOT, '..', 'brand-icons');
const FORGE = path.join(__dirname, 'cover-forge.js');

/**
 * 每篇文章的封面配置。
 *   title       横幅主标题
 *   sub         副标题（封面/横幅共用）
 *   bannerSub   横幅副标题（可选，比 sub 更详细时用）
 *   main        主图标文件名（brand-icons 下）
 *   theme       配色预设
 */
const POSTS = {
  'astrbot-snowluma-deploy': {
    title: 'SnowLuma + AstrBot',
    sub: '放弃官方机器人 · 自建 QQ 机器人',
    main: 'astrbot.svg',
    theme: 'purple',
  },
  'blog-kook-voice-channel-debug': {
    title: 'KOOK 语音频道',
    sub: '接口默认值 · 同一个假设',
    main: 'kook.svg',
    theme: 'teal',
  },
  'wechat-ime-mathinput': {
    title: '按 = 出答案',
    sub: 'AutoHotkey v2 · 任意输入框里算算式',
    main: 'autohotkey.svg',
    theme: 'blue',
  },
  'blog-cover-design-guide': {
    title: '封面生成规则',
    sub: '630×487 是怎么算出来的',
    bannerSub: '630×487 与 1600×400 的来历 · butterfly 三层图实测',
    main: 'hexo.svg',
    theme: 'ink',
  },
  '博客重建全程复盘-从61篇旧站到个人技术博客': {
    title: '博客重建复盘',
    sub: '从 61 篇旧站到个人技术博客',
    main: 'hexo.svg',
    theme: 'blue',
  },
};

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
  const only = typeof flags.only === 'string' ? flags.only.split(',').map(s => s.trim()).filter(Boolean) : null;

  const names = Object.keys(POSTS).filter(n => !only || only.includes(n));
  if (!names.length) {
    console.error('没有匹配的文章。可用：\n  ' + Object.keys(POSTS).join('\n  '));
    return 1;
  }

  let fail = 0;
  for (const name of names) {
    const dir = path.join(POSTS_DIR, name);
    if (!fs.existsSync(dir)) {
      console.log(`\n⚠ 跳过 ${name}：目录不存在`);
      continue;
    }
    const cfg = POSTS[name];
    const args = [
      FORGE, dir,
      '--title', cfg.title,
      '--sub', cfg.sub || '',
      '--main', path.join(BRAND, cfg.main),
      '--theme', cfg.theme || 'blue',
      '--brand', BRAND,
    ];
    if (cfg.bannerSub) args.push('--banner-sub', cfg.bannerSub);
    if (flags.png) args.push('--png');
    if (flags['force-tight']) args.push('--force-tight');

    console.log('\n================ ' + name);
    const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
    if (r.status !== 0) { fail++; continue; }

    if (flags.check) {
      const c = spawnSync(process.execPath, [FORGE, '--check', dir], { stdio: 'inherit' });
      if (c.status !== 0) fail++;
    }
  }

  console.log('\n' + (fail ? `✗ ${fail} 篇有问题` : `✓ ${names.length} 篇全部完成`));
  return fail ? 1 : 0;
}

process.exit(main());
