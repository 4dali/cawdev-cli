// What a turn cost, in the unit people actually have.
//
// The CLI reports `total_cost_usd`, and it is tempting to show it. **It is a
// list-price equivalent, not a bill**: the event says so itself with
// `costBasis: "list"`. Somebody on a Claude subscription pays a flat fee, so
// "$5.37 so far" tells them a number they will never be charged, and reads as
// if they have spent it. Tokens are what they actually consumed.
//
// Cost belongs in R20, which records it per provider alongside the basis it was
// quoted on, and leaves it blank when a provider states none. A transcript line
// is the wrong place to imply an invoice.

/** 1234 → "1.2k", 1234567 → "1.2M". Small numbers stay exact. */
export function formatTokens(count) {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
    return '0';
  }
  if (count < 1000) {
    return String(Math.round(count));
  }
  if (count < 1_000_000) {
    const thousands = count / 1000;
    // 12.4k below a hundred, 124k above: a decimal on a big number is noise.
    return `${thousands < 100 ? thousands.toFixed(1) : Math.round(thousands)}k`;
  }
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** "45s", "13m", "1h 4m" — a turn's length, at the precision that matters. */
export function formatDuration(milliseconds) {
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0) {
    return null;
  }
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * The tokens a `result` event reports.
 *
 * `usage` is this turn; `modelUsage` accumulates across the session — which is
 * what the old line's "so far" was reaching for, and worth keeping now that it
 * is expressed in something real.
 *
 * Cache reads are shown because they are usually the largest number by an order
 * of magnitude, and a turn that reads 200k of cache and writes 2k of output
 * looks otherwise inexplicably slow.
 */
export function describeUsage(event) {
  const usage = event?.usage ?? {};
  const parts = [];

  const input = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  if (input) {
    parts.push(`${formatTokens(input)} in`);
  }
  if (usage.output_tokens) {
    parts.push(`${formatTokens(usage.output_tokens)} out`);
  }
  if (usage.cache_read_input_tokens) {
    parts.push(`${formatTokens(usage.cache_read_input_tokens)} cached`);
  }

  const session = sessionTotals(event?.modelUsage);
  if (session) {
    parts.push(`session ${formatTokens(session.input)} in, ${formatTokens(session.output)} out`);
  }
  return parts;
}

/** Summed across models: a session that switched models still has one total. */
function sessionTotals(modelUsage) {
  if (!modelUsage || typeof modelUsage !== 'object') {
    return null;
  }
  let input = 0;
  let output = 0;
  for (const model of Object.values(modelUsage)) {
    input += (model?.inputTokens ?? 0) + (model?.cacheCreationInputTokens ?? 0);
    output += model?.outputTokens ?? 0;
  }
  return input || output ? { input, output } : null;
}

/** The whole line: how the turn ended, how long it took, and what it used. */
export function describeTurn(event) {
  const bits = [`turn ended (${event?.subtype ?? 'done'})`];

  const duration = formatDuration(event?.duration_ms);
  if (duration) {
    bits.push(`in ${duration}`);
  }
  const usage = describeUsage(event);
  return usage.length ? `${bits.join(' ')} · ${usage.join(', ')}` : bits.join(' ');
}
