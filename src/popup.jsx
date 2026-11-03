import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { iconPaths } from '../icons.js';
import { durationSummary, formatDuration, validDuration } from '../metadata.js';
import { playbackOrder, playbackProgress } from '../playback.js';

const EMPTY = { list: { items: [], direction: 'forward', loop: false, playbackRate: 1 }, session: { status: 'ready', currentTime: 0 } };
const STATUS = { ready: '等待开始', loading: '正在加载', playing: '正在播放', paused: '已暂停', buffering: '正在缓冲', error: '加载失败', missing: '未找到播放器', blocked: '等待点击播放', stopped: '已停止', finished: '本轮已播完' };

function Icon({ name, className = '' }) {
  return <svg className={`icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{(iconPaths[name] || iconPaths.play).map(([tag, attrs], i) => React.createElement(tag, { ...attrs, key: i }))}</svg>;
}
function Button({ name, label, className = '', children, ...props }) {
  return <button type="button" className={className} aria-label={label} title={label} {...props}>{name && <Icon name={name} />}{children}</button>;
}
function Cover({ url }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return <span className="cover">{url && !failed ? <img src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <Icon name="play" />}</span>;
}

function App() {
  const [state, setState] = useState(EMPTY);
  const [pending, setPending] = useState({ action: false, importing: false });
  const pendingRef = useRef({ action: false, importing: false });
  const [draft, setDraft] = useState('');
  const draftRef = useRef('');
  const dialog = useRef(null), input = useRef(null), dialogVersion = useRef(0);
  const [feedback, setFeedback] = useState('');
  const [toast, setToast] = useState({ text: '', error: false });
  const toastTimer = useRef(null);
  const [menu, setMenu] = useState(null);
  const drag = useRef(null);
  const [dragged, setDragged] = useState(null);
  const [drop, setDrop] = useState(null);
  const listRef = useRef(null);

  const notify = useCallback((text, error = false) => {
    clearTimeout(toastTimer.current);
    if (dialog.current?.open) { setFeedback(text); return; }
    setToast({ text, error });
    if (!error) toastTimer.current = setTimeout(() => setToast({ text: '', error: false }), 3500);
  }, []);
  const request = useCallback(async (type, fields = {}) => {
    const response = await chrome.runtime.sendMessage({ type, ...fields });
    if (!response?.ok) throw new Error(response?.error || '扩展未响应，请重新打开');
    if (response.state) setState(response.state);
    return response;
  }, []);
  const execute = useCallback(async (type, fields = {}) => {
    const importing = type === 'ADD', key = importing ? 'importing' : 'action';
    if (pendingRef.current.action || importing && pendingRef.current.importing) return;
    pendingRef.current = { ...pendingRef.current, [key]: true }; setPending(pendingRef.current);
    setMenu(null);
    try { return await request(type, fields); }
    catch (error) { notify(error.message, true); }
    finally { pendingRef.current = { ...pendingRef.current, [key]: false }; setPending(pendingRef.current); }
  }, [request, notify]);

  useEffect(() => {
    let refresh;
    const onChange = changes => {
      if (!changes.playlist && !changes.playback) return;
      clearTimeout(refresh);
      refresh = setTimeout(() => { void request('GET').catch(error => notify(error.message, true)); }, 80);
    };
    chrome.storage.onChanged.addListener(onChange);
    void request('GET').catch(error => notify(error.message, true));
    void chrome.tabs.getCurrent().then(tab => document.documentElement.classList.toggle('manager', Boolean(tab))).catch(() => {});
    return () => { clearTimeout(refresh); clearTimeout(toastTimer.current); chrome.storage.onChanged.removeListener(onChange); };
  }, [request, notify]);
  useEffect(() => {
    if (!menu) return;
    const close = event => { if (!event.target.closest('.row-menu')) setMenu(null); };
    const escape = event => { if (event.key === 'Escape') setMenu(null); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [menu]);

  const setInput = value => { draftRef.current = value; setDraft(value); };
  function openAdd() {
    dialogVersion.current++; setFeedback(''); setToast({ text: '', error: false });
    if (!dialog.current.open) dialog.current.showModal();
    input.current.focus();
  }
  async function add() {
    const text = draftRef.current, version = dialogVersion.current;
    const response = await execute('ADD', { text });
    if (!response) return;
    const sameDraft = version === dialogVersion.current && draftRef.current === text;
    if (sameDraft && !response.errors.length) { setInput(''); dialog.current.close(); }
    else if (sameDraft) setInput(response.failedTokens.join('\n'));
    notify(`${sameDraft ? '' : '上一批：'}已添加 ${response.added} 条视频${response.errors.length ? '\n' + response.errors.join('\n') : ''}`, Boolean(response.errors.length));
  }
  function endDrag() { drag.current = null; setDragged(null); setDrop(null); }
  function dragStart(event, id) {
    if (pending.action || event.target.closest('button')) { event.preventDefault(); return; }
    drag.current = id; setDragged(id); setMenu(null);
    event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', id);
  }
  function dragOver(event) {
    if (!drag.current || pending.action) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    const row = event.target.closest('.item');
    if (row && row.dataset.id !== drag.current) {
      const rect = row.getBoundingClientRect();
      const placement = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      setDrop(previous => previous?.id === row.dataset.id && previous.placement === placement ? previous : { id: row.dataset.id, placement });
    }
    const rect = listRef.current.getBoundingClientRect();
    if (event.clientY < rect.top + 28) listRef.current.scrollTop -= 12;
    else if (event.clientY > rect.bottom - 28) listRef.current.scrollTop += 12;
  }
  function dropped(event) {
    if (!drag.current) return;
    event.preventDefault();
    const row = event.target.closest('.item'), id = drag.current, targetId = row?.dataset.id;
    const rect = row?.getBoundingClientRect();
    const placement = rect && event.clientY > rect.top + rect.height / 2 ? 'after' : 'before';
    endDrag();
    if (targetId && targetId !== id) void execute('REORDER', { id, targetId, placement });
  }

  const { list, session } = state, summary = durationSummary(list.items), progress = playbackProgress(list, session);
  const reverse = list.direction === 'reverse', busy = pending.action;
  const position = playbackOrder(list).findIndex(item => item.id === session.itemId);
  const currentId = session.running ? session.itemId : list.selectedId;
  const loading = list.items.some(item => item.metadataStatus === 'loading' || !item.metadataStatus);
  const currentTitle = progress.item ? `${progress.item.title || progress.item.bvid}${progress.item.partTitle ? ` · ${progress.item.partTitle}` : ''}` : '选择视频，开始播放';
  const videoTime = `${formatDuration(progress.currentTime)} / ${formatDuration(progress.duration)}`;
  const queueTime = `${progress.position ? `第 ${progress.position}/${progress.count} 条` : '尚未开始'} · ${Math.floor(progress.overallRatio * 100)}%`;
  const queueElapsed = progress.completeTotal ? `${formatDuration(progress.elapsed)} / ${formatDuration(progress.total)}` : '按条数估算 · 时长待补全';
  const activeStatus = ['playing', 'paused', 'buffering', 'blocked', 'error', 'missing'].includes(session.status);
  const disabledPrev = busy || !list.items.length || !list.loop && position === 0;
  const disabledNext = busy || !list.items.length || !list.loop && position >= 0 && position === list.items.length - 1;

  return <main className="app-shell">
    <header className="app-header">
      <div className="brand"><span className="logo" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="m11 3 5 5 5-5M7 9h18a3 3 0 0 1 3 3v13a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V12a3 3 0 0 1 3-3Z"/><path className="logo-play" d="m13 14 8 5-8 5Z"/></svg></span><h1>bilibili-queue</h1></div>
      <div className="header-actions"><Button id="expand" className="icon-button" name="expand" label="在独立标签页管理" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') })}/><span className="header-divider"/><Button id="open-add" className="primary" name="plus" label="添加视频" onClick={openAdd}>添加视频</Button></div>
    </header>
    <section className="queue-panel" aria-label="视频播放列表">
      <div className="queue-heading"><h2>播放列表 <span id="count">{list.items.length}</span></h2><div className="list-summary" aria-live="polite"><span id="duration-label">{summary.unknown ? '已知时长' : '总时长'}</span><strong id="total-duration">{summary.unknown && !summary.known ? '--:--' : formatDuration(summary.seconds)}</strong></div></div>
      <div className="queue-toolbar">
        <div className="segmented" role="group" aria-label="播放方向"><button id="order-forward" aria-pressed={!reverse} disabled={busy} onClick={() => void execute('DIRECTION', { value: 'forward' })}>顺序</button><button id="order-reverse" aria-pressed={reverse} disabled={busy} onClick={() => void execute('DIRECTION', { value: 'reverse' })}>逆序</button></div>
        <span className="toolbar-divider"/>
        <label className="loop" htmlFor="loop"><span>列表循环</span><input id="loop" type="checkbox" checked={list.loop} disabled={busy} onChange={event => void execute('LOOP', { value: event.target.checked })}/><span className="switch" aria-hidden="true"/></label>
        <label className="speed-control" htmlFor="playback-rate"><span>倍速</span><select id="playback-rate" aria-label="播放速度" title="立即应用，下一条视频沿用此速度" value={list.playbackRate ?? 1} disabled={busy} onChange={event => void execute('RATE', { value: Number(event.target.value) })}>{[1, 1.5, 2, 3].map(rate => <option key={rate} value={rate}>{rate}×</option>)}</select></label>
        <div className="toolbar-end"><Button id="refresh" className="icon-button" name="refresh" label="刷新信息" disabled={busy || !list.items.length} onClick={() => void execute('REFRESH_METADATA')}/><Button id="clear" className="icon-button danger" name="trash" label="清空" disabled={busy || !list.items.length} onClick={() => { if (confirm('清空整个播放列表？正在播放的视频也会暂停。')) void execute('CLEAR'); }}/></div>
      </div>
      <div id="duration-status" className="duration-status" role="status" hidden={!summary.unknown && !loading}>{summary.unknown ? `另 ${summary.unknown} 条时长待获取${loading ? ' · 获取中' : ' · 可点击刷新重试'}` : '正在更新视频信息…'}</div>
      <p id="order-hint" className="sr-only">{reverse ? '从下往上播放' : '从上往下播放'}，拖动六点手柄调整顺序。</p>
      <ol id="list" ref={listRef} hidden={!list.items.length} aria-label="按播放顺序排列的视频" onWheel={() => setMenu(null)} onDragOver={dragOver} onDrop={dropped} onDragEnd={endDrag}>
        {list.items.map((item, index) => {
          const current = item.id === currentId;
          return <li key={item.id} data-id={item.id} aria-current={current} className={`item${current ? ' current' : ''}${dragged === item.id ? ' dragging' : ''}${drop?.id === item.id ? ` drop-${drop.placement}` : ''}`} draggable={!busy} onDragStart={event => dragStart(event, item.id)}>
            <span className="drag-handle" title="拖动调整顺序" aria-hidden="true"><Icon name="grip"/></span>
            <span className="ordinal">{String(index + 1).padStart(2, '0')}</span>
            <Cover url={item.cover}/>
            <div className="info"><div className="title" title={item.title || item.metadataError}>{item.title || (item.metadataStatus === 'error' ? '视频信息暂未获取' : '正在获取视频标题…')}</div><div className="meta">{item.bvid}<span className="part-tag">P{item.page}</span>{item.partTitle && item.partTitle !== item.title && <span className="part-title" title={item.partTitle}>· {item.partTitle}</span>}</div>{item.metadataStatus === 'error' && <div className="metadata-error" title={item.metadataError}>{item.metadataError || '获取失败，请刷新重试'}</div>}</div>
            <span className="duration"><span className="sr-only">时长 </span>{formatDuration(validDuration(item.duration) ? item.duration : null)}</span>
            <div className="row-actions"><Button name="play" className="row-play" label={`从第 ${index + 1} 条开始播放`} disabled={busy} onClick={() => void execute('START', { id: item.id })}/><Button name="trash" className="row-delete danger" label="删除" disabled={busy} onClick={() => void execute('REMOVE', { id: item.id })}/><div className="row-menu"><Button name="list" className="row-more" label="更多操作" aria-expanded={menu?.id === item.id} disabled={busy} onClick={() => setMenu(menu === item.id ? null : item.id)}/>{menu === item.id && <div className="row-menu-panel" role="menu" style={{ left: menu.left, top: menu.top }}><button role="menuitem" disabled={index === 0} onClick={() => void execute('MOVE', { id: item.id, delta: -1 })}><Icon name="up"/>上移</button><button role="menuitem" disabled={index === list.items.length - 1} onClick={() => void execute('MOVE', { id: item.id, delta: 1 })}><Icon name="down"/>下移</button></div>}</div></div>
          </li>;
        })}
      </ol>
      <div id="empty" hidden={Boolean(list.items.length)}><span className="empty-icon"><Icon name="list"/></span><h3>播放列表还是空的</h3><p>添加 BV 号或视频链接，按你喜欢的顺序播放。</p><Button id="empty-add" name="plus" label="添加第一个视频" className="primary" onClick={openAdd}>添加第一个视频</Button></div>
      <div className="queue-footer"><Icon name="grip"/>拖动调整顺序<span>列表自动保存在本机</span></div>
    </section>
    <section className={`player-card${activeStatus ? ' has-playback' : ''}`} data-empty={!progress.item} aria-label="播放控制">
      <div className="player-main">
        <div className="player-details"><div className="status-row"><span id="status-dot" className={`dot ${session.status === 'playing' ? 'active' : ['error','buffering','blocked','missing'].includes(session.status) ? 'blocked' : ''}`}/><span id="status">{STATUS[session.status] || '等待开始'}</span><span className="player-position">{progress.position ? `${progress.position} / ${progress.count}` : '你的下一场放映'}</span></div><div className="now-row"><h2 id="now-title" title={currentTitle}>{currentTitle}</h2><Button id="focus" className="player-link" name="expand" label="前往播放页" disabled={busy || session.tabId == null} onClick={() => void execute('FOCUS')}/></div><p id="note" hidden={!['blocked','error','missing','buffering'].includes(session.status)}>{session.note}</p><progress id="video-progress" max="1" value={progress.currentRatio} aria-label="当前视频播放进度" aria-valuetext={`${videoTime} · ${Math.floor(progress.currentRatio * 100)}%`}/><div className="time-row"><span id="video-time">{videoTime}</span><span id="video-percent">{Math.floor(progress.currentRatio * 100)}%</span></div></div>
        <div className="controls"><Button id="prev" name="prev" className="icon-button" label="上一条" disabled={disabledPrev} onClick={() => void execute('PREV')}/><Button id="start" name={session.running ? 'restart' : 'play'} className="primary main-play" label={session.running ? '重播当前' : reverse ? '开始逆序' : '开始顺序'} disabled={busy || !list.items.length} onClick={() => void execute('START')}/><Button id="next" name="next" className="icon-button" label="下一条" disabled={disabledNext} onClick={() => void execute('NEXT')}/><Button id="stop" name="stop" className="icon-button" label="停止" disabled={busy || !session.running} onClick={() => void execute('STOP')}/></div>
      </div>
      <div className="queue-progress-row"><span id="queue-time">{queueTime}</span><progress id="queue-progress" max="1" value={progress.overallRatio} aria-label="列表播放进度" aria-valuetext={`${queueTime} · ${queueElapsed}`} title="按当前排列及方向计算，不表示累计观看时间"/><span id="queue-elapsed">{queueElapsed}</span></div>
    </section>
    <div id="message" role="status" className={`message${toast.error ? ' error' : ''}`} hidden={!toast.text}>{toast.text}</div>
    <dialog id="add-dialog" ref={dialog} aria-labelledby="add-heading"><div className="dialog-heading"><div><h2 id="add-heading">添加视频</h2><p>支持 BV 号、视频链接和 b23.tv 短链</p></div><Button id="close-add" name="close" className="icon-button" label="关闭添加窗口" onClick={() => dialog.current.close()}/></div><label htmlFor="input">每行一个视频，也可用空格或逗号分隔</label><textarea id="input" ref={input} value={draft} onChange={event => setInput(event.target.value)} spellCheck="false" placeholder={'BV1xx411c7mD\nhttps://www.bilibili.com/video/BV1Q541167Qg/'} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void add(); } }}/><p id="add-feedback" className="add-feedback" role="status" hidden={!feedback}>{feedback}</p><div className="dialog-footer"><span>Ctrl + Enter 快速添加 · 允许重复条目</span><Button id="add" name="plus" className="primary" label="添加到队列" disabled={busy || pending.importing} onClick={() => void add()}>{pending.importing ? '正在解析…' : '添加到队列'}</Button></div></dialog>
  </main>;
}

createRoot(document.getElementById('root')).render(<App/>);
