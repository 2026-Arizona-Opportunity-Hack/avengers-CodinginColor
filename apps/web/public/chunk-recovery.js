(() => {
  const retry = 'cic-retry';
  let reloading = false;
  const asset = (value) => {
    try {
      const url = new URL(value, location.href);
      return url.origin === location.origin && /\/(?:main|chunk|polyfills)-[\w-]+\.js$/.test(url.pathname);
    } catch { return false; }
  };
  const recover = () => {
    if (reloading) return;
    const url = new URL(location.href);
    if (!url.searchParams.has(retry)) {
      reloading = true;
      url.searchParams.set(retry, '1');
      location.replace(url.href);
      return;
    }
    const show = () => {
      if (document.getElementById('chunk-recovery-alert')) return;
      const alert = document.createElement('div');
      alert.id = 'chunk-recovery-alert'; alert.setAttribute('role', 'alert');
      alert.style.cssText = 'position:fixed;inset:auto 16px 16px;z-index:10000;padding:20px;background:white;color:#0f1a15;border:2px solid #007a3d;border-radius:12px';
      alert.textContent = 'The workspace could not load its latest version. Your saved records have been kept. ';
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = 'Try loading again';
      button.addEventListener('click', () => {
        const next = new URL(location.href); next.searchParams.set(retry, String(Date.now()));
        location.replace(next.href);
      });
      alert.append(button); document.body.append(alert);
    };
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show, { once: true });
  };
  const moduleError = (error) => {
    if (/Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Loading chunk [\w-]+ failed/i.test(error?.message ?? '')) recover();
  };
  window.addEventListener('error', (event) => {
    const node = event.target;
    if ((node?.tagName === 'SCRIPT' && node.type === 'module' && asset(node.src)) ||
        (node?.tagName === 'LINK' && node.rel === 'modulepreload' && asset(node.href))) recover();
  }, true);
  window.addEventListener('unhandledrejection', (event) => moduleError(event.reason));
  window.addEventListener('cic:module-error', (event) => moduleError(event.detail));
})();
