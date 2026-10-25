// node --test tools/runner/pause-note.test.mjs
//
// R571 — a queued run's note for a paused machine: two kinds of pause, two
// different ways out.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inWords, noteKey, pauseLogLine, pausedNote, reportedPauseNote, worstWindow } from './pause-note.mjs';

const NOW = Date.parse('2026-10-25T10:00:00Z');
const IN_80_MIN = '2026-10-25T11:20:00Z';

test('a hand pause names where to resume it, and the c key', () => {
  assert.equal(
    pausedNote({ pausedByUsage: false }, NOW),
    'this machine is paused from the console (resume it on Settings → Machines, or press c)',
  );
});

test('a usage pause says the window, the percent, when it is back, and that it resumes itself', () => {
  const note = pausedNote({
    pausedByUsage: true,
    limits: [{ window: 'FIVE_HOUR', percent: 92, resetsAt: IN_80_MIN, model: null }],
  }, NOW);
  assert.equal(
    note,
    'cawdev paused this machine for usage: its five-hour window is at 92%, back in 1h 20m — it resumes by itself',
  );
  assert.doesNotMatch(note, /press c/);
});

test('a usage pause with no reading says so rather than quoting a stale number', () => {
  assert.equal(
    pausedNote({ pausedByUsage: true, limits: [] }, NOW),
    'cawdev paused this machine for usage — it resumes by itself when the window resets',
  );
});

test('the worst WHOLE window wins; a per-model window never counts', () => {
  const worst = worstWindow([
    { window: 'FIVE_HOUR', percent: 40 },
    { window: 'WEEKLY', percent: 81 },
    { window: 'WEEKLY', percent: 99, model: 'Fable' },
    { window: 'FIVE_HOUR', percent: null },
  ]);
  assert.equal(worst.window, 'WEEKLY');
  assert.equal(worst.percent, 81);
  assert.equal(worstWindow([]), null);
  assert.equal(worstWindow(undefined), null);
});

test('inWords', () => {
  assert.equal(inWords(30_000), 'under a minute');
  assert.equal(inWords(12 * 60_000), '12m');
  assert.equal(inWords(80 * 60_000), '1h 20m');
  assert.equal(inWords(3 * 3_600_000), '3h');
  assert.equal(inWords(NaN), 'under a minute');
});

test('the note key ignores the minutes left, so the log is not chatty', () => {
  const limits = [{ window: 'FIVE_HOUR', percent: 92, resetsAt: IN_80_MIN }];
  assert.equal(noteKey({ pausedByUsage: true, limits }), noteKey({ pausedByUsage: true, limits: [...limits] }));
  assert.notEqual(noteKey({ pausedByUsage: true, limits }), noteKey({ pausedByUsage: false, limits }));
  assert.notEqual(
    noteKey({ pausedByUsage: true, limits }),
    noteKey({ pausedByUsage: true, limits: [{ ...limits[0], percent: 95 }] }),
  );
});

test('the heartbeat log line says each change once and nothing when nothing moved', () => {
  const idle = { paused: false, pausedByUsage: false };
  assert.match(pauseLogLine(idle, { paused: true }), /^paused from the console/);
  assert.match(pauseLogLine(idle, { paused: true, pausedByUsage: true }), /^cawdev paused this machine for usage/);
  assert.equal(pauseLogLine(idle, { paused: false }), null);
  assert.equal(pauseLogLine({ paused: true, pausedByUsage: false }, { paused: true }), null);
  assert.equal(pauseLogLine({ paused: true, pausedByUsage: false }, { paused: false }), 'unpaused from the console');
  assert.match(pauseLogLine({ paused: true, pausedByUsage: true }, { paused: false }), /^cawdev lifted the usage pause/);
});

test('the platform is told nothing about a pause: no figures, no "press c" — R571', () => {
  assert.equal(reportedPauseNote(), null);
  const local = pausedNote({ pausedByUsage: true, limits: [{ window: 'FIVE_HOUR', percent: 92, resetsAt: IN_80_MIN }] }, NOW);
  assert.match(local, /%/);
  assert.match(pausedNote({}, NOW), /press c/);
});
