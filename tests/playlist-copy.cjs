const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const extension = path.resolve(__dirname, '..');
  const profile = path.join(process.env.BILI_AUDIT_WORKDIR || require('node:os').tmpdir(), `bili-copy-${Date.now()}`);
  const context = await chromium.launchPersistentContext(profile, {
    ...(process.env.BILI_TEST_BROWSER ? { executablePath: process.env.BILI_TEST_BROWSER } : { channel: 'chromium' }),
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 520, height: 600 }
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.copyCalls = [];
      window.failCopy = false;
      window.holdCopy = false;
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          async writeText(text) {
            if (window.failCopy) throw Error('clipboard denied');
            window.copyCalls.push(text);
            if (window.holdCopy) await new Promise(resolve => { window.finishCopy = resolve; });
          }
        }
      });
    });
    await page.goto(`chrome-extension://${worker.url().split('/')[2]}/popup.html`);
    await page.waitForSelector('#copy-bvids');
    assert(await page.locator('#copy-bvids').isDisabled());
    await worker.evaluate(async () => {
      const items = ['BV15yA3eWE5b', 'BV1pXA5eyEEg', 'BV15yA3eWE5b'].map((bvid, index) => ({
        id: String(index), bvid, page: index === 2 ? 2 : 1,
        title: '测试标题', duration: 60, metadataStatus: 'ready', coverChecked: true
      }));
      await chrome.storage.local.set({ playlist: { items, direction: 'reverse', loop: false } });
    });
    await page.waitForFunction(() => document.getElementById('count').textContent === '3');
    await page.locator('#copy-bvids').click();
    await page.waitForFunction(() => window.copyCalls.length === 1);
    assert.equal(await page.evaluate(() => window.copyCalls[0]), 'BV15yA3eWE5b\nBV1pXA5eyEEg\nBV15yA3eWE5b');
    console.log('PASS: display order, duplicate retention, BV-only output and reverse playback setting');

    const response = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'MOVE', id: '1', delta: -1 }));
    assert(response.ok);
    await page.waitForFunction(() => document.querySelector('.meta').textContent.startsWith('BV1pXA5eyEEg'));
    await page.locator('#copy-bvids').click();
    assert.equal(await page.evaluate(() => window.copyCalls.at(-1)), 'BV1pXA5eyEEg\nBV15yA3eWE5b\nBV15yA3eWE5b');
    console.log('PASS: changed row order is reflected in clipboard output');

    await page.evaluate(() => { window.failCopy = true; });
    await page.locator('#copy-bvids').click();
    await page.waitForFunction(() => document.getElementById('message').textContent.includes('复制失败'));
    assert(!(await page.locator('#copy-bvids').isDisabled()));
    await page.evaluate(() => { window.failCopy = false; window.holdCopy = true; });
    const before = await page.evaluate(() => window.copyCalls.length);
    await page.locator('#copy-bvids').evaluate(button => { button.click(); button.click(); });
    await page.waitForFunction(() => document.getElementById('copy-bvids').disabled);
    assert.equal(await page.evaluate(() => window.copyCalls.length), before + 1);
    await page.evaluate(() => window.finishCopy());
    await page.waitForFunction(() => !document.getElementById('copy-bvids').disabled);
    console.log('PASS: clipboard failure allows retry and pending copy rejects repeated clicks');

    for (const width of [390, 520, 1100]) {
      await page.setViewportSize({ width, height: 600 });
      const fits = await page.locator('.heading-actions').evaluate(element => {
        const copy = document.getElementById('copy-bvids').getBoundingClientRect();
        const duration = document.querySelector('.list-summary').getBoundingClientRect();
        return copy.right <= duration.left && duration.right <= innerWidth &&
          document.documentElement.scrollWidth <= innerWidth;
      });
      assert(fits, `Heading overflows at ${width}px`);
    }
    assert.deepEqual(errors, []);
    console.log('PASS: copy and duration fit at 390, 520 and 1100px');
  } finally {
    await context.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
