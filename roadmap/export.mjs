#!/usr/bin/env node
// Writes a project's ROADMAP.md from cawdev.
//
//   CAWDEV_URL=… CAWDEV_TOKEN=… node tools/roadmap/export.mjs [project] [--out FILE]
//
// The output is deliberately byte-stable: same data in, same bytes out, so a
// regenerated export shows a diff only when the roadmap actually changed. CI
// checks that export → import → export is a fixed point.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, readConfig, resolveProject } from '../lib/cawdev.mjs';
import { renderRoadmap } from '../lib/roadmap-format.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The order sections appear in. Kept beside the exporter rather than in the
 * database because it is prose layout, unlike an entry's own section, which is
 * a planning decision.
 */
const SECTION_ORDER = [
  'Phase 1 — the roadmap platform, usable on its own',
  'Phase 2 — the MCP server',
  'Phase 3 — agent orchestration',
];

async function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const out = outIndex === -1 ? 'ROADMAP.md' : args[outIndex + 1];
  const slugArgument = args.find((arg) => !arg.startsWith('--') && arg !== out);

  const config = await readConfig();
  const slug = resolveProject(config, slugArgument);

  const entries = await call(config, `/api/projects/${slug}/roadmap`);
  const preamble = await readFile(join(here, 'preamble.md'), 'utf8');

  const markdown = renderRoadmap(entries, { preamble, sectionOrder: SECTION_ORDER });
  await writeFile(resolve(out), markdown, 'utf8');

  const byStatus = {};
  for (const entry of entries) byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
  console.error(
    `Wrote ${out}: ${entries.length} entries from ${slug} at ${config.url} ` +
      `(${Object.entries(byStatus).map(([k, v]) => `${v} ${k}`).join(', ')})`,
  );
}

main().catch((failure) => {
  console.error(failure.message);
  process.exit(1);
});
