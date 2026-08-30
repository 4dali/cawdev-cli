// The ROADMAP.md format, in one place: parsing it and writing it.
//
// The importer and the exporter must agree exactly, or export → import → export
// is not a fixed point and the generated file churns on every release. Keeping
// both halves in one file is how they stay agreed.

/** Status as stored, from how the file writes it: "IN PROGRESS" -> IN_PROGRESS. */
export function statusFromDisplay(display) {
  return display.trim().replace(/\s+/g, '_').toUpperCase();
}

/** Status as the file writes it: IN_PROGRESS -> "IN PROGRESS". */
export function statusToDisplay(status) {
  return status.replace(/_/g, ' ');
}

/**
 * Sections that come from a status rather than from the entry's own `section`.
 * The file has always grouped these two this way, and deriving them means a
 * declined entry cannot end up filed under a phase it is no longer part of.
 */
export const STATUS_SECTIONS = {
  CONSIDERING: 'Considering — wanted, not settled',
  DECLINED: 'Declined — decided against, with the reason',
};

/** Where an entry belongs in the exported file. */
export function sectionOf(entry) {
  return STATUS_SECTIONS[entry.status] ?? entry.section ?? 'Roadmap';
}

/**
 * Sections these entries use that the given order does not name, with how many
 * entries each holds.
 *
 * `renderRoadmap` appends an unknown section rather than refusing it — a new
 * phase is legitimate, and an exporter that fails on one would block the
 * release that introduces it. But appending silently is how the list fell
 * behind in the first place, so the exporter says which sections it did not
 * know about. Status-derived sections are never "unlisted": they are the
 * format's own, and no `sectionOrder` should have to repeat them.
 */
export function unlistedSections(entries, sectionOrder = []) {
  const known = new Set([...sectionOrder, ...Object.values(STATUS_SECTIONS)]);
  const counts = new Map();
  for (const entry of entries) {
    const section = sectionOf(entry);
    if (known.has(section)) continue;
    counts.set(section, (counts.get(section) ?? 0) + 1);
  }
  return [...counts].map(([section, count]) => ({ section, count }));
}

/**
 * Parses a ROADMAP.md into entries.
 *
 * Only the part after the preamble's closing rule is considered. The Format
 * section contains a fenced *example* heading — "### R7 — a short title" —
 * which is not an entry; parsing the whole file silently shifts every number
 * after it by one. That cost a run of misnumbered entries the first time.
 */
export function parseRoadmap(text) {
  const body = afterPreamble(text);
  const entries = [];
  const problems = [];

  let currentSection = null;

  for (const block of splitBlocks(body)) {
    if (block.kind === 'section') {
      currentSection = block.title;
      continue;
    }

    const heading = /^R(\d+)\s+[—–-]\s+(.+)$/.exec(block.heading);
    if (!heading) {
      problems.push(`Entry heading is not "R<number> — title": ${block.heading}`);
      continue;
    }

    const entry = {
      number: Number(heading[1]),
      title: heading[2].trim(),
      status: 'PLANNED',
      branch: null,
      version: null,
      reason: null,
      related: [],
      section: currentSection,
      body: '',
    };

    const bodyLines = [];
    for (const line of block.lines) {
      const status = /^Status:\s*(.+)$/.exec(line.trim());
      if (status) {
        const value = status[1].trim();
        const shipped = /^SHIPPED\s+(\S+)$/.exec(value);
        if (shipped) {
          entry.status = 'SHIPPED';
          entry.version = shipped[1];
        } else {
          entry.status = statusFromDisplay(value);
        }
        continue;
      }
      const branch = /^Branch:\s*(.+)$/.exec(line.trim());
      if (branch) {
        entry.branch = branch[1].trim();
        continue;
      }
      const related = /^Related:\s*(.+)$/.exec(line.trim());
      if (related) {
        entry.related = related[1]
          .split(/[,\s]+/)
          .map((token) => Number(token.replace(/^R/i, '')))
          .filter((value) => Number.isInteger(value) && value > 0);
        continue;
      }
      bodyLines.push(line);
    }

    // A horizontal rule at column 0 separates sections in this format, so a
    // trailing one belongs to the file's structure, not to the last entry of a
    // section. Left in, it reappears inside the body on the next export and the
    // round trip stops being a fixed point — which is exactly how this was
    // found.
    while (bodyLines.length && /^\s*$|^-{3,}\s*$/.test(bodyLines.at(-1))) {
      bodyLines.pop();
    }
    entry.body = bodyLines.join('\n').trim();

    // DECLINED needs a reason; the file writes it as a "Reason:" paragraph.
    if (entry.status === 'DECLINED') {
      const found = /Reason:\s*([\s\S]*)/.exec(entry.body);
      entry.reason = (found ? found[1] : entry.body).replace(/\s+/g, ' ').trim();
    }

    entries.push(entry);
  }

  entries.sort((left, right) => left.number - right.number);
  return { entries, problems };
}

function afterPreamble(text) {
  const separator = text.indexOf('\n---\n');
  return separator === -1 ? text : text.slice(separator);
}

/** Yields section headings and entry blocks in document order. */
function* splitBlocks(text) {
  const lines = text.split('\n');
  let entry = null;

  for (const line of lines) {
    const section = /^##\s+(.+)$/.exec(line);
    if (section && !line.startsWith('###')) {
      if (entry) {
        yield entry;
        entry = null;
      }
      yield { kind: 'section', title: section[1].trim() };
      continue;
    }

    const heading = /^###\s+(.+)$/.exec(line);
    if (heading) {
      if (entry) yield entry;
      entry = { kind: 'entry', heading: heading[1].trim(), lines: [] };
      continue;
    }

    if (entry) entry.lines.push(line);
  }
  if (entry) yield entry;
}

/**
 * Writes entries as ROADMAP.md's entry sections.
 *
 * Sections appear in `sectionOrder`, then any others in first-appearance order,
 * with the two status-derived sections last — a roadmap reads forward through
 * the work and ends with what was set aside.
 */
export function renderRoadmap(entries, { preamble, sectionOrder = [] }) {
  const bySection = new Map();
  for (const entry of [...entries].sort((left, right) => left.number - right.number)) {
    const section = sectionOf(entry);
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section).push(entry);
  }

  const statusSections = Object.values(STATUS_SECTIONS);
  const ordered = [
    ...sectionOrder.filter((section) => bySection.has(section)),
    ...[...bySection.keys()].filter(
      (section) => !sectionOrder.includes(section) && !statusSections.includes(section),
    ),
    ...statusSections.filter((section) => bySection.has(section)),
  ];

  const parts = [preamble.trimEnd(), ''];
  for (const section of ordered) {
    parts.push('---', '', `## ${section}`, '');
    for (const entry of bySection.get(section)) {
      parts.push(renderEntry(entry), '');
    }
  }

  // Exactly one trailing newline, so the file is stable under any editor.
  return parts.join('\n').replace(/\n+$/, '') + '\n';
}

function renderEntry(entry) {
  const lines = [`### R${entry.number} — ${entry.title}`, ''];

  const status =
    entry.status === 'SHIPPED' && entry.version
      ? `SHIPPED ${entry.version}`
      : statusToDisplay(entry.status);
  lines.push(`Status: ${status}`);

  if (entry.status === 'CODING' && entry.branch) {
    lines.push(`Branch: ${entry.branch}`);
  }
  if (entry.related?.length) {
    lines.push(`Related: ${[...entry.related].sort((a, b) => a - b).map((n) => `R${n}`).join(', ')}`);
  }

  if (entry.body?.trim()) {
    lines.push('', entry.body.trim());
  }
  return lines.join('\n');
}
