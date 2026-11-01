// R586 — one failed quality-gate condition in words. Shared by the MCP server
// (`quality_get`) and `sonar.sh` (tools/quality/scan.mjs) so the two cannot
// drift. Zero dependencies.

/** One failed gate condition, as SonarQube words it: `new_violations 1287 > 0`. A rating's step is its letter. */
export function describeCondition({ metric, comparator, threshold, actual }) {
  const letter = (step) => ('12345'.includes(step) && step.length === 1 ? 'ABCDE'['12345'.indexOf(step)] : step);
  if (metric.endsWith('_rating')) return `${metric} ${letter(actual)} worse than ${letter(threshold)}`;
  const symbol = { GT: '>', LT: '<', EQ: '=', NE: '!=' }[comparator] ?? comparator;
  return `${metric} ${actual} ${symbol} ${threshold}`;
}
