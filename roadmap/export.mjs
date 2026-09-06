#!/usr/bin/env node
// Writes a project's ROADMAP.md from cawdev.
//
//   CAWDEV_URL=… CAWDEV_TOKEN=… node tools/roadmap/export.mjs [project] [--out FILE]
//   CAWDEV_URL=… CAWDEV_TOKEN=… node tools/roadmap/export.mjs [project] --issues
//
// R85: two files, because there are two questions. --issues writes ISSUES.md
// from the cards whose kind is ISSUE, filed by status rather than by phase — a
// defect does not belong to "Phase 3", it belongs to open or fixed.
//
// The output is deliberately byte-stable: same data in, same bytes out, so a
// regenerated export shows a diff only when the roadmap actually changed. CI
// checks that export → import → export is a fixed point.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, readConfig, resolveProject } from '../lib/cawdev.mjs';
import { renderIssues, renderRoadmap, unlistedSections } from '../lib/roadmap-format.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The order sections appear in. Kept beside the exporter rather than in the
 * database because it is prose layout, unlike an entry's own section, which is
 * a planning decision.
 *
 * A section missing from this list is not an error — it is appended, and named
 * in the note this script prints, because a list nobody is told about is a list
 * nobody updates. That is how "Roadmap" became a junk drawer (R45).
 */
const SECTION_ORDER = [
  'Phase 1 — the roadmap platform, usable on its own',
  'Phase 2 — the MCP server',
  'Phase 3 — agent orchestration',
  'Phase 3 — the console becomes the workplace',
  'Phase 3 — the console drives the agent',
  'Phase 4 — roadmap, issues and development: three boards and one dashboard',
  'Phase 5 — agents, skills and a marketplace',
  'Phase 6 — the meta-harness: a lifecycle, not a chat',
  'The generated files and the tools',
  // Named rather than appended: six entries were arriving here silently, which
  // is the state R45's note exists to end. Last, because a finding somebody
  // accepted is work that was not planned into a phase.
  'Found by an audit',
];

async function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const out = outIndex === -1 ? 'ROADMAP.md' : args[outIndex + 1];
  const slugArgument = args.find((arg) => !arg.startsWith('--') && arg !== out);
  const issues = args.includes('--issues');

  const config = await readConfig();
  const slug = resolveProject(config, slugArgument);

  if (issues) {
    const filed = await call(config, `/api/projects/${slug}/issues`);
    const preamble = await readFile(join(here, 'issues-preamble.md'), 'utf8');
    await writeFile(resolve(out === 'ROADMAP.md' ? 'ISSUES.md' : out),
      renderIssues(filed, { preamble }), 'utf8');
    const bySeverity = {};
    for (const entry of filed) {
      bySeverity[entry.severity] = (bySeverity[entry.severity] ?? 0) + 1;
    }
    console.error(
      `Wrote ISSUES.md: ${filed.length} issue(s) from ${slug} at ${config.url}` +
        (filed.length
          ? ` (${Object.entries(bySeverity).map(([k, v]) => `${v} ${k}`).join(', ')})`
          : ''),
    );
    return;
  }

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

  const unlisted = unlistedSections(entries, SECTION_ORDER);
  if (unlisted.length) {
    console.error(
      `Note: ${unlisted.length} section(s) not in SECTION_ORDER, appended in the order they ` +
        `appear: ${unlisted.map(({ section, count }) => `"${section}" (${count})`).join(', ')}. ` +
        'Add each to SECTION_ORDER in this file, or give those entries a section that is in it. ' +
        '"Roadmap" is the fallback for an entry with no section of its own.',
    );
  }
}

main().catch((failure) => {
  console.error(failure.message);
  process.exit(1);
});
