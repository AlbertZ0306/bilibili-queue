const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('node:path'), assert = require('node:assert/strict');
const extension = path.resolve(__dirname, '..');
const profile = path.join(process.env.BILI_AUDIT_WORKDIR || require('node:os').tmpdir(), `bili-speed-${Date.now()}`);
function wave() {
  const n = 8000 * 120, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b.toString('base64');
}
async function poll(fn) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); }
  throw Error('Playback-speed assertion timed out');
}
(async () => {
  const context = await chromium.launchPersistentContext(profile, {
    ...(process.env.BILI_TEST_BROWSER ? { executablePath: process.env.BILI_TEST_BROWSER } : { channel: 'chromium' }),
    headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 520, height: 600 }
  });
  try {
    const errors = []; context.on('weberror', e => errors.push(e.error().message));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await context.route('https://api.bilibili.com/**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 0, data: { title: '倍速测试', pages: [{ page: 1, duration: 120 }] } }) }));
    await context.route('https://www.bilibili.com/**', route => route.fulfill({ contentType: 'text/html', body: `<h1>倍速测试</h1><div class="bpx-player-video-wrap"><video muted controls style="width:600px;height:350px" src="data:audio/wav;base64,${wave()}"></video></div>` }));
    const page = await context.newPage();
    const popupURL = `chrome-extension://${worker.url().split('/')[2]}/popup.html`;
    await page.goto(popupURL);
    const cmd = (type, fields = {}) => page.evaluate(async ({ type, fields }) => {
      const r = await chrome.runtime.sendMessage({ type, ...fields }); if (!r.ok) throw Error(r.error); return r;
    }, { type, fields });
    await page.waitForSelector('#playback-rate');
    assert.equal(await page.locator('#playback-rate').inputValue(), '1');
    await page.locator('#playback-rate').selectOption('1.5');
    await poll(async () => (await cmd('GET')).state.list.playbackRate === 1.5);
    await cmd('ADD', { text: 'BV1xx411c7mD BV1Q541167Qg' }); await cmd('START');
    await poll(async () => (await cmd('GET')).state.session.status === 'playing');
    const videoPage = context.pages().find(p => p.url().startsWith('https://www.bilibili.com/'));
    const rate = () => videoPage.evaluate(() => document.querySelector('video')?.playbackRate);
    await poll(async () => await rate() === 1.5);
    console.log('PASS: speed selected before starting applies to actual HTML media');
    const url = videoPage.url();
    await videoPage.evaluate(() => { const v = document.querySelector('video'); v.pause(); v.currentTime = 20; });
    await poll(async () => (await cmd('GET')).state.session.status === 'paused');
    for (const value of ['2', '3', '1', '1.5']) {
      await page.locator('#playback-rate').selectOption(value);
      await poll(async () => await rate() === Number(value));
      const media = await videoPage.evaluate(() => { const v = document.querySelector('video'); return { paused: v.paused, time: v.currentTime, defaultRate: v.defaultPlaybackRate }; });
      assert(media.paused); assert(Math.abs(media.time - 20) < .01); assert.equal(media.defaultRate, Number(value));
      assert.equal(videoPage.url(), url);
    }
    console.log('PASS: 1x/1.5x/2x/3x apply immediately without resuming, seeking or navigating');
    await videoPage.evaluate(() => { document.querySelector('video').playbackRate = 1; });
    await poll(async () => await rate() === 1.5);
    await videoPage.evaluate(() => { const old = document.querySelector('video'), next = old.cloneNode(); old.replaceWith(next); next.load(); });
    await videoPage.waitForFunction(() => document.querySelector('video').readyState >= 2);
    await poll(async () => await rate() === 1.5);
    assert(await videoPage.evaluate(() => document.querySelector('video').paused));
    console.log('PASS: player speed reset and paused player-node replacement preserve preference');
    await page.locator('#playback-rate').selectOption('3');
    await poll(async () => await rate() === 3);
    await videoPage.evaluate(async () => { const v = document.querySelector('video'); v.currentTime = v.duration - .3; await v.play(); });
    await poll(() => videoPage.url() !== url);
    await poll(async () => (await cmd('GET')).state.session.status === 'playing');
    await poll(async () => await rate() === 3);
    assert(videoPage.url().includes('BV1Q541167Qg'));
    console.log('PASS: natural end advances to next video at saved 3x speed');
    await cmd('STOP'); await cmd('CLEAR'); await page.reload();
    await page.waitForFunction(() => document.getElementById('playback-rate')?.value === '3');
    console.log('PASS: clear and popup reopen retain speed');
    for (const width of [390, 520, 1100]) {
      await page.setViewportSize({ width, height: 600 });
      await page.waitForTimeout(100);
      const bounds = await page.locator('.queue-toolbar').evaluate(el => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, items: [...el.children].filter(x => getComputedStyle(x).display !== 'none').map(x => { const b = x.getBoundingClientRect(); return { left: b.left, right: b.right }; }), scroll: document.documentElement.scrollWidth };
      });
      assert(bounds.items.every((b, i) => b.left >= bounds.left && b.right <= bounds.right + .5 && (!i || b.left >= bounds.items[i - 1].right - .5)), JSON.stringify(bounds));
      assert(bounds.scroll <= width, `Horizontal overflow at ${width}px`);
    }
    assert.deepEqual(errors, []);
    console.log('PASS: toolbar controls fit at 390/520/1100px; no uncaught browser errors');
  } finally { await context.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
