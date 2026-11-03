import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../controller.js';
import { metadataForPage } from '../metadata.js';
import { playbackProgress } from '../playback.js';

const BV = 'BV1xx411c7mD';
const nextTick = () => new Promise(resolve => setImmediate(resolve));
function harness(shortFetcher) {
  const db = { local: {}, session: {} }, tabs = new Map(); let id = 0;
  const api = {
    runtime: { id: 'audit', getURL: p => `chrome-extension://audit/${p}` },
    storage: Object.fromEntries(['local','session'].map(area => [area, {
      get: async key => ({ [key]: structuredClone(db[area][key]) }),
      set: async values => Object.assign(db[area], structuredClone(values))
    }])),
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabs: {
      get: async id => { if (!tabs.has(id)) throw Error('closed'); return {...tabs.get(id)}; },
      create: async options => { const t = { id:++id, windowId:1, ...options }; tabs.set(id,t); return {...t}; },
      update: async (id, options) => { Object.assign(tabs.get(id), options); return {...tabs.get(id)}; },
      sendMessage: async () => {}
    }
  };
  const controller = createController(api, async (url, options) => {
    if (url.startsWith('https://b23.tv/')) return shortFetcher(url, options);
    return { ok:true,json:async()=>({code:0,data:{bvid:BV,title:'测试视频',pages:[{page:1,duration:60}]}}) };
  });
  const command = (type, fields={}) => controller.handle({type,...fields},{id:'audit',url:api.runtime.getURL('popup.html')});
  const state = () => db.session.playback;
  const content = (type, fields={}) => controller.handle({type,runId:state().runId,url:tabs.get(state().tabId).url,...fields}, {id:'audit',tab:{id:state().tabId},frameId:0,documentId:'audit-doc'});
  return { db, api, command, content, state };
}

test('a pending short link cannot block Stop', async () => {
  let release, entered = false;
  const h = harness(() => { entered=true; return new Promise(resolve => {release=resolve;}); });
  await h.command('ADD',{text:BV}); await h.command('START');
  const add = h.command('ADD',{text:'https://b23.tv/slow'});
  while(!entered) await nextTick();
  let stopped=false; const stop = h.command('STOP').then(()=>{stopped=true;});
  await nextTick(); const stoppedBeforeNetwork = stopped;
  release({ok:true,url:`https://www.bilibili.com/video/${BV}/`});
  await Promise.all([add,stop]);
  assert.equal(stoppedBeforeNetwork,true,'Stop must complete before the network request finishes');
});

test('manual Next at the final video must not fabricate completion', async () => {
  const h=harness(); await h.command('ADD',{text:BV}); await h.command('START');
  await h.content('BQ_HELLO'); await h.content('BQ_PROGRESS',{currentTime:12,duration:60});
  await h.command('NEXT').catch(()=>{});
  assert.equal(h.state().running,true); assert.notEqual(h.state().status,'finished'); assert.equal(h.state().currentTime,12);
});

test('Next before starting in reverse mode starts at the direction boundary', async () => {
  const h=harness(); const added=await h.command('ADD',{text:`${BV} ${BV}`});
  await h.command('DIRECTION',{value:'reverse'}); await h.command('NEXT');
  assert.equal(h.state().running,true); assert.equal(h.state().itemId,added.state.list.items[1].id);
});

test('adding a new video after completion must reduce the queue progress', () => {
  const items=[{id:'a',duration:60},{id:'b',duration:60},{id:'c',duration:60}];
  const p=playbackProgress({items},{itemId:'b',status:'finished',currentTime:60,mediaDuration:60});
  assert.equal(p.overallRatio,2/3); assert.equal(p.elapsed,120);
});

test('malformed page entries cannot leave metadata loading forever', () => {
  const info=metadataForPage({title:'测试',pages:[null,{page:1,duration:60}]},1);
  assert.equal(info.duration,60); assert.equal(info.metadataStatus,'ready');
});

test('failed tab creation leaves a stopped state instead of an orphan running session', async () => {
  const h=harness(); await h.command('ADD',{text:BV}); await h.command('START');
  h.api.tabs.get=async()=>{throw Error('tab closed');};
  h.api.tabs.create=async()=>{throw Error('create failed');};
  await assert.rejects(h.command('START'),/create failed/);
  assert.equal(h.state().running,false);
});

test('clearing while resolving a short link cancels the old import', async () => {
  let release, entered=false;
  const h=harness(()=>{entered=true;return new Promise(resolve=>{release=resolve;});});
  const add=h.command('ADD',{text:'https://b23.tv/slow'}); const rejected=assert.rejects(add,/已取消/);
  while(!entered) await nextTick();
  const clear=h.command('CLEAR'); await nextTick();
  release({ok:true,url:`https://www.bilibili.com/video/${BV}/`});
  await Promise.all([clear,rejected]); assert.equal(h.db.local.playlist.items.length,0);
});

test('automatic ended can advance while an import is waiting for the network', async () => {
  let release,entered=false;
  const h=harness(()=>{entered=true;return new Promise(resolve=>{release=resolve;});});
  const added=await h.command('ADD',{text:`${BV} ${BV}`});await h.command('START');await h.content('BQ_HELLO');
  const add=h.command('ADD',{text:'https://b23.tv/slow'});while(!entered)await nextTick();
  const ended=h.content('BQ_ENDED');await nextTick();
  const advanced=h.state().itemId===added.state.list.items[1].id;
  release({ok:true,url:`https://www.bilibili.com/video/${BV}/`});await Promise.all([add,ended]);assert(advanced);
});

test('imports keep submitted batch order even if later input needs no network', async () => {
  let release,entered=false;
  const h=harness(()=>{entered=true;return new Promise(resolve=>{release=resolve;});});
  const first=h.command('ADD',{text:'https://b23.tv/slow'});while(!entered)await nextTick();
  const second=h.command('ADD',{text:'BV1Q541167Qg'});await nextTick();
  release({ok:true,url:`https://www.bilibili.com/video/${BV}/`});await Promise.all([first,second]);
  assert.deepEqual(h.db.local.playlist.items.map(x=>x.bvid),[BV,'BV1Q541167Qg']);
});

test('failed tokens are returned intact instead of being parsed out of error strings', async () => {
  const h=harness();const result=await h.command('ADD',{text:`${BV} 错误：原始内容`});
  assert.equal(result.added,1);assert.deepEqual(result.failedTokens,['错误：原始内容']);
});

test('unauthorized import never initiates a network request', async () => {
  let requests=0;const h=harness(()=>{requests++;});
  const controller=createController(h.api,()=>{requests++;});
  await assert.rejects(controller.handle({type:'ADD',text:'https://b23.tv/test'},{id:'audit',url:'https://www.bilibili.com/'}),/不允许/);
  assert.equal(requests,0);
});

test('automatic advance does not recreate a tab the user just closed', async () => {
  const h=harness();await h.command('ADD',{text:`${BV} ${BV}`});await h.command('START');await h.content('BQ_HELLO');
  h.api.tabs.get=async()=>{throw Error('user closed tab');};
  let creations=0;h.api.tabs.create=async()=>{creations++;return {id:99,url:'about:blank'};};
  await h.content('BQ_ENDED').catch(()=>{});
  assert.equal(creations,0);assert.equal(h.state().running,false);
});

test('parallel short-link resolution deduplicates requests and preserves mixed input order', async () => {
  const releases=new Map();let requests=0;
  const h=harness(url=>{requests++;return new Promise(resolve=>releases.set(url,resolve));});
  const pending=h.command('ADD',{text:`https://b23.tv/a ${BV} https://b23.tv/b https://b23.tv/a`});
  while(releases.size<2)await nextTick();
  releases.get('https://b23.tv/b')({ok:true,url:'https://www.bilibili.com/video/BV1Q541167Qg/?p=2'});
  releases.get('https://b23.tv/a')({ok:true,url:`https://www.bilibili.com/video/${BV}/`});
  const result=await pending;assert.equal(requests,2);
  assert.deepEqual(result.state.list.items.map(x=>[x.bvid,x.page]),[[BV,1],[BV,1],['BV1Q541167Qg',2],[BV,1]]);
});
