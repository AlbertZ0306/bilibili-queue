export function validDuration(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const rest = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${String(minutes).padStart(2, '0')}:${rest}`;
}

export function durationSummary(items) {
  let seconds = 0, unknown = 0;
  for (const item of items) {
    if (validDuration(item.duration)) seconds += Math.round(item.duration);
    else unknown++;
  }
  return { seconds, unknown, known: items.length - unknown };
}

export function safeCover(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return '';
    if (url.hostname !== 'hdslb.com' && !url.hostname.endsWith('.hdslb.com')) return '';
    url.protocol = 'https:';
    return url.href;
  } catch { return ''; }
}

function validateMetadata(data, bvid) {
  if (!data || typeof data.title !== 'string' || !data.title.trim() || !Array.isArray(data.pages)) {
    throw new Error('视频信息不完整，请稍后刷新');
  }
  if (data.bvid && data.bvid !== bvid) throw new Error('返回的视频信息不匹配');
  return data;
}

export function metadataFromPageHTML(html, bvid) {
  if (typeof html !== 'string' || html.length > 5 * 1024 * 1024) throw new Error('网页视频信息不可用');
  // Read JSON already embedded in the public video page. Never execute page scripts.
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const script = match[1], assignment = /(?:^|[;\s])(?:window\.)?__INITIAL_STATE__\s*=\s*/.exec(script);
    if (!assignment) continue;
    const start = assignment.index + assignment[0].length;
    if (script[start] !== '{') continue;
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < script.length; i++) {
      const char = script[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        try {
          const data = JSON.parse(script.slice(start, i + 1)).videoData;
          if (data?.bvid === bvid) return validateMetadata(data, bvid);
        } catch { /* malformed or unrelated page data */ }
        break;
      }
    }
  }
  throw new Error('网页未提供匹配的视频信息');
}

export async function fetchVideoMetadata(bvid, fetcher = fetch) {
  if (!/^BV[a-zA-Z0-9]{10}$/.test(bvid)) throw new Error('BV 号格式不正确');
  const deadline = Date.now() + 10000;
  const options = timeout => ({ credentials: 'omit', signal: AbortSignal.timeout(Math.max(1, Math.min(timeout, deadline - Date.now()))) });
  let failure;
  try {
    const url = new URL('https://api.bilibili.com/x/web-interface/view');
    url.searchParams.set('bvid', bvid);
    const response = await fetcher(url.href, options(6000));
    if (!response.ok) throw new Error([412, 429].includes(response.status)
      ? `B站暂时限制信息请求（HTTP ${response.status}），可打开视频页后补全`
      : `视频信息请求失败（HTTP ${response.status}）`);
    const body = await response.json();
    if (body.code !== 0) throw new Error(body.code === -412
      ? `B站暂时限制信息请求（${body.code}），可打开视频页后补全`
      : typeof body.message === 'string' && body.message.trim() ? body.message.slice(0, 120) : '暂时无法获取视频信息');
    return validateMetadata(body.data, bvid);
  } catch (error) { failure = error; }
  // One bounded fallback, sharing the same request across duplicate queue entries.
  // Keep requests anonymous; no cookie access, proxy, challenge solving or retry loop.
  try {
    if (Date.now() >= deadline) throw failure;
    const response = await fetcher(`https://www.bilibili.com/video/${bvid}/`, options(6000));
    if (!response.ok) throw failure;
    return metadataFromPageHTML(await response.text(), bvid);
  } catch { throw failure; }
}

export function metadataForPage(data, page) {
  const title = data.title.trim().slice(0, 180);
  const image = { cover: safeCover(data.pic), coverChecked: true };
  const part = data.pages.find(item => item && typeof item === 'object' && item.page === page);
  if (!part) return { title, partTitle: '', duration: null, metadataStatus: 'error', metadataError: `第 ${page} P 不存在`, ...image };
  const duration = validDuration(part.duration) ? Math.round(part.duration) : null;
  return {
    title,
    partTitle: data.pages.length > 1 && typeof part.part === 'string' ? part.part.trim().slice(0, 180) : '',
    duration,
    metadataStatus: duration ? 'ready' : 'error',
    metadataError: duration ? '' : '暂时无法获取时长',
    ...image
  };
}
