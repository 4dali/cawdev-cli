// Code-unit order: what Array#sort does to strings by default and what Java's
// String.compareTo does, said out loud. Never localeCompare here: ICU weighs
// `-`, `.` and `_` differently, and an export must not churn (R315) nor a
// refusal reorder its paths.
export function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
