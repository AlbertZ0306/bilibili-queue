import test from 'node:test';
import assert from 'node:assert/strict';
import { playbackOrder, playbackProgress } from '../playback.js';

const items = [{ id: 'a', duration: 60 }, { id: 'b', duration: 120 }, { id: 'c', duration: 180 }];

test('queue progress uses time weighting and the current playback direction', () => {
  let p = playbackProgress({ items }, { itemId: 'b', currentTime: 30, mediaDuration: 120 });
  assert.equal(p.position, 2); assert.equal(p.duration, 120); assert.equal(p.currentRatio, .25);
  assert.equal(p.elapsed, 90); assert.equal(p.total, 360); assert.equal(p.overallRatio, .25);
  p = playbackProgress({ items, direction: 'reverse' }, { itemId: 'b', currentTime: 30, mediaDuration: 120 });
  assert.equal(p.elapsed, 210); assert.equal(p.overallRatio, 210 / 360);
  assert.deepEqual(playbackOrder({ items, direction: 'reverse' }).map(x => x.id), ['c','b','a']);
  assert.equal(items[0].id, 'a');
});

test('progress has a defined result for incomplete metadata, missing items and completed queues', () => {
  const unknown = [{ id: 'a', duration: null }, { id: 'b', duration: 120 }];
  let p = playbackProgress({ items: unknown }, { itemId: 'b', currentTime: 60 });
  assert.equal(p.completeTotal, false); assert.equal(p.overallRatio, .75);
  p = playbackProgress({ items }, { itemId: 'missing', currentTime: 999 });
  assert.equal(p.position, 0); assert.equal(p.overallRatio, 0); assert.equal(p.currentTime, 0);
  p = playbackProgress({ items }, { itemId: 'c', currentTime: 170, status: 'finished' });
  assert.equal(p.currentRatio, 1); assert.equal(p.overallRatio, 1); assert.equal(p.elapsed, 360);
  p = playbackProgress({ items: [] }, {}); assert.equal(p.overallRatio, 0);
});

test('actual media duration and seeking are reflected without corrupting metadata totals', () => {
  let p = playbackProgress({ items }, { itemId: 'b', currentTime: 61, mediaDuration: 122 });
  assert.equal(p.currentRatio, .5); assert.equal(p.elapsed, 120); assert.equal(p.total, 360);
  p = playbackProgress({ items }, { itemId: 'b', currentTime: 999, mediaDuration: 122 });
  assert.equal(p.currentTime, 122); assert.equal(p.currentRatio, 1);
  p = playbackProgress({ items }, { itemId: 'b', currentTime: 0, mediaDuration: 122 });
  assert.equal(p.currentRatio, 0); assert.equal(p.elapsed, 60);
});
