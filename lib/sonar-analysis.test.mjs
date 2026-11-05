import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test, { after, before } from 'node:test';
import { parseProperties, sonarAsker, waitForAnalysis } from './sonar-analysis.mjs';

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

// R622: a real server that accepts and never answers, answers half, or refuses.
let server;
let base;
before(async () => {
  server = createServer((request, response) => {
    if (request.url.startsWith('/half')) {
      response.setHeader('content-type', 'application/json');
      response.writeHead(200);
      response.write('{"task":');
    } else if (request.url.startsWith('/bad')) {
      response.statusCode = 400;
      response.end('{}');
    }
    // anything else (/hang, /api/ce/task): never answered
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

test('R622: a request the server never answers times out with SONAR_TIMEOUT, naming the path without its query', async () => {
  const started = Date.now();
  await assert.rejects(sonarAsker(base, 't', { requestTimeoutMs: 200 })('/hang?x=1'),
    (error) => error.code === 'SONAR_TIMEOUT' && /did not answer \/hang within 1s$/.test(error.message));
  assert.ok(Date.now() - started < 2000);
});

test('R622: a body that stalls half-way times out too', async () => {
  const started = Date.now();
  await assert.rejects(sonarAsker(base, 't', { requestTimeoutMs: 200 })('/half'),
    (error) => error.code === 'SONAR_TIMEOUT' && /did not answer \/half/.test(error.message));
  assert.ok(Date.now() - started < 2000);
});

test('R622: a non-ok answer keeps its message', async () => {
  await assert.rejects(sonarAsker(base, 't')('/bad?q=1'), /answered 400 to \/bad$/);
});

test('R622: waitForAnalysis is cut off by its deadline, not by the 30s cap', async () => {
  const started = Date.now();
  await assert.rejects(waitForAnalysis(sonarAsker(base, 't'), 'T', Date.now() + 300, 1), /not finished analysing after 1s/);
  assert.ok(Date.now() - started < 1500);
});

test('R622: an asker with a deadline says the reading\'s time ran out', async () => {
  await assert.rejects(sonarAsker(base, 't', { deadline: Date.now() + 200 })('/hang'),
    (error) => error.code === 'SONAR_TIMEOUT' && /before the reading's time ran out/.test(error.message));
});
