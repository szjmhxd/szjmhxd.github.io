#!/usr/bin/env node
/**
 * cover-forge —— 给 butterfly 博客生成「封面 + 横幅」的命令行工具
 *
 * 一条命令从「文章标题 + 两个图标」出两张图，且保证不踩三个坑：
 *   ① 封面比例必须等于首页卡片可视区比例（630×487 ↔ 348×269），否则被 cover 裁切
 *   ② 横幅必须同时避开「左右横向裁切」和「主题标题区」
 *   ③ 图标内层自带的 fill 必须剥离，否则深色底上隐形
 *
 * 用法见: node cover-forge.js --help
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ─────────────────────── 常量：规范就是数字 ─────────────────────── */

const SPEC = {
  cover: {
    w: 630, h: 487,
    main: { x: 265, y: 92, size: 175 },
    sub: { x: 448, y: 180, size: 95 },
    bar: { x: 58, y: 288, w: 6, h: 58, rx: 3 },
    title: { x: 82, y: 332, size: 46 },
    desc: { x: 84, y: 378, size: 23 },
    safeBottom: 288,
  },
  banner: {
    w: 1600, h: 400,
    // 安全框 = 五个视口实测交集：
    //   1280 宽横裁 ±160 → x 必须 ≥160（再让 22px）
    //   2560 宽纵裁 ±120 → y 必须 ≥100（顶部还有导航栏）
    //   长标题在 1280 折两行 → 标题文字上沿 y=214，自绘内容须 <200
    // 安全框 x 方向对所有档位一致；y 下界按「标题会不会折行」分两档：
    //   折行 → 标题上沿 y=214，自绘内容须 < 200
    //   单行 → 标题上沿 y=266，自绘内容可到 245
    safe: { x0: 182, x1: 1420, y0: 100, y1Wrap: 200, y1Single: 245 },
    // 注意：下面 main/sub 的 x,y 是「图标方框的左上角」，不是图标实际墨迹边界。
    // place() 会把图标等比居中进 size 见方的框，所以方框 = 图标的最大占位。
    tight: {   // 标题长（1280 下会折成两行）→ 矮版
      main: { x: 1218, y: 100, size: 96 },
      sub: { x: 1334, y: 118, size: 66 },
      bar: { x: 182, y: 110, w: 5, h: 48, rx: 2.5 },
      title: { x: 206, y: 148, size: 40 },
      desc: { x: 208, y: 188, size: 20 },
    },
    normal: {  // 标题短（始终单行）→ 常规版，图标可以大一圈
      main: { x: 1164, y: 104, size: 128 },
      sub: { x: 1312, y: 126, size: 88 },
      bar: { x: 182, y: 112, w: 5, h: 52, rx: 2.5 },
      title: { x: 206, y: 152, size: 44 },
      desc: { x: 208, y: 194, size: 21 },
    },
    // 标题会不会折行：真实字体栈下量出的宽度超过这个值即视为折行
    wrapThreshold: 1120,
  },
  fonts: 'Microsoft YaHei, PingFang SC, sans-serif',
  // 真实页面标题盒：max-width 1200 - padding 60 = 内容宽 1140px，字号 35px
  titleFont: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Lato, Roboto, "PingFang SC", "Microsoft YaHei", sans-serif',
};

const THEME_PRESETS = {
  blue: ['#0c1a2b', '#16395c', '#3fa9f5'],
  purple: ['#091726', '#1d1040', '#57b0f0'],
  teal: ['#04191b', '#0b3a3a', '#2fd4c4'],
  green: ['#0b1403', '#1e3308', '#87eb00'],
  orange: ['#2a1108', '#4a1f0c', '#e95420'],
  slate: ['#0a1622', '#122c44', '#0078d4'],
  ink: ['#0d1b2a', '#1b2f4a', '#4fa8e0'],
};

/* ─────────────────────── 图标处理 ─────────────────────── */

/**
 * 读 SVG 内部内容。必须剥离内层 fill —— 图标自带的黑色填充会盖掉外层配色，
 * 在深色底上直接隐形（本项目最常撞的坑）。
 */
function innerSvg(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const vb = (raw.match(/viewBox="([^"]+)"/) || [, '0 0 24 24'])[1].trim().split(/\s+/).map(Number);
  const inner = raw
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>[\s\S]*$/, '')
    .replace(/<title>[\s\S]*?<\/title>/g, '')
    .replace(/<metadata>[\s\S]*?<\/metadata>/g, '')
    .replace(/\sfill="#[0-9a-fA-F]{3,8}"/g, '')
    .replace(/\sstyle="[^"]*"/g, '');
  if (!inner.trim()) throw new Error('图标内容为空: ' + file);
  return { vb, inner, file };
}

/** 等比放进 size 见方的框并居中到 (x,y)；处理非零原点 viewBox */
function place(spec, x, y, size, opts) {
  opts = opts || {};
  const [vx, vy, vw, vh] = spec.vb;
  const sc = Math.min(size / vw, size / vh);
  const ox = x + (size - vw * sc) / 2;
  const oy = y + (size - vh * sc) / 2;
  let out = `<g transform="translate(${ox.toFixed(2)},${oy.toFixed(2)}) scale(${sc.toFixed(5)})"`
    + ` fill="${opts.fill || '#ffffff'}" opacity="${opts.opacity === undefined ? 0.97 : opts.opacity}">\n`;
  if (vx !== 0 || vy !== 0) out += `<g transform="translate(${-vx},${-vy})">\n${spec.inner}\n</g>\n`;
  else out += spec.inner + '\n';
  return out + '</g>\n';
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ─────────────────────── 判定：标题会不会折行 ─────────────────────── */

async function measureTitle(text, pw) {
  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 200 } });
    await page.setContent(`<html><head><style>
      body{margin:0;font-family:${SPEC.titleFont}}
      #post-info>*{margin:0 auto;padding:0 30px;max-width:1200px}
      .post-title{font-size:35px;font-weight:400;line-height:1.5}
    </style></head><body><div id="post-info"><h1 class="post-title">${esc(text)}</h1></div></body></html>`);
    const r = await page.evaluate(() => {
      const h = document.querySelector('.post-title');
      const range = document.createRange();
      range.selectNodeContents(h);
      const b = range.getBoundingClientRect();
      return { width: Math.round(b.width) };
    });
    return { ...r, wraps: r.width > SPEC.banner.wrapThreshold };
  } finally {
    await browser.close();
  }
}

/* ─────────────────────── 绘图 ─────────────────────── */

const defsBlock = (t, gx, gy, gr, go) => `  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${t.c1}"/><stop offset="100%" stop-color="${t.c2}"/>
    </linearGradient>
    <radialGradient id="glow" cx="${gx}" cy="${gy}" r="${gr}">
      <stop offset="0%" stop-color="${t.accent}" stop-opacity="${go}"/>
      <stop offset="100%" stop-color="${t.accent}" stop-opacity="0"/>
    </radialGradient>
  </defs>
`;

function makeCover(t) {
  const C = SPEC.cover;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${C.w}" height="${C.h}" viewBox="0 0 ${C.w} ${C.h}" font-family="${SPEC.fonts}">\n`;
  s += defsBlock(t, '70%', '35%', '60%', '0.22');
  s += `  <rect width="${C.w}" height="${C.h}" fill="url(#bg)"/>\n`;
  s += `  <rect width="${C.w}" height="${C.h}" fill="url(#glow)"/>\n`;
  s += place(t.mainIcon, C.main.x, C.main.y, C.main.size, { fill: t.accent });
  s += place(t.subIcon, C.sub.x, C.sub.y, C.sub.size, { fill: '#ffffff', opacity: 0.92 });
  s += `  <rect x="${C.bar.x}" y="${C.bar.y}" width="${C.bar.w}" height="${C.bar.h}" fill="${t.accent}" rx="${C.bar.rx}"/>\n`;
  s += `  <text x="${C.title.x}" y="${C.title.y}" font-size="${C.title.size}" font-weight="bold" fill="#ffffff">${esc(t.coverTitle)}</text>\n`;
  s += `  <text x="${C.desc.x}" y="${C.desc.y}" font-size="${C.desc.size}" fill="${t.accent}" opacity="0.92">${esc(t.coverSub)}</text>\n`;
  return s + '</svg>\n';
}

function makeBanner(t, tight) {
  const B = SPEC.banner, L = tight ? B.tight : B.normal;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${B.w}" height="${B.h}" viewBox="0 0 ${B.w} ${B.h}" font-family="${SPEC.fonts}">\n`;
  s += defsBlock(t, '76%', '45%', '45%', '0.18');
  s += `  <rect width="${B.w}" height="${B.h}" fill="url(#bg)"/>\n`;
  s += `  <rect width="${B.w}" height="${B.h}" fill="url(#glow)"/>\n`;
  s += place(t.mainIcon, L.main.x, L.main.y, L.main.size, { fill: t.accent });
  s += place(t.subIcon, L.sub.x, L.sub.y, L.sub.size, { fill: '#ffffff', opacity: 0.92 });
  s += `  <rect x="${L.bar.x}" y="${L.bar.y}" width="${L.bar.w}" height="${L.bar.h}" fill="${t.accent}" rx="${L.bar.rx}"/>\n`;
  s += `  <text x="${L.title.x}" y="${L.title.y}" font-size="${L.title.size}" font-weight="bold" fill="#ffffff">${esc(t.bannerTitle)}</text>\n`;
  s += `  <text x="${L.desc.x}" y="${L.desc.y}" font-size="${L.desc.size}" fill="${t.accent}" opacity="0.9">${esc(t.bannerSub)}</text>\n`;
  return s + '</svg>\n';
}

/* ─────────────────────── 静态自检 ─────────────────────── */

function selfCheck(t, tight) {
  const problems = [];
  const C = SPEC.cover;
  if (C.main.y + C.main.size > C.safeBottom) problems.push(`封面主图标底部越过安全线 ${C.safeBottom}`);
  if (C.sub.y + C.sub.size > C.safeBottom) problems.push(`封面副图标底部越过安全线 ${C.safeBottom}`);

  const B = SPEC.banner, L = tight ? B.tight : B.normal, S = B.safe;
  const y1 = tight ? S.y1Wrap : S.y1Single;
  const boxes = [
    ['主图标', L.main.x, L.main.y, L.main.size, L.main.size],
    ['副图标', L.sub.x, L.sub.y, L.sub.size, L.sub.size],
    ['竖条', L.bar.x, L.bar.y, L.bar.w, L.bar.h],
  ];
  for (const [name, x, y, w, h] of boxes) {
    if (x < S.x0) problems.push(`横幅${name}左边 ${x} 越过安全区 ${S.x0}（1280 宽会被裁）`);
    if (x + w > S.x1) problems.push(`横幅${name}右边 ${x + w} 越过安全区 ${S.x1}`);
    if (y < S.y0) problems.push(`横幅${name}顶部 ${y} 越过安全区 ${S.y0}（2560 宽会被裁）`);
    if (y + h > y1) problems.push(`横幅${name}底部 ${y + h} 越过安全区 ${y1}（会压主题标题）`);
  }
  if (L.title.x < S.x0) problems.push(`横幅主标题起点 ${L.title.x} 越过安全区 ${S.x0}`);
  if (L.desc.x < S.x0) problems.push(`横幅副标题起点 ${L.desc.x} 越过安全区 ${S.x0}`);
  if (L.title.y > y1) problems.push(`横幅主标题基线 ${L.title.y} 越界`);
  return problems;
}

/* ─────────────────────── 命令行 ─────────────────────── */

// 纯开关型参数：本身不带值（路径等放在位置参数里）
const BOOLEAN_FLAGS = new Set(['check', 'png', 'help', 'init', 'force-tight']);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) { out[key] = true; continue; }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function usage() {
  console.log(`
cover-forge —— butterfly 封面/横幅生成器

用法：
  node cover-forge.js <文章目录> [选项]
  node cover-forge.js --check <文章目录> [--url http://127.0.0.1:4000]
  node cover-forge.js --init <目录> [--title "文章标题"]

内容选项：
  --title <文>        横幅主标题（也用作封面标题的默认值）
  --banner-title <文> 单独指定横幅主标题
  --sub <文>          副标题（封面/横幅共用）
  --banner-sub <文>   单独指定横幅副标题
  --cover-title <文>  单独指定封面大标题
  --cover-sub <文>    单独指定封面小标题
  --theme <名>        配色预设：${Object.keys(THEME_PRESETS).join(' / ')}（默认 blue）
  --c1 --c2 --accent <色> 自定义配色，覆盖 --theme

图标选项：
  --main <svg>        主图标 = 文章主题的官方矢量（默认 brand-icons/hexo.svg）
  --sub-icon <svg>    副图标 = 这篇文章对该主题做了什么（默认 brand-icons/wand.svg）
  --brand <目录>      图标库目录（默认自动探测 ../../../../brand-icons）

输出：
  --png               额外导出 cover.png / banner.png（掘金等平台需要位图）
  --preview <目录>    导出目检图：原尺寸 / 348×269 卡片裁切 / 横幅

验收：
  --check             多视口碰撞验收（需 hexo server 在跑）
  --url <地址>        配合 --check，默认 http://127.0.0.1:4000
  --id <abbrlink>     配合 --check，默认从同名 md 的 front matter 读

其它：
  --force-tight       强制横幅用矮版（标题折行时会自动启用）
  --help              本帮助

示例：
  node cover-forge.js "E:/test/hexo/source/_posts/wechat-ime-mathinput" \\
    --title "按 = 出答案" --sub "AutoHotkey v2 · 任意输入框里算算式" \\
    --main E:/test/brand-icons/autohotkey.svg --png --preview E:/tmp/preview
`);
}

/* ─────────────────────── 主流程 ─────────────────────── */

function loadPlaywright() {
  const candidates = [
    'playwright',
    'D:/environment/nodejs/node_modules/playwright',
    path.join(process.env.APPDATA || '', 'npm/node_modules/playwright'),
  ];
  for (const c of candidates) {
    try { return require(c); } catch (e) { /* next */ }
  }
  return null;
}

async function exportPngs(pw, postDir, targets) {
  const browser = await pw.chromium.launch();
  try {
    for (const t of targets) {
      const svg = fs.readFileSync(path.join(postDir, t.file), 'utf8');
      const page = await browser.newPage({ viewport: { width: t.w, height: t.h }, deviceScaleFactor: 2 });
      await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
      await page.waitForTimeout(150);
      const out = path.join(postDir, t.file.replace(/\.svg$/, '.png'));
      await page.screenshot({ path: out });
      await page.close();
      console.log('  ' + path.basename(out) + '  ' + fs.statSync(out).size + ' B');
    }
  } finally {
    await browser.close();
  }
}

async function exportPreviews(pw, postDir, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const cover = fs.readFileSync(path.join(postDir, 'cover.svg'), 'utf8');
  const banner = fs.readFileSync(path.join(postDir, 'banner.svg'), 'utf8');
  const browser = await pw.chromium.launch();
  try {
    let p = await browser.newPage({ viewport: { width: 630, height: 487 }, deviceScaleFactor: 2 });
    await p.setContent(`<html><body style="margin:0">${cover}</body></html>`);
    await p.waitForTimeout(150);
    await p.screenshot({ path: path.join(outDir, 'cover-full.png') });
    await p.close();

    p = await browser.newPage({ viewport: { width: 348, height: 269 }, deviceScaleFactor: 2 });
    await p.setContent(`<html><body style="margin:0;background:#000">
      <div style="width:348px;height:269px;overflow:hidden">
        <div style="transform:scale(${348 / 630});transform-origin:0 0;width:630px;height:487px">${cover}</div>
      </div></body></html>`);
    await p.waitForTimeout(150);
    await p.screenshot({ path: path.join(outDir, 'cover-card.png') });
    await p.close();

    p = await browser.newPage({ viewport: { width: 1600, height: 400 }, deviceScaleFactor: 1 });
    await p.setContent(`<html><body style="margin:0">${banner}</body></html>`);
    await p.waitForTimeout(150);
    await p.screenshot({ path: path.join(outDir, 'banner.png') });
    await p.close();
  } finally {
    await browser.close();
  }
  console.log('  ' + outDir + '  (cover-full / cover-card / banner)');
}

/**
 * 多视口碰撞验收。
 * 关键：用 getBoundingClientRect 而非 getBBox —— getBBox 返回元素自身坐标系，
 * 不含祖先 transform，图标 path 的 0~24 会被误当成画布坐标（会得到一整批假警报）。
 */
async function runCheck(pw, postDir, postId, baseUrl) {
  const svg = fs.readFileSync(path.join(postDir, 'banner.svg'), 'utf8');
  const VPS = [1280, 1440, 1600, 1920, 2560];
  const browser = await pw.chromium.launch();
  let bad = 0;
  try {
    const probe = await browser.newPage({ viewport: { width: 1600, height: 400 } });
    await probe.setContent(`<html><body style="margin:0">${svg}</body></html>`);
    await probe.waitForTimeout(250);
    const elems = await probe.evaluate(() => {
      const root = document.querySelector('svg');
      const rb = root.getBoundingClientRect();
      const out = [];
      (function walk(node) {
        for (const el of node.children) {
          const tag = el.tagName.toLowerCase();
          if (['defs', 'clippath', 'mask', 'lineargradient', 'radialgradient', 'stop', 'title'].includes(tag)) continue;
          if (tag === 'g') { walk(el); continue; }
          const b = el.getBoundingClientRect();
          if (b.width < 2 || b.height < 2) continue;
          if (b.width >= 1590 && b.height >= 390) continue;  // 背景铺满画布，必然“重叠”
          out.push({ tag, x: b.left - rb.left, y: b.top - rb.top, w: b.width, h: b.height, text: (el.textContent || '').trim().slice(0, 14) });
        }
      })(root);
      return out;
    });
    await probe.close();

    console.log('\n  自绘元素（图坐标）:');
    for (const e of elems) {
      console.log('    ' + e.tag.padEnd(5)
        + ' x' + String(Math.round(e.x)).padStart(4) + '~' + String(Math.round(e.x + e.w)).padStart(4)
        + ' y' + String(Math.round(e.y)).padStart(3) + '~' + String(Math.round(e.y + e.h)).padStart(3)
        + (e.text ? '  "' + e.text + '"' : ''));
    }
    console.log('');

    for (const vw of VPS) {
      const page = await browser.newPage({ viewport: { width: vw, height: 900 } });
      await page.goto(`${baseUrl}/posts/${postId}/`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);
      const tb = await page.evaluate(() => {
        const h1 = document.querySelector('#post-info .post-title');
        const rg = document.createRange(); rg.selectNodeContents(h1);
        const t = rg.getBoundingClientRect();
        return { l: t.left, r: t.right, t: t.top, b: t.bottom };
      });
      await page.close();

      const sc = Math.max(vw / 1600, 400 / 400);
      const offX = (1600 * sc - vw) / 2, offY = (400 * sc - 400) / 2;
      let overlap = 0, cut = 0, worst = null;
      for (const e of elems) {
        const l = e.x * sc - offX, t = e.y * sc - offY;
        const r = (e.x + e.w) * sc - offX, b = (e.y + e.h) * sc - offY;
        const ix = Math.max(0, Math.min(r, tb.r) - Math.max(l, tb.l));
        const iy = Math.max(0, Math.min(b, tb.b) - Math.max(t, tb.t));
        const a = ix * iy;
        const c = Math.max(0, -l) + Math.max(0, r - vw) + Math.max(0, -t) + Math.max(0, b - 400);
        if (a > 0) { overlap += a; if (!worst || a > worst.a) worst = { ...e, a }; }
        cut += c;
      }
      if (overlap > 0 || cut > 0) bad++;
      console.log('  vw=' + String(vw).padStart(4), 'sc=' + sc.toFixed(2), 'offX=' + offX.toFixed(0),
        '| 重叠 ' + Math.round(overlap) + 'px²' + (worst ? ' (' + worst.tag + (worst.text ? ' "' + worst.text + '"' : '') + ')' : ''),
        '| 出框 ' + Math.round(cut) + 'px');
    }
  } finally {
    await browser.close();
  }

  if (bad) { console.log('\n  ✗ ' + bad + ' 个视口有问题'); return 1; }
  console.log('\n  ✓ 全部视口通过（0 重叠 / 0 出框）');
  return 0;
}

function guessAbbrlink(postDir) {
  // 约定：文章素材目录是 source/_posts/<name>/，md 是同级的 <name>.md
  const md = path.join(postDir + '.md');
  if (!fs.existsSync(md)) return null;
  const m = fs.readFileSync(md, 'utf8').match(/^abbrlink:\s*(\S+)/m);
  return m ? m[1] : null;
}

/** 从同名 md 的 front matter 读 title（判定折行要用它） */
function readPostTitle(postDir) {
  const md = path.join(postDir + '.md');
  if (!fs.existsSync(md)) return null;
  const txt = fs.readFileSync(md, 'utf8');
  const fm = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const m = fm[1].match(/^title:\s*(.+)$/m);
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return 0; }
  if (!args._.length && !args.check && !args.init) { usage(); return 1; }

  const pw = loadPlaywright();
  if (!pw) {
    console.error('✗ 找不到 playwright。安装：npm i -g playwright && npx playwright install chromium');
    return 1;
  }

  /* --init */
  if (args.init) {
    const dirName = args._[0];
    if (!dirName) { console.error('✗ --init 需要目录名，例如：--init my-new-post'); return 1; }
    const dir = path.isAbsolute(dirName) ? dirName : path.join(process.cwd(), dirName);
    fs.mkdirSync(dir, { recursive: true });
    const title = args.title || '文章标题';
    const mdPath = dir + '.md';
    if (!fs.existsSync(mdPath)) {
      fs.writeFileSync(mdPath, `---
title: ${title}
date: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}
cover: cover.svg
top_img: banner.svg
---

## 正文开始
`, 'utf8');
      console.log('已建 ' + mdPath);
    }
    console.log('已建目录 ' + dir);
    console.log('\n下一步：\n  node cover-forge.js "' + dir + '" --title "' + title + '" --main <图标.svg>');
    return 0;
  }

  /* --check */
  if (args.check) {
    const postDir = path.resolve(args._[0] || '.');
    const id = args.id || guessAbbrlink(postDir);
    if (!id) { console.error('✗ 找不到 abbrlink，请用 --id 指定'); return 1; }
    console.log('验收 ' + postDir);
    return await runCheck(pw, postDir, id, args.url || 'http://127.0.0.1:4000');
  }

  /* 生成 */
  const postDir = path.resolve(args._[0]);
  if (!fs.existsSync(postDir)) { console.error('✗ 目录不存在: ' + postDir); return 1; }

  // 图标库定位：--brand 优先；否则从文章目录向上逐级找 brand-icons
  const findBrandDir = () => {
    if (args.brand) return path.resolve(String(args.brand));
    let d = postDir;
    for (let i = 0; i < 8; i++) {
      const cand = path.join(d, 'brand-icons');
      if (fs.existsSync(cand)) return cand;
      const parent = path.dirname(d);
      if (parent === d) break;
      d = parent;
    }
    return null;
  };
  const brandDir = findBrandDir();

  // 绝对路径原样使用（避免被 shell 的 cwd 影响）；相对路径按 cwd 解析
  const resolveIconPath = (given) => {
    const raw = path.normalize(String(given).split('\\\\').join('/'));
    return path.isAbsolute(raw) ? raw : path.resolve(raw);
  };

  const pickIcon = (given, fallbackName) => {
    if (given) {
      const p = resolveIconPath(given);
      if (!fs.existsSync(p)) throw new Error('图标不存在: ' + p);
      return p;
    }
    if (!brandDir) {
      throw new Error('找不到图标库 brand-icons（用 --main / --sub-icon 指定图标，或 --brand 指定目录）');
    }
    const p = path.join(brandDir, fallbackName);
    if (!fs.existsSync(p)) throw new Error('默认图标不存在: ' + p + '（用 --main / --sub-icon 指定）');
    return p;
  };

  const themeName = String(args.theme || 'blue');
  const preset = THEME_PRESETS[themeName] || THEME_PRESETS.blue;

  const title = String(args.title || path.basename(postDir));
  const t = {
    c1: String(args.c1 || preset[0]),
    c2: String(args.c2 || preset[1]),
    accent: String(args.accent || preset[2]),
    mainIcon: innerSvg(pickIcon(args.main, 'hexo.svg')),
    subIcon: innerSvg(pickIcon(args['sub-icon'], 'wand.svg')),
    coverTitle: String(args['cover-title'] || title),
    coverSub: String(args['cover-sub'] || args.sub || ''),
    bannerTitle: String(args['banner-title'] || title),
    bannerSub: String(args['banner-sub'] || args.sub || ''),
  };

  // 判定折行要用「文章标题」（页面 h1），不是横幅上那行短字。
  // 文章标题决定主题标题区占多高，进而决定横幅可用空间。
  const postTitle = String(args['post-title'] || readPostTitle(postDir) || t.bannerTitle);
  console.log('量文章标题宽度（决定横幅版式）…');
  const m = await measureTitle(postTitle, pw);
  const tight = args['force-tight'] ? true : m.wraps;
  console.log(`  "${postTitle.slice(0, 26)}${postTitle.length > 26 ? '…' : ''}"`
    + ` 宽 ${m.width}px / 阈值 ${SPEC.banner.wrapThreshold}px`
    + ` → ${m.wraps ? '1280 下会折两行' : '始终单行'} → 横幅用 ${tight ? '矮版' : '常规版'}`);

  const problems = selfCheck(t, tight);
  if (problems.length) {
    console.error('\n✗ 自检未通过：');
    problems.forEach(p => console.error('  · ' + p));
    return 1;
  }

  const coverPath = path.join(postDir, 'cover.svg');
  const bannerPath = path.join(postDir, 'banner.svg');
  fs.writeFileSync(coverPath, makeCover(t), 'utf8');
  fs.writeFileSync(bannerPath, makeBanner(t, tight), 'utf8');
  console.log('\n已写入:');
  console.log('  cover.svg   ' + fs.statSync(coverPath).size + ' B');
  console.log('  banner.svg  ' + fs.statSync(bannerPath).size + ' B');
  console.log(`  主图标 ${path.basename(t.mainIcon.file)} · 副图标 ${path.basename(t.subIcon.file)} · 配色 ${themeName}`);

  if (args.png) {
    console.log('\n导出 PNG:');
    await exportPngs(pw, postDir, [
      { file: 'cover.svg', w: 630, h: 487 },
      { file: 'banner.svg', w: 1600, h: 400 },
    ]);
  }

  if (args.preview) {
    console.log('\n导出目检图:');
    await exportPreviews(pw, postDir, path.resolve(String(args.preview)));
  }

  console.log('\n下一步:');
  console.log('  1) npx hexo generate');
  console.log('  2) node cover-forge.js --check "' + postDir + '"');
  return 0;
}

main().then(code => process.exit(code || 0)).catch(e => {
  console.error('✗ ' + (e && e.message ? e.message : e));
  process.exit(1);
});
