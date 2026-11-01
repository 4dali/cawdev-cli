// node --test tools/runner/shots.test.mjs
//
// R605 — the cache of screenshots is the terminal's alone, and what it opens,
// prints and sends is checked here without a terminal or a platform.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  cachedPath, isImage, localCopy, openerFor, parseComments, printable, roundListing,
  showGate, thumbnailEscape, thumbnailProtocol,
} from './shots.mjs';

const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const view = (extra = {}) => ({
  id: 'id-1', runId: 'run-1', round: 2, name: 'a.png', contentType: 'image/png', sha256: sha(BYTES), ...extra,
});

async function inTemp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'shots-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('the first copy downloads and the second does not', async (t) => {
  const dir = await inTemp(t);
  let fetched = 0;
  const fetchBytes = async () => (fetched++, BYTES);
  const first = await localCopy(view(), { dir, fetchBytes });
  const second = await localCopy(view(), { dir, fetchBytes });
  assert.equal(first.downloaded, true);
  assert.equal(second.downloaded, false);
  assert.equal(fetched, 1);
  assert.equal(first.path, second.path);
});

test('a cached file whose bytes changed is downloaded again', async (t) => {
  const dir = await inTemp(t);
  let fetched = 0;
  const fetchBytes = async () => (fetched++, BYTES);
  const { path } = await localCopy(view(), { dir, fetchBytes });
  await writeFile(path, 'tampered');
  const again = await localCopy(view(), { dir, fetchBytes });
  assert.equal(again.downloaded, true);
  assert.equal(fetched, 2);
});

test('bytes that do not match their checksum are refused and leave nothing', async (t) => {
  const dir = await inTemp(t);
  await assert.rejects(
    localCopy(view(), { dir, fetchBytes: async () => Buffer.from('other') }),
    /does not match its own checksum/,
  );
  assert.deepEqual(await readdir(join(dir, 'run-1', '2')), []);
});

test('a link anywhere under the cache is refused', async (t) => {
  const dir = await inTemp(t);
  const elsewhere = await inTemp(t);
  await mkdir(join(dir, 'run-1'));
  await symlink(elsewhere, join(dir, 'run-1', '2'));
  await assert.rejects(localCopy(view(), { dir, fetchBytes: async () => BYTES }), /is a link; remove it/);
  assert.deepEqual(await readdir(elsewhere), []);

  const linked = await inTemp(t);
  await symlink(elsewhere, join(linked, 'run-1'));
  await assert.rejects(localCopy(view(), { dir: linked, fetchBytes: async () => BYTES }), /is a link/);
});

test('the directory is private and the file is private', async (t) => {
  const dir = await inTemp(t);
  const { path } = await localCopy(view(), { dir, fetchBytes: async () => BYTES });
  assert.equal((await stat(join(dir, 'run-1', '2'))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('a file is named by its checksum and content type, never by the name a session chose', async (t) => {
  const dir = await inTemp(t);
  const { path } = await localCopy(view({ name: '../../x.png' }), { dir, fetchBytes: async () => BYTES });
  assert.equal(path, join(dir, 'run-1', '2', `${sha(BYTES)}.png`));
  assert.ok(path.startsWith(join(dir, 'run-1', '2')));
  assert.equal(cachedPath(dir, view({ contentType: 'image/jpeg' })).endsWith('.jpg'), true);
});

test('a run id or round that is not a plain path part has no cached path', () => {
  assert.equal(cachedPath('/x', view({ runId: '../x' })), null);
  assert.equal(cachedPath('/x', view({ round: '../1' })), null);
  assert.equal(cachedPath('/x', view({ round: 1.5 })), null);
});

test('a link planted where a file will be written is not written through', async (t) => {
  const dir = await inTemp(t);
  const target = join(await inTemp(t), 'victim');
  await writeFile(target, 'precious');
  const { path } = await localCopy(view(), { dir, fetchBytes: async () => BYTES });
  await rm(path);
  await symlink(target, `${path}.tmp-${process.pid}`);
  await localCopy(view(), { dir, fetchBytes: async () => BYTES });
  assert.equal((await readFile(target)).toString(), 'precious');
});

test('html has no cached path and is not an image', async () => {
  const page = view({ contentType: 'text/html', name: 'mock.html' });
  assert.equal(isImage(page), false);
  assert.equal(cachedPath('/x', page), null);
  await assert.rejects(localCopy(page, { dir: '/nonexistent-shots', fetchBytes: async () => BYTES }), /opens on cawdev/);
});

test('macOS opens every path in one call; elsewhere one call each', () => {
  assert.deepEqual(openerFor('darwin')(['a', 'b']), [['open', ['a', 'b']]]);
  assert.deepEqual(openerFor('linux')(['a', 'b']), [['xdg-open', ['a']], ['xdg-open', ['b']]]);
  assert.deepEqual(openerFor('darwin')([]), []);
});

test('comments: #n is a note on a screenshot, the rest is the round', () => {
  const shots = [{ id: 'one' }, { id: 'two' }, { id: 'three' }];
  assert.deepEqual(parseComments('too dark\n#2 button overlaps\n#2 and is blue', shots), {
    reason: 'too dark', notes: { two: 'button overlaps\nand is blue' }, error: null,
  });
  assert.match(parseComments('#9 x', shots).error, /no screenshot 9/);
  assert.match(parseComments('#0 x', shots).error, /no screenshot 0/);
  assert.match(parseComments('#2', shots).error, /after #2/);
  assert.match(parseComments('  \n ', shots).error, /write a note/);
  assert.equal(parseComments('#1: dark', shots).notes.one, 'dark');
});

test('a name or caption cannot carry a control sequence, a new line, or a reordering', () => {
  assert.equal(printable('a\x1b[2Jb\x07c\x00'), 'abc');
  assert.equal(printable('one\n  2  fake.png'), 'one   2  fake.png');
  assert.equal(printable('evil\u202egnp.exe'), 'evilgnp.exe');
  assert.equal(printable('a\nb', { lines: true }), 'a\nb');
});

test('a gate names its round and screenshots, or is not one', () => {
  const gate = { toolName: 'stage:SHOW', toolInput: JSON.stringify({ round: 2, attachments: ['a', 'b'] }) };
  assert.deepEqual(showGate(gate), { round: 2, ids: ['a', 'b'] });
  assert.equal(showGate({ toolName: 'Bash', toolInput: '{}' }), null);
  assert.equal(showGate({ toolName: 'stage:SHOW', toolInput: 'not json' }), null);
});

test('the listing is numbered, and marks html', () => {
  const lines = roundListing([
    { name: 'a.png', caption: 'home', contentType: 'image/png' },
    { name: 'm.html', caption: null, contentType: 'text/html' },
  ]);
  assert.equal(lines[0], '  1  a.png — home');
  assert.match(lines[1], /^ {2}2 {2}m\.html.*html — opens on cawdev/);
});

test('thumbnails: only iTerm2, WezTerm and kitty get any escape', () => {
  assert.equal(thumbnailProtocol({ TERM_PROGRAM: 'iTerm.app' }), 'iterm');
  assert.equal(thumbnailProtocol({ TERM_PROGRAM: 'WezTerm' }), 'iterm');
  assert.equal(thumbnailProtocol({ KITTY_WINDOW_ID: '3' }), 'kitty');
  assert.equal(thumbnailProtocol({ TERM: 'xterm-kitty' }), 'kitty');
  assert.equal(thumbnailProtocol({ TERM_PROGRAM: 'Apple_Terminal' }), null);

  const iterm = thumbnailEscape(BYTES, 'iterm');
  assert.ok(iterm.startsWith('\x1b]1337;File=inline=1'));
  assert.ok(iterm.endsWith('\x07'));

  const big = Buffer.alloc(10_000, 7);
  const kitty = thumbnailEscape(big, 'kitty');
  const chunks = kitty.split('\x1b\\').filter(Boolean);
  assert.ok(chunks.length > 1);
  assert.match(chunks[0], /^\x1b_Ga=T,f=100,c=24,m=1;/);
  assert.match(chunks.at(-1), /^\x1b_Gm=0;/);
  assert.equal(thumbnailEscape(big, null), '');
});
