import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  firstVersion, openapiVersion, packageJsonVersion, pomVersion, versionOf, workspaceVersion,
} from './version-files.mjs';

const POM = `<project><parent><groupId>x</groupId><version>4.1.0</version></parent>
<groupId>dev.caw</groupId><version>1.1.1</version>
<dependencies><dependency><version>9.9.9</version></dependency></dependencies></project>`;
const API = 'openapi: 3.0.3\ninfo:\n  title: x\n  description: |\n    a\n\n    b\n  version: 1.1.1\npaths: {}\n';

test('a pom: the first version outside parent and dependencies', () => {
  assert.equal(pomVersion(POM), '1.1.1');
  assert.equal(versionOf('backend/pom.xml', POM), '1.1.1');
});

test('openapi: info.version at the block indentation', () => {
  assert.equal(openapiVersion(API), '1.1.1');
  assert.equal(versionOf('openapi.yaml', API), '1.1.1');
  assert.equal(versionOf('spec.yml', 'paths: {}\n'), null);
});

test('package.json: top-level version only', () => {
  assert.equal(packageJsonVersion('{"name":"a","version":"1.2.3"}'), '1.2.3');
  assert.equal(packageJsonVersion('{"name":"a"}'), null);
  assert.equal(packageJsonVersion('not json'), null);
  assert.equal(versionOf('tools/package.json', '{"version":"1.2.3"}'), '1.2.3');
});

test('an unknown kind has no version', () => {
  assert.equal(versionOf('VERSION', '1.2.3'), null);
});

test('firstVersion: declared order, missing and unparseable files are skipped', async () => {
  const files = { 'a/missing.json': undefined, 'b/package.json': '{}', 'c/pom.xml': POM, 'd/package.json': '{"version":"9.0.0"}' };
  const read = async (path) => {
    if (files[path] === undefined) throw new Error('ENOENT');
    return files[path];
  };
  assert.deepEqual(await firstVersion(Object.keys(files), read), { version: '1.1.1', file: 'c/pom.xml' });
  assert.equal(await firstVersion(['a/missing.json', 'b/package.json'], read), null);
  assert.equal(await firstVersion(undefined, read), null);
});

test('workspaceVersion skips a path out of the checkout and an absolute one; the first valid file wins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cawdev-wsv-'));
  try {
    const checkout = join(root, 'checkout');
    await mkdir(checkout, { recursive: true });
    await writeFile(join(root, 'package.json'), '{"version":"9.9.9"}');
    await writeFile(join(checkout, 'a.json'), 'not json');
    await writeFile(join(checkout, 'package.json'), '{"version":"1.2.3"}');
    const found = await workspaceVersion(checkout, [
      '../package.json', join(root, 'package.json'), 'missing/pom.xml', 'a.json', 'package.json',
    ]);
    assert.deepEqual(found, { version: '1.2.3', file: 'package.json' });
    assert.equal(await workspaceVersion(checkout, ['../package.json', join(root, 'package.json')]), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
