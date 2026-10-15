// node --test tools/lib/codex.test.mjs
//
// The Codex CLI's command line and event stream. The events below are lines
// the real CLI (0.155) printed, trimmed — not a shape guessed from docs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentLabel, agentOfCommand } from './agents.mjs';
import { cawdevToolNames, codexArgs, tomlValue, translateCodexEvent } from './codex.mjs';

test('a configured command is an agent by its name', () => {
  assert.equal(agentOfCommand('claude'), 'claude');
  assert.equal(agentOfCommand('agy'), 'agy');
  assert.equal(agentOfCommand('codex'), 'codex');
  assert.equal(agentOfCommand('/usr/local/bin/codex'), 'codex');
  assert.equal(agentOfCommand('/opt/claude'), 'claude');
  assert.equal(agentOfCommand(undefined), 'claude', 'nothing named is what every run was before');
  assert.equal(agentLabel('codex'), 'Codex CLI');
  assert.equal(agentLabel('agy'), 'Antigravity CLI');
  assert.equal(agentLabel('claude'), 'Claude Code');
});

test('only cawdev tools survive, without their prefix', () => {
  assert.deepEqual(
    cawdevToolNames(['Read', 'mcp__cawdev__report', 'mcp__codegraph__x', 'mcp__cawdev__roadmap_get',
      'mcp__cawdev__report']),
    ['report', 'roadmap_get']);
  assert.deepEqual(cawdevToolNames(null), []);
});

test('values are TOML that -c parses', () => {
  assert.equal(tomlValue('node'), '"node"');
  assert.equal(tomlValue('a "quoted"\nline'), '"a \\"quoted\\"\\nline"');
  assert.equal(tomlValue('del\u007f'), '"del\\u007f"', 'TOML refuses a raw DEL');
  assert.equal(tomlValue(['a', 'b']), '["a", "b"]');
  assert.equal(tomlValue({ PATH: '/bin', 'odd key': 'x' }), '{ PATH = "/bin", "odd key" = "x" }');
});

test('a read-only turn is sandboxed and every server is approved', () => {
  const args = codexArgs({
    sandbox: 'read-only',
    model: 'gpt-5.5',
    effort: 'high',
    servers: [{
      name: 'cawdev', command: '/bin/node', args: ['/srv/server.mjs'],
      envVars: ['CAWDEV_TOKEN'], enabledTools: ['roadmap_get'],
    }],
  });
  assert.deepEqual(args.slice(0, 4), ['exec', '--json', '--strict-config', '--ignore-user-config']);
  assert.ok(args.includes('--sandbox') && args[args.indexOf('--sandbox') + 1] === 'read-only');
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-5.5');
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.ok(args.includes('mcp_servers.cawdev.enabled_tools=["roadmap_get"]'));
  assert.ok(args.includes('mcp_servers.cawdev.env_vars=["CAWDEV_TOKEN"]'));
  assert.ok(args.includes('mcp_servers.cawdev.default_tools_approval_mode="approve"'),
    'without it exec refuses every MCP call: approval policy is never');
  assert.equal(args.at(-1), '-', 'the prompt goes on stdin');
});

test('the token is never on the command line', () => {
  const args = codexArgs({
    sandbox: 'bypass',
    servers: [{ name: 'cawdev', command: 'node', envVars: ['CAWDEV_TOKEN'] }],
    hideFromShell: ['CAWDEV_TOKEN', 'CAWDEV_URL'],
  });
  assert.ok(!args.join(' ').includes('cawdr_'));
  assert.ok(args.includes('shell_environment_policy.set={ CAWDEV_TOKEN = "", CAWDEV_URL = "" }'),
    'the model\'s own commands must not be able to echo it');
  assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!args.includes('--sandbox'));
});

test('resume comes after the exec options, which it refuses behind it', () => {
  const args = codexArgs({ sandbox: 'read-only', resumeId: 'abc' });
  const at = args.indexOf('resume');
  assert.ok(at > args.indexOf('--sandbox'), '`resume … -s` is "unexpected argument"');
  assert.deepEqual(args.slice(at), ['resume', 'abc', '-']);
});

test('an unknown sandbox is refused rather than defaulted', () => {
  assert.throws(() => codexArgs({ sandbox: 'workspace-write' }));
});

test('the stream becomes transcript lines, a session id and usage', () => {
  assert.deepEqual(
    translateCodexEvent({ type: 'thread.started', thread_id: '01a0cdaf' }),
    { lines: [], sessionId: '01a0cdaf' });
  assert.deepEqual(
    translateCodexEvent({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'finished' } }).lines,
    [{ kind: 'ASSISTANT', body: 'finished' }]);
  assert.deepEqual(
    translateCodexEvent({ type: 'item.started', item: { type: 'command_execution', command: '/bin/zsh -lc ls', status: 'in_progress' } }).lines,
    [{ kind: 'TOOL', body: 'Bash(/bin/zsh -lc ls)' }]);
  assert.deepEqual(
    translateCodexEvent({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: '', exit_code: 0 } }).lines,
    [{ kind: 'TOOL_RESULT', body: '(exit 0)' }]);
  assert.deepEqual(
    translateCodexEvent({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'cawdev', tool: 'report', arguments: { status: 'done' } } }).lines,
    [{ kind: 'TOOL', body: 'mcp__cawdev__report({"status":"done"})' }]);
  assert.deepEqual(
    translateCodexEvent({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'cawdev', tool: 'report',
      result: { content: [{ type: 'text', text: 'recorded' }] }, error: null } }).lines,
    [{ kind: 'TOOL_RESULT', body: 'recorded' }]);
  assert.deepEqual(
    translateCodexEvent({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'cawdev', tool: 'report',
      result: null, error: { message: 'MCP tool call requires approval, but approval policy is never' } } }).lines,
    [{ kind: 'TOOL_RESULT', body: 'failed: MCP tool call requires approval, but approval policy is never' }]);

  const done = translateCodexEvent({ type: 'turn.completed',
    usage: { input_tokens: 68755, cached_input_tokens: 55296, output_tokens: 240 } });
  assert.equal(done.ended, true);
  assert.deepEqual(done.usage, { input: 68755, output: 240 });
});

test('only turn.failed fails a turn; a top-level error may be a retry', () => {
  const failed = translateCodexEvent({ type: 'turn.failed', error: { message: 'boom' } });
  assert.equal(failed.failed, 'boom');
  const passing = translateCodexEvent({ type: 'error', message: 'Reconnecting... 2/5' });
  assert.equal(passing.failed, undefined);
  assert.equal(passing.error, 'Reconnecting... 2/5');
  assert.deepEqual(translateCodexEvent({ type: 'turn.started' }), { lines: [] });
});

test('a server may be given a longer tool timeout — one call that waits for a person', () => {
  const args = codexArgs({ sandbox: 'read-only', servers: [{ name: 'cawdev', command: 'node', toolTimeoutSec: 660 }] });
  assert.ok(args.includes('mcp_servers.cawdev.tool_timeout_sec=660'), args.join(' '));
  const plain = codexArgs({ sandbox: 'read-only', servers: [{ name: 'other', command: 'x' }] });
  assert.ok(!plain.some((each) => each.includes('tool_timeout_sec')), 'unset stays unset');
});
