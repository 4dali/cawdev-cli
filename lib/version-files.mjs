// R587: the project's version out of a file that declares it. Moved from
// tools/release/plan.mjs so the release plan, `sonar.sh` (through
// tools/quality/scan.mjs) and the daemon's scan (runner.mjs, scanQuality) read
// a version one way. Pure and zero dependencies, like all of tools/.
//
// A file is told apart by its NAME: `pom.xml`, `package.json`, and a `.yaml` /
// `.yml` with an `info:` block (openapi.yaml). Anything else has no version
// here: null, never a guess.

import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, resolve, sep } from 'node:path';

/**
 * The project's own version in a pom: the first `<version>` OUTSIDE
 * `<parent>`, which carries Spring Boot's, and outside `<dependencies>`,
 * `<build>` and the rest, which carry their libraries'.
 */
export function pomVersion(pom) {
  const top = pom
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(parent|dependencies|dependencyManagement|build|profiles|properties)>[\s\S]*?<\/\1>/g, '');
  const match = /<version>\s*([^<\s]+)\s*<\/version>/.exec(top);
  return match ? match[1] : null;
}

/**
 * `info.version` in openapi.yaml: a `version:` key directly under `info:`,
 * at the block's own indentation: `info.description` is a block scalar
 * with blank lines in it, and a deeper `version:` is somebody's schema.
 */
export function openapiVersion(yaml) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => /^info:\s*$/.test(line));
  if (start === -1) return null;
  let indent = null;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const own = /^(\s*)/.exec(line)[1].length;
    if (own === 0) return null;
    indent ??= own;
    if (own !== indent) continue;
    const match = /^\s*version:\s*['"]?([^'"\s]+)/.exec(line);
    if (match) return match[1];
  }
  return null;
}

/** The top-level `version` of a package.json, or null (not JSON, no version). */
export function packageJsonVersion(text) {
  try {
    const version = JSON.parse(text)?.version;
    return typeof version === 'string' && version.trim() ? version.trim() : null;
  } catch {
    return null;
  }
}

/** The version `text` declares, by what `path` is called; null for a kind it does not know. */
export function versionOf(path, text) {
  const name = basename(String(path));
  if (name === 'pom.xml') return pomVersion(text);
  if (name === 'package.json') return packageJsonVersion(text);
  if (/\.ya?ml$/i.test(name)) return openapiVersion(text);
  return null;
}

/**
 * The first declared file that yields a version: `{version, file}`, or null.
 * `read(path)` returns the text, or throws for a file that is not there; both
 * a throw and a non-string mean "not this one". Order is the project's.
 */
export async function firstVersion(files, read) {
  for (const file of files ?? []) {
    let text;
    try { text = await read(file); } catch { continue; }
    if (typeof text !== 'string') continue;
    const version = versionOf(file, text);
    if (version) return { version, file };
  }
  return null;
}

/**
 * R587: the first of the project's declared version files that parses, read
 * from the workspace: `{version, file}` or null. A file that is missing, does
 * not parse, or would climb out of the checkout is skipped, never an error.
 * Only a branch analysis has a new-code period of its own and never touches the
 * project's gate; a MAIN analysis (`whenBranchesRefused: "main"`) is the one
 * the version matters to, since SonarQube reads a versionless one as a change.
 */
export async function workspaceVersion(cwd, files) {
  const root = resolve(cwd);
  return firstVersion(files, async (file) => {
    if (isAbsolute(file)) return null;
    const path = resolve(root, file);
    if (path !== root && !path.startsWith(`${root}${sep}`)) return null;
    return readFile(path, 'utf8');
  });
}
