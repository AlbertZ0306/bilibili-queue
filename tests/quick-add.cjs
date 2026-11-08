const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const extension = path.resolve(__dirname, '..');
const bvid = 'BV1MEtZzeEif';
const videoURL = `https://www.bilibili.com/video/${bvid}/`;

async function main() {
  const profile = path.join(process.env.BILI_AUDIT_WORKDIR || require('node:os').tmpdir(), `bili-quick-add-${Date.now()}`);
  const context = await chromium.launchPersistentContext(profile, {
    ...(process.env.BILI_TEST_BROWSER ? { executablePath: process.env.BILI_TEST_BROWSER } : { channel: 'chromium' }),
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 900, height: 660 }
  });
  try {
    context.setDefaultTimeout(8000);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const errors = [];
    context.on('weberror', error => errors.push(error.error().message));
    await context.route('https://api.bilibili.com/**', route => route.fulfill({
      json: { code: 0, data: { bvid, title: '测试课程', pages: [{ page: 1, duration: 100 }, { page: 2, duration: 200 }] } }
    }));
    await context.route('https://www.bilibili.com/**', route => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><meta charset="utf-8">
        <style>:root{--text1:#e3e5e7;background:#18191b;color:var(--text1)}
        .video-info-title-inner{width:340px;overflow:hidden}
        h1{width:100%;margin:0}</style>
        <div id="app" data-server-rendered="true">
          <header id="biliMainHeader">首页　搜索　登录</header>
          <div class="video-info-title-inner"><h1 class="video-title">${'很长的视频标题'.repeat(9)}</h1></div>
        </div>`
    }));
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${worker.url().split('/')[2]}/popup.html`);
    const state = () => popup.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'GET' })).state);
    const video = await context.newPage();
    await video.goto(videoURL);
    const host = video.locator('#bq-quick-add');
    const button = host.locator('button');
    // Hold the server markup through a mount interval, then simulate hydration.
    await video.waitForTimeout(1200);
    assert.equal(await host.count(), 0, 'the server-rendered title must be left intact');
    await video.locator('#app').evaluate(app => app.removeAttribute('data-server-rendered'));
    await button.waitFor();
    assert(await video.locator('#biliMainHeader').isVisible());
    const fits = await button.evaluate(el => {
      const host = el.getRootNode().host;
      return el.getBoundingClientRect().right <= host.parentElement.getBoundingClientRect().right &&
        host.previousElementSibling.getBoundingClientRect().right < el.getBoundingClientRect().left &&
        getComputedStyle(el).color === 'rgb(227, 229, 231)';
    });
    assert(fits);
    await button.evaluate(el => el.click());
    assert.equal((await state()).list.items.length, 0, 'synthetic click must not enqueue');

    await button.click();
    await button.filter({ hasText: '已加入播放列表' }).waitFor();
    assert.equal(video.url(), videoURL);
    assert.equal((await state()).session.running, false);
    assert.equal((await state()).list.items[0].page, 1);
    await button.click();
    await button.filter({ hasText: '已在播放列表' }).waitFor();
    assert.equal((await state()).list.items.length, 1);

    await video.evaluate(() => {
      history.pushState({}, '', '?p=2');
      const title = document.querySelector('.video-info-title-inner');
      title.replaceWith(title.cloneNode(true));
      document.getElementById('bq-quick-add')?.remove();
    });
    await host.locator('button[data-state="ready"]').waitFor();
    await button.press('Enter');
    await host.locator('button[data-state="added"], button[data-state="error"]').waitFor();
    assert.match(await button.textContent(), /已加入播放列表/);
    assert.deepEqual((await state()).list.items.map(item => item.page), [1, 2]);
    assert.equal(await host.count(), 1);
    assert(await video.locator('#biliMainHeader').isVisible());
    console.log('PASS: waits for delayed hydration, preserves the header, and adds P2 after SPA navigation');

    await popup.locator('#open-add').click();
    await popup.locator('#input').fill(videoURL + '?p=2');
    await popup.locator('#add').click();
    await popup.waitForFunction(() => document.querySelectorAll('.item').length === 3);
    assert.deepEqual((await state()).list.items.map(item => item.page), [1, 2, 2]);

    await video.evaluate(() => history.pushState({}, '', '/'));
    await host.waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
    console.log('PASS: paste entry still accepts repeats and page button disappears outside video pages');
  } finally {
    await context.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
