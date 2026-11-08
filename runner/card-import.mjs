// Cards from a JSON file — `cawdev import <file>` and `/import` in the
// terminal, over `POST /api/projects/{slug}/roadmap/import`.
//
// The file is either a bare array of cards or `{ "cards": [...] }`, each card
// `{ title, body?, kind?, severity?, priority?, status?, section?, tags?,
// assignee? }`. A card with a severity and no kind is an issue. What a card
// may hold is the server's to say, card by card (`CardImportService`): this
// side only refuses what is not a list of objects at all, because a file that
// is not JSON is a sentence the person should read before anything is sent.
//
// Zero dependencies, like everything in tools/.

/** The most cards one call takes — `CardImportService.MAX_CARDS`. */
export const MAX_CARDS = 200;

/**
 * The cards in a file's text, or a thrown sentence saying what is wrong with
 * it. Pure: the console's dialog spells the same rule in `board/card-import.ts`.
 */
export function cardsFrom(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error_) {
    throw new Error(`not JSON: ${error_.message}`);
  }
  const cards = Array.isArray(parsed) ? parsed : parsed?.cards;
  if (!Array.isArray(cards)) {
    throw new TypeError('expected a list of cards, or an object with a "cards" list');
  }
  if (!cards.length) {
    throw new Error('the file holds no cards');
  }
  if (cards.length > MAX_CARDS) {
    throw new Error(`at most ${MAX_CARDS} cards in one import — the file holds ${cards.length}`);
  }
  const notCards = cards.findIndex((card) => !card || typeof card !== 'object' || Array.isArray(card));
  if (notCards !== -1) {
    throw new Error(`card ${notCards + 1} is not an object`);
  }
  return cards;
}

/**
 * One call. `dryRun` files nothing and says what would be. A card whose title
 * is taken (on the board, or earlier in the file) is skipped and listed in
 * `duplicates` unless `allowDuplicates`.
 */
export function importCards(session, slug, cards, { dryRun = false, status, allowDuplicates = false } = {}) {
  return session.request(
    `/api/projects/${encodeURIComponent(slug)}/roadmap/import?dryRun=${dryRun}`,
    {
      method: 'POST',
      body: { cards, ...(status ? { status } : {}), ...(allowDuplicates ? { allowDuplicates: true } : {}) },
    },
  );
}

/** How many of each kind, in words: `3 issues and 1 roadmap card`. */
export function countWords(filed) {
  const issues = filed.filter((card) => card.kind === 'ISSUE').length;
  const roadmap = filed.length - issues;
  const parts = [];
  if (issues) parts.push(`${issues} issue${issues === 1 ? '' : 's'}`);
  if (roadmap) parts.push(`${roadmap} roadmap card${roadmap === 1 ? '' : 's'}`);
  return parts.join(' and ') || 'no card';
}

/**
 * The lines a result is told in. Every refusal is named with its place in the
 * file (from 1, as an editor counts) and its title, so it can be found and
 * fixed; a real run lists the refs it filed. A duplicate names what it
 * repeats: the project's card, or the file's own earlier one.
 */
export function resultLines(result, slug, ink) {
  const lines = [];
  const filed = result.filed ?? [];
  const refused = result.refused ?? [];
  const duplicates = result.duplicates ?? [];
  const tail = (refused.length ? ink.warn(` · ${refused.length} refused`) : '')
    + (duplicates.length ? ink.muted(` · ${duplicates.length} skipped as duplicates`) : '');
  if (result.dryRun) {
    const head = ink.text(`${countWords(filed)} would be filed on ${slug}`);
    lines.push(`  ${head}${tail}`);
  } else {
    const head = ink.success(`filed ${countWords(filed)} on ${slug}`);
    lines.push(`  ${head}${tail}`);
    for (const card of filed) {
      lines.push(`    ${ink.accent(card.ref ?? '?')} ${ink.muted(card.title)}`);
    }
  }
  for (const card of refused) {
    const number = ink.danger(`#${card.index + 1}`);
    lines.push(`    ${number} ${ink.muted(card.title ?? '(no title)')} — ${card.reason}`);
  }
  for (const card of duplicates) {
    const of = card.ref ? `already ${card.ref}` : `same as #${card.sameAs + 1}`;
    const note = ink.muted(`#${card.index + 1} ${card.title} — ${of}`);
    lines.push(`    ${note}`);
  }
  return lines;
}

function withoutTrailingSlashes(path) {
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end--;
  return path.slice(0, end);
}

/**
 * Which project, when the command did not name one: the project whose checkout
 * the directory stands in (the deepest, when checkouts nest), else the one
 * project this machine serves. Null when it cannot be told, and the command
 * asks for `--project`. `pathsOf` and `absolute` are configure's and paths'.
 */
export function projectFor(projects, cwd, { pathsOf, absolute }) {
  const slugs = Object.keys(projects ?? {});
  const inside = (path) => cwd === path || cwd.startsWith(`${withoutTrailingSlashes(path)}/`);
  const here = slugs
    .flatMap((slug) => pathsOf(projects[slug]).map((path) => [slug, absolute(path)]))
    .filter(([, path]) => inside(path))
    .sort((left, right) => right[1].length - left[1].length);
  if (here.length) return here[0][0];
  return slugs.length === 1 ? slugs[0] : null;
}
