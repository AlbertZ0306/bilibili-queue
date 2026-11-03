const BV = /^BV[a-zA-Z0-9]{10}$/;
const HOSTS = new Set(['www.bilibili.com', 'bilibili.com', 'm.bilibili.com']);

export function parseVideo(input) {
  const value = String(input).trim();
  if (/^bv/i.test(value) && BV.test('BV' + value.slice(2))) {
    return { bvid: 'BV' + value.slice(2), page: 1 };
  }
  let url;
  try { url = new URL(/^https?:\/\//i.test(value) ? value : 'https://' + value); }
  catch { throw new Error('请输入完整 BV 号或 B 站视频链接'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('链接格式不正确');
  }
  if (url.hostname === 'b23.tv' && /^\/[a-zA-Z0-9]+\/?$/.test(url.pathname)) {
    return { shortUrl: 'https://b23.tv' + url.pathname };
  }
  const match = /^\/video\/(BV[a-zA-Z0-9]{10})\/?$/i.exec(url.pathname);
  if (!HOSTS.has(url.hostname) || !match || !BV.test('BV' + match[1].slice(2))) {
    throw new Error('仅支持 BV 号、/video/BV… 视频链接或 b23.tv 视频短链');
  }
  const p = url.searchParams.get('p') ?? '1';
  if (!/^[1-9]\d{0,4}$/.test(p)) throw new Error('分 P 参数 p 必须是正整数');
  return { bvid: 'BV' + match[1].slice(2), page: Number(p) };
}

// One entry per line, or use whitespace / Chinese or ASCII commas as separators.
export function splitInput(text) {
  if (typeof text !== 'string' || text.length > 100000) throw new Error('输入过长，请分批添加');
  return text.trim().split(/[\s,，;；]+/u).filter(Boolean);
}

export function videoURL(item, runId) {
  const url = new URL(`https://www.bilibili.com/video/${item.bvid}/`);
  url.searchParams.set('p', String(item.page));
  if (runId) {
    url.searchParams.set('autoplay', '1');
    url.searchParams.set('t', '0');
    // A different query forces a fresh document for duplicate queue entries.
    url.searchParams.set('bq_run', runId);
  }
  return url.href;
}

export function matchesRun(url, item, runId) {
  try {
    const parsed = parseVideo(url);
    return parsed.bvid === item.bvid && parsed.page === item.page &&
      new URL(url).searchParams.get('bq_run') === runId;
  } catch { return false; }
}
