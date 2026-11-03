const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const path=require('node:path'),assert=require('node:assert/strict');
const extension=path.resolve(__dirname,'..');
async function poll(fn){const until=Date.now()+15000;while(Date.now()<until){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Metadata recovery timed out');}
(async()=>{
 const context=await chromium.launchPersistentContext(path.join(process.env.BILI_AUDIT_WORKDIR||require('node:os').tmpdir(),`bili-metadata-${Date.now()}`),{...(process.env.BILI_TEST_BROWSER?{executablePath:process.env.BILI_TEST_BROWSER}:{channel:'chromium'}),headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],viewport:{width:520,height:600}});
 try{
  const errors=[];context.on('weberror',e=>errors.push(e.error().message));
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const bvid='BV1ug436JE8w',title='影之刃零陆家村一个boss都不打，三分钟速通到第四章';
  let blocked=true,apiCalls=0,pageCalls=0;
  await context.route('https://api.bilibili.com/**',route=>{apiCalls++;return route.fulfill({status:412,body:'request limited'});});
  await context.route('https://www.bilibili.com/**',route=>{pageCalls++;return route.fulfill(blocked?{status:412,body:'request limited'}:{contentType:'text/html',body:`<script>window.__INITIAL_STATE__=${JSON.stringify({videoData:{bvid,title,pic:'https://i0.hdslb.com/bfs/archive/fallback.jpg',pages:[{page:1,part:'视频',duration:186}]}})};(function(){throw Error('Must never execute page scripts')})();</script>`});});
  await context.route('https://i0.hdslb.com/**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="48" height="32"><rect width="48" height="32" fill="pink"/></svg>'}));
  const page=await context.newPage();await page.goto(`chrome-extension://${worker.url().split('/')[2]}/popup.html`);
  const cmd=(type,fields={})=>page.evaluate(async({type,fields})=>{const r=await chrome.runtime.sendMessage({type,...fields});if(!r.ok)throw Error(r.error);return r;},{type,fields});
  await cmd('ADD',{text:`${bvid}\n${bvid}\n${bvid}`});
  await poll(async()=>(await cmd('GET')).state.list.items.every(x=>x.metadataStatus==='error'));
  await page.waitForFunction(()=>document.querySelectorAll('.metadata-error').length===3);
  assert.match(await page.locator('.metadata-error').first().textContent(),/B站暂时限制.*412/);
  assert.equal(apiCalls,1);assert.equal(pageCalls,1);
  await page.waitForTimeout(1100);assert.equal(apiCalls,1);assert.equal(pageCalls,1);
  console.log('PASS: dual-source failure has clear restriction text and no automatic retry loop');
  blocked=false;await page.locator('#refresh').click();
  await poll(async()=>(await cmd('GET')).state.list.items.every(x=>x.metadataStatus==='ready'));
  await page.waitForFunction(()=>document.getElementById('total-duration').textContent==='09:18');
  assert.deepEqual(await page.locator('.title').allTextContents(),[title,title,title]);
  assert.deepEqual(await page.locator('.duration').allTextContents(),['时长 03:06','时长 03:06','时长 03:06']);
  assert.equal(await page.locator('.metadata-error').count(),0);assert.equal(apiCalls,2);assert.equal(pageCalls,2);
  console.log('PASS: Refresh recovers all three identical videos from one public-page request: 03:06 each, 09:18 total');
  assert(!(await cmd('GET')).state.session.running);
  assert(!context.pages().some(p=>p.url().startsWith('https://www.bilibili.com/')));
  console.log('PASS: metadata recovery requires no playback, extra tabs, cookies or script execution');
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
