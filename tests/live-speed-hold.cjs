// Opt-in network test against Bilibili's actual player, using a fresh browser profile.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

async function main() {
  const extension = path.resolve(__dirname, '..');
  const context = await chromium.launchPersistentContext(path.join(process.env.BILI_AUDIT_WORKDIR || require('node:os').tmpdir(), `bili-live-hold-${Date.now()}`), {
    ...(process.env.BILI_TEST_BROWSER ? { executablePath: process.env.BILI_TEST_BROWSER } : { channel: 'chromium' }),
    headless: true, viewport: { width: 1440, height: 950 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    await context.addInitScript(() => {
      window.bqTestRateEvents = [];
      for (const type of ['keydown', 'keyup', 'playing', 'pause', 'ratechange', 'loadedmetadata', 'blur']) {
        window.addEventListener(type, event => {
          window.bqTestRateEvents.push({ type, key: event.key, rate: document.querySelector('video')?.playbackRate });
          if (window.bqTestRateEvents.length > 60) window.bqTestRateEvents.shift();
        }, true);
      }
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${worker.url().split('/')[2]}/popup.html`);
    await popup.waitForSelector('#playback-rate');
    const command = (type, fields = {}) => popup.evaluate(async ({ type, fields }) => {
      const response = await chrome.runtime.sendMessage({ type, ...fields });
      if (!response.ok) throw Error(response.error); return response;
    }, { type, fields });
    const page = await context.newPage();
    async function ready(target) {
      await target.locator('[data-bq-rate="3"]').waitFor({ state: 'attached', timeout: 30000 });
      await target.locator('video').evaluate(async video => { video.muted = true; await video.play(); });
      // The speed menu and keyboard shortcuts mount in separate lazy-loaded modules.
      await target.waitForTimeout(1000);
    }
    const rate = target => target.locator('video').evaluate(video => video.playbackRate);
    const waitRate = (target, value) => target.waitForFunction(value => document.querySelector('video')?.playbackRate === value, value);
    async function hold(target) {
      await target.locator('.bpx-player-ctrl-playbackrate').focus();
      await target.keyboard.down('ArrowRight');
      try { await waitRate(target, 3); }
      catch (error) {
        console.error('Native hold diagnostics:', await target.evaluate(() => ({
          url: location.href, active: document.activeElement.outerHTML.slice(0, 200),
          paused: document.querySelector('video').paused, controls: document.querySelector('video').controls,
          hint: document.querySelector('.bpx-player-three-playrate-hint')?.textContent,
          events: window.bqTestRateEvents
        })));
        throw error;
      }
      await target.waitForTimeout(1100);
      assert.equal(await rate(target), 3);
    }
    async function release(target, fixed) {
      await target.keyboard.up('ArrowRight'); await waitRate(target, fixed);
      await target.waitForTimeout(850); assert.equal(await rate(target), fixed);
    }
    if (process.argv.includes('--queue')) {
      // Test queue playback in its own fresh visitor session. Bilibili may gate
      // native speed controls behind login on subsequent pages for some guests.
      await command('RATE', { value: 1.5 });
      await command('ADD', { text: 'BV1xx411c7mD BV1xx411c7mD' });
      const created = context.waitForEvent('page'); await command('START');
      const managed = await created;
      await managed.waitForURL('**/*bq_run=*'); await ready(managed); await waitRate(managed, 1.5);
      await managed.locator('video').evaluate(video => video.pause());
      await hold(managed); await release(managed, 1.5);
      const previousURL = managed.url();
      await command('NEXT'); await managed.waitForURL(url => url.href !== previousURL);
      await ready(managed); await waitRate(managed, 1.5);
      await command('STOP');
      console.log('PASS LIVE: native hold resumes a paused queued video; release restores fixed speed; next item retains fixed speed');
      return;
    }
    await page.goto('https://www.bilibili.com/video/BV1xx411c7mD/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await ready(page);
    for (const fixed of [1, 1.5, 2, 3]) {
      await command('RATE', { value: fixed }); await waitRate(page, fixed);
      await hold(page);
      assert.equal((await command('GET')).state.list.playbackRate, fixed);
      await popup.waitForFunction(() => !document.getElementById('speed-status').hidden && document.getElementById('speed-status').textContent.includes('临时 3×'));
      assert.equal(await popup.locator('#playback-rate').inputValue(), String(fixed));
      await release(page, fixed);
      await popup.waitForFunction(() => document.getElementById('speed-status').hidden);
    }
    console.log('PASS LIVE: real native long hold and restore at 1x/1.5x/2x/3x; popup displays temporary speed; saved preference is unchanged');

    await command('RATE', { value: 1.5 }); await waitRate(page, 1.5);
    await hold(page); await command('RATE', { value: 2 }); await page.waitForTimeout(900);
    assert.equal(await rate(page), 3); await release(page, 2);
    await hold(page); await page.keyboard.press('Shift+Comma');
    await page.waitForFunction(() => document.getElementById('bq-speed-feedback')?.getAttribute('aria-label') === '固定倍速 1.5×，松开后生效');
    await page.waitForTimeout(450);
    assert.equal(await rate(page), 3); assert.equal((await command('GET')).state.list.playbackRate, 1.5);
    await release(page, 1.5);
    assert.equal(await page.locator('#bq-speed-feedback').getAttribute('aria-label'), '播放速度 1.5×');
    // Headless tabs do not consistently emit OS focus events; exercise the actual
    // player's registered blur cleanup explicitly rather than assuming tab focus.
    await hold(page); await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await waitRate(page, 1.5);
    await page.keyboard.up('ArrowRight'); await page.bringToFront();
    await command('RATE', { value: 2 }); await waitRate(page, 2);
    console.log('PASS LIVE: changes during hold defer until release; < shortcut and the real player blur handler preserve restoration and subsequent synchronization');

    await page.locator('video').evaluate(video => { video.pause(); video.currentTime = 20; });
    await page.locator('.bpx-player-ctrl-playbackrate').focus();
    await page.keyboard.press('ArrowRight', { delay: 70 });
    await page.waitForFunction(() => Math.abs(document.querySelector('video').currentTime - 25) < 1);
    // Native seekAutoplay may finish asynchronously after the seek lands.
    await page.waitForFunction(() => !document.querySelector('video').seeking && document.querySelector('video').readyState >= 3);
    await page.waitForTimeout(1000);
    await page.locator('video').evaluate(video => video.pause());
    await page.waitForTimeout(600);
    assert(await page.locator('video').evaluate(video => video.paused));
    const pausedTime = await page.locator('video').evaluate(video => video.currentTime);
    const menu = page.locator('.bpx-player-ctrl-playbackrate');
    await page.mouse.move(10, 10); await menu.hover();
    await menu.locator('[data-value="3"]').click();
    await popup.waitForFunction(() => document.getElementById('playback-rate').value === '3'); await waitRate(page, 3);
    await popup.locator('#playback-rate').selectOption('1.25'); await waitRate(page, 1.25);
    assert(await page.locator('video').evaluate(video => video.paused));
    assert(Math.abs(await page.locator('video').evaluate(video => video.currentTime) - pausedTime) < .1);
    await menu.focus(); await page.keyboard.press('Shift+Period'); await waitRate(page, 1.5);
    await hold(page); await release(page, 1.5);
    console.log('PASS LIVE: short press still seeks five seconds; native 3x menu, popup and > synchronize without changing paused position');

    await page.reload({ waitUntil: 'domcontentloaded' }); await ready(page); await waitRate(page, 1.5);
    assert.equal(await page.locator('[data-value="3"]').count(), 1);
    console.log('PASS LIVE: reload retains fixed speed and exactly one native 3x entry');
  } finally { await context.close(); }
}
main().then(() => {
  if (!process.argv.includes('--queue')) {
    const result = require('node:child_process').spawnSync(process.execPath, [__filename, '--queue'], { env: process.env, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status || 1;
  }
}).catch(error => { console.error(error); process.exitCode = 1; });
