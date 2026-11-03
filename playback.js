import { durationSummary, validDuration } from './metadata.js';

export function playbackOrder(list) {
  return list.direction === 'reverse' ? [...list.items].reverse() : list.items;
}

export function playbackProgress(list, session) {
  const items = playbackOrder(list);
  const index = items.findIndex(item => item.id === session.itemId);
  const item = items[index] ?? null;
  const summary = durationSummary(items);
  const duration = item ? (validDuration(session.mediaDuration) ? session.mediaDuration : validDuration(item.duration) ? item.duration : null) : null;
  const finished = Boolean(item && session.status === 'finished');
  const rawTime = typeof session.currentTime === 'number' && Number.isFinite(session.currentTime) ? Math.max(0, session.currentTime) : 0;
  const currentTime = !item ? 0 : finished && duration ? duration : duration ? Math.min(rawTime, duration) : rawTime;
  const currentRatio = duration ? Math.min(1, currentTime / duration) : 0;
  const completeTotal = summary.unknown === 0;
  const prefix = index < 0 ? 0 : items.slice(0, index).reduce((sum, row) => sum + (validDuration(row.duration) ? Math.round(row.duration) : 0), 0);
  const elapsed = item ? prefix + (validDuration(item.duration) ? Math.round(item.duration) * currentRatio : 0) : 0;
  const overallRatio = !item || !items.length ? 0 : completeTotal && summary.seconds > 0 ? elapsed / summary.seconds : (index + currentRatio) / items.length;
  return { item, position: index + 1, count: items.length, currentTime, duration, currentRatio,
    elapsed, total: summary.seconds, completeTotal,
    overallRatio: Math.max(0, Math.min(1, overallRatio)) };
}
