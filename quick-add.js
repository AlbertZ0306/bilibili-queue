(() => {
  const host = document.createElement('span');
  host.id = 'bq-quick-add';
  document.getElementById(host.id)?.remove();

  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { display: inline-flex; flex: none; vertical-align: middle; }
    button {
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      height: 28px;
      min-width: 126px;
      padding: 0 9px;
      border: 1px solid #00aeec66;
      border-radius: 6px;
      background: #00aeec14;
      color: var(--text1, #18191c);
      font: 600 12px/1 system-ui, sans-serif;
      white-space: nowrap;
      cursor: pointer;
    }
    button:hover { background: #00aeec24; }
    button:focus-visible { outline: 2px solid #00aeec; outline-offset: 2px; }
    button:disabled { opacity: .65; cursor: wait; }
    .icon { color: #00aeec; font-size: 16px; }
    [data-state="added"] .icon { color: #2caf82; }
    .status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  `;
  const button = document.createElement('button');
  button.type = 'button';
  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  button.append(icon, label);
  const status = document.createElement('span');
  status.className = 'status';
  status.setAttribute('role', 'status');
  root.append(style, button, status);

  let videoKey = '';
  let resetTimer;
  let pending = null;

  function currentVideoKey() {
    const match = /^\/video\/(BV[a-zA-Z0-9]{10})\/?$/.exec(location.pathname);
    if (!match) return '';
    const part = new URLSearchParams(location.search).get('p') ?? '1';
    return /^[1-9]\d{0,4}$/.test(part) ? `${match[1]}:${part}` : '';
  }

  function showState(state, text, details = text) {
    button.dataset.state = state;
    button.disabled = state === 'pending';
    button.title = details;
    icon.textContent = state === 'added' ? '✓' : '＋';
    label.textContent = text;
    status.textContent = state === 'ready' ? '' : details;
  }

  function ready() {
    showState('ready', '加入播放列表', '将当前视频和分 P 加入 bilibili-queue');
  }

  function mount() {
    const key = currentVideoKey();
    if (key !== videoKey) {
      videoKey = key;
      pending = null;
      clearTimeout(resetTimer);
      ready();
    }
    if (!key) {
      host.remove();
      return;
    }
    const title = document.querySelector('.video-info-title-inner > h1, h1.video-title, #viewbox_report h1');
    // An extra child in the server-rendered title can make Vue rebuild the app
    // during hydration, removing the Bilibili header. Wait for Vue's marker to clear.
    if (!title || title.closest('[data-server-rendered]')) {
      host.remove();
      return;
    }
    if (host.previousElementSibling !== title) title.after(host);
  }

  button.addEventListener('click', async event => {
    if (!event.isTrusted || pending) return;
    const key = currentVideoKey();
    if (!key || key !== videoKey) return;
    event.stopPropagation();
    clearTimeout(resetTimer);
    const attempt = {};
    pending = attempt;
    showState('pending', '正在添加…');
    try {
      const response = await chrome.runtime.sendMessage({ type: 'BQ_QUICK_ADD', url: location.href });
      if (pending !== attempt || currentVideoKey() !== key) return;
      if (!response?.ok) throw new Error(response?.error || '请刷新视频页后重试');
      showState('added', response.duplicate ? '已在播放列表' : '已加入播放列表');
      resetTimer = setTimeout(ready, 2200);
    } catch (error) {
      if (pending !== attempt || currentVideoKey() !== key) return;
      const details = chrome.runtime?.id ? error.message : '扩展已更新，请刷新视频页后重试';
      showState('error', '添加失败，重试', details);
    } finally {
      if (pending === attempt) pending = null;
    }
  });

  mount();
  // Bilibili can replace the title or navigate between videos without a page reload.
  setInterval(mount, 750);
})();
