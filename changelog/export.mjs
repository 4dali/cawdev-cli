#!/usr/bin/env node
// Writes a project's CHANGELOG.md from cawdev.
//
//   CAWDEV_URL=… CAWDEV_TOKEN=… node tools/changelog/export.mjs [project] [--out FILE]
//
// Release order comes from the API, which sorts semver-aware. Doing it again
// here would be a second chance to put v0.10.0 below v0.9.0 — the bug that
// looks right for nine releases.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, readConfig, resolveProject } from '../lib/cawdev.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** Keep a Changelog's order. Categories absent from a release are omitted. */
const CATEGORY_ORDER = ['ADDED', 'CHANGED', 'FIXED', 'REMOVED', 'SECURITY'];

const CATEGORY_HEADINGS = {
  ADDED: 'Added',
  CHANGED: 'Changed',
  FIXED: 'Fixed',
  REMOVED: 'Removed',
  SECURITY: 'Security',
};

async function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const out = outIndex === -1 ? 'CHANGELOG.md' : args[outIndex + 1];
  const slugArgument = args.find((arg) => !arg.startsWith('--') && arg !== out);

  const config = await readConfig();
  const slug = resolveProject(config, slugArgument);

  const releases = await call(config, `/api/projects/${slug}/changelog`);
  const preamble = await readFile(join(here, 'preamble.md'), 'utf8');

  await writeFile(resolve(out), render(releases, preamble), 'utf8');

  const total = releases.reduce((sum, release) => sum + release.entries.length, 0);
  console.error(
    `Wrote ${out}: ${total} entries across ${releases.length} release(s) from ${slug}.`,
  );
}

function render(releases, preamble) {
  const parts = [preamble.trimEnd(), ''];

  if (!releases.length) {
    parts.push('## Unreleased', '', 'Nothing recorded yet.', '');
  }

  for (const release of releases) {
    parts.push(`## ${release.version}`);
    if (release.hasBreaking) {
      // Said at the release as well as the entry: the reader's first question
      // is "must I act", and it should be answerable without reading on.
      parts.push('', '> Contains breaking changes.');
    }
    parts.push('');

    for (const category of CATEGORY_ORDER) {
      const entries = release.entries.filter((entry) => entry.category === category);
      if (!entries.length) continue;

      parts.push(`### ${CATEGORY_HEADINGS[category]}`, '');
      for (const entry of entries) {
        parts.push(`- ${entry.breaking ? '**BREAKING** ' : ''}${entry.text}`);
      }
      parts.push('');
    }
  }

  return parts.join('\n').replace(/\n+$/, '') + '\n';
}

main().catch((failure) => {
  console.error(failure.message);
  process.exit(1);
});
