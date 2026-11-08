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
  // Revisions prevent a delayed HELLO/storage read from undoing a newer selection.
  let ratePreference = { playbackRate: 1, rateRevision: -1 };

  function acceptRate(value) {
    if (!value || ![1, 1.5, 2, 3].includes(value.playbackRate)) return;
    const revision = Number.isSafeInteger(value.rateRevision) && value.rateRevision >= 0 ? value.rateRevision : 0;
    if (revision < ratePreference.rateRevision) return;
    ratePreference = { playbackRate: value.playbackRate, rateRevision: revision };
    applyRate();
  }
  function applyRate() {
    if (!media || !matching() || completed) return;
    const rate = ratePreference.playbackRate;
    // Neither play() nor seeking is needed; a paused video stays paused.
    if (media.defaultPlaybackRate !== rate) media.defaultPlaybackRate = rate;
    if (media.playbackRate !== rate) media.playbackRate = rate;
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
      media.removeEventListener('loadedmetadata', applyRate);
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
  function onPlaying() { if (matching()) { applyRate(); attempted = true; userPaused = false; hideNotice(); report('playing'); reportProgress(true); } }
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
        media.addEventListener('loadedmetadata', applyRate);
      }
    }
    if (!media) {
      if (Date.now() - startedAt > 20000) report('missing');
      return;
    }
    media.loop = false;
    applyRate();
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
    if (event.key !== '<' && event.key !== '>') return;
    if (!event.isTrusted || event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
    if (!matching() || completed) return;
    if (event.composedPath().some(target => target.isContentEditable || target.matches?.('input, textarea, select, [role="textbox"]'))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat) return;
    void send({ type: 'BQ_RATE_STEP', runId: config.runId, url: location.href, step: event.key === '<' ? -1 : 1 });
  }, true);

  chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'BQ_RATE' && message.runId === config?.runId && matching()) acceptRate(message);
    if (message.type === 'BQ_STOP') deactivate(true);
    if (message.type === 'BQ_FINISH') { deactivate(); showNotice('队列播放已结束', null, true); }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.playlist) acceptRate(changes.playlist.newValue);
    if (area !== 'session' || !changes.playback) return;
    const next = changes.playback.newValue;
    if (config && (!next?.running || next.runId !== config.runId)) deactivate();
  });
  // Handles SPA navigation and replacement of the HTML5 player. Never resumes a user pause.
  setInterval(tick, 750);
  void chrome.storage.local.get('playlist').then(result => acceptRate(result.playlist)).catch(() => {});
  void sync();
})();
