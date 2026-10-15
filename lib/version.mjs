// R283 — the CLI's own version, and whether it is old enough to matter.
//
// Zero dependencies, like everything in tools/: no semver package, just the
// three numbers this project actually uses (`tools/package.json`'s own
// version is always `major.minor.patch`, and so is what the platform sends
// back on `/api/health`).

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** This CLI's own version, read from `tools/package.json`. */
export async function cliVersion() {
  const path = join(HERE, '..', 'package.json');
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  return parsed.version;
}

/**
 * `major.minor.patch` as three numbers, or null for anything that is not
 * shaped that way — a pre-release suffix, a build nobody tagged, garbage from
 * a setting typed by hand. Null is "cannot compare", never "oldest possible":
 * refusing a version we cannot parse would turn a typo in a setting into
 * every runner on the platform refusing to boot.
 */
function parts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * Whether `version` is older than `minimum`. False when either cannot be
 * parsed, or when `minimum` is blank — "cannot tell" and "no requirement" are
 * both the safe reading here, matching `PlatformSettingService`'s own
 * treatment of a blank `minimum_cli_version`.
 */
export function isBelow(version, minimum) {
  if (!minimum || !String(minimum).trim()) return false;
  const have = parts(version);
  const need = parts(minimum);
  if (!have || !need) return false;
  for (let i = 0; i < 3; i += 1) {
    if (have[i] !== need[i]) return have[i] < need[i];
  }
  return false;
}
