// Colour in a terminal, and the good manners around it — R62.
//
// Zero dependencies, like everything in tools/. That is not austerity for its
// own sake: a colour library is a supply chain, and what it does for us is
// thirty lines of escape codes that have not changed since 1979.
//
// Three rules, and the second two are the ones people forget:
//
//   1. Say what the terminal can hear. Truecolor where it advertises it, the
//      256-colour cube where it does not, nothing where colour is unwanted.
//   2. **Never carry meaning in colour alone.** Every state that has a colour
//      here also has a word beside it, because a pipe, a CI log and a
//      red-green reader are all normal.
//   3. **Measure what is visible, not what is written.** A coloured string is
//      longer than it looks, and padding it by `length` is how a table stops
//      lining up the moment anything in it goes red.

/**
 * Whether to colour at all, and how richly.
 *
 * `NO_COLOR` is honoured for any value, which is what the convention asks
 * (no-color.org): its presence is the signal, not its contents. `FORCE_COLOR`
 * overrides in the other direction, for the case this is piped somewhere that
 * does understand escapes — a file somebody will `less -R`, a CI log viewer.
 */
export function colourDepth(env = process.env, stream = process.stdout) {
  if (env.NO_COLOR !== undefined) return 0;
  if (env.FORCE_COLOR !== undefined) {
    // `FORCE_COLOR=` with nothing after it means ON, which is how people
    // usually write it. `Number('')` is 0, so reading this numerically without
    // saying so first silences colour for exactly the person who asked for it.
    const asked = env.FORCE_COLOR.trim();
    if (asked === '') return 3;
    if (asked === '0' || asked.toLowerCase() === 'false') return 0;
    const level = Number(asked);
    return Number.isFinite(level) ? Math.min(3, Math.max(0, level)) : 3;
  }
  if (!stream?.isTTY) return 0;
  if (env.TERM === 'dumb') return 0;
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 3;
  if (/-256(color)?$/i.test(env.TERM ?? '')) return 2;
  return env.TERM ? 1 : 0;
}

/** The nearest colour the terminal can actually show. */
function code(depth, [r, g, b], basic) {
  if (depth >= 3) return `\x1b[38;2;${r};${g};${b}m`;
  if (depth === 2) return `\x1b[38;5;${cube(r, g, b)}m`;
  return `\x1b[${basic}m`;
}

/**
 * A 24-bit colour in the 256-colour cube.
 *
 * The greys are a separate ramp and are worth using: rounding a near-grey into
 * the 6×6×6 cube gives it a colour cast, which on the dim text this file is
 * mostly used for reads as "the terminal is broken".
 */
function cube(r, g, b) {
  if (Math.abs(r - g) < 12 && Math.abs(g - b) < 12) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return 232 + Math.round(((r - 8) / 247) * 23);
  }
  const axis = (value) => Math.round((value / 255) * 5);
  return 16 + 36 * axis(r) + 6 * axis(g) + axis(b);
}

/**
 * A painter bound to one terminal's abilities.
 *
 * Every colour names a **basic fallback** as well as its true value, so a
 * 16-colour terminal gets something deliberate rather than whatever the cube
 * rounds to.
 */
export function painter(depth = colourDepth()) {
  const on = depth > 0;
  const wrap = (open) => (text) => (on ? `${open}${text}\x1b[0m` : String(text));
  const ink = (rgb, basic) => wrap(code(depth, rgb, basic));

  return {
    depth,
    enabled: on,

    // cawdev's own mark, from cawdev-mark.svg. Used for the logo and nowhere
    // else: the brand is not a status.
    violet: ink([0x4b, 0x3f, 0xd4], 35),
    violetLight: ink([0x75, 0x68, 0xe3], 95),
    amber: ink([0xf0, 0xa2, 0x2e], 33),

    /**
     * The working palette, in Claude Code's warm register rather than the
     * console's violet: this is a terminal tool sitting beside the CLI it
     * drives, and matching that is what makes it look like it belongs.
     * One place to change if that judgement changes.
     */
    accent: ink([0xd9, 0x77, 0x57], 33),
    success: ink([0x71, 0xa5, 0x78], 32),
    warn: ink([0xd9, 0xa0, 0x57], 33),
    danger: ink([0xc0, 0x62, 0x62], 31),
    muted: ink([0x8a, 0x86, 0x82], 90),
    text: ink([0xd4, 0xd0, 0xcc], 37),

    bold: wrap('\x1b[1m'),
    dim: wrap('\x1b[2m'),
    reverse: wrap('\x1b[7m'),
    /** Plain, for a value that should not compete with the label beside it. */
    plain: (text) => String(text),
  };
}

/**
 * A string's width on screen, ignoring escape sequences.
 *
 * The one function everything that lines up depends on. Padding by `length`
 * counts the escapes, so a coloured cell is silently ~10 characters wide and
 * the column after it walks.
 */
export function visibleWidth(text) {
  return stripAnsi(String(text)).length;
}

export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

/** Pads to `width` by what is visible, never by what is written. */
export function padVisible(text, width) {
  const short = width - visibleWidth(text);
  return short > 0 ? `${text}${' '.repeat(short)}` : text;
}
