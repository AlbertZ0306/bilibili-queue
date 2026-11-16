const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

async function main() {
  const extension = path.resolve(__dirname, '..');
  const profile = path.join(process.env.BILI_AUDIT_WORKDIR || require('node:os').tmpdir(), `bili-menu-speed-${Date.now()}`);
  const context = await chromium.launchPersistentContext(profile, {
    ...(process.env.BILI_TEST_BROWSER ? { executablePath: process.env.BILI_TEST_BROWSER } : { channel: 'chromium' }),
    headless: true, viewport: { width: 900, height: 850 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    const errors = [];
    context.on('weberror', error => errors.push(error.error().message));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await context.route('https://www.bilibili.com/**', route => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><div id="app" data-server-rendered="true">
        <header id="biliMainHeader">首页　搜索</header>
        <div class="bpx-player-video-wrap"><video controls style="width:600px;height:350px"></video></div>
        <div class="bpx-player-ctrl-playbackrate">
          <div class="bpx-player-ctrl-playbackrate-result">倍速</div>
          <ul class="bpx-player-ctrl-playbackrate-menu">${[2, 1.5, 1.25, 1, .75, .5].map(rate =>
            `<li class="bpx-player-ctrl-playbackrate-menu-item" data-value="${rate}">${rate}x</li>`).join('')}
          </ul>
        </div></div>
        <textarea aria-label="评论"></textarea>
        <script>
          document.querySelector('ul').addEventListener('click', event => {
            const item = event.target.closest('li');
            if (!item) return;
            document.querySelector('video').playbackRate = Number(item.dataset.value);
            document.querySelectorAll('li').forEach(el => el.classList.toggle('bpx-state-active', el === item));
            document.querySelector('.bpx-player-ctrl-playbackrate-result').textContent = item.textContent;
          });
        </script>`
    }));
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${worker.url().split('/')[2]}/popup.html`);
    await popup.waitForSelector('#playback-rate');
    const page = await context.newPage();
    await page.goto('https://www.bilibili.com/video/BV1xx411c7mD/');
    await page.waitForTimeout(1100);
    assert.equal(await page.locator('[data-value="3"]').count(), 0);
    await page.locator('#app').evaluate(app => app.removeAttribute('data-server-rendered'));
    const three = page.locator('[data-value="3"]');
    await three.waitFor();
    await three.click();
    await popup.waitForFunction(() => document.getElementById('playback-rate').value === '3');
    assert.equal(await page.locator('video').evaluate(video => video.playbackRate), 3);
    assert(await page.locator('#biliMainHeader').isVisible());
    console.log('PASS: waits for hydration and adds native 3x without starting a queue');

    await popup.locator('#playback-rate').selectOption('1.25');
    await page.waitForFunction(() => document.querySelector('.bpx-state-active').dataset.value === '1.25');
    await page.locator('[data-value="3"]').click();
    await page.locator('[data-value="0.75"]').click();
    await popup.waitForFunction(() => document.getElementById('playback-rate').value === '0.75');
    await page.waitForTimeout(850);
    assert.equal(await page.locator('video').evaluate(video => video.playbackRate), .75);
    console.log('PASS: popup updates player menu and rapid native selections persist the final choice');

    await page.locator('ul').evaluate(menu => {
      const replacement = menu.cloneNode(true);
      replacement.querySelector('[data-bq-rate]')?.remove();
      menu.replaceWith(replacement);
    });
    await three.waitFor();
    assert.equal(await three.count(), 1);
    const comment = page.getByRole('textbox', { name: '评论' });
    await comment.press('Shift+Period');
    assert.equal(await comment.inputValue(), '>');
    assert.equal(await popup.locator('#playback-rate').inputValue(), '0.75');
    await page.locator('#biliMainHeader').click();
    await page.keyboard.press('Shift+Period');
    await popup.waitForFunction(() => document.getElementById('playback-rate').value === '1');
    console.log('PASS: replaced menus receive one 3x entry and shortcuts respect comment input');

    await page.goto('https://www.bilibili.com/');
    await popup.locator('#playback-rate').selectOption('3');
    await page.waitForTimeout(900);
    assert.equal(await page.locator('[data-value="3"]').count(), 0);
    assert.equal(await page.locator('video').evaluate(video => video.playbackRate), 1);
    assert.deepEqual(errors, []);
    console.log('PASS: speed injection and synchronization are confined to video pages');
  } finally {
    await context.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
