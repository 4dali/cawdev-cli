#!/usr/bin/env node
// A scripted JSON-RPC session against tools/mcp/server.mjs, over real stdio.
//
//   CAWDEV_URL=… CAWDEV_TOKEN=… node tools/mcp/smoke.mjs [project]
//
// This is what CI runs against the compose stack. It drives the server the way
// a client does — spawn, write lines to stdin, read lines from stdout — rather
// than importing its functions, because the parts most likely to break are the
// transport and the framing, and importing would skip exactly those.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const project = process.argv[2];

const server = spawn(process.execPath, [join(here, 'server.mjs')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
});

let buffer = '';
const waiting = new Map();

server.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;

    const message = JSON.parse(line);
    const resolve = waiting.get(message.id);
    if (resolve) {
      waiting.delete(message.id);
      resolve(message);
    }
  }
});

let nextId = 1;

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, resolve);
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => reject(new Error(`${method} timed out after 20s`)), 20_000).unref();
  });
}

function notify(method, params) {
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

const checks = [];
function check(description, condition, detail = '') {
  checks.push({ description, ok: Boolean(condition), detail });
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${description}${detail && !condition ? `\n        ${detail}` : ''}`);
}

/** Tool results carry their text in content[0]; a refusal sets isError. */
function textOf(result) {
  return result?.content?.map((part) => part.text).join('\n') ?? '';
}

try {
  const initialize = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'cawdev-smoke', version: '1' },
  });
  check('initialize answers with a server name', initialize.result?.serverInfo?.name === 'cawdev',
    JSON.stringify(initialize));
  check('initialize declares the tools capability', initialize.result?.capabilities?.tools !== undefined);
  notify('notifications/initialized');

  const list = await request('tools/list');
  const names = (list.result?.tools ?? []).map((tool) => tool.name);
  check('tools/list returns the roadmap and changelog verbs', names.includes('roadmap_list')
    && names.includes('roadmap_set_status') && names.includes('changelog_add'),
    names.join(', '));
  check('every tool has a description and an input schema',
    (list.result?.tools ?? []).every((tool) => tool.description && tool.inputSchema));

  // The guarantee that matters more than any feature.
  check('there is no delete tool, for roadmap or changelog',
    !names.some((name) => name.includes('delete') || name.includes('remove')),
    names.join(', '));

  const where = await request('tools/call', { name: 'roadmap_where', arguments: {} });
  check('roadmap_where says which platform and who we are',
    textOf(where.result).includes('platform:') && textOf(where.result).includes('you are:'),
    textOf(where.result));

  const statuses = await request('tools/call', { name: 'roadmap_statuses', arguments: {} });
  check('roadmap_statuses says what CODING requires',
    /CODING\s+\(requires a branch\)/.test(textOf(statuses.result)),
    textOf(statuses.result));

  const listed = await request('tools/call', {
    name: 'roadmap_list',
    arguments: { ...(project ? { project } : {}), brief: true },
  });
  check('roadmap_list returns entries', !listed.result?.isError && textOf(listed.result).includes('R1'),
    textOf(listed.result));

  const created = await request('tools/call', {
    name: 'roadmap_create',
    arguments: {
      ...(project ? { project } : {}),
      title: 'smoke test entry (safe to decline)',
      body: 'Created by tools/mcp/smoke.mjs.',
    },
  });
  check('roadmap_create makes an entry', !created.result?.isError
    && /Created R\d+/.test(textOf(created.result)), textOf(created.result));

  const number = Number(/Created R(\d+)/.exec(textOf(created.result))?.[1]);

  // A status that is not given what it requires must come back as a readable
  // refusal, not a crash — and the message should say what is missing.
  const refused = await request('tools/call', {
    name: 'roadmap_set_status',
    arguments: { ...(project ? { project } : {}), number, status: 'CODING' },
  });
  check('CODING without a branch is refused, readably',
    refused.result?.isError && /branch/i.test(textOf(refused.result)),
    textOf(refused.result));

  const moved = await request('tools/call', {
    name: 'roadmap_set_status',
    arguments: { ...(project ? { project } : {}), number, status: 'CODING', branch: 'smoke-test' },
  });
  check('CODING with a branch is accepted', !moved.result?.isError
    && textOf(moved.result).includes('smoke-test'), textOf(moved.result));

  const declined = await request('tools/call', {
    name: 'roadmap_decline',
    arguments: {
      ...(project ? { project } : {}),
      number,
      reason: 'A smoke-test entry. Declined so it leaves a trace rather than vanishing.',
    },
  });
  check('roadmap_decline closes it with a reason', !declined.result?.isError
    && textOf(declined.result).includes('DECLINED'), textOf(declined.result));

  const changelog = await request('tools/call', {
    name: 'changelog_list',
    arguments: { ...(project ? { project } : {}) },
  });
  check('changelog_list works', !changelog.result?.isError, textOf(changelog.result));

  const unknown = await request('tools/call', { name: 'roadmap_teleport', arguments: {} });
  check('an unknown tool is a protocol error, not a crash', unknown.error?.code === -32602,
    JSON.stringify(unknown));
} finally {
  server.stdin.end();
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
