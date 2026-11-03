import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../controller.js';
import { durationSummary, fetchVideoMetadata, formatDuration, metadataForPage, metadataFromPageHTML, safeCover } from '../metadata.js';

const bvid = 'BV1xx411c7mD';
const data = { bvid, title: '测试课程', duration: 999, pages: [
  { page: 1, part: '第一课', duration: 60 }, { page: 2, part: '第二课', duration: 125 }
] };
const response = value => ({ ok: true, json: async () => ({ code: 0, data: value }) });
async function until(fn) {
  const end = Date.now() + 2000;
  while (Date.now() < end) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw Error('Metadata did not settle');
}
function setup(fetcher, playlist) {
  const db = { local: { playlist }, session: {} };
  const api = {
    runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}` },
    storage: Object.fromEntries(['local','session'].map(area => [area, {
      get: async key => ({ [key]: structuredClone(db[area][key]) }),
      set: async values => Object.assign(db[area], structuredClone(values))
    }])),
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabs: { sendMessage: async () => {} }
  };
  const controller = createController(api, fetcher);
  const command = (type, fields = {}) => controller.handle({ type, ...fields }, { id: 'test', url: api.runtime.getURL('popup.html') });
  return { db, command, items: () => db.local.playlist?.items || [] };
}

test('duration formatting and totals handle hours, duplicates and unknown durations', () => {
  assert.equal(formatDuration(0), '00:00'); assert.equal(formatDuration(65), '01:05');
  assert.equal(formatDuration(3725), '1:02:05'); assert.equal(formatDuration(null), '--:--');
  assert.equal(formatDuration(NaN), '--:--'); assert.equal(formatDuration(-1), '--:--');
  assert.deepEqual(durationSummary([{ duration: 60 }, { duration: 125 }, { duration: 60 }, { duration: null }, {}]), { seconds: 245, known: 3, unknown: 2 });
});

test('metadata uses the selected P duration, never the whole multi-P duration', () => {
  assert.deepEqual(metadataForPage(data, 2), { title: '测试课程', partTitle: '第二课', duration: 125, metadataStatus: 'ready', metadataError: '', cover: '', coverChecked: true });
  const invalid = metadataForPage(data, 3);
  assert.equal(invalid.duration, null); assert.equal(invalid.metadataStatus, 'error'); assert.match(invalid.metadataError, /第 3 P 不存在/);
});

test('cover images accept only the Bilibili image CDN and normalize HTTPS', () => {
  assert.equal(safeCover('http://i0.hdslb.com/bfs/archive/a.jpg'),'https://i0.hdslb.com/bfs/archive/a.jpg');
  for (const value of ['javascript:alert(1)','data:image/png;base64,AAAA','https://hdslb.com.evil.test/a','https://user:password@i0.hdslb.com/a','https://evilhdslb.com/a',null]) assert.equal(safeCover(value),'');
  assert.equal(metadataForPage({...data,pic:'https://i0.hdslb.com/bfs/archive/a.jpg'},1).coverChecked,true);
});

test('old complete items make one bounded API/page attempt for missing covers and keep cached details', async () => {
  let calls=0;
  const h=setup(async()=>{calls++;return {ok:false,status:403};},{items:[{id:'legacy',bvid,page:1,title:'已缓存标题',duration:60,metadataStatus:'ready'}],loop:false,direction:'forward'});
  await h.command('GET');await until(()=>h.items()[0].coverChecked===true);
  for(let i=0;i<5;i++)await h.command('GET');
  assert.equal(calls,2);assert.equal(h.items()[0].title,'已缓存标题');assert.equal(h.items()[0].metadataStatus,'ready');
});

const pageHTML = value => `<html><script>window.__INITIAL_STATE__=${JSON.stringify({videoData:value})};(function(){window.__mustNotRun=true})()</script></html>`;

test('HTTP 412 falls back to public-page metadata without credentials or repeated API requests', async () => {
  const calls=[];
  const result=await fetchVideoMetadata(bvid,async(url,options)=>{
    calls.push({url,options});
    return url.startsWith('https://api.')?{ok:false,status:412}:{ok:true,text:async()=>pageHTML(data)};
  });
  assert.equal(result.title,data.title);assert.equal(calls.length,2);
  assert.equal(calls[1].url,`https://www.bilibili.com/video/${bvid}/`);
  assert(calls.every(x=>x.options.credentials==='omit'&&x.options.signal instanceof AbortSignal));
  assert.equal(metadataForPage(result,2).duration,125);
});

test('embedded state handles quotes, braces, unicode and trailing JavaScript without executing it', () => {
  const tricky={...data,title:'转义 "引号"、反斜杠 \\ 和 } { 中文'};
  globalThis.__mustNotRun=false;
  const result=metadataFromPageHTML(pageHTML(tricky),bvid);
  assert.equal(result.title,tricky.title);assert.equal(globalThis.__mustNotRun,false);
  delete globalThis.__mustNotRun;
  assert.throws(()=>metadataFromPageHTML('<script>window.__INITIAL_STATE__=(()=>{throw 1})()</script>',bvid));
  assert.throws(()=>metadataFromPageHTML('<script>window.__INITIAL_STATE__={broken}</script>',bvid));
});

test('unrelated, incomplete and challenge pages cannot become video metadata', () => {
  assert.throws(()=>metadataFromPageHTML(pageHTML({...data,bvid:'BV1Q541167Qg'}),bvid));
  assert.throws(()=>metadataFromPageHTML(pageHTML({...data,pages:null}),bvid));
  assert.throws(()=>metadataFromPageHTML('<h1>访问受限</h1><title>验证</title>',bvid));
  assert.throws(()=>metadataFromPageHTML(pageHTML({...data,bvid:undefined}),bvid));
});

test('when both sources fail, show a specific restriction message rather than a nonexistent-video error', async () => {
  let calls=0;
  await assert.rejects(fetchVideoMetadata(bvid,async()=>{calls++;return{ok:false,status:412};}),/B站暂时限制.*412.*打开视频页/);
  assert.equal(calls,2);
  await assert.rejects(fetchVideoMetadata('not-a-bv',async()=>{throw Error('must not fetch');}),/BV 号格式/);
});

test('three duplicate entries share one API and one page fallback, including covers and total duration', async () => {
  const calls=[];
  const h=setup(async url=>{
    calls.push(url);
    return url.startsWith('https://api.')?{ok:false,status:412}:{ok:true,text:async()=>pageHTML({...data,pic:'https://i0.hdslb.com/bfs/archive/test.jpg'})};
  });
  await h.command('ADD',{text:`${bvid}\n${bvid}\n${bvid}`});
  await until(()=>h.items().length===3&&h.items().every(x=>x.metadataStatus==='ready'));
  assert.equal(calls.length,2);assert.deepEqual(h.items().map(x=>x.duration),[60,60,60]);
  assert(h.items().every(x=>x.cover==='https://i0.hdslb.com/bfs/archive/test.jpg'));
  assert.equal(durationSummary(h.items()).seconds,180);
});

test('a working API returns directly without a webpage fetch', async () => {
  let calls=0;const result=await fetchVideoMetadata(bvid,async()=>{calls++;return response(data);});
  assert.equal(calls,1);assert.equal(result.title,data.title);
});

test('adding duplicates and multiple P entries shares a metadata request and stores per-P values', async () => {
  let calls = 0;
  const h = setup(async () => { calls++; return response(data); });
  await h.command('ADD', { text: `${bvid}\nhttps://www.bilibili.com/video/${bvid}/?p=2\n${bvid}` });
  await until(() => h.items().length === 3 && h.items().every(x => x.metadataStatus === 'ready'));
  assert.equal(calls, 1); assert.deepEqual(h.items().map(x => x.duration), [60,125,60]);
  assert(h.items().every(x => x.title === '测试课程'));
  assert.deepEqual(durationSummary(h.items()), { seconds: 245, unknown: 0, known: 3 });
  await h.command('REMOVE', { id: h.items()[1].id });
  assert.equal(durationSummary(h.items()).seconds, 120);
});

test('old lists hydrate automatically and a failed request can be retried', async () => {
  let fail = true;
  const h = setup(async () => fail ? { ok: true, json: async () => ({ code: -412, message: '请求暂受限制' }) } : response(data), {
    items: [{ id: 'legacy', bvid, page: 2, title: '' }], selectedId: 'legacy', loop: false
  });
  await h.command('GET'); await until(() => h.items()[0].metadataStatus === 'error');
  assert.equal(durationSummary(h.items()).unknown, 1);
  fail = false; await h.command('REFRESH_METADATA');
  await until(() => h.items()[0].metadataStatus === 'ready');
  assert.equal(h.items()[0].duration, 125); assert.equal(h.items()[0].title, '测试课程');
});

test('slow metadata does not block queue operations or resurrect removed items', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const h = setup(() => pending);
  await h.command('ADD', { text: bvid });
  const id = h.items()[0].id;
  await h.command('REMOVE', { id });
  await h.command('STOP');
  assert.equal(h.items().length, 0);
  resolve(response(data));
  await new Promise(done => setTimeout(done, 20));
  assert.equal(h.items().length, 0);
  assert.equal((await h.command('GET')).state.session.running, false);
});

test('bad HTTP, API errors and mismatched responses are rejected', async () => {
  await assert.rejects(fetchVideoMetadata(bvid, async () => ({ ok: false, status: 403 })), /403/);
  await assert.rejects(fetchVideoMetadata(bvid, async () => ({ ok: true, json: async () => ({ code: -404, message: '视频不存在' }) })), /视频不存在/);
  await assert.rejects(fetchVideoMetadata(bvid, async () => response({ ...data, bvid: 'BV1Q541167Qg' })), /不匹配/);
});

test('malformed page arrays and blank API error messages settle into a retryable error', async () => {
  const malformed=setup(async()=>response({...data,pages:[null]}));
  await malformed.command('ADD',{text:bvid});await until(()=>malformed.items()[0].metadataStatus==='error');
  const blank=setup(async()=>({ok:true,json:async()=>({code:-1,message:''})}));
  await blank.command('ADD',{text:bvid});await until(()=>blank.items()[0].metadataStatus==='error');
  assert(blank.items()[0].metadataError);
});

test('bulk metadata loading respects its three-request concurrency limit', async () => {
  let active=0,maximum=0;
  const h=setup(async url=>{
    active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setTimeout(resolve,2));active--;
    return response({bvid:new URL(url).searchParams.get('bvid'),title:'并发测试',pages:[{page:1,duration:60}]});
  });
  const tokens=Array.from({length:20},(_,i)=>`BV1xx411${String(i).padStart(4,'0')}`);
  await h.command('ADD',{text:tokens.join('\n')});await until(()=>h.items().length===20&&h.items().every(x=>x.metadataStatus==='ready'));
  assert.equal(maximum,3);assert.equal(durationSummary(h.items()).seconds,1200);
});
