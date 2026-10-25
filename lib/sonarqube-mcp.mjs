// R319. What the daemon adds to SonarSource's MCP server before it is spawned.
//
// The registry row says WHAT to run (`java -jar <file name>`); this says where
// the jar is on this machine and under which credentials, because those are
// facts about the machine and the platform must not hold them. Pure, so the
// three refusals can be tested without a daemon.

import { isAbsolute, join } from 'node:path';

/** The directory, on this machine, that holds the jar the row names. */
export const JAR_DIR_ENV = 'CAWDEV_SONARQUBE_MCP_DIR';

const trimSlash = (text) => String(text).replace(/\/+$/, '');

/**
 * The arguments and environment to spawn the server with, or the sentence
 * saying why it is not attached. Never throws.
 *
 * - the token is `process.env[quality.tokenEnv]` — the credential R300 already
 *   holds — and is put in the SERVER's environment only;
 * - the URL is the machine's override, else the project's connection, so a
 *   project on another server gets that server;
 * - a machine with no `quality` block for the project, no token, no URL or no
 *   jar directory does not get the server, and is told which.
 */
export function sonarqubeLaunch({ skill, quality, sonarUrl, env, storagePath }) {
  const name = skill.name ?? skill.key;
  const dir = env[JAR_DIR_ENV];
  if (!dir || !isAbsolute(dir)) {
    return { skip: `${name} was not attached: set ${JAR_DIR_ENV} to the absolute directory that `
      + `holds ${skill.args.find((arg) => String(arg).endsWith('.jar')) ?? 'the server jar'}.` };
  }
  if (!quality) {
    return { skip: `${name} was not attached: this machine has no "quality" block for this `
      + 'project, so it holds no scanner token for the server to use.' };
  }
  const token = env[quality.tokenEnv];
  if (!token) {
    return { skip: `${name} was not attached: $${quality.tokenEnv} is not set on this machine.` };
  }
  const url = quality.url ?? sonarUrl;
  if (!url) {
    return { skip: `${name} was not attached: neither the project's connection nor this machine's `
      + 'quality block names a SonarQube server.' };
  }
  return {
    args: skill.args.map((arg) => (String(arg).endsWith('.jar') && !isAbsolute(arg) ? join(dir, arg) : arg)),
    env: { SONARQUBE_TOKEN: token, SONARQUBE_URL: trimSlash(url), STORAGE_PATH: storagePath },
  };
}
