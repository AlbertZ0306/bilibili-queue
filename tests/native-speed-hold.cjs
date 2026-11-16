const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('node:path');
const assert = require('node:assert/strict');

function wave() {
  const data = Buffer.alloc(44 + 8000 * 120 * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36);
  data.writeUInt32LE(data.length - 44, 40);
  return data.toString('base64');
}

async function main() {
  const extension = path.resolve(__dirname, '..');
  const context = await chromium.launchPersistentContext(path.join(process.env.BILI_AUDIT_WORKDIR || require('node:os').tmpdir(), `bili-native-hold-${Date.now()}`), {
    ...(process.env.BILI_TEST_BROWSER ? { executablePath: process.env.BILI_TEST_BROWSER } : { channel: 'chromium' }),
    headless: true, viewport: { width: 900, height: 800 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    const errors = [];
    context.on('weberror', error => errors.push(error.error().message));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await context.route('https://api.bilibili.com/**', route => route.fulfill({ json: { code: 0, data: { title: '长按倍速回归', pages: [{ page: 1, duration: 120 }] } } }));
    await context.route('https://www.bilibili.com/**', route => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><h1>长按倍速回归</h1>
        <div class="bpx-player-video-wrap"><video muted src="data:audio/wav;base64,${wave()}" style="width:600px;height:350px"></video></div>
        <div class="bpx-player-ctrl-playbackrate" tabindex="0"><div class="bpx-player-ctrl-playbackrate-result">倍速</div>
        <ul class="bpx-player-ctrl-playbackrate-menu">${[2, 1.5, 1.25, 1, .75, .5].map(rate => `<li class="bpx-player-ctrl-playbackrate-menu-item" data-value="${rate}">${rate}x</li>`).join('')}</ul></div>
        <div class="bpx-player-three-playrate-hint" style="display:none">倍速播放中</div><textarea aria-label="评论"></textarea>
        <script>
          const video = document.querySelector('video'), hint = document.querySelector('.bpx-player-three-playrate-hint');
          let held = false, timer, boosted = false, previous;
          const setRate = rate => { video.playbackRate = rate; video.defaultPlaybackRate = rate; };
          document.querySelector('ul').addEventListener('click', event => {
            const item = event.target.closest('li'); if (!item) return;
            setRate(Number(item.dataset.value));
            document.querySelectorAll('li').forEach(el => el.classList.toggle('bpx-state-active', el === item));
            document.querySelector('.bpx-player-ctrl-playbackrate-result').textContent = item.textContent;
          });
          window.addEventListener('keydown', event => {
            if (event.key !== 'ArrowRight' || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || event.target.closest?.('textarea,input,[contenteditable]')) return;
            event.preventDefault(); if (held) return; held = true;
            timer = setTimeout(() => { previous = video.playbackRate; boosted = true; hint.style.display = 'block'; setRate(3); }, 300);
          });
          function release(event) {
            if (event.type === 'keyup' && event.key !== 'ArrowRight' || !held) return;
            held = false; clearTimeout(timer);
            if (boosted) { hint.style.display = 'none'; setRate(previous); boosted = false; }
            else if (event.type === 'keyup') video.currentTime += 5;
          }
          window.addEventListener('keyup', release); window.addEventListener('blur', release); window.addEventListener('contextmenu', release);
        </script>`
    }));
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${worker.url().split('/')[2]}/popup.html`);
    await popup.waitForSelector('#playback-rate');
    const command = (type, fields = {}) => popup.evaluate(async ({ type, fields }) => {
      const response = await chrome.runtime.sendMessage({ type, ...fields });
      if (!response.ok) throw Error(response.error); return response;
    }, { type, fields });
    const page = await context.newPage();
    await page.goto('https://www.bilibili.com/video/BV1xx411c7mD/');
    await page.locator('[data-bq-rate="3"]').waitFor();
    const rate = () => page.locator('video').evaluate(video => video.playbackRate);
    const waitRate = value => page.waitForFunction(value => document.querySelector('video').playbackRate === value, value);
    const saved = async () => (await command('GET')).state.list.playbackRate;
    const hold = async () => { await page.locator('.bpx-player-ctrl-playbackrate').focus(); await page.keyboard.down('ArrowRight'); await waitRate(3); await page.waitForTimeout(950); };
    const release = async expected => { await page.keyboard.up('ArrowRight'); await waitRate(expected); await page.waitForTimeout(850); assert.equal(await rate(), expected); };

    for (const fixed of [1, 1.5, 2, 3]) {
      await command('RATE', { value: fixed }); await waitRate(fixed);
      await hold(); assert.equal(await rate(), 3); assert.equal(await saved(), fixed);
      await popup.waitForFunction(() => document.getElementById('speed-status').textContent.includes('临时 3×') && !document.getElementById('speed-status').hidden);
      assert.equal(await popup.locator('#playback-rate').inputValue(), String(fixed));
      await release(fixed);
      await popup.waitForFunction(() => document.getElementById('speed-status').hidden);
    }
    console.log('PASS: native long hold survives multiple ticks at 1x/1.5x/2x/3x; release restores fixed speed; popup shows temporary speed without saving it');

    await command('RATE', { value: 1.5 }); await waitRate(1.5);
    await page.locator('.bpx-player-ctrl-playbackrate').focus();
    await page.keyboard.down('ArrowRight'); await page.waitForTimeout(70); await page.keyboard.up('ArrowRight');
    assert.equal(await page.locator('video').evaluate(video => video.currentTime), 5);
    assert.equal(await rate(), 1.5);
    const comment = page.getByRole('textbox', { name: '评论' });
    await comment.focus(); await page.keyboard.down('ArrowRight'); await page.waitForTimeout(400); await page.keyboard.up('ArrowRight');
    await comment.press('Shift+Comma'); await comment.press('Shift+Period');
    assert.equal(await comment.inputValue(), '<>'); assert.equal(await saved(), 1.5);
    console.log('PASS: short right-arrow seek and editing comments retain native behavior');

    await hold(); await command('RATE', { value: 2 }); await page.waitForTimeout(950);
    assert.equal(await rate(), 3); assert.equal(await saved(), 2); await release(2);
    await hold(); await page.keyboard.press('Shift+Comma'); await page.waitForTimeout(400);
    assert.equal(await rate(), 3); assert.equal(await saved(), 1.5); await release(1.5);
    for (const event of ['blur', 'contextmenu']) {
      await hold(); await page.evaluate(type => window.dispatchEvent(new Event(type)), event);
      await waitRate(1.5); await page.keyboard.up('ArrowRight');
      await command('RATE', { value: 2 }); await waitRate(2);
      await command('RATE', { value: 1.5 }); await waitRate(1.5);
    }
    console.log('PASS: fixed changes during hold apply after native restore; < shortcut, blur and context menu cannot leave boost stuck');

    await page.locator('[data-value="3"]').click();
    await popup.waitForFunction(() => document.getElementById('playback-rate').value === '3'); await waitRate(3);
    await popup.locator('#playback-rate').selectOption('1.25'); await waitRate(1.25);
    await page.locator('.bpx-player-ctrl-playbackrate').focus(); await page.keyboard.press('Shift+Period'); await waitRate(1.5);
    await hold(); await release(1.5);
    console.log('PASS: native 3x menu, popup and < / > remain synchronized after long holds');

    await command('ADD', { text: 'BV1xx411c7mD BV1Q541167Qg' });
    const created = context.waitForEvent('page');
    await command('START');
    const managed = await created;
    await managed.waitForURL('**/*bq_run=*');
    await managed.waitForFunction(() => document.querySelector('video')?.playbackRate === 1.5);
    await managed.locator('.bpx-player-ctrl-playbackrate').focus(); await managed.keyboard.down('ArrowRight');
    await managed.waitForFunction(() => document.querySelector('video').playbackRate === 3);
    await managed.locator('video').evaluate(async video => { await video.play(); });
    await managed.waitForTimeout(1100);
    assert.equal(await managed.locator('video').evaluate(video => video.playbackRate), 3);
    await command('RATE', { value: 2 }); await managed.waitForTimeout(900);
    assert.equal(await managed.locator('video').evaluate(video => video.playbackRate), 3);
    await managed.keyboard.up('ArrowRight'); await managed.waitForFunction(() => document.querySelector('video').playbackRate === 2);
    await command('NEXT'); await managed.waitForURL('**/BV1Q541167Qg/**');
    await managed.waitForFunction(() => document.querySelector('video')?.playbackRate === 2);
    await command('STOP');
    assert.deepEqual(errors, []);
    console.log('PASS: managed queue playing events do not cancel boost; latest fixed speed survives next video; no uncaught browser errors');
  } finally { await context.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
