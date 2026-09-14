// node --test tools/lib/transcript-batch.test.mjs
//
// R255: a batch that fails to send must be kept and retried, not dropped —
// the daemon-side half of "when the runner has internet again, it should
// report everything it did while it was gone".

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TranscriptBatch } from './transcript-batch.mjs';

test('a batch that sends cleanly is not resent', async () => {
  const sent = [];
  const batch = new TranscriptBatch(async (lines) => { sent.push(lines); }, { every: 5, max: 10 });
  batch.push({ body: 'a' });
  batch.push({ body: 'b' });
  await batch.flush();
  assert.deepEqual(sent, [[{ body: 'a' }, { body: 'b' }]]);
  assert.deepEqual(batch.pending, []);
});

test('a failed send keeps its lines, in order, for the next flush', async () => {
  let calls = 0;
  const sent = [];
  const send = async (lines) => {
    calls += 1;
    if (calls === 1) throw new Error('network is unreachable');
    sent.push(lines);
  };
  const retries = [];
  const batch = new TranscriptBatch(send, {
    every: 5,
    max: 10,
    onRetry: (info) => retries.push(info),
  });
  batch.push({ body: 'a' });
  batch.push({ body: 'b' });
  await batch.flush();

  // Nothing was lost — the failed attempt's lines are still queued.
  assert.deepEqual(batch.pending, [{ body: 'a' }, { body: 'b' }]);
  assert.equal(retries.length, 1);
  assert.deepEqual(retries[0].lines, [{ body: 'a' }, { body: 'b' }]);
  assert.match(retries[0].failure.message, /unreachable/);

  // A line produced during the outage joins the queue rather than jumping it.
  batch.push({ body: 'c' });
  await batch.flush();

  assert.deepEqual(sent, [[{ body: 'a' }, { body: 'b' }, { body: 'c' }]]);
  assert.deepEqual(batch.pending, []);
});

test('lines pushed while a send is in flight are not swept into it', async () => {
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  let started;
  const startedFirst = new Promise((resolve) => { started = resolve; });
  const sent = [];
  const send = async (lines) => {
    if (sent.length === 0) {
      started();
      await first;
    }
    sent.push(lines);
  };
  const batch = new TranscriptBatch(send, { every: 5, max: 10 });
  batch.push({ body: 'a' });
  const flushing = batch.flush();
  // Not until `send_` has actually been called — and so has taken its
  // snapshot of `pending` — does a push belong to the NEXT batch rather than
  // this one.
  await startedFirst;
  batch.push({ body: 'b' });
  releaseFirst();
  await flushing;

  assert.deepEqual(sent, [[{ body: 'a' }]]);
  // Not lost either — still queued for the next round.
  assert.deepEqual(batch.pending, [{ body: 'b' }]);
});

test('retries back off rather than hammering, and cap at maxRetryDelay', async () => {
  const send = async () => { throw new Error('still down'); };
  const delays = [];
  const batch = new TranscriptBatch(send, {
    every: 10,
    max: 10,
    maxRetryDelay: 30,
    onRetry: ({ delayMs }) => delays.push(delayMs),
  });
  batch.push({ body: 'a' });
  await batch.flush();
  await batch.flush();
  await batch.flush();

  // 10, then 20, then capped at 30 rather than 40.
  assert.deepEqual(delays, [10, 20, 30]);
});

test('an empty flush sends nothing', async () => {
  let calls = 0;
  const batch = new TranscriptBatch(async () => { calls += 1; }, { every: 5 });
  await batch.flush();
  assert.equal(calls, 0);
});
