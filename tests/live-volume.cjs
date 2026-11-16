// Opt-in network audit of native volume persistence with/without the extension.
// --mute-audio silences this test browser's output; it does not set video.muted.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('node:path'), fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const ids = ['BV1xx411c7mD', 'BV1Q541167Qg', 'BV1xx411c7mD'];
const baseline = process.argv.includes('--baseline');
const extension = path.resolve(__dirname, '..');
const work = path.join(process.env.BILI_AUDIT_WORKDIR || require('node:os').tmpdir(), `bili-volume-${baseline ? 'baseline' : 'extension'}-${Date.now()}`);
const report = { mode: baseline ? 'baseline' : 'extension', checks: [], pages: [] };

async function main() {
  const context = await chromium.launchPersistentContext(work, {
    ...(process.env.BILI_TEST_BROWSER ? { executablePath: process.env.BILI_TEST_BROWSER } : { channel: 'chromium' }),
    headless: true, viewport: { width: 1440, height: 950 },
    args: ['--mute-audio', ...(baseline ? ['--disable-extensions'] : [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`])]
  });
  try {
    await context.addInitScript(() => {
      window.bqVolumeTrace = [];
      function record(type, video) {
        if (!video?.matches?.('.bpx-player-video-wrap video, .bilibili-player-video video, #bilibili-player video')) return;
        const row = { type, at: Math.round(performance.now()), volume: video.volume, muted: video.muted, paused: video.paused, ready: video.readyState, position: video.currentTime };
        window.bqVolumeTrace.push(row);
        if (window.bqVolumeTrace.length > 600) window.bqVolumeTrace.shift();
      }
      for (const type of ['loadedmetadata', 'canplay', 'play', 'playing', 'pause', 'volumechange']) window.addEventListener(type, event => record(type, event.target), true);
      let previous = '';
      setInterval(() => {
        const video = document.querySelector('.bpx-player-video-wrap video');
        if (!video || video.paused || video.readyState < 3) return;
        const key = `${video.volume}:${video.muted}`;
        if (key !== previous) { previous = key; record('audible-state-sample', video); }
      }, 25);
    });
    let popup, command;
    if (!baseline) {
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      popup = await context.newPage(); await popup.goto(`chrome-extension://${worker.url().split('/')[2]}/popup.html`);
      await popup.waitForSelector('#playback-rate');
      command = (type, fields = {}) => popup.evaluate(async ({ type, fields }) => {
        const response = await chrome.runtime.sendMessage({ type, ...fields });
        if (!response.ok) throw Error(response.error); return response;
      }, { type, fields });
    }
    const snapshot = page => page.locator('video').evaluate(video => ({ volume: video.volume, muted: video.muted, paused: video.paused, rate: video.playbackRate, position: video.currentTime }));
    async function ready(page) {
      await page.locator('.bpx-player-ctrl-volume').waitFor({ state: 'attached', timeout: 30000 });
      await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2, null, { timeout: 30000 });
      if (!baseline) await page.locator('[data-bq-rate="3"]').waitFor({ state: 'attached', timeout: 30000 });
      await page.waitForTimeout(1100);
    }
    async function expectVolume(page, expected, label, startup = false) {
      const state = await snapshot(page);
      assert(Math.abs(state.volume - expected) < .005, `${label}: ${JSON.stringify(state)}`);
      assert.equal(state.muted, false, `${label}: unexpectedly muted`);
      const trace = await page.evaluate(() => window.bqVolumeTrace);
      if (startup) {
        const starts = trace.filter(event => ['playing', 'audible-state-sample'].includes(event.type));
        assert(starts.length > 0, `${label}: playback must actually start for a startup-volume check`);
        const loud = starts.filter(event => !event.muted && event.volume > expected + .005);
        assert.deepEqual(loud, [], `${label}: played above saved volume during initialization`);
      }
      report.checks.push({ label, ...state });
      if (startup) report.pages.push({ label, url: page.url(), trace });
      console.log(`PASS ${report.mode}: ${label}, volume=${Math.round(state.volume * 100)}%, muted=${state.muted}`);
    }
    async function setNativeVolume(page, value) {
      await page.locator('.bpx-player-ctrl-volume').focus();
      for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowDown');
      for (let i = 0; i < Math.round(value * 10); i++) await page.keyboard.press('ArrowUp');
      await page.waitForTimeout(400);
      await expectVolume(page, value, `native volume ${Math.round(value * 100)}%`);
    }
    const seed = await context.newPage();
    await seed.goto(`https://www.bilibili.com/video/${ids[0]}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await ready(seed); await setNativeVolume(seed, .2);
    await seed.locator('video').evaluate(video => video.pause());
    let page;
    if (baseline) {
      page = await context.newPage();
      await page.goto(`https://www.bilibili.com/video/${ids[0]}/?p=1&autoplay=1&t=0`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } else {
      await command('ADD', { text: ids.join(' ') });
      const created = context.waitForEvent('page'); await command('START'); page = await created;
      await page.waitForURL('**/*bq_run=*');
    }
    await ready(page); await expectVolume(page, .2, 'new playback tab inherits 20%', true);
    async function navigate(type, index) {
      if (baseline) await page.goto(`https://www.bilibili.com/video/${ids[index]}/?p=1&autoplay=1&t=0`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      else { const previousURL = page.url(); await command(type); await page.waitForURL(url => url.href !== previousURL); }
      await ready(page);
    }
    await page.locator('video').evaluate(async video => { video.pause(); await video.play(); });
    await expectVolume(page, .2, 'pause and resume retain 20%');
    if (!baseline) {
      for (const value of [.5, 1.5, 2, 3]) {
        await command('RATE', { value });
        await page.waitForFunction(value => document.querySelector('video').playbackRate === value, value);
        await expectVolume(page, .2, `fixed ${value}x retains volume`);
      }
      await command('RATE', { value: 1 });
    }
    await setNativeVolume(page, .7);
    await navigate('NEXT', 1); await expectVolume(page, .7, 'different BV next retains 70%', true);
    await page.locator('.bpx-player-ctrl-volume').focus(); await page.keyboard.press('m');
    await expectVolume(page, 0, 'native M mutes with volume zero');
    await navigate('PREV', 0); await expectVolume(page, 0, 'previous BV retains silence', true);
    await page.locator('.bpx-player-ctrl-volume').focus(); await page.keyboard.press('m');
    await expectVolume(page, .7, 'native M restores previous nonzero volume');
    await setNativeVolume(page, .2);
    if (!baseline) {
      const previousURL = page.url();
      await page.locator('video').evaluate(async video => { video.currentTime = video.duration - .25; await video.play(); });
      await page.waitForURL(url => url.href !== previousURL, { timeout: 30000 }); await ready(page);
    } else await navigate('NEXT', 1);
    await expectVolume(page, .2, baseline ? 'equivalent reload retains 20%' : 'natural ended advances at 20%', true);
    if (!baseline) {
      await command('STOP'); await expectVolume(page, .2, 'stop retains volume');
      assert((await snapshot(page)).paused);
      const previousURL = page.url(); await command('START'); await page.waitForURL(url => url.href !== previousURL); await ready(page);
      await expectVolume(page, .2, 'restart retains 20%', true);
      const tabId = (await command('GET')).state.session.tabId;
      await popup.evaluate(tabId => chrome.tabs.update(tabId, { muted: true }), tabId);
      await navigate('NEXT', 1); await expectVolume(page, .2, 'tab mute does not reset player volume', true);
      const tabMuted = await popup.evaluate(async tabId => (await chrome.tabs.get(tabId)).mutedInfo.muted, tabId);
      assert.equal(tabMuted, true, 'queue navigation must retain Chrome tab mute');
      await popup.evaluate(tabId => chrome.tabs.update(tabId, { muted: false }), tabId);
      await command('STOP');
      console.log('PASS extension: Chrome tab mute survives queue navigation');
    }
    report.passed = true;
  } catch (error) { report.error = error.stack; throw error; }
  finally {
    await fs.writeFile(path.join(work, 'volume-report.json'), JSON.stringify(report, null, 2));
    console.log('Volume report:', path.join(work, 'volume-report.json'));
    await context.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
