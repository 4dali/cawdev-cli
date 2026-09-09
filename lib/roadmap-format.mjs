// The ROADMAP.md format, in one place: parsing it and writing it.
//
// The importer and the exporter must agree exactly, or export → import → export
// is not a fixed point and the generated file churns on every release. Keeping
// both halves in one file is how they stay agreed.

/** Status as stored, from how the file writes it: "IN PROGRESS" -> IN_PROGRESS. */
/**
 * What to call a card — R127.
 *
 * <p>The API says, in `ref`. This is the fallback for an entry parsed out of a
 * file, where the prefix in the heading is the only thing there is to read. One
 * place on this side of the wire spells the prefix, so the parser and the
 * writer cannot drift apart.
 */
export function entryRef(entry) {
  return entry.ref ?? ((entry.kind === 'ISSUE' ? 'i' : 'R') + entry.number);
}

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
 *
 * Two, and REVIEW is deliberately not a third: work waiting to be read is still
 * part of the phase it belongs to, and moving it to a section of its own would
 * take it out of its phase for a few days and put it back afterwards.
 */
export const STATUS_SECTIONS = {
  CONSIDERING: 'Considering — wanted, not settled',
  DECLINED: 'Declined — decided against, with the reason',
};

/**
 * ISSUES.md's sections — R85.
 *
 * Every one of them is derived from the status, because an issue has no phase:
 * a defect does not belong to "Phase 3", it belongs to "open" or "fixed". That
 * is the whole reason the two files are separate rather than one file with a
 * kind column — the roadmap is organised by intent and this is organised by
 * whether it is still true.
 */
export const ISSUE_SECTIONS = {
  NEW: 'New — filed, not yet triaged',
  CONFIRMED: 'Confirmed — real, waiting for somebody',
  IN_DEVELOPMENT: 'In development — somebody is fixing it',
  MERGED: 'Resolved — the fix landed',
  SHIPPED: 'Released — the fix shipped',
  DECLINED: "Won't fix — decided against, with the reason",
};

/** The order ISSUES.md reads in: what needs somebody first, history last. */
export const ISSUE_SECTION_ORDER = Object.values(ISSUE_SECTIONS);

/** Where an issue belongs in ISSUES.md. */
export function issueSectionOf(entry) {
  return ISSUE_SECTIONS[entry.status] ?? 'Open';
}

/**
 * Issues, rendered as their own file.
 *
 * Sorted by severity inside each section, critical first, because that IS the
 * question the file is read to answer. `renderRoadmap` sorts by number, which
 * on a roadmap is chronological and useful and here would bury a critical
 * defect behind six minor ones filed after it.
 */
export function renderIssues(entries, { preamble }) {
  const rank = { CRITICAL: 0, MEDIUM: 1, MINOR: 2 };
  const bySection = new Map();
  for (const entry of entries) {
    const section = issueSectionOf(entry);
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section).push(entry);
  }
  for (const list of bySection.values()) {
    list.sort((a, b) =>
      (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3) || a.number - b.number);
  }

  const ordered = [
    ...ISSUE_SECTION_ORDER.filter((section) => bySection.has(section)),
    ...[...bySection.keys()].filter((section) => !ISSUE_SECTION_ORDER.includes(section)),
  ];

  const parts = [preamble.trimEnd(), ''];
  for (const section of ordered) {
    parts.push('---', '', `## ${section}`, '');
    for (const entry of bySection.get(section)) {
      parts.push(renderEntry(entry), '');
    }
  }
  return `${parts.join('\n').trimEnd()}\n`;
}

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

    // Either prefix — R127. An old export headed `### R90` still parses, which
    // is what import.mjs needs; the prefix says which kind the card is.
    const heading = /^([Ri])(\d+)\s+[—–-]\s+(.+)$/.exec(block.heading);
    if (!heading) {
      problems.push(
        `Entry heading is not "R<number> — title" or "i<number> — title": ${block.heading}`,
      );
      continue;
    }

    const entry = {
      number: Number(heading[2]),
      kind: heading[1] === 'i' ? 'ISSUE' : 'ROADMAP',
      title: heading[3].trim(),
      status: 'PLANNED',
      branch: null,
      merge: null,
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
      const severity = /^Severity:\s*(.+)$/.exec(line.trim());
      if (severity) {
        entry.severity = severity[1].trim();
        continue;
      }
      const development = /^Development:\s*(.+)$/.exec(line.trim());
      if (development) {
        entry.development = statusFromDisplay(development[1].trim());
        continue;
      }
      const merge = /^Merged:\s*(.+)$/.exec(line.trim());
      if (merge) {
        entry.merge = merge[1].trim();
        continue;
      }
      const related = /^Related:\s*(.+)$/.exec(line.trim());
      if (related) {
        // Both prefixes — R127 — and the refs are kept exactly as written.
        // Without that, render → parse → render rewrites `i91` as `R91` and the
        // round trip stops being a fixed point.
        const tokens = related[1]
          .split(/[,\s]+/)
          .map((token) => ({ ref: token, number: Number(token.replace(/^[Ri]/i, '')) }))
          .filter(({ number }) => Number.isInteger(number) && number > 0);
        entry.related = tokens.map(({ number }) => number);
        entry.relatedRefs = tokens.map(({ ref }) => ref);
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
  const lines = [`### ${entryRef(entry)} — ${entry.title}`, ''];

  const status =
    entry.status === 'SHIPPED' && entry.version
      ? `SHIPPED ${entry.version}`
      : statusToDisplay(entry.status);
  lines.push(`Status: ${status}`);

  // R85. An issue carries how badly it is broken, and it is a line rather than
  // a prefix on the title: welded into a title it goes stale the moment
  // somebody re-ranks it, which is exactly what triage is for.
  if (entry.severity) {
    lines.push(`Severity: ${entry.severity}`);
  }

  // Each status writes only what it currently claims. A MERGED entry keeps its
  // branch in the database as history, but the file must not print it: the
  // branch is expected to be deleted, and `--live` would then be reading a claim
  // the entry is no longer making.
  //
  // IN DEVELOPMENT does print it, for the mirror-image reason: the branch is
  // where the work is, and it is still there until MERGED says where it went.
  // R84 — one status where CODING, REVIEW and DONE each printed one.
  if (entry.status === 'IN_DEVELOPMENT' && entry.branch) {
    lines.push(`Branch: ${entry.branch}`);
  }
  // How far that branch has got, when the platform knows — R84. It is the WORK
  // ITEM's status and not the card's, which is exactly why it is a second line
  // rather than a fifth spelling of Status. A file whose cards say only "in
  // development" is still a valid roadmap; this line is what makes it readable.
  const development = entry.development ?? entry.workItem?.status;
  if (entry.status === 'IN_DEVELOPMENT' && development) {
    lines.push(`Development: ${statusToDisplay(development)}`);
  }
  if (entry.status === 'MERGED' && entry.merge) {
    lines.push(`Merged: ${entry.merge}`);
  }
  if (entry.related?.length) {
    // Each id written the way its own card is written, when the API said so —
    // R127. Still sorted by number, so an export does not churn on the order
    // the ids happen to arrive in.
    const refs = new Map(
      (entry.relatedRefs ?? []).map((ref, index) => [entry.related[index], ref]),
    );
    const written = [...entry.related]
      .sort((a, b) => a - b)
      .map((n) => refs.get(n) ?? `R${n}`);
    lines.push(`Related: ${written.join(', ')}`);
  }

  if (entry.body?.trim()) {
    lines.push('', entry.body.trim());
  }
  return lines.join('\n');
}
