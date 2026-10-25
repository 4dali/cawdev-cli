// node --test tools/lib/sonarqube-mcp.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

import { JAR_DIR_ENV, sonarqubeLaunch } from './sonarqube-mcp.mjs';

const skill = { key: 'sonarqube', name: 'SonarQube', args: ['-jar', 'sonarqube-mcp-server-1.29.0.4488.jar'] };
const quality = { tokenEnv: 'MY_SONAR', url: null };
const base = {
  skill, quality, sonarUrl: 'https://sonar.example/', storagePath: '/cache/s',
  env: { [JAR_DIR_ENV]: '/opt/mcp', MY_SONAR: 'squ_secret' },
};

test('the token comes from quality.tokenEnv and the URL from the project connection', () => {
  const out = sonarqubeLaunch(base);
  assert.deepEqual(out.args, ['-jar', '/opt/mcp/sonarqube-mcp-server-1.29.0.4488.jar']);
  assert.deepEqual(out.env, {
    SONARQUBE_TOKEN: 'squ_secret', SONARQUBE_URL: 'https://sonar.example', STORAGE_PATH: '/cache/s',
  });
});

test('the machine\'s own url wins, so a LAN hostname is honoured', () => {
  const out = sonarqubeLaunch({ ...base, quality: { ...quality, url: 'http://lan:9000' } });
  assert.equal(out.env.SONARQUBE_URL, 'http://lan:9000');
});

test('no jar directory, no quality block, no token or no URL: not attached, and said why', () => {
  for (const [change, mention] of [
    [{ env: { MY_SONAR: 'x' } }, JAR_DIR_ENV],
    [{ quality: undefined }, 'quality'],
    [{ env: { [JAR_DIR_ENV]: '/opt/mcp' } }, 'MY_SONAR'],
    [{ sonarUrl: null }, 'SonarQube server'],
  ]) {
    const out = sonarqubeLaunch({ ...base, ...change });
    assert.ok(out.skip?.includes(mention), JSON.stringify(out));
    assert.equal(out.env, undefined);
  }
});

test('the token is never in the arguments', () => {
  assert.ok(!JSON.stringify(sonarqubeLaunch(base).args).includes('squ_secret'));
});
