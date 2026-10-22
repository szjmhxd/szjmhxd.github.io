/**
 * 版权区块「文章链接」按当前访问来源动态生成
 *
 * 场景：同一份静态产物，从 127.0.0.1 / 内网 IP / 公网域名访问时，
 *       页面里显示的文章链接自动跟随当前 host，而不是写死线上域名。
 *
 * 原理：hexo 生成时写死的是 _config.yml 里的 url（如 https://blog.szjmhxd.online），
 *       本脚本在页面加载后用 location.origin 替换版权区块内的 host。
 */
(function () {
  'use strict';

  function fixPostLinks() {
    var container = document.querySelector('.post-copyright__type .post-copyright-info');
    if (!container) return;
    var a = container.querySelector('a');
    if (!a) return;

    var origin = window.location.origin;
    if (!origin || origin === 'null' || origin.indexOf('file:') === 0) return;

    var href = a.getAttribute('href') || '';
    var path;
    try {
      path = new URL(href, origin).pathname;
    } catch (e) {
      path = href;
    }
    // 兜底：当前页面路径（版权链接必然指向本页）
    if (!path || path === '/') {
      path = window.location.pathname;
    }

    var newUrl = origin + path;
    a.setAttribute('href', newUrl);
    a.textContent = newUrl;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fixPostLinks);
  } else {
    fixPostLinks();
  }

  // 兼容 butterfly pjax / swup 局部刷新
  document.addEventListener('pjax:complete', fixPostLinks);
  document.addEventListener('swup:page:view', fixPostLinks);
})();
