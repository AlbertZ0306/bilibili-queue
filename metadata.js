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

export async function fetchVideoMetadata(bvid, fetcher = fetch) {
  const url = new URL('https://api.bilibili.com/x/web-interface/view');
  url.searchParams.set('bvid', bvid);
  const response = await fetcher(url.href, { credentials: 'omit', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`视频信息请求失败（HTTP ${response.status}）`);
  const body = await response.json();
  if (body.code !== 0) throw new Error(typeof body.message === 'string' ? body.message.slice(0, 120) : '暂时无法获取视频信息');
  if (!body.data || typeof body.data.title !== 'string' || !body.data.title.trim() || !Array.isArray(body.data.pages)) {
    throw new Error('视频信息不完整，请稍后刷新');
  }
  if (body.data.bvid && body.data.bvid !== bvid) throw new Error('返回的视频信息不匹配');
  return body.data;
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
