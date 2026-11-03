import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const code = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function playerHarness() {
  let hello, stored, storageListener, messageListener, tick;
  const video = { playbackRate: 1, defaultPlaybackRate: 1, currentTime: 27, duration: 100, paused: true, readyState: 1, loop: false, clientWidth: 600, clientHeight: 350, addEventListener() {}, removeEventListener() {} };
  const location = { href: 'https://www.bilibili.com/video/BV1xx411c7mD/?bq_run=run' };
  vm.runInNewContext(code, {
    URL, Date, console, location,
    document: { querySelectorAll: () => [video], querySelector: () => null, title: '测试' },
    window: { addEventListener() {} },
    setInterval: fn => { tick = fn; }, setTimeout, clearTimeout,
    chrome: {
      runtime: { sendMessage: message => message.type === 'BQ_HELLO' ? new Promise(resolve => { hello = resolve; }) : Promise.resolve({ ok: true }), onMessage: { addListener: fn => { messageListener = fn; } } },
      storage: { local: { get: () => new Promise(resolve => { stored = resolve; }) }, onChanged: { addListener: fn => { storageListener = fn; } } }
    }
  });
  return { video, location, hello: config => hello({ ok: true, config }), stored: playlist => stored({ playlist }), changed: playlist => storageListener({ playlist: { newValue: playlist } }, 'local'), message: message => messageListener(message), tick: () => tick() };
}
const config = { bvid: 'BV1xx411c7mD', page: 1, runId: 'run', playbackRate: 1, rateRevision: 0 };

test('new speed wins over delayed HELLO, storage initialization and stale tab messages', async () => {
  const h = playerHarness();
  h.changed({ playbackRate: 3, rateRevision: 2 });
  h.hello(config); await flush();
  assert.equal(h.video.playbackRate, 3);
  h.stored({ playbackRate: 1, rateRevision: 0 }); await flush();
  h.message({ type: 'BQ_RATE', runId: 'run', playbackRate: 1.5, rateRevision: 1 });
  h.tick();
  assert.equal(h.video.playbackRate, 3);
  assert.equal(h.video.currentTime, 27); assert(h.video.paused);
});

test('speed preference never modifies an unmanaged video or applies an old run message', async () => {
  const h = playerHarness(); h.hello(config); h.stored({ playbackRate: 2, rateRevision: 1 }); await flush();
  assert.equal(h.video.playbackRate, 2);
  h.message({ type: 'BQ_RATE', runId: 'old-run', playbackRate: 3, rateRevision: 5 });
  assert.equal(h.video.playbackRate, 2);
  h.location.href = 'https://www.bilibili.com/video/BV1Q541167Qg/';
  h.changed({ playbackRate: 3, rateRevision: 2 });
  assert.equal(h.video.playbackRate, 2);
});
