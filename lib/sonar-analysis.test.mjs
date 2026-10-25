import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProperties, waitForAnalysis } from './sonar-analysis.mjs';

test('parseProperties reads key=value lines, keeping = inside values', () => {
  const parsed = parseProperties('serverUrl=http://x:9000\nceTaskId=AB\ndashboardUrl=http://x/dashboard?id=a=b\n\njunk\n');
  assert.equal(parsed.serverUrl, 'http://x:9000');
  assert.equal(parsed.ceTaskId, 'AB');
  assert.equal(parsed.dashboardUrl, 'http://x/dashboard?id=a=b');
  assert.equal(parsed.junk, undefined);
});

test('waitForAnalysis returns the task once it is SUCCESS', async () => {
  const states = ['PENDING', 'SUCCESS'];
  const asked = [];
  const ask = async (path) => { asked.push(path); return { task: { status: states.shift(), analysisId: 'AZ1' } }; };
  const task = await waitForAnalysis(ask, 'T 1', Date.now() + 20000, 20);
  assert.equal(task.analysisId, 'AZ1');
  assert.equal(asked.length, 2);
  assert.match(asked[0], /id=T%201$/);
});

test('waitForAnalysis throws the errorMessage of a FAILED task', async () => {
  const ask = async () => ({ task: { status: 'FAILED', errorMessage: 'bad report' } });
  await assert.rejects(waitForAnalysis(ask, 'T', Date.now() + 5000, 5), /bad report/);
});

test('waitForAnalysis says what a CANCELED task without a message was', async () => {
  const ask = async () => ({ task: { status: 'CANCELED' } });
  await assert.rejects(waitForAnalysis(ask, 'T', Date.now() + 5000, 5), /canceled the analysis/);
});

test('waitForAnalysis throws when the deadline passes', async () => {
  const ask = async () => ({ task: { status: 'PENDING' } });
  await assert.rejects(waitForAnalysis(ask, 'T', Date.now() - 1, 7), /not finished analysing after 7s/);
});
