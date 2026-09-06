// What the daemon says about itself when it starts — R62.
//
// This is the mark, and then the five things that decide what this machine
// will actually do. They used to be spread across a config file nobody has
// open and a log line each, in the same grey as everything after them — so
// "why did that not happen" started with reading JSON.
//
// The five, and why each is here rather than assumed:
//
//   the URL       a machine can have three checkouts and a --config flag, so
//                 "which cawdev is this" is a real question with a wrong
//                 answer available
//   the name      it is the identity runs are claimed under
//   projects      with how many checkouts each has, because R47 made a
//                 project's concurrency min(workspaces, maxSessions) and
//                 neither number was ever on screen. It is a cap on CODING
//                 runs and on nothing else — R70
//   the cap       the other half of that, and the one that counts every
//                 profile: a question is bounded here and nowhere else
//   the browser   R61, and the one line that says an agent may reach Chrome
//
// It prints once, at boot. Anything that changes afterwards belongs in the
// log, not here.

import { mark } from './brand.mjs';
import { padVisible } from '../lib/ansi.mjs';

/**
 * The launch banner, as lines.
 *
 * Lines rather than output, so the caller decides where it goes — and so this
 * can be tested by reading it rather than by capturing a stream.
 */
export function bannerLines(config, ink) {
  const lines = ['', ...mark(ink, { tagline: 'the runner' }), ''];

  const label = (text) => ink.muted(padVisible(text, 12));
  const say = (name, value) => lines.push(`  ${label(name)}${value}`);

  say('platform', ink.accent(config.url));
  say('runner', ink.text(config.name));

  const projects = Object.entries(config.projects);
  projects.forEach(([slug, project], at) => {
    const count = project.workspaces.length;
    // The number is the point: it is this project's ceiling on concurrent
    // coding runs, and it is the one people are surprised by. The word is
    // "coding" because that is all it bounds — R70. A question, a roadmap
    // session and an audit take no checkout and are held back by the cap
    // below and by nothing here.
    const s = count === 1 ? '' : 's';
    const many = ink.muted(`${count} checkout${s}, so ${count} coding run${s}`);
    say(at === 0 ? 'serving' : '', `${ink.text(padVisible(slug, 14))}${many}`);
  });
  if (!projects.length) {
    say('serving', ink.danger('nothing'));
  }

  // R109 removed the machine-wide `maxSessions`: it bounded PROCESSES, and a
  // delegated expert runs inside its parent's session and costs none, so the
  // number it capped was never the number anybody was worried about. The line
  // stayed and printed `undefined sessions, this machine`, which reads as a
  // misconfiguration on a machine that has none. What bounds a run is the
  // workspace, and the line above already says how many there are.
  say('at once', ink.muted('one coding run per checkout — the only gate there is'));

  // Said either way. "Off" is the answer to a question somebody will ask when
  // a run reports it could not look at the page, and a line that only appears
  // when enabled cannot answer it.
  say('browser', config.browser
    ? `${ink.success('allowed')} ${ink.muted('— runs may drive Claude in Chrome')}`
    : `${ink.muted('off')} ${ink.muted('— set "browser": true to allow it')}`);

  lines.push('');
  return lines;
}

/**
 * How a log line is coloured — R62.
 *
 * **By what it is, never only by colour.** Every one of these already reads
 * correctly in black and white; the colour is there to let the eye skip to the
 * failure, not to carry the meaning. That is why this matches on the words the
 * daemon already writes rather than on a level nobody sets.
 */
export function tintLog(line, ink) {
  if (!ink.enabled) return line;

  // FIRST, and this order is the whole design. Several benign lines contain
  // the word "failed" inside a sentence that says the daemon handled it —
  // `fetch skipped: git fetch --prune origin failed: no origin` is a
  // repository with no remote, which is fine and happens on every survey of
  // every scratch checkout. Painting those red teaches people that red means
  // nothing, which costs more than having no colour at all.
  if (/\bskipped\b|\bnothing to\b|\balready\b/i.test(line)) return ink.muted(line);

  if (/\bfailed\b|\bcould not\b|\berror\b|\brefus|exited \(code [1-9]/i.test(line)) {
    return ink.danger(line);
  }
  if (/\bwaiting\b|\bqueued\b|\bno free workspace\b|\bdoes not allow\b/i.test(line)) {
    return ink.warn(line);
  }
  if (/\bclaiming\b|\bspawning\b|\bregistered\b/i.test(line)) return ink.accent(line);
  if (/\bserving\b|\bavailable\b/i.test(line)) return ink.success(line);
  return ink.muted(line);
}
