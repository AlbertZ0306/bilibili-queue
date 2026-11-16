// Controlled-site regression: the fixture owns volume persistence. This is not
// evidence about Bilibili's own persistence; live-site checks are run separately.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

const extension = path.resolve(__dirname, '..');
const ids = ['BV1xx411c7mD', 'BV1Q541167Qg', 'BV1ai4y1N7SV'];
const base = process.env.BILI_AUDIT_WORKDIR || require('node:os').tmpdir();
function wave() {
  const data = Buffer.alloc(44 + 8000 * 60 * 2); // All samples are zero: no test noise.
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(data.length - 44, 40);
  return data.toString('base64');
}
async function launch(blockAutoplay = false) {
  const context = await chromium.launchPersistentContext(path.join(base, `bili-volume-${blockAutoplay ? 'blocked-' : ''}${Date.now()}`), {
    ...(process.env.BILI_TEST_BROWSER ? { executablePath: process.env.BILI_TEST_BROWSER } : { channel: 'chromium' }),
    headless: true, viewport: { width: 900, height: 800 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--mute-audio',
      `--autoplay-policy=${blockAutoplay ? 'document-user-activation-required' : 'no-user-gesture-required'}`]
  });
  const errors = [];
  context.on('weberror', error => errors.push(error.error().message));
  await context.route('https://api.bilibili.com/**', route => route.fulfill({ json: { code: 0, data: { title: '音量回归', pages: [{ page: 1, duration: 60 }] } } }));
  await context.route('https://www.bilibili.com/**', route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><h1>音量回归</h1>
      <div class="bpx-player-video-wrap"><video controls style="width:600px;height:350px" src="data:audio/wav;base64,${wave()}"></video></div>
      <div class="bpx-player-ctrl-playbackrate" tabindex="0"><div class="bpx-player-ctrl-playbackrate-result">倍速</div>
      <ul class="bpx-player-ctrl-playbackrate-menu">${[2, 1.5, 1.25, 1, .75, .5].map(rate => `<li class="bpx-player-ctrl-playbackrate-menu-item" data-value="${rate}">${rate}x</li>`).join('')}</ul></div>
      <div class="bpx-player-three-playrate-hint" style="display:none">倍速播放中</div><textarea aria-label="评论"></textarea>
      <script>
        window.volumeEvents = [];
        window.bindNativeVolume = video => {
          const saved = JSON.parse(localStorage.getItem('bq-test-native-volume') || '{"volume":0.37,"muted":false}');
          video.volume = saved.volume; video.muted = saved.muted;
          video.addEventListener('volumechange', () => {
            const state = {volume:video.volume,muted:video.muted};
            localStorage.setItem('bq-test-native-volume', JSON.stringify(state));
            window.volumeEvents.push(state);
          });
        };
        window.bindNativeVolume(document.querySelector('video'));
        document.querySelector('ul').addEventListener('click', event => {
          const item = event.target.closest('li'); if (!item) return;
          document.querySelector('video').playbackRate = Number(item.dataset.value);
          document.querySelectorAll('li').forEach(el => el.classList.toggle('bpx-state-active', el === item));
        });
        let timer, held = false, previous;
        window.addEventListener('keydown', event => {
          if (event.key !== 'ArrowRight' || held || event.target.matches?.('textarea,input,select')) return;
          held = true; timer = setTimeout(() => { const v=document.querySelector('video'); previous=v.playbackRate;
            document.querySelector('.bpx-player-three-playrate-hint').style.display='block'; v.playbackRate=3; },300);
        });
        window.addEventListener('keyup', event => {
          if (event.key !== 'ArrowRight') return; clearTimeout(timer); held=false;
          if (previous !== undefined) { document.querySelector('.bpx-player-three-playrate-hint').style.display='none';
            document.querySelector('video').playbackRate=previous; previous=undefined; }
        });
      </script>`
  }));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${worker.url().split('/')[2]}/popup.html`);
  await popup.waitForSelector('#playback-rate');
  const cmd = (type, fields = {}) => popup.evaluate(async ({ type, fields }) => {
    const result = await chrome.runtime.sendMessage({ type, ...fields });
    if (!result.ok) throw Error(result.error); return result;
  }, { type, fields });
  return { context, worker, popup, cmd, errors };
}
async function main() {
  const { context, popup, cmd, errors } = await launch();
  try {
    await cmd('ADD', { text: ids.join(' ') });
    const rows = (await cmd('GET')).state.list.items;
    const created = context.waitForEvent('page'); await cmd('START');
    const page = await created; await page.waitForURL('**/*bq_run=*');
    const ready = async () => {
      await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
      await page.locator('[data-bq-rate="3"]').waitFor({state:'attached'});
    };
    const state = () => page.locator('video').evaluate(v => ({volume:v.volume,muted:v.muted}));
    const check = async (volume, muted, label) => {
      await ready(); await page.waitForTimeout(900);
      assert.deepEqual(await state(), {volume,muted}, label);
    };
    const set = async (volume, muted) => {
      await page.locator('video').evaluate((v, value) => {v.volume=value.volume;v.muted=value.muted;}, {volume,muted});
      await page.waitForFunction(value => {
        const saved=JSON.parse(localStorage.getItem('bq-test-native-volume'));
        return saved.volume===value.volume && saved.muted===value.muted;
      }, {volume,muted});
    };
    const navigate = async (type, fields = {}) => {
      const oldURL=page.url(); await cmd(type,fields);
      await page.waitForURL(url=>url.href!==oldURL); await ready();
    };
    await check(.37,false,'Initial fixture volume is not overwritten');
    await navigate('NEXT'); assert(page.url().includes(ids[1])); await check(.37,false,'Next different BV');
    await navigate('PREV'); assert(page.url().includes(ids[0])); await check(.37,false,'Previous different BV');
    await set(0,false); await navigate('NEXT'); await check(0,false,'Zero-volume mute survives next');
    await set(.61,true); await navigate('NEXT'); await check(.61,true,'Explicit element mute is preserved');
    console.log('PASS: controlled native persistence survives different-BV next/previous, zero volume and explicit mute');

    await set(.43,false);
    await page.locator('video').evaluate(v=>v.pause());
    for (const value of [0.5,1.25,1.5,2,3]) {await cmd('RATE',{value});await check(.43,false,'Rate selection preserves volume');}
    await page.locator('.bpx-player-ctrl-playbackrate').focus();
    await page.keyboard.press('Shift+Comma'); await page.keyboard.press('Shift+Period');
    await page.keyboard.down('ArrowRight'); await page.waitForTimeout(1100); await check(.43,false,'Temporary boost preserves volume');
    await page.keyboard.up('ArrowRight'); await check(.43,false,'Native release preserves volume');
    await page.locator('video').evaluate(async v=>{await v.play();v.pause();});
    await check(.43,false,'Pause/resume preserves volume');
    await page.locator('video').evaluate(old=>{const next=old.cloneNode();old.replaceWith(next);window.bindNativeVolume(next);next.load();});
    await check(.43,false,'Native video-node replacement preserves restored volume');
    await cmd('STOP'); assert(await page.locator('video').evaluate(v=>v.paused));
    await check(.43,false,'Stop does not mute');
    await navigate('START'); await check(.43,false,'Restart retains fixture volume');
    console.log('PASS: rate menu, < / >, native temporary boost, pause/resume, node replacement, Stop and restart do not overwrite sound state');

    await cmd('DIRECTION',{value:'forward'});
    await navigate('START',{id:rows[0].id}); await set(.27,false);
    const oldURL=page.url();
    await page.locator('video').evaluate(async v=>{v.currentTime=v.duration-.15;await v.play();});
    await page.waitForURL(url=>url.href!==oldURL); assert(page.url().includes(ids[1]));
    await check(.27,false,'Natural ended transition preserves fixture volume');
    await cmd('DIRECTION',{value:'reverse'}); await navigate('START',{id:rows[2].id});
    await navigate('NEXT'); assert(page.url().includes(ids[1])); await check(.27,false,'Reverse next');
    await cmd('LOOP',{value:true}); await navigate('START',{id:rows[0].id});
    await navigate('NEXT'); assert(page.url().includes(ids[2])); await check(.27,false,'Reverse loop boundary');
    console.log('PASS: natural ended, reverse playback and loop boundary retain fixture volume');

    const tabId=(await cmd('GET')).state.session.tabId;
    await popup.evaluate(tabId=>chrome.tabs.update(tabId,{muted:true}),tabId);
    await navigate('PREV');
    assert(await popup.evaluate(async tabId=>(await chrome.tabs.get(tabId)).mutedInfo.muted,tabId));
    await check(.27,false,'Tab mute is independent from media volume');
    await cmd('RATE',{value:1.5});
    assert(await popup.evaluate(async tabId=>(await chrome.tabs.get(tabId)).mutedInfo.muted,tabId));
    await popup.evaluate(tabId=>chrome.tabs.update(tabId,{muted:false}),tabId);
    await cmd('STOP'); assert.deepEqual(errors,[]);
    console.log('PASS: Chrome tab mute remains enabled across navigation and speed changes; no uncaught browser errors');
  } finally {await context.close();}

  const blocked = await launch(true);
  try {
    await blocked.cmd('ADD',{text:ids[0]});
    const created=blocked.context.waitForEvent('page'); await blocked.cmd('START');
    const page=await created; await page.waitForURL('**/*bq_run=*');
    await blocked.popup.waitForFunction(async()=>{
      const r=await chrome.runtime.sendMessage({type:'GET'});return r.state.session.status==='blocked';
    });
    const sound=await page.locator('video').evaluate(v=>({volume:v.volume,muted:v.muted,paused:v.paused}));
    assert.deepEqual(sound,{volume:.37,muted:false,paused:true});
    assert.deepEqual(blocked.errors,[]);
    console.log('PASS: real browser autoplay rejection is reported as blocked without forcing mute or changing volume');
  } finally {await blocked.context.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
