// node --test tools/lib/code-map.test.mjs
//
// The map's one hard part: turning what somebody wrote into a file that exists.
// Everything on the page rests on this, and a WRONG edge is worse than a
// missing one — it is a claim about the code that a reader will believe.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codeMapOf, resolveRelative } from './code-map.mjs';

test('a relative specifier resolves against the file that wrote it', () => {
  assert.equal(resolveRelative('a/b/c.ts', './d'), 'a/b/d');
  assert.equal(resolveRelative('a/b/c.ts', '../d'), 'a/d');
  assert.equal(resolveRelative('a/b/c.ts', '../../d/e'), 'd/e');
});

test('a package specifier resolves to nothing, and that is the right answer', () => {
  // `@angular/core` is a dependency on something outside this repository, and
  // inventing a node for it would fill the map with libraries.
  assert.equal(resolveRelative('a/b.ts', '@angular/core'), null);
  assert.equal(resolveRelative('a/b.ts', 'node:fs'), null);
});

test('an import written without its extension still finds the file', () => {
  const map = codeMapOf([
    { path: 'app/one.ts', text: "import { two } from './two';" },
    { path: 'app/two.ts', text: '' },
  ]);

  assert.deepEqual(map.edges, [{ from: 'app/one.ts', to: 'app/two.ts', weight: 1 }]);
});

test('a java import resolves by package path, not by class name', () => {
  // Two packages can each hold a `Runner`. Matching on the name alone draws an
  // edge to whichever was read first, which is a lie a reader cannot see.
  const map = codeMapOf([
    {
      path: 'backend/src/main/java/dev/caw/cawdev/run/A.java',
      text: 'import dev.caw.cawdev.git.Runner;\nimport java.util.List;',
    },
    { path: 'backend/src/main/java/dev/caw/cawdev/git/Runner.java', text: '' },
    { path: 'backend/src/main/java/dev/caw/cawdev/run/Runner.java', text: '' },
  ]);

  assert.deepEqual(map.edges, [{
    from: 'backend/src/main/java/dev/caw/cawdev/run/A.java',
    to: 'backend/src/main/java/dev/caw/cawdev/git/Runner.java',
    weight: 1,
  }]);
});

test('an import of something outside the repository is not an edge', () => {
  // `java.util.List` is in almost every file and points at somebody else.
  const map = codeMapOf([
    { path: 'a/A.java', text: 'import java.util.List;\nimport java.time.Instant;' },
  ]);

  assert.deepEqual(map.edges, []);
});

test('a file that imports itself draws no circle on its own box', () => {
  const map = codeMapOf([{ path: 'a/one.ts', text: "export * from './one';" }]);
  assert.deepEqual(map.edges, []);
});

test('a file whose text is not read is still on the map', () => {
  // A map missing the CSS is a map of somewhere else. Files are the population;
  // edges are only what we can honestly say about them.
  const map = codeMapOf([
    { path: 'a/one.ts', text: '' },
    { path: 'a/style.css' },
    { path: 'a/schema.sql' },
  ]);

  assert.deepEqual(map.files.map((each) => each.path),
    ['a/one.ts', 'a/schema.sql', 'a/style.css']);
});

test('a file carries the directory it lives in, which is what the map nests by', () => {
  const map = codeMapOf([{ path: 'backend/src/App.java' }]);
  assert.equal(map.files[0].dir, 'backend/src');
});

test('two imports of one file count as two, so a thick line means something', () => {
  const map = codeMapOf([
    { path: 'a/one.ts', text: "import {a} from './two';\nimport {b} from './two';" },
    { path: 'a/two.ts', text: '' },
  ]);

  assert.equal(map.edges[0].weight, 2);
});
