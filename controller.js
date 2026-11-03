import { parseVideo, splitInput, videoURL, matchesRun } from './parser.js';
import { fetchVideoMetadata, metadataForPage, validDuration } from './metadata.js';
import { playbackOrder } from './playback.js';

const PLAYBACK_RATES = [1, 1.5, 2, 3];
const initialList = () => ({ items: [], selectedId: null, loop: false, direction: 'forward', playbackRate: 1, rateRevision: 0, generation: 'initial' });
const initialSession = () => ({ running: false, tabId: null, runId: null, itemId: null, documentId: null, status: 'ready', note: '', currentTime: 0, mediaDuration: null, progressUpdatedAt: null });

export function createController(api, fetcher = fetch) {
  let chain = Promise.resolve();
  let importChain = Promise.resolve();
  const serial = fn => {
    const result = chain.then(fn);
    chain = result.catch(() => {});
    return result;
  };
  const metadataJobs = new Map();
  function assertUI(sender) {
    if (sender.id !== api.runtime.id || !sender.url?.startsWith(api.runtime.getURL(''))) throw new Error('不允许此来源修改播放列表');
  }
  async function resolveInputs(tokens) {
    const results = new Array(tokens.length), shortRequests = new Map();
    const deadline = Date.now() + 20000;
    let cursor = 0;
    async function resolveShort(url) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('短链解析超时，请分批添加或使用完整视频链接');
      const response = await fetcher(url, { redirect: 'follow', credentials: 'omit', signal: AbortSignal.timeout(Math.min(8000, remaining)) });
      if (!response.ok) throw new Error('短链解析失败，请使用完整视频链接');
      const parsed = parseVideo(response.url);
      if (parsed.shortUrl) throw new Error('短链未跳转到视频，请改用完整链接');
      return parsed;
    }
    async function worker() {
      while (cursor < tokens.length) {
        const index = cursor++, token = tokens[index];
        try {
          let parsed = parseVideo(token);
          if (parsed.shortUrl) {
            if (!shortRequests.has(parsed.shortUrl)) shortRequests.set(parsed.shortUrl, resolveShort(parsed.shortUrl));
            parsed = await shortRequests.get(parsed.shortUrl);
          }
          results[index] = { token, parsed };
        } catch (error) { results[index] = { token, error: error?.message || '链接解析失败' }; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, tokens.length) }, () => worker()));
    return results;
  }
  let activeMetadata = 0;
  function scheduleMetadata(items) {
    for (const item of items) {
      if (item.metadataStatus === 'error' || (item.title && validDuration(item.duration) && item.metadataStatus !== 'loading' && item.coverChecked)) continue;
      let job = metadataJobs.get(item.bvid);
      if (!job) { job = { bvid: item.bvid, ids: new Set(), started: false }; metadataJobs.set(item.bvid, job); }
      job.ids.add(item.id);
    }
    pumpMetadata();
  }
  function pumpMetadata() {
    for (const job of metadataJobs.values()) {
      if (activeMetadata >= 3) break;
      if (job.started) continue;
      job.started = true;
      activeMetadata++;
      void updateMetadata(job).catch(console.error).finally(() => {
        metadataJobs.delete(job.bvid);
        activeMetadata--;
        pumpMetadata();
      });
    }
  }
  async function updateMetadata(job) {
    let data, failure;
    try { data = await fetchVideoMetadata(job.bvid, fetcher); }
    catch (error) { failure = error?.name === 'TimeoutError' ? '获取超时，请点击刷新信息重试' : error?.message || '视频信息获取失败，请稍后刷新'; }
    // Fetch outside the command lock so slow metadata never blocks playback.
    await serial(async () => {
      const state = await load();
      let changed = false;
      for (const item of state.list.items) {
        if (!job.ids.has(item.id) || item.bvid !== job.bvid) continue;
        if (failure) {
          // A playable page may have supplied the missing details while fetching.
          if (item.metadataStatus === 'ready') { item.coverChecked = true; changed = true; continue; }
          item.coverChecked = true;
          item.metadataStatus = 'error'; item.metadataError = failure || '获取失败，请重试';
        } else Object.assign(item, metadataForPage(data, item.page));
        changed = true;
      }
      if (changed) await save(state);
    });
  }
  async function load() {
    const [local, session] = await Promise.all([api.storage.local.get('playlist'), api.storage.session.get('playback')]);
    const list = { ...initialList(), ...local.playlist };
    if (!PLAYBACK_RATES.includes(list.playbackRate)) list.playbackRate = 1;
    if (!Number.isSafeInteger(list.rateRevision) || list.rateRevision < 0) list.rateRevision = 0;
    return { list, session: { ...initialSession(), ...session.playback } };
  }
  async function save(state) {
    if (state.session.status === 'finished' && playbackOrder(state.list).at(-1)?.id !== state.session.itemId) {
      state.session.status = 'stopped';
      state.session.note = '列表或方向已更新，请重新开始播放';
    }
    await api.storage.local.set({ playlist: state.list });
    await api.storage.session.set({ playback: state.session });
    await api.action.setBadgeText({ text: state.session.running ? String(state.list.items.findIndex(x => x.id === state.session.itemId) + 1) : '' });
    await api.action.setBadgeBackgroundColor({ color: '#e35b86' });
  }
  async function signal(session, type, fields = {}) {
    if (session.tabId == null) return;
    try { await api.tabs.sendMessage(session.tabId, { type, ...fields }, { frameId: 0 }); } catch { /* page may be closed or loading */ }
  }
  async function stop(state, note, pause = true, status = 'stopped') {
    const old = { ...state.session };
    state.session = { ...state.session, running: false, runId: null, documentId: null, status, note };
    await signal(old, pause ? 'BQ_STOP' : 'BQ_FINISH');
    await save(state);
  }
  async function start(state, id, focus = true, automatic = false) {
    const item = state.list.items.find(x => x.id === id);
    if (!item) throw new Error('请先添加视频');
    try {
      let tab;
      if (state.session.tabId != null) {
        try {
          const existing = await api.tabs.get(state.session.tabId);
          if (existing.url?.startsWith('https://www.bilibili.com/')) tab = existing;
        } catch { /* closed tab */ }
      }
      if (automatic) {
        const previous = state.list.items.find(row => row.id === state.session.itemId);
        if (!tab || !previous || !matchesRun(tab.pendingUrl || tab.url, previous, state.session.runId)) {
          await stop(state, '播放页已关闭或切换，队列已停止', false);
          return;
        }
      }
      // Only an explicit start may create a new tab. Auto-next must respect a close.
      await signal(state.session, 'BQ_STOP');
      if (!tab) tab = await api.tabs.create({ url: 'about:blank', active: focus });
      state.list.selectedId = id;
      const runId = crypto.randomUUID();
      state.session = { ...initialSession(), running: true, tabId: tab.id, runId, itemId: id, status: 'loading', note: '正在加载播放页…' };
      await save(state);
      await api.tabs.update(tab.id, { url: videoURL(item, runId), ...(focus ? { active: true } : {}) });
    } catch (error) {
      await stop(state, '打开播放页失败，请重试');
      throw error;
    }
  }
  async function step(state, delta, automatic = false) {
    const items = playbackOrder(state.list);
    if (!items.length) throw new Error('请先添加视频');
    const index = items.findIndex(x => x.id === state.session.itemId);
    if (index < 0) { await start(state, items[0].id, !automatic, automatic); return; }
    let next = index + delta;
    if (next >= items.length) {
      if (state.list.loop) next = 0;
      else if (automatic) { await stop(state, '列表已播放完毕', false, 'finished'); return; }
      else throw new Error('已经是当前播放方向的最后一条');
    }
    if (next < 0) {
      if (state.list.loop) next = items.length - 1;
      else throw new Error('已经是当前播放方向的第一条');
    }
    await start(state, items[next]?.id, !automatic, automatic);
  }
  function trustedContent(sender) {
    return sender.tab && sender.frameId === 0 && sender.id === api.runtime.id;
  }
  function authorized(state, message, sender) {
    const item = state.list.items.find(x => x.id === state.session.itemId);
    return trustedContent(sender) && state.session.running && sender.tab.id === state.session.tabId && item &&
      message.runId === state.session.runId && matchesRun(message.url, item, state.session.runId) &&
      (!state.session.documentId || state.session.documentId === sender.documentId);
  }
  async function dispatch(message, sender = {}, prepared = null, generation = null) {
    const state = await load();
    const { list, session } = state;
    if (message?.type === 'BQ_HELLO') {
      const item = list.items.find(x => x.id === session.itemId);
      if (!trustedContent(sender) || !session.running || sender.tab.id !== session.tabId || !item || !matchesRun(message.url, item, session.runId)) return { config: null };
      session.documentId = sender.documentId;
      await save(state);
      return { config: { runId: session.runId, itemId: item.id, bvid: item.bvid, page: item.page, playbackRate: list.playbackRate, rateRevision: list.rateRevision } };
    }
    if (message?.type === 'BQ_PROGRESS') {
      if (!authorized(state, message, sender)) return { ignored: true };
      if (typeof message.currentTime !== 'number' || !Number.isFinite(message.currentTime) || message.currentTime < 0) return { ignored: true };
      if (validDuration(message.duration)) session.mediaDuration = message.duration;
      session.currentTime = validDuration(session.mediaDuration) ? Math.min(message.currentTime, session.mediaDuration) : message.currentTime;
      session.progressUpdatedAt = Date.now();
      // Frequent progress updates stay in session storage; the playlist is not rewritten.
      await api.storage.session.set({ playback: session });
      return {};
    }
    if (message?.type === 'BQ_ENDED' || message?.type === 'BQ_STATUS') {
      if (!authorized(state, message, sender)) return { ignored: true };
      if (message.type === 'BQ_ENDED') {
        const item = list.items.find(x => x.id === session.itemId);
        session.currentTime = session.mediaDuration || item?.duration || session.currentTime;
        await step(state, 1, true);
      }
      else {
        const notes = { playing: '正在播放', paused: '视频已暂停，点击播放器可继续', blocked: '请在视频页点击播放，允许有声播放', missing: '未检测到播放器，请检查视频是否可观看', buffering: '正在缓冲，请稍候', error: '视频加载失败，请检查播放页或手动切换下一条' };
        if (!notes[message.status]) return { ignored: true };
        session.status = message.status;
        session.note = notes[message.status];
        const item = list.items.find(x => x.id === session.itemId);
        if (!item.title && typeof message.title === 'string' && message.title.trim()) item.title = message.title.trim().slice(0, 180);
        if (!validDuration(item.duration) && validDuration(message.duration)) item.duration = Math.round(message.duration);
        if (item.title && validDuration(item.duration)) { item.metadataStatus = 'ready'; item.metadataError = ''; }
        await save(state);
      }
      return { state };
    }
    // Queue-changing commands may only originate from an extension page.
    assertUI(sender);
    switch (message?.type) {
      case 'GET': break;
      case 'ADD': {
        if (!prepared || generation !== list.generation) throw new Error('列表已清空，本次添加已取消，请重新添加');
        const errors = [], failedTokens = [];
        const wasEmpty = list.items.length === 0;
        let added = 0;
        for (const { token, parsed, error } of prepared) {
          try {
            if (error) throw new Error(error);
            if (list.items.length >= 1000) throw new Error('列表最多保存 1000 条');
            const item = { id: crypto.randomUUID(), ...parsed, title: '', partTitle: '', duration: null, metadataStatus: 'loading', metadataError: '' };
            list.items.push(item);
            list.selectedId ??= item.id;
            added++;
          } catch (error) { errors.push(`${token}：${error.message}`); failedTokens.push(token); }
        }
        if (wasEmpty && added && !state.session.running) {
          state.session = { ...initialSession(), tabId: state.session.tabId, note: `已添加 ${added} 条视频，点击开始播放` };
        }
        await save(state);
        return { state, added, errors, failedTokens };
      }
      case 'START': await start(state, message.id ?? (session.running ? session.itemId : playbackOrder(list)[0]?.id)); break;
      case 'STOP': await stop(state, '已停止队列，视频已暂停'); break;
      case 'NEXT': await step(state, 1); break;
      case 'PREV': await step(state, -1); break;
      case 'LOOP': list.loop = Boolean(message.value); await save(state); break;
      case 'RATE':
        if (!PLAYBACK_RATES.includes(message.value)) throw new Error('请选择 1、1.5、2 或 3 倍速');
        list.playbackRate = message.value;
        list.rateRevision++;
        await save(state);
        if (session.running) await signal(session, 'BQ_RATE', { runId: session.runId, playbackRate: list.playbackRate, rateRevision: list.rateRevision });
        break;
      case 'DIRECTION':
        if (!['forward', 'reverse'].includes(message.value)) throw new Error('播放方向无效');
        list.direction = message.value; await save(state); break;
      case 'REORDER': {
        const from = list.items.findIndex(item => item.id === message.id);
        const target = list.items.findIndex(item => item.id === message.targetId);
        if (from < 0 || target < 0) throw new Error('列表已更新，请重新拖动');
        if (from === target) break;
        const [item] = list.items.splice(from, 1);
        const to = list.items.findIndex(row => row.id === message.targetId);
        list.items.splice(to + (message.placement === 'after' ? 1 : 0), 0, item);
        await save(state);
        break;
      }
      case 'REFRESH_METADATA':
        for (const item of list.items) { item.metadataStatus = 'loading'; item.metadataError = ''; }
        await save(state);
        break;
      case 'MOVE': {
        const index = list.items.findIndex(x => x.id === message.id);
        const target = index + (message.delta === -1 ? -1 : 1);
        if (index >= 0 && target >= 0 && target < list.items.length) {
          [list.items[index], list.items[target]] = [list.items[target], list.items[index]];
          await save(state);
        }
        break;
      }
      case 'REMOVE': {
        const index = list.items.findIndex(x => x.id === message.id);
        if (index < 0) break;
        if (session.running && session.itemId === message.id) await stop(state, '当前条目已删除，队列已停止');
        list.items.splice(index, 1);
        if (list.selectedId === message.id) list.selectedId = list.items[Math.min(index, list.items.length - 1)]?.id ?? null;
        await save(state);
        break;
      }
      case 'CLEAR': await stop(state, '列表已清空'); state.list = { ...initialList(), playbackRate: list.playbackRate, rateRevision: list.rateRevision, generation: crypto.randomUUID() }; await save(state); break;
      case 'FOCUS': {
        if (session.tabId == null) throw new Error('尚未打开播放页');
        const tab = await api.tabs.get(session.tabId);
        await api.tabs.update(tab.id, { active: true });
        await api.windows.update(tab.windowId, { focused: true });
        break;
      }
      default: throw new Error('未知操作');
    }
    return { state };
  }
  return {
    handle: async (message, sender) => {
      let result;
      if (message?.type === 'ADD') {
        const ticket = await serial(async () => {
          assertUI(sender ?? {});
          const tokens = splitInput(message.text);
          if (!tokens.length) throw new Error('请先输入 BV 号或视频链接');
          if (tokens.length > 200) throw new Error('每次最多添加 200 条视频');
          return { tokens, generation: (await load()).list.generation };
        });
        const imported = importChain.then(async () => {
          // Network work is outside the playback lock. Preserve batch submission order.
          const prepared = await resolveInputs(ticket.tokens);
          return serial(() => dispatch(message, sender, prepared, ticket.generation));
        });
        importChain = imported.catch(() => {});
        result = await imported;
      } else result = await serial(() => dispatch(message, sender));
      // GET also fills old lists and resumes an interrupted metadata fetch.
      if (['GET', 'ADD', 'REFRESH_METADATA'].includes(message?.type) && result.state) scheduleMetadata(result.state.list.items);
      return result;
    },
    tabRemoved: tabId => serial(async () => {
      const state = await load();
      if (state.session.tabId === tabId) { state.session.tabId = null; await stop(state, '播放标签页已关闭'); }
    }),
    navigated: (tabId, url) => serial(async () => {
      const state = await load();
      const item = state.list.items.find(x => x.id === state.session.itemId);
      if (state.session.running && state.session.tabId === tabId && item && !matchesRun(url, item, state.session.runId)) {
        const tab = await api.tabs.get(tabId).catch(() => null);
        if (tab && !matchesRun(tab.pendingUrl || tab.url, item, state.session.runId)) {
          await stop(state, '播放页已切换，队列已停止', false);
        }
      }
    })
  };
}
