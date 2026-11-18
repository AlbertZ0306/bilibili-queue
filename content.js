(() => {
  let config = null;
  let lastURL = '';
  let syncing = false;
  let completed = false;
  let media = null;
  let previousLoop = false;
  let attempted = false;
  let userPaused = false;
  let status = '';
  let lastReport = '';
  let lastProgressAt = 0;
  let lastProgressKey = '';
  let startedAt = Date.now();
  let notice;
  let noticeTimer;
  const playbackRates = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
  const rateItemSelector = '.bpx-player-ctrl-playbackrate-menu-item';
  let speedMedia = null;
  let pendingSpeed = null;
  let applyingRate = false;
  let speedURL = '';
  let speedMenu = null;
  let rateDirty = false;
  let rightHeld = false;
  let rateReleaseTimer = null;
  let rateFeedback = null;
  let rateNotice = null;
  let rateNoticeBox = null;
  let rateNoticeRevision = null;
  let rateNoticeTimer;
  let rateNoticeRemoveTimer;
  // Revisions prevent a delayed HELLO/storage read from undoing a newer selection.
  let ratePreference = { playbackRate: 1, rateRevision: -1 };

  function acceptRate(value) {
    if (!value || !playbackRates.includes(value.playbackRate)) return;
    const revision = Number.isSafeInteger(value.rateRevision) && value.rateRevision >= 0 ? value.rateRevision : 0;
    if (revision < ratePreference.rateRevision) return;
    if (revision === ratePreference.rateRevision && value.playbackRate === ratePreference.playbackRate) return;
    if ((rateFeedback && rateFeedback.revision !== revision) || (rateNotice && rateNoticeRevision !== revision)) clearRateFeedback();
    ratePreference = { playbackRate: value.playbackRate, rateRevision: revision };
    rateDirty = true;
    applyRate();
  }
  function nativeRateHintVisible() {
    const hint = document.querySelector('.bpx-player-three-playrate-hint');
    return Boolean(hint?.getClientRects().length && getComputedStyle(hint).visibility !== 'hidden');
  }
  function applyRate() {
    if (!rateDirty || !speedMedia || !videoPage() || speedURL !== location.href || applyingRate || ratePreference.rateRevision < 0) return;
    // Native long-press speed belongs to the player, not the saved preference.
    if (rightHeld || rateReleaseTimer !== null || nativeRateHintVisible()) return;
    const rate = pendingSpeed?.rate ?? ratePreference.playbackRate;
    applyingRate = true;
    try {
      const menu = document.querySelector('.bpx-player-ctrl-playbackrate-menu');
      if (menu?.closest('[data-server-rendered]')) return;
      if (menu) {
        const items = [...menu.querySelectorAll(rateItemSelector)];
        const selected = items.find(item => Number(item.dataset.value) === rate);
        // Use the native delegated handler so Bilibili also updates its player settings.
        if (selected && (!selected.classList.contains('bpx-state-active') || speedMedia.playbackRate !== rate)) selected.click();
        for (const item of items) item.classList.toggle('bpx-state-active', Number(item.dataset.value) === rate);
        const result = menu.parentElement.querySelector('.bpx-player-ctrl-playbackrate-result');
        if (result) {
          const text = rate === 1 ? '倍速' : `${Number.isInteger(rate) ? rate.toFixed(1) : rate}x`;
          if (result.textContent !== text) result.textContent = text;
        }
      }
      if (speedMedia.defaultPlaybackRate !== rate) speedMedia.defaultPlaybackRate = rate;
      if (speedMedia.playbackRate !== rate) speedMedia.playbackRate = rate;
      rateDirty = false;
    } finally { applyingRate = false; }
    flushRateFeedback();
  }
  function onSpeedMetadata() { rateDirty = true; applyRate(); }
  function releaseNativeRate() {
    if (!rightHeld) return;
    rightHeld = false;
    clearTimeout(rateReleaseTimer);
    const url = location.href;
    // Our capture listener runs before Bilibili's keyup/blur handler restores speed.
    rateReleaseTimer = setTimeout(() => {
      rateReleaseTimer = null;
      if (location.href !== url) return;
      rateDirty = true;
      applyRate();
    }, 0);
  }
  function videoPage() {
    const url = new URL(location.href);
    return url.origin === 'https://www.bilibili.com' && /^\/video\/BV[a-zA-Z0-9]{10}\/?$/.test(url.pathname);
  }
  function syncPlayerSpeed() {
    if (speedURL !== location.href) {
      clearRateFeedback();
      speedURL = location.href;
      pendingSpeed = null;
      rightHeld = false;
      clearTimeout(rateReleaseTimer);
      rateReleaseTimer = null;
      speedMenu = null;
      rateDirty = true;
    }
    const found = videoPage() ? findMedia() : null;
    if (found !== speedMedia) {
      clearRateFeedback();
      speedMedia?.removeEventListener('loadedmetadata', onSpeedMetadata);
      speedMedia = found;
      speedMedia?.addEventListener('loadedmetadata', onSpeedMetadata);
      rateDirty = true;
    }
    const menu = document.querySelector('.bpx-player-ctrl-playbackrate-menu');
    if (menu !== speedMenu) { speedMenu = menu; rateDirty = true; }
    if (speedMedia && menu && !menu.closest('[data-server-rendered]') && !menu.querySelector('[data-value="3"]')) {
      const template = menu.querySelector(rateItemSelector);
      if (template) {
        const item = template.cloneNode(false);
        item.classList.remove('bpx-state-active');
        item.dataset.value = '3';
        item.dataset.bqRate = '3';
        item.textContent = '3.0x';
        item.setAttribute('title', '3 倍速 · bilibili-queue');
        menu.prepend(item);
        rateDirty = true;
      }
    }
    applyRate();
    flushRateFeedback();
  }
  function clearRateFeedback() {
    rateFeedback = null;
    clearTimeout(rateNoticeTimer);
    clearTimeout(rateNoticeRemoveTimer);
    rateNotice?.remove();
    rateNotice = null;
    rateNoticeBox = null;
    rateNoticeRevision = null;
  }
  function renderRateFeedback(feedback, deferred) {
    const container = speedMedia?.closest('.bpx-player-video-area') ||
      speedMedia?.closest('.bpx-player-video-wrap, .bilibili-player-video, #bilibili-player');
    if (!container || container.closest('[data-server-rendered]')) return false;
    if (!rateNotice?.isConnected || rateNotice.parentElement !== container) {
      rateNotice?.remove();
      rateNotice = document.createElement('div');
      rateNotice.id = 'bq-speed-feedback';
      rateNotice.setAttribute('role', 'status');
      rateNotice.setAttribute('aria-live', 'polite');
      rateNotice.setAttribute('aria-atomic', 'true');
      rateNotice.style.cssText = 'all:initial;position:absolute;top:16px;left:16px;z-index:2147483647;pointer-events:none;max-width:calc(100% - 32px);font:13px/20px "Microsoft YaHei",system-ui,sans-serif;opacity:0;transform:translateY(-3px);transition:opacity 150ms ease,transform 150ms ease;';
      rateNoticeBox = document.createElement('div');
      rateNoticeBox.style.cssText = 'box-sizing:border-box;padding:6px 10px;border-radius:6px;color:#fff;background:rgba(20,22,26,.72);border:1px solid rgba(255,255,255,.09);box-shadow:0 2px 10px #0002;font:inherit;';
      rateNotice.attachShadow({ mode: 'closed' }).append(rateNoticeBox);
      container.append(rateNotice);
    }
    // A closed shadow root keeps native player styles out of the compact hint.
    const label = deferred ? '固定倍速' : feedback.atLimit ?
      feedback.step > 0 ? '已达最高倍速' : '已达最低倍速' : '播放速度';
    const note = deferred ? '松开后生效' : '';
    const text = `${label} ${feedback.rate}×${note ? '，' + note : ''}`;
    rateNotice.setAttribute('aria-label', text);
    // Rebuild only our own shadow content; never change the player's layout styles.
    const box = rateNoticeBox;
    box.replaceChildren();
    const prefix = document.createElement('span'); prefix.textContent = label;
    const value = document.createElement('strong'); value.textContent = `${feedback.rate}×`;
    value.style.cssText = 'font-weight:600;font-variant-numeric:tabular-nums;margin-left:5px';
    box.append(prefix, value);
    if (note) {
      const suffix = document.createElement('span'); suffix.textContent = note;
      suffix.style.cssText = 'font-size:12px;color:#d0d3d9;margin-left:8px';
      box.append(suffix);
    }
    rateNoticeRevision = feedback.revision;
    clearTimeout(rateNoticeTimer);
    clearTimeout(rateNoticeRemoveTimer);
    const current = rateNotice;
    requestAnimationFrame(() => {
      if (rateNotice === current) { current.style.opacity = '1'; current.style.transform = 'none'; }
    });
    rateNoticeTimer = setTimeout(() => {
      if (rateNotice !== current) return;
      current.style.opacity = '0'; current.style.transform = 'translateY(-3px)';
      rateNoticeRemoveTimer = setTimeout(() => {
        if (rateNotice === current) { current.remove(); rateNotice = null; rateNoticeBox = null; rateNoticeRevision = null; }
      }, 150);
    }, 1350);
    return true;
  }
  function flushRateFeedback() {
    const feedback = rateFeedback;
    if (!feedback) return;
    if (feedback.url !== location.href || feedback.revision !== ratePreference.rateRevision) { clearRateFeedback(); return; }
    if (!speedMedia) return;
    const deferred = rightHeld || rateReleaseTimer !== null || nativeRateHintVisible();
    if (deferred) {
      if (!feedback.shownDeferred) feedback.shownDeferred = renderRateFeedback(feedback, true);
      return;
    }
    if (rateDirty || speedMedia.playbackRate !== feedback.rate) return;
    if (feedback.shownDeferred) feedback.atLimit = false;
    if (renderRateFeedback(feedback, false)) rateFeedback = null;
  }
  async function changePlayerSpeed(fields) {
    const attempt = { url: location.href, rate: fields.value };
    pendingSpeed = attempt;
    const result = await send({ type: fields.step ? 'BQ_PLAYER_RATE_STEP' : 'BQ_PLAYER_RATE', url: attempt.url, ...fields });
    if (pendingSpeed !== attempt) return;
    pendingSpeed = null;
    if (location.href !== attempt.url) return;
    if (result?.ok) {
      acceptRate(result);
      if (fields.step && result.rateRevision === ratePreference.rateRevision) {
        rateFeedback = { url: attempt.url, rate: result.playbackRate, revision: result.rateRevision, step: fields.step, atLimit: result.atLimit, shownDeferred: false };
        flushRateFeedback();
      }
    }
    else {
      rateDirty = true;
      applyRate();
      showNotice(result?.error || '倍速同步失败，请刷新视频页后重试', null, true);
    }
  }

  function matching() {
    if (!config) return false;
    const url = new URL(location.href);
    return url.pathname.replace(/\/$/, '') === `/video/${config.bvid}` &&
      Number(url.searchParams.get('p') || 1) === config.page && url.searchParams.get('bq_run') === config.runId;
  }
  async function send(message) {
    try { return await chrome.runtime.sendMessage(message); }
    catch { return null; } // The extension may have been reloaded while this page is open.
  }
  function title() {
    const h1 = document.querySelector('h1.video-title, h1[title], h1');
    return h1?.getAttribute('title') || h1?.textContent || document.title.replace(/_哔哩哔哩.*$/, '');
  }
  function report(next) {
    if (!matching() || completed) return;
    status = next;
    const duration = Number.isFinite(media?.duration) && media.duration > 0 ? Math.round(media.duration) : null;
    const message = { type: 'BQ_STATUS', runId: config.runId, url: location.href, status: next, title: title(), duration };
    const key = JSON.stringify(message);
    if (lastReport === key) return;
    lastReport = key;
    void send(message);
  }
  function reportProgress(force = false) {
    if (!matching() || completed || !media) return;
    const now = Date.now();
    if (!force && now - lastProgressAt < 1000) return;
    const currentTime = Number.isFinite(media.currentTime) ? Math.max(0, Math.round(media.currentTime * 100) / 100) : 0;
    const duration = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : null;
    const key = `${config.runId}:${currentTime}:${duration}`;
    if (!force && lastProgressKey === key) return;
    lastProgressAt = now; lastProgressKey = key;
    void send({ type: 'BQ_PROGRESS', runId: config.runId, url: location.href, currentTime, duration });
  }
  function onTimeUpdate() { reportProgress(); }
  function onSeeked() { reportProgress(true); }
  function hideNotice() { clearTimeout(noticeTimer); notice?.remove(); notice = null; }
  function showNotice(text, action, temporary = false) {
    if (!document.documentElement) return;
    hideNotice();
    notice = document.createElement('div');
    notice.style.cssText = 'position:fixed;left:22px;bottom:24px;z-index:2147483647;';
    const root = notice.attachShadow({ mode: 'closed' });
    const box = document.createElement('div');
    box.style.cssText = 'font:14px/1.6 system-ui,sans-serif;background:#172333;color:white;padding:13px 16px;border-radius:12px;box-shadow:0 6px 26px #0004;max-width:340px;';
    const label = document.createElement('span');
    label.textContent = `bilibili-queue · ${text}`;
    box.append(label);
    if (action) {
      const button = document.createElement('button');
      button.textContent = '点击播放';
      button.style.cssText = 'margin-left:10px;border:0;border-radius:6px;background:#f378a0;color:#172333;padding:5px 9px;cursor:pointer;font:inherit';
      button.addEventListener('click', action);
      box.append(button);
    }
    root.append(box);
    document.documentElement.append(notice);
    if (temporary) noticeTimer = setTimeout(hideNotice, 4500);
  }
  function findMedia() {
    const videos = [...document.querySelectorAll('.bpx-player-video-wrap video, .bilibili-player-video video, #bilibili-player video')];
    return videos.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0] || null;
  }
  async function tryPlay() {
    if (!media || !matching() || completed) return;
    const current = media;
    userPaused = false;
    try {
      await current.play();
      if (matching() && current === media) { hideNotice(); report('playing'); }
    } catch (error) {
      if (!matching() || current !== media) return;
      if (current.error || error.name === 'NotSupportedError') { onError(); return; }
      if (error.name === 'NotAllowedError') {
        report('blocked');
        showNotice('浏览器需要你点击一次播放', () => { void tryPlay(); });
      } else {
        report('paused');
        showNotice('视频尚未就绪，可在播放器内点击播放', () => { void tryPlay(); });
      }
    }
  }
  function detach(pause = false) {
    if (media) {
      media.loop = previousLoop;
      media.removeEventListener('playing', onPlaying);
      media.removeEventListener('pause', onPause);
      media.removeEventListener('timeupdate', onTimeUpdate);
      media.removeEventListener('seeked', onSeeked);
      media.removeEventListener('waiting', onWaiting);
      media.removeEventListener('stalled', onWaiting);
      media.removeEventListener('error', onError);
      if (pause) media.pause();
    }
    media = null;
    attempted = false;
  }
  function deactivate(pause = false) {
    config = null;
    detach(pause);
    hideNotice();
  }
  function onPlaying() { if (matching()) { attempted = true; userPaused = false; hideNotice(); report('playing'); reportProgress(true); } }
  function onPause() { if (matching() && !media?.ended) { userPaused = true; report('paused'); reportProgress(true); } }
  function onWaiting() { if (matching() && !userPaused && !media?.ended) report('buffering'); }
  function onError() {
    if (!matching()) return;
    report('error'); reportProgress(true);
    showNotice('视频加载失败，请检查播放页或手动切换下一条');
  }
  function finish(event) {
    if (!matching() || !media || (event && event.target !== media)) return;
    if (!media.ended || !Number.isFinite(media.duration) || media.duration <= 0) return;
    // Prevent the site's own next-video handler from racing the queue navigation.
    event?.stopImmediatePropagation();
    if (completed) return;
    completed = true;
    const message = { type: 'BQ_ENDED', runId: config.runId, url: location.href };
    void send(message).then(result => {
      if (!result?.ok || result.ignored) showNotice('切换失败，请打开扩展点击下一条', null, true);
    });
  }
  window.addEventListener('ended', finish, true);

  function tick() {
    syncPlayerSpeed();
    if (location.href !== lastURL) { void sync(); return; }
    if (!matching()) return;
    const found = findMedia();
    if (found !== media) {
      detach();
      media = found;
      if (media) {
        previousLoop = media.loop;
        media.addEventListener('playing', onPlaying);
        media.addEventListener('pause', onPause);
        media.addEventListener('timeupdate', onTimeUpdate);
        media.addEventListener('seeked', onSeeked);
        media.addEventListener('waiting', onWaiting);
        media.addEventListener('stalled', onWaiting);
        media.addEventListener('error', onError);
      }
    }
    if (!media) {
      if (Date.now() - startedAt > 20000) report('missing');
      return;
    }
    media.loop = false;
    if (media.error) { if (status !== 'error') onError(); return; }
    if (media.ended) { finish(); return; }
    if (userPaused && status !== 'paused') report('paused');
    if (media.readyState >= 1 && status) report(status);
    if (media.readyState >= 1) reportProgress();
    if (!attempted && media.readyState >= 2 && !userPaused) {
      attempted = true;
      void tryPlay();
    }
    if (media.readyState < 2 && !userPaused && Date.now() - startedAt > 20000) report('buffering');
  }
  async function sync() {
    if (syncing) return;
    syncing = true;
    try {
      const url = location.href;
      if (url !== lastURL) { deactivate(); lastURL = url; }
      const result = await send({ type: 'BQ_HELLO', url });
      if (url !== location.href) { lastURL = ''; return; }
      syncPlayerSpeed();
      const next = result?.ok ? result.config : null;
      if (!next) { deactivate(); return; }
      if (next.runId !== config?.runId) {
        deactivate(); config = next; completed = false; userPaused = false; status = ''; lastReport = ''; lastProgressAt = 0; lastProgressKey = ''; startedAt = Date.now();
      }
      acceptRate(next);
      tick();
    } finally { syncing = false; }
  }
  window.addEventListener('keydown', event => {
    const right = event.key === 'ArrowRight' || event.keyCode === 102;
    if (!right && event.key !== '<' && event.key !== '>') return;
    if (!event.isTrusted || event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
    if (!videoPage() || !speedMedia) return;
    if (event.composedPath().some(target => target.isContentEditable || target.matches?.('input, textarea, select, [role="textbox"]'))) return;
    if (right) {
      if (event.shiftKey) return;
      rightHeld = true;
      clearTimeout(rateReleaseTimer);
      rateReleaseTimer = null;
      return; // Preserve native seek, long-press threshold, and temporary speed.
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat) return;
    void changePlayerSpeed({ step: event.key === '<' ? -1 : 1 });
  }, true);
  window.addEventListener('keyup', event => {
    if (event.key === 'ArrowRight' || event.keyCode === 102) releaseNativeRate();
  }, true);
  window.addEventListener('blur', releaseNativeRate);
  window.addEventListener('contextmenu', releaseNativeRate, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseNativeRate(); });
  window.addEventListener('click', event => {
    if (!event.isTrusted || !videoPage()) return;
    const item = event.target.closest?.(rateItemSelector);
    if (!item || !item.closest('.bpx-player-ctrl-playbackrate-menu')) return;
    const rate = Number(item.dataset.value);
    if (playbackRates.includes(rate)) void changePlayerSpeed({ value: rate });
  }, true);

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type === 'BQ_GET_SPEED') {
      respond(videoPage() && speedURL === location.href && speedMedia ? {
        url: location.href, playbackRate: speedMedia.playbackRate,
        fixedRate: ratePreference.playbackRate,
        temporary: nativeRateHintVisible() || rightHeld && speedMedia.playbackRate !== ratePreference.playbackRate
      } : null);
      return;
    }
    if (message.type === 'BQ_RATE' && message.runId === config?.runId && matching()) acceptRate(message);
    if (message.type === 'BQ_STOP') { clearRateFeedback(); deactivate(true); }
    if (message.type === 'BQ_FINISH') { clearRateFeedback(); deactivate(); showNotice('队列播放已结束', null, true); }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.playlist) acceptRate(changes.playlist.newValue);
    if (area !== 'session' || !changes.playback) return;
    const next = changes.playback.newValue;
    if (config && (!next?.running || next.runId !== config.runId)) deactivate();
  });
  // Handles SPA navigation and replacement of the HTML5 player. Never resumes a user pause.
  setInterval(tick, 750);
  void chrome.storage.local.get('playlist').then(result => {
    acceptRate({ playbackRate: 1, rateRevision: 0, ...result.playlist });
    syncPlayerSpeed();
  }).catch(() => {});
  void sync();
})();
