#!/usr/bin/env node
// Seeds a cawdev project from a ROADMAP.md.
//
//   CAWDEV_URL=… CAWDEV_TOKEN=… node tools/roadmap/import.mjs [project] [--file ROADMAP.md]
//
// This is the one-time move from a hand-written file into the platform, and
// the other half of the export → import → export fixed point CI checks.
//
// **Idempotent enough to re-run after a partial failure**: entries that already
// exist are updated rather than duplicated, so a run that died halfway can
// simply be run again. It refuses to start on a project whose numbering has
// already diverged, because ids are permanent and silently renumbering them
// would break every commit message that points at one.

import { readFile } from 'node:fs/promises';
import { call, readConfig, resolveProject } from '../lib/cawdev.mjs';
import { parseRoadmap } from '../lib/roadmap-format.mjs';

async function main() {
  const args = process.argv.slice(2);
  const fileIndex = args.indexOf('--file');
  const file = fileIndex === -1 ? 'ROADMAP.md' : args[fileIndex + 1];
  const slugArgument = args.find((arg) => !arg.startsWith('--') && arg !== file);

  const config = await readConfig();
  const slug = resolveProject(config, slugArgument);

  const { entries, problems } = parseRoadmap(await readFile(file, 'utf8'));
  if (problems.length) {
    for (const problem of problems) console.error(`  ${problem}`);
    throw new Error(`${file} did not parse cleanly; fix the above and re-run.`);
  }
  if (!entries.length) {
    throw new Error(`${file} has no entries. Did the preamble swallow them?`);
  }

  const existing = await call(config, `/api/projects/${slug}/roadmap?brief=true`);
  const known = new Map(existing.map((entry) => [entry.number, entry]));

  console.error(
    `${file}: R${entries[0].number}–R${entries.at(-1).number} (${entries.length} entries). ` +
      `${slug} holds ${known.size}.`,
  );

  // Numbers are allocated by the platform in sequence, so preserving them means
  // creating in order from an empty (or exactly-prefix-matching) project.
  const missing = entries.filter((entry) => !known.has(entry.number));
  const nextExpected = known.size ? Math.max(...known.keys()) + 1 : 1;
  if (missing.length && missing[0].number !== nextExpected) {
    throw new Error(
      `Cannot preserve ids: ${slug} holds up to R${nextExpected - 1}, but the next entry to ` +
        `create is R${missing[0].number}. Ids are permanent — import into an empty project, ` +
        `or add the gap by hand first.`,
    );
  }

  // Pass 1: create or update everything, without related ids, so a forward
  // reference (R4 relating to R7) does not fail on a not-yet-created entry.
  let created = 0;
  let updated = 0;
  for (const entry of entries) {
    if (known.has(entry.number)) {
      await call(config, `/api/projects/${slug}/roadmap/${entry.number}`, {
        method: 'PATCH',
        body: { title: entry.title, body: entry.body, section: entry.section ?? '' },
      });
      await call(config, `/api/projects/${slug}/roadmap/${entry.number}/status`, {
        method: 'POST',
        body: {
          status: entry.status,
          branch: entry.branch ?? undefined,
          version: entry.version ?? undefined,
          reason: entry.reason ?? undefined,
        },
      });
      updated += 1;
      continue;
    }

    const result = await call(config, `/api/projects/${slug}/roadmap`, {
      method: 'POST',
      body: {
        title: entry.title,
        body: entry.body,
        status: entry.status,
        branch: entry.branch ?? undefined,
        version: entry.version ?? undefined,
        reason: entry.reason ?? undefined,
        section: entry.section ?? undefined,
      },
    });
    if (result.number !== entry.number) {
      throw new Error(
        `R${entry.number} was allocated ${result.number}. Ids are permanent, so this import ` +
          `cannot continue — start from an empty project.`,
      );
    }
    created += 1;
  }

  // Pass 2: related ids, now that every entry exists.
  let linked = 0;
  for (const entry of entries) {
    if (!entry.related.length) continue;
    await call(config, `/api/projects/${slug}/roadmap/${entry.number}`, {
      method: 'PATCH',
      body: { related: entry.related },
    });
    linked += 1;
  }

  console.error(`Created ${created}, updated ${updated}, linked ${linked} with related ids.`);
}

main().catch((failure) => {
  console.error(failure.message);
  process.exit(1);
});
