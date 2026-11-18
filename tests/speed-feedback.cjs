const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('node:path'), assert = require('node:assert/strict');
function wave() {
  const buffer = Buffer.alloc(44 + 8000 * 60 * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(buffer.length - 44, 40);
  return buffer.toString('base64');
}
async function main() {
  const extension = path.resolve(__dirname, '..');
  const context = await chromium.launchPersistentContext(path.join(process.env.BILI_AUDIT_WORKDIR || require('node:os').tmpdir(), `bili-speed-feedback-${Date.now()}`), {
    ...(process.env.BILI_TEST_BROWSER ? { executablePath: process.env.BILI_TEST_BROWSER } : { channel: 'chromium' }),
    headless: true, viewport: { width: 1100, height: 800 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--mute-audio']
  });
  try {
    const errors = []; context.on('weberror', error => errors.push(error.error().message));
    await context.route('https://www.bilibili.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html>
      <style>body{margin:30px;font:14px system-ui}#bilibili-player{width:800px}.bpx-player-video-area{position:relative;width:800px;height:450px;background:#647c94}.bpx-player-video-wrap{height:100%}video{width:100%;height:100%}#bilibili-player:fullscreen{width:100vw;height:100vh;background:#17202b}#bilibili-player:fullscreen .bpx-player-video-area{width:100vw;height:100vh}ul{display:flex;gap:20px;padding:10px}li{list-style:none;cursor:pointer}</style>
      <h1>倍速提示回归</h1><div id="bilibili-player"><div class="bpx-player-video-area"><div class="bpx-player-video-wrap"><video src="data:audio/wav;base64,${wave()}"></video></div>
      <div class="bpx-player-three-playrate-hint" style="display:none">临时加速中</div></div>
      <div class="bpx-player-ctrl-playbackrate" tabindex="0"><div class="bpx-player-ctrl-playbackrate-result">倍速</div><ul class="bpx-player-ctrl-playbackrate-menu">${[2,1.5,1.25,1,.75,.5].map(rate=>`<li class="bpx-player-ctrl-playbackrate-menu-item" data-value="${rate}">${rate}x</li>`).join('')}</ul></div>
      <button id="fullscreen" onclick="document.getElementById('bilibili-player').requestFullscreen()">全屏</button></div><textarea aria-label="评论"></textarea>
      <script>
        const video=document.querySelector('video'),hint=document.querySelector('.bpx-player-three-playrate-hint');video.volume=.37;
        document.querySelector('ul').addEventListener('click',event=>{const item=event.target.closest('li');if(!item)return;video.playbackRate=video.defaultPlaybackRate=Number(item.dataset.value);document.querySelectorAll('li').forEach(el=>el.classList.toggle('bpx-state-active',el===item));});
        let held=false,boost=false,timer,previous;
        addEventListener('keydown',event=>{if(event.key!=='ArrowRight'||held||event.target.matches?.('textarea,input,select'))return;held=true;timer=setTimeout(()=>{previous=video.playbackRate;boost=true;hint.style.display='block';video.playbackRate=3;},300);});
        addEventListener('keyup',event=>{if(event.key!=='ArrowRight')return;held=false;clearTimeout(timer);if(boost){boost=false;hint.style.display='none';video.playbackRate=previous;}});
      </script>` }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const popup = await context.newPage(); await popup.goto(`chrome-extension://${worker.url().split('/')[2]}/popup.html`); await popup.waitForSelector('#playback-rate');
    const command = (type, fields = {}) => popup.evaluate(async ({type,fields})=>{const r=await chrome.runtime.sendMessage({type,...fields});if(!r.ok)throw Error(r.error);return r;},{type,fields});
    const page = await context.newPage(); await page.goto('https://www.bilibili.com/video/BV1xx411c7mD/');
    await page.locator('[data-bq-rate="3"]').waitFor();
    await page.waitForFunction(()=>document.querySelector('video').readyState>=2);
    await page.locator('video').evaluate(video=>{video.pause();video.currentTime=10;});
    const hud=page.locator('#bq-speed-feedback');
    const show = label => page.waitForFunction(label=>{const el=document.getElementById('bq-speed-feedback');return el?.getAttribute('aria-label')===label&&Number(getComputedStyle(el).opacity)===1;},label);
    const absent = () => page.waitForFunction(()=>!document.getElementById('bq-speed-feedback'));
    assert.equal(await hud.count(),0,'Page load must not announce a keyboard selection');
    await page.keyboard.press('Shift+Period'); await show('播放速度 1.25×');
    const geometry=await hud.evaluate(el=>{const a=el.parentElement.getBoundingClientRect(),b=el.getBoundingClientRect(),css=getComputedStyle(el);return {x:b.left-a.left,y:b.top-a.top,height:b.height,font:css.fontSize,pointer:css.pointerEvents};});
    assert.deepEqual(geometry,{x:16,y:16,height:34,font:'13px',pointer:'none'});
    const before=await page.locator('video').evaluate(v=>({rate:v.playbackRate,volume:v.volume,muted:v.muted,paused:v.paused,position:v.currentTime}));
    assert.deepEqual(before,{rate:1.25,volume:.37,muted:false,paused:true,position:10});
    await absent();
    console.log('PASS: successful shortcut shows approved 13px hint at player top-left and fades; media pause/position/volume are unchanged');

    await page.keyboard.press('Shift+Period'); await show('播放速度 1.5×');
    await page.waitForTimeout(900);
    await page.keyboard.press('Shift+Period'); await show('播放速度 2×');
    assert.equal(await hud.count(),1); await page.waitForTimeout(800); assert.equal(await hud.count(),1,'New selection must restart the timer');
    await absent();
    await page.keyboard.press('Shift+Period'); await show('播放速度 3×');
    await page.keyboard.press('Shift+Period'); await show('已达最高倍速 3×');
    await command('RATE',{value:.5}); await absent();
    await page.keyboard.press('Shift+Comma'); await show('已达最低倍速 0.5×'); await absent();
    console.log('PASS: rapid selections reuse one hint, restart fade timer, and report both speed limits');

    const comment=page.getByRole('textbox',{name:'评论'});
    await comment.press('Shift+Comma'); await comment.press('Shift+Period'); assert.equal(await comment.inputValue(),'<>'); assert.equal(await hud.count(),0);
    await popup.locator('#playback-rate').selectOption('1.5'); await page.waitForTimeout(250); assert.equal(await hud.count(),0);
    await page.locator('[data-value="2"]').click(); await page.waitForTimeout(250); assert.equal(await hud.count(),0);
    await page.locator('.bpx-player-ctrl-playbackrate').focus(); await page.keyboard.press('Shift+Comma'); await show('播放速度 1.5×');
    await page.keyboard.down('ArrowRight'); await page.waitForFunction(()=>document.querySelector('video').playbackRate===3);
    await page.keyboard.press('Shift+Comma'); await show('固定倍速 1.25×，松开后生效');
    assert.equal(await page.locator('video').evaluate(v=>v.playbackRate),3);
    await page.keyboard.up('ArrowRight'); await show('播放速度 1.25×');
    assert.equal(await page.locator('video').evaluate(v=>v.playbackRate),1.25);
    await absent();
    console.log('PASS: comments and menu selections do not trigger shortcut hints; temporary boost is preserved and deferred selection is confirmed after release');

    await page.locator('#fullscreen').click(); await page.waitForFunction(()=>!!document.fullscreenElement);
    await page.keyboard.press('Shift+Period'); await show('播放速度 1.5×');
    assert(await hud.evaluate(el=>document.fullscreenElement.contains(el)));
    await page.evaluate(()=>document.exitFullscreen());
    await page.keyboard.press('Shift+Period'); await show('播放速度 2×');
    const source=page.url(); await page.goto(source+'?p=2'); await page.locator('[data-bq-rate="3"]').waitFor(); assert.equal(await hud.count(),0);
    console.log('PASS: hint stays in fullscreen player and is cleared on navigation');

    await worker.evaluate(()=>{globalThis.bqTestOriginalGet=chrome.tabs.get;chrome.tabs.get=async()=>{throw Error('测试同步失败');};});
    await page.keyboard.press('Shift+Period'); await page.waitForTimeout(350); assert.equal(await hud.count(),0,'Failed request must not show success');
    await worker.evaluate(()=>{chrome.tabs.get=globalThis.bqTestOriginalGet;});
    await worker.evaluate(()=>{chrome.tabs.get=async(...args)=>{await new Promise(resolve=>setTimeout(resolve,120));return globalThis.bqTestOriginalGet(...args);};});
    await page.keyboard.press('Shift+Period'); await page.keyboard.press('Shift+Period'); await page.keyboard.press('Shift+Period');
    await show('已达最高倍速 3×'); assert.equal(await hud.count(),1);
    await worker.evaluate(()=>{chrome.tabs.get=globalThis.bqTestOriginalGet;delete globalThis.bqTestOriginalGet;});
    await page.waitForTimeout(250); assert.equal(await hud.getAttribute('aria-label'),'已达最高倍速 3×');
    assert.deepEqual(errors,[]);
    console.log('PASS: failures never show success; delayed responses and fast repeated commands leave only the newest confirmed speed');
  } finally { await context.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
