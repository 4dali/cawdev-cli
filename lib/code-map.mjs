// The shape of a codebase: which files exist, and which of them reach for which
// others — R77's Map tab.
//
// **Pure, and deliberately so.** Everything here takes text and returns data, so
// the hard part — resolving a written import to a file that exists — can be
// tested without a repository, a daemon or a network. The runner does the
// reading; this does the thinking.
//
// **Why not CodeGraph.** R76 says use it rather than rebuild it, and that still
// holds for what R76 is for: symbols and call paths, queried by an agent over
// MCP, one question at a time. This is a different graph for a different
// consumer — every file and every edge at once, laid out for a person to look
// at — and R76's own text names that as the case where rebuilding is right: "if
// the graph it exposes over MCP is not the graph the next entry needs". An
// import edge is also the one thing a reader can check by opening the file,
// which a call path inferred through a parser is not.

/** Files we can honestly extract dependencies from. Others are drawn with no edges. */
const READABLE = /\.(java|mjs|js|ts|tsx|jsx)$/;

/** What counts as a source file at all — the map's population. */
const SOURCE = /\.(java|mjs|js|ts|tsx|jsx|html|css|sql|yaml|yml)$/;

/**
 * Java imports.
 *
 * <p>All of them, including `java.util.List`; the resolver drops the ones that
 * point outside the repository. Filtering here would need this function to know
 * what the project is called, which is the resolver's business.
 */
function javaImports(text) {
  const found = [];
  for (const line of text.split('\n')) {
    const match = /^\s*import\s+(?:static\s+)?([\w.]+)\s*;/.exec(line);
    if (match) {
      found.push(match[1]);
    }
  }
  return found;
}

/** ESM imports and re-exports, which in this corpus are always relative. */
function esmImports(text) {
  const found = [];
  const pattern = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    found.push(match[1]);
  }
  return found;
}

/** `a/b/c.ts` + `../d` -> `a/d`. Null when it is not relative, or climbs out. */
export function resolveRelative(from, specifier) {
  if (!specifier.startsWith('.')) {
    return null;
  }
  const parts = from.split('/').slice(0, -1);
  for (const step of specifier.split('/')) {
    if (step === '.' || step === '') continue;
    if (step === '..') {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(step);
  }
  return parts.join('/');
}

/**
 * The file a specifier means, or null.
 *
 * <p>Null is the honest answer and is kept as one: a specifier resolving to
 * nothing in this repository is a dependency on something outside it, and
 * inventing a node for it would fill the map with somebody else's libraries.
 */
function resolveIn(known, base) {
  if (!base) {
    return null;
  }
  if (known.has(base)) {
    return base;
  }
  for (const suffix of ['.ts', '.tsx', '.js', '.mjs', '.jsx']) {
    if (known.has(base + suffix)) {
      return base + suffix;
    }
  }
  for (const suffix of ['/index.ts', '/index.js', '/index.mjs']) {
    if (known.has(base + suffix)) {
      return base + suffix;
    }
  }
  return null;
}

/**
 * A Java class name to the file that declares it.
 *
 * <p>By package path rather than by class name: two packages may each hold a
 * `Runner`, and picking whichever was read first would draw an edge to the
 * wrong one — a lie a reader cannot see. `a.b.C` is `.../a/b/C.java`, and
 * indexing by the tail after `/java/` is what copes with `src/main/java` in
 * front of it.
 */
function resolveJava(byJavaPath, name) {
  return byJavaPath.get(name.replace(/\./g, '/') + '.java') ?? null;
}

/**
 * The map: every source file, and every edge between two of them.
 *
 * @param files `[{path, text}]`. `text` may be absent for a file whose
 *   dependencies are not read — it is still drawn, because a map missing the
 *   CSS is a map of somewhere else.
 */
export function codeMapOf(files) {
  const paths = files.map((each) => each.path).filter((path) => SOURCE.test(path));
  const known = new Set(paths);

  const byJavaPath = new Map();
  for (const path of paths) {
    if (!path.endsWith('.java')) continue;
    const at = path.indexOf('/java/');
    byJavaPath.set(at === -1 ? path : path.slice(at + '/java/'.length), path);
  }

  // Nested rather than a composite key: a delimiter is a character somebody's
  // filename eventually contains.
  const out = new Map();
  for (const file of files) {
    if (!file.text || !READABLE.test(file.path) || !known.has(file.path)) {
      continue;
    }
    const targets = file.path.endsWith('.java')
      ? javaImports(file.text).map((name) => resolveJava(byJavaPath, name))
      : esmImports(file.text).map(
          (specifier) => resolveIn(known, resolveRelative(file.path, specifier)));

    for (const to of targets) {
      // A file importing itself is a re-export shim, not a dependency, and a
      // self-loop is a circle drawn on top of a box.
      if (!to || to === file.path) continue;
      if (!out.has(file.path)) {
        out.set(file.path, new Map());
      }
      const mine = out.get(file.path);
      mine.set(to, (mine.get(to) ?? 0) + 1);
    }
  }

  const edges = [];
  for (const [from, targets] of out) {
    for (const [to, weight] of targets) {
      edges.push({ from, to, weight });
    }
  }

  return {
    files: paths.sort().map((path) => ({ path, dir: path.split('/').slice(0, -1).join('/') })),
    edges,
  };
}
