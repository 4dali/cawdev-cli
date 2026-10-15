// node --test tools/runner/sonar-project.test.mjs
//
// R308: the repository scans as ONE SonarQube project, and the daemon's scan
// (runner.mjs, scanQuality) is what reads the root sonar-project.properties
// — it overrides the key, the host and the branch on argv and puts the token
// in the environment, so the file must never carry a host, a token or a
// branch of its own.
//
// What is pinned: no host, token or branch key in the committed file; every
// source and test root it names exists in the checkout; the three coverage
// reports are the paths the three builds write; the exclusions mirror the
// test inclusions exactly (a file both roots claim that neither list names
// is "indexed twice" and the scan fails); and sonar.sh refuses, naming both
// variables, before it runs a single suite — with SONAR_HOST_URL and
// SONAR_TOKEN stripped from the child's environment on purpose, because an
// operator who has them exported would otherwise start three test batteries
// from inside a test.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PROPERTIES = resolve(ROOT, 'sonar-project.properties');
const SCRIPT = resolve(ROOT, 'sonar.sh');

/** key=value lines; `#` lines and blanks are skipped. Values are split on commas. */
async function properties() {
  const out = new Map();
  for (const raw of (await readFile(PROPERTIES, 'utf8')).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    assert.ok(at > 0, `not a key=value line: ${raw}`);
    out.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return out;
}

const list = (value) => (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

async function exists(path) {
  try { await stat(resolve(ROOT, path)); return true; } catch { return false; }
}

/** Runs sonar.sh with exactly the environment given; resolves with the exit code and stderr. */
function sonarSh(env, args = []) {
  return new Promise((done) => {
    execFile(SCRIPT, args, { cwd: ROOT, env, timeout: 5_000 }, (error, stdout, stderr) => {
      done({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

test('the committed file names no host, no token and no branch — those are the daemon\'s', async () => {
  const props = await properties();
  for (const key of ['sonar.host.url', 'sonar.token', 'sonar.login', 'sonar.password', 'sonar.branch.name']) {
    assert.ok(!props.has(key), `${key} must not be in sonar-project.properties`);
  }
  assert.equal(props.get('sonar.projectKey'), 'cawdev');
});

test('every source and test root is a real path in the checkout', async () => {
  const props = await properties();
  const roots = [...list(props.get('sonar.sources')), ...list(props.get('sonar.tests'))];
  assert.ok(roots.length >= 4, `expected the three trees at least: ${roots}`);
  for (const root of roots) {
    assert.ok(await exists(root), `${root} is named in sonar-project.properties but is not in the checkout`);
  }
  // A build product, not asserted to exist: the Java analyser needs it and
  // fails the whole scan without it, which DEVELOPING.md says.
  assert.equal(props.get('sonar.java.binaries'), 'backend/target/classes');
  assert.equal(props.get('sonar.java.test.binaries'), 'backend/target/test-classes');
});

test('the three coverage reports are where the three builds write them', async () => {
  const props = await properties();
  assert.equal(props.get('sonar.coverage.jacoco.xmlReportPaths'), 'backend/target/site/jacoco/jacoco.xml');
  const lcov = list(props.get('sonar.javascript.lcov.reportPaths'));
  assert.ok(lcov.includes('frontend/coverage/cawdev-console/lcov.info'), `console lcov missing from ${lcov}`);
  assert.ok(lcov.includes('coverage/tools/lcov.info'), `tools lcov missing from ${lcov}`);
});

test('sonar.exclusions mirrors sonar.test.inclusions minus the Java test tree — the double-indexing guard', async () => {
  const props = await properties();
  const inclusions = list(props.get('sonar.test.inclusions'));
  const exclusions = list(props.get('sonar.exclusions'));
  assert.ok(inclusions.includes('backend/src/test/**'),
    'with test.inclusions set only matching files are tests, so backend/src/test/** must be listed');
  assert.deepEqual(
    [...exclusions].sort(),
    inclusions.filter((p) => p !== 'backend/src/test/**').sort(),
    'a spec pattern in one list and not the other is a file indexed twice');
});

test('sonar.sh refuses first, naming both variables, when neither is set', async () => {
  const started = Date.now();
  const { code, stderr } = await sonarSh({ PATH: process.env.PATH });
  assert.equal(code, 1, `expected exit 1, got ${code}: ${stderr}`);
  assert.ok(Date.now() - started < 1_000, 'the refusal must come before any suite runs');
  assert.match(stderr, /SONAR_HOST_URL/);
  assert.match(stderr, /SONAR_TOKEN/);
});

test('sonar.sh treats an empty SONAR_TOKEN as not set', async () => {
  const { code, stderr } = await sonarSh({ PATH: process.env.PATH, SONAR_HOST_URL: 'http://localhost:9000', SONAR_TOKEN: '' });
  assert.equal(code, 1, `expected exit 1, got ${code}: ${stderr}`);
  assert.match(stderr, /SONAR_TOKEN/);
  assert.doesNotMatch(stderr, /SONAR_HOST_URL is not set/);
});

test('sonar.sh --help says what it runs and what --scan-only skips, with nothing exported', async () => {
  const { code, stdout } = await sonarSh({ PATH: process.env.PATH }, ['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /--scan-only/);
  assert.match(stdout, /SONAR_HOST_URL/);
  assert.match(stdout, /SONAR_TOKEN/);
});
