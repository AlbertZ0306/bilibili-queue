import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../controller.js';
import { parseVideo, splitInput, matchesRun, videoURL } from '../parser.js';

const BV1 = 'BV1xx411c7mD', BV2 = 'BV1Q541167Qg';
function harness() {
  const db = { local: {}, session: {} };
  const clone = value => structuredClone(value);
  const areas = Object.fromEntries(Object.keys(db).map(area => [area, {
    get: async key => ({ [key]: clone(db[area][key]) }),
    set: async values => Object.assign(db[area], clone(values))
  }]));
  const tabs = new Map(); const signals = []; let id = 0;
  const api = {
    storage: areas,
    runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}` },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabs: {
      get: async id => { if (!tabs.has(id)) throw Error('closed'); return clone(tabs.get(id)); },
      create: async props => { const tab = { id: ++id, windowId: 1, ...props }; tabs.set(id, tab); return clone(tab); },
      update: async (id, props) => { if (!tabs.has(id)) throw Error('closed'); Object.assign(tabs.get(id), props); return clone(tabs.get(id)); },
      sendMessage: async (id, message) => { signals.push({ id, message, snapshot: clone(db.session) }); }
    }, windows: { update: async () => {} }
  };
  let controller = createController(api, async url => ({ ok: true, url: `https://www.bilibili.com/video/${BV2}/?p=2` }));
  const ui = { id: 'test', url: 'chrome-extension://test/popup.html' };
  const command = (type, fields = {}) => controller.handle({ type, ...fields }, ui);
  const current = () => clone(db.session.playback);
  const contentSender = () => ({ id: 'test', tab: { id: current().tabId }, frameId: 0, documentId: `doc-${current().runId}`, url: tabs.get(current().tabId).url });
  const content = async (type, fields = {}, overrideSender) => {
    const s = current();
    return controller.handle({ type, url: tabs.get(s.tabId)?.url, runId: s.runId, ...fields }, overrideSender || contentSender());
  };
  return { db, tabs, signals, api, command, content, contentSender, current,
    restartWorker() { controller = createController(api); } };
}

test('playback speed defaults to normal and persists through worker restart and clearing', async () => {
  const h = harness();
  assert.equal((await h.command('GET')).state.list.playbackRate, 1);
  await h.command('RATE', { value: 3 });
  h.restartWorker();
  assert.equal((await h.command('GET')).state.list.playbackRate, 3);
  const cleared = (await h.command('CLEAR')).state.list;
  assert.equal(cleared.playbackRate, 3);
  assert.equal(cleared.rateRevision, 1);
});

test('all supported speeds reach the active player without navigating or resetting progress', async () => {
  const h = harness();
  await h.command('ADD', { text: `${BV1} ${BV2}` });
  await h.command('START'); await h.content('BQ_HELLO');
  await h.content('BQ_PROGRESS', { currentTime: 12, duration: 60 });
  const before = h.current(); const url = h.tabs.get(before.tabId).url;
  for (const value of [1.5, 2, 3, 1]) {
    await h.command('RATE', { value });
    const signal = h.signals.at(-1);
    assert.equal(signal.message.type, 'BQ_RATE');
    assert.equal(signal.message.playbackRate, value);
    assert.equal(signal.message.runId, before.runId);
    assert.equal(h.current().currentTime, 12);
    assert.equal(h.tabs.get(before.tabId).url, url);
  }
  await h.command('RATE', { value: 2 });
  await h.content('BQ_ENDED');
  const next = await h.content('BQ_HELLO');
  assert.equal(next.config.playbackRate, 2);
  assert.equal(next.config.rateRevision, 5);
});

test('invalid speed and content-page attempts cannot change the saved preference', async () => {
  const h = harness();
  for (const value of [0, -1, 1.25, 4, Infinity, NaN, '2', null]) await assert.rejects(h.command('RATE', { value }));
  await assert.rejects(createController(h.api).handle({ type: 'RATE', value: 3 }, { id: 'test', url: 'https://www.bilibili.com/', tab: { id: 1 }, frameId: 0 }));
  assert.equal((await h.command('GET')).state.list.playbackRate, 1);
  assert.equal(h.signals.length, 0);
});

test('legacy playlists gain a default speed and corrupt preferences are normalized', async () => {
  const h = harness(); h.db.local.playlist = { items: [], direction: 'reverse' };
  assert.equal((await h.command('GET')).state.list.playbackRate, 1);
  assert.equal((await h.command('GET')).state.list.direction, 'reverse');
  h.db.local.playlist.playbackRate = -8; h.db.local.playlist.rateRevision = NaN;
  const { list } = (await h.command('GET')).state;
  assert.equal(list.playbackRate, 1); assert.equal(list.rateRevision, 0);
});

test('parse BV, p, mobile URL, multiple separators, and reject external or malformed links', () => {
  assert.deepEqual(parseVideo(BV1), { bvid: BV1, page: 1 });
  assert.deepEqual(parseVideo(`https://m.bilibili.com/video/${BV1}?p=3&share_source=copy`), { bvid: BV1, page: 3 });
  assert.deepEqual(parseVideo('https://b23.tv/abc123'), { shortUrl: 'https://b23.tv/abc123' });
  assert.equal(splitInput(`${BV1}，${BV2}\n${BV1}`).length, 3);
  for (const url of [`https://evil.test/video/${BV1}`, `https://www.bilibili.com.evil.test/video/${BV1}`, `https://user@www.bilibili.com/video/${BV1}`, `https://www.bilibili.com/video/${BV1}?p=-1`, 'javascript:alert(1)', 'BV123']) assert.throws(() => parseVideo(url));
  assert(matchesRun(videoURL({ bvid: BV1, page: 2 }, 'run'), { bvid: BV1, page: 2 }, 'run'));
});

test('partial add preserves order and duplicates; short links resolve to a video', async () => {
  const h = harness();
  const result = await h.command('ADD', { text: `${BV1}\nnope\n${BV1}\nhttps://b23.tv/abc` });
  assert.equal(result.added, 3); assert.equal(result.errors.length, 1);
  assert.deepEqual(result.state.list.items.map(x => [x.bvid, x.page]), [[BV1,1],[BV1,1],[BV2,2]]);
  assert.notEqual(result.state.list.items[0].id, result.state.list.items[1].id);
});

test('ended advances once, rejects stale or wrong-tab events, then finishes at list end', async () => {
  const h = harness(); await h.command('ADD', { text: `${BV1}\n${BV2}` }); await h.command('START');
  await h.content('BQ_HELLO');
  const old = h.current(); const oldSender = h.contentSender(); const oldURL = h.tabs.get(old.tabId).url;
  assert((await h.content('BQ_ENDED', {}, { ...oldSender, tab: { id: 999 } })).ignored);
  await h.content('BQ_ENDED'); const next = h.current();
  assert.notEqual(next.itemId, old.itemId); assert.equal(next.tabId, old.tabId);
  assert((await h.content('BQ_ENDED', { url: oldURL, runId: old.runId }, oldSender)).ignored);
  assert.equal(h.current().itemId, next.itemId);
  await h.content('BQ_HELLO'); await h.content('BQ_ENDED');
  assert.equal(h.current().running, false); assert.equal(h.current().status, 'finished');
});

test('loop handles duplicate videos with a distinct navigation token', async () => {
  const h = harness(); await h.command('ADD', { text: BV1 }); await h.command('LOOP', { value: true }); await h.command('START');
  const firstURL = h.tabs.get(h.current().tabId).url; await h.content('BQ_HELLO'); await h.content('BQ_ENDED');
  assert(h.current().running); assert.notEqual(h.tabs.get(h.current().tabId).url, firstURL);
});

test('worker suspension, reordering and current deletion preserve queue invariants', async () => {
  const h = harness(); const added = await h.command('ADD', { text: `${BV1} ${BV2}` }); await h.command('START');
  const playing = h.current(); h.restartWorker(); await h.content('BQ_HELLO');
  await h.command('MOVE', { id: playing.itemId, delta: 1 });
  assert.equal(h.current().itemId, playing.itemId);
  await h.command('REMOVE', { id: playing.itemId }); assert(!h.current().running);
  const state = (await h.command('GET')).state;
  assert.equal(state.list.items.length, 1); assert.equal(state.list.selectedId, added.state.list.items[1].id);
});

test('stop pauses before storage notification detaches the content player', async () => {
  const h = harness(); await h.command('ADD', { text: BV1 }); await h.command('START'); await h.command('STOP');
  const last = h.signals.at(-1); assert.equal(last.message.type, 'BQ_STOP'); assert.equal(last.snapshot.playback.running, true);
  assert(!h.current().running);
});

test('closed or manually navigated tabs stop the session; unrelated tabs are not reused', async () => {
  const h = harness(); await h.command('ADD', { text: BV1 }); await h.command('START');
  const tab = h.current().tabId;
  h.tabs.get(tab).url = 'https://example.com/'; await h.restartWorker();
  // Use the public factory for browser event handling.
  const events = createController(h.api); await events.navigated(tab, 'https://example.com/');
  assert(!h.current().running);
  await h.command('START'); assert.notEqual(h.current().tabId, tab);
  const newTab = h.current().tabId; h.tabs.delete(newTab); await events.tabRemoved(newTab);
  assert(!h.current().running); assert.equal(h.current().tabId, null);
});

test('concurrent additions serialize and page messages cannot edit the queue', async () => {
  const h = harness();
  await Promise.all([h.command('ADD', { text: BV1 }), h.command('ADD', { text: BV2 })]);
  assert.equal((await h.command('GET')).state.list.items.length, 2);
  const c = createController(h.api);
  await assert.rejects(c.handle({ type: 'CLEAR' }, { id: 'test', url: 'https://www.bilibili.com/', tab: { id: 1 }, frameId: 0 }));
});

test('reverse mode starts at the bottom, advances upward, and finishes at the top', async () => {
  const h = harness(); const added = await h.command('ADD', { text: `${BV1} ${BV2} ${BV1}` });
  const ids = added.state.list.items.map(x => x.id);
  await h.command('DIRECTION', { value: 'reverse' }); await h.command('START');
  assert.equal(h.current().itemId, ids[2]);
  await h.content('BQ_HELLO'); await h.content('BQ_ENDED'); assert.equal(h.current().itemId, ids[1]);
  await h.content('BQ_HELLO'); await h.content('BQ_ENDED'); assert.equal(h.current().itemId, ids[0]);
  await h.content('BQ_HELLO'); await h.content('BQ_ENDED'); assert.equal(h.current().status, 'finished');
});

test('reverse previous/next and looping follow the chosen playback direction', async () => {
  const h = harness(); const added = await h.command('ADD', { text: `${BV1} ${BV2} ${BV1}` });
  const ids = added.state.list.items.map(x => x.id);
  await h.command('DIRECTION', { value: 'reverse' }); await h.command('LOOP', { value: true }); await h.command('START');
  await h.command('PREV'); assert.equal(h.current().itemId, ids[0]);
  await h.command('NEXT'); assert.equal(h.current().itemId, ids[2]);
  await h.command('NEXT'); assert.equal(h.current().itemId, ids[1]);
  const runId = h.current().runId;
  await h.command('DIRECTION', { value: 'forward' }); assert.equal(h.current().runId, runId);
  await h.command('NEXT'); assert.equal(h.current().itemId, ids[2]);
});

test('drag reordering uses entry IDs, preserves playing identity, and affects the next item', async () => {
  const h = harness(); const added = await h.command('ADD', { text: `${BV1} ${BV2} ${BV1}` });
  const ids = added.state.list.items.map(x => x.id);
  await h.command('START', { id: ids[0] }); const runId = h.current().runId;
  await h.command('REORDER', { id: ids[2], targetId: ids[1], placement: 'before' });
  assert.deepEqual((await h.command('GET')).state.list.items.map(x => x.id), [ids[0], ids[2], ids[1]]);
  assert.equal(h.current().runId, runId);
  await h.command('NEXT'); assert.equal(h.current().itemId, ids[2]);
  await h.command('REORDER', { id: ids[0], targetId: ids[1], placement: 'after' });
  assert.deepEqual((await h.command('GET')).state.list.items.map(x => x.id), [ids[2], ids[1], ids[0]]);
  await assert.rejects(h.command('REORDER', { id: 'removed', targetId: ids[1] }), /列表已更新/);
});

test('media progress survives worker suspension, rejects stale events, and resets on navigation', async () => {
  const h = harness(); await h.command('ADD', { text: `${BV1} ${BV2}` }); await h.command('START'); await h.content('BQ_HELLO');
  await h.content('BQ_PROGRESS', { currentTime: 12.5, duration: 60 });
  assert.equal(h.current().currentTime, 12.5); assert.equal(h.current().mediaDuration, 60);
  h.restartWorker(); assert.equal((await h.command('GET')).state.session.currentTime, 12.5);
  assert((await h.content('BQ_PROGRESS', { currentTime: -1, duration: 60 })).ignored);
  assert((await h.content('BQ_PROGRESS', { currentTime: 20, runId: 'stale' })).ignored);
  assert.equal(h.current().currentTime, 12.5);
  await h.command('NEXT'); assert.equal(h.current().currentTime, 0); assert.equal(h.current().mediaDuration, null);
});

