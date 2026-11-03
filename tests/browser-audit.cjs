const { chromium }=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path=require('node:path');
const extension=path.resolve(process.env.AUDIT_EXTENSION||path.join(__dirname,'..'));
const profileRoot=process.env.BILI_AUDIT_WORKDIR||require('node:os').tmpdir();
const checks=[];
function check(name,passed,detail){checks.push({name,passed,detail});console.log(`${passed?'PASS':'FAIL'}: ${name} ${detail||''}`);}
async function poll(fn,timeout=15000){const until=Date.now()+timeout;while(Date.now()<until){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('poll timeout');}
function wave(seconds=15){const n=8000*seconds,b=Buffer.alloc(44+n*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);return b.toString('base64');}
(async()=>{
 const context=await chromium.launchPersistentContext(path.join(profileRoot,`bili-audit-${Date.now()}`),{...(process.env.BILI_TEST_BROWSER?{executablePath:process.env.BILI_TEST_BROWSER}:{channel:'chromium'}),headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],viewport:{width:900,height:900}});
 try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const errors=[];context.on('weberror',e=>errors.push(e.error().message));
  let metadataTitle='审查测试视频';
  await context.route('https://api.bilibili.com/**',route=>{const bvid=new URL(route.request().url()).searchParams.get('bvid');return route.fulfill({contentType:'application/json',body:JSON.stringify({code:0,data:{bvid,title:metadataTitle,pages:[{page:1,duration:15}]}})});});
  await context.route('https://www.bilibili.com/**',route=>route.fulfill({contentType:'text/html',body:`<h1>审查测试视频</h1><div class="bpx-player-video-wrap"><video muted style="width:600px;height:400px" controls src="data:audio/wav;base64,${wave()}"></video></div>`}));
  let releaseShort,shortEntered=false;const pendingShort=new Promise(resolve=>{releaseShort=resolve;});
  await context.route('https://b23.tv/**',async route=>{shortEntered=true;await pendingShort;await route.fulfill({status:302,headers:{location:'https://www.bilibili.com/video/BV1xx411c7mD/'},body:''});});
  const page=await context.newPage();await page.goto(`chrome-extension://${worker.url().split('/')[2]}/popup.html`);
  const cmd=(type,fields={})=>page.evaluate(async({type,fields})=>{const r=await chrome.runtime.sendMessage({type,...fields});if(!r.ok)throw Error(r.error);return r;},{type,fields});
  await cmd('CLEAR');await cmd('ADD',{text:'BV1xx411c7mD'});await cmd('START');
  await poll(async()=>(await cmd('GET')).state.session.currentTime>.1);
  await page.waitForTimeout(150);
  check('manual Next is unavailable at a non-looping final row',await page.locator('#next').isDisabled());
  const videoPage=context.pages().find(p=>p.url().startsWith('https://www.bilibili.com/'));
  await videoPage.evaluate(()=>document.querySelector('video').pause());
  await poll(async()=>(await cmd('GET')).state.session.status==='paused');
  await videoPage.evaluate(()=>{const old=document.querySelector('video'),v=old.cloneNode();v.muted=true;old.replaceWith(v);v.load();});
  await videoPage.waitForFunction(()=>document.querySelector('video').readyState>=2);
  await videoPage.waitForTimeout(1600);
  check('paused video stays paused after player-node replacement',await videoPage.evaluate(()=>document.querySelector('video').paused));
  await videoPage.evaluate(async()=>{await document.querySelector('video').play();});
  await poll(async()=>(await cmd('GET')).state.session.status==='playing');
  await videoPage.evaluate(()=>document.querySelector('video').dispatchEvent(new Event('waiting')));
  await poll(async()=>(await cmd('GET')).state.session.status==='buffering').catch(()=>{});
  check('buffering state is reported', (await cmd('GET')).state.session.status==='buffering');
  await videoPage.evaluate(async()=>{const v=document.querySelector('video');v.pause();await v.play();});
  await poll(async()=>(await cmd('GET')).state.session.status==='playing');
  await videoPage.evaluate(async()=>{const v=document.querySelector('video');await v.play();v.src='data:video/mp4;base64,AAAA';v.load();});
  await videoPage.waitForFunction(()=>Boolean(document.querySelector('video').error));
  await videoPage.waitForTimeout(900);
  const errorStatus=(await cmd('GET')).state.session.status;
  check('native media load failure is reported as error',errorStatus==='error',`status=${errorStatus}`);
  await cmd('START');await poll(async()=>(await cmd('GET')).state.session.status==='playing');
  await page.locator('#open-add').click();await page.locator('#input').fill('https://b23.tv/slow');await page.locator('#add').click();
  await poll(()=>shortEntered);await page.keyboard.press('Escape');
  const stopAvailable=!await page.locator('#stop').isDisabled();
  check('Stop remains available while a short link is resolving',stopAvailable);
  if(stopAvailable){await page.locator('#stop').click();await poll(async()=>!(await cmd('GET')).state.session.running);check('Stop pauses the media before the short-link response',await videoPage.evaluate(()=>document.querySelector('video').paused));}
  await page.locator('#open-add').click();await page.locator('#input').fill('BV1Q541167Qg');releaseShort();
  await poll(async()=>(await cmd('GET')).state.list.items.length===2);
  await page.waitForTimeout(200);
  check('an earlier import cannot overwrite a newly opened draft',await page.locator('#input').inputValue()==='BV1Q541167Qg'&&await page.locator('#add-dialog').evaluate(el=>el.open));
  await page.locator('#input').fill('错误：原始内容');await page.locator('#add').click();
  await page.waitForFunction(()=>document.getElementById('add-feedback').textContent.includes('已添加 0 条'));
  check('failed input containing a full-width colon stays intact',await page.locator('#input').inputValue()==='错误：原始内容');
  metadataTitle='<img src=x onerror="window.__auditInjected=true">';await cmd('REFRESH_METADATA');
  await poll(async()=>(await cmd('GET')).state.list.items.every(x=>x.title===metadataTitle));
  await page.waitForFunction(()=>document.querySelector('.title')?.textContent.startsWith('<img'));
  check('video titles are rendered as text without executing HTML',await page.locator('#list img').count()===0&&!await page.evaluate(()=>window.__auditInjected));
  check('no uncaught browser errors',!errors.length,errors.join(';'));
  console.log(JSON.stringify(checks));
  if(checks.some(x=>!x.passed))process.exitCode=1;
 }finally{await context.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
