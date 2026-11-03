const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const extension=path.resolve(process.env.NATIVE_EXTENSION||path.join(__dirname,'..'));
process.env.NATIVE_EXPECT_FIXED='1';
process.env.NATIVE_SEED ??= '1';
const profile=path.join(process.env.BILI_AUDIT_WORKDIR||require('node:os').tmpdir(),`bili-native-popup-${Date.now()}`);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const context=await chromium.launchPersistentContext(profile,{...(process.env.BILI_TEST_BROWSER?{executablePath:process.env.BILI_TEST_BROWSER}:{channel:'chromium'}),viewport:null,headless:false,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--remote-debugging-port=0','--window-size=1200,900',...(process.env.NATIVE_SCALE?[`--force-device-scale-factor=${process.env.NATIVE_SCALE}`]:[])]});
 let socket;
 try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const extensionId=worker.url().split('/')[2];
  if(process.env.NATIVE_SEED){
    let items;
    if(fs.existsSync('work/ui-real-samples.json'))items=JSON.parse(fs.readFileSync('work/ui-real-samples.json','utf8'));
    else items=Array.from({length:6},(_,i)=>({id:`native-${i}`,bvid:'BV1xx411c7mD',page:1,title:`原生弹窗测试视频 ${i+1}`,duration:120,coverChecked:true,metadataStatus:'ready'}));
    const current=items[1];
    await worker.evaluate(async({items,current})=>{await chrome.storage.local.set({playlist:{items,direction:'forward',selectedId:current.id,loop:false}});await chrome.storage.session.set({playback:{running:true,itemId:current.id,tabId:null,runId:'native-test',status:'playing',currentTime:Math.min(26,current.duration*.24),mediaDuration:current.duration}});},{items,current});
  }
  const [port]=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n');
  const version=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  socket=new WebSocket(version.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let seq=0;const pending=new Map();
  socket.addEventListener('message',event=>{const msg=JSON.parse(event.data);if(msg.id&&pending.has(msg.id)){const {resolve,reject}=pending.get(msg.id);pending.delete(msg.id);msg.error?reject(Error(msg.error.message)):resolve(msg.result);}});
  function send(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
  await worker.evaluate(()=>chrome.action.openPopup());
  await sleep(500);
  const contexts=await worker.evaluate(()=>chrome.runtime.getContexts({contextTypes:['POPUP']}));
  console.log('Chrome popup contexts:',JSON.stringify(contexts));
  let target;
  for(let i=0;i<30;i++){const result=await send('Target.getTargets');target=result.targetInfos.find(x=>x.url===`chrome-extension://${extensionId}/popup.html`);if(target)break;await sleep(100);}
  console.log('Targets:',JSON.stringify((await send('Target.getTargets')).targetInfos.map(t=>({type:t.type,url:t.url,targetId:t.targetId}))));
  assert(contexts.length>0,'A real Chrome POPUP context must exist');assert(target,'Native popup target must exist');
  const {sessionId}=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true});
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;};
  await sleep(process.env.NATIVE_SEED?1500:300);
  await evaluate(`(()=>{const select=document.getElementById('playback-rate');select.value='3';select.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await sleep(300);
  const speed=await evaluate(`(async()=>{const {playlist}=await chrome.storage.local.get('playlist');const el=document.getElementById('playback-rate'),r=el.getBoundingClientRect();return{value:el.value,saved:playlist.playbackRate,left:r.left,right:r.right}})()`);
  assert.equal(speed.value,'3');assert.equal(speed.saved,3);assert(speed.left>=0&&speed.right<=520);
  console.log('PASS: native popup speed selector saves 3x:',JSON.stringify(speed));
  const state=await evaluate(`({width:innerWidth,height:innerHeight,html:getComputedStyle(document.documentElement).width,body:getComputedStyle(document.body).width,rootClass:document.documentElement.className,manager:document.documentElement.classList.contains('manager'),scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,ready:!!document.getElementById('open-add'),screenWidth:screen.width,dpr:devicePixelRatio,media:matchMedia('(max-width:519px)').matches})`);
  console.log('NATIVE POPUP:',JSON.stringify(state));
  const shot=await send('Page.captureScreenshot',{format:'png'},sessionId);
  fs.writeFileSync(process.env.NATIVE_SCREENSHOT||path.join(profile,'native-popup.png'),Buffer.from(shot.data,'base64'));
  if(process.env.NATIVE_EXPECT_FIXED){assert.equal(state.width,520);assert.equal(state.height,600);assert.equal(state.manager,false);assert.equal(state.scrollWidth,520);assert.equal(state.ready,true);console.log('PASS: real toolbar popup is 520x600, not a simulated tab.');}
  if(process.env.NATIVE_EXPECT_FIXED){
    const details=await evaluate(`(()=>{const list=document.getElementById('list'),rect=list.getBoundingClientRect();return{rows:list.children.length,listHeight:list.clientHeight,visibleRows:[...list.children].filter(row=>{const b=row.getBoundingClientRect();return b.top>=rect.top&&b.bottom<=rect.bottom}).length,dockBottom:document.querySelector('.player-card').getBoundingClientRect().bottom}})()`);
    assert(details.dockBottom<=600.1);if(process.env.NATIVE_SEED){assert(details.rows>=5);assert(details.visibleRows>=5);}
    console.log('Native layout details:',JSON.stringify(details));
    const dialog=await evaluate(`(()=>{document.getElementById('open-add').click();const dialog=document.getElementById('add-dialog'),r=dialog.getBoundingClientRect();return{open:dialog.open,left:r.left,right:r.right,width:r.width,height:r.height}})()`);
    assert(dialog.open);assert(dialog.width>=400);assert(dialog.left>=0&&dialog.right<=520.1);console.log('PASS: add dialog fits actual native popup:',JSON.stringify(dialog));
    await evaluate(`document.getElementById('close-add').click();true`);
  }
 }finally{socket?.close();await context.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
