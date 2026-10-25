// The SonarQube server side of a scan, shared by the runner daemon
// (tools/runner/runner.mjs, scanQuality) and `sonar.sh` (tools/quality/scan.mjs):
// the scanner's report-task.txt, a GET with the scanner's own token, and the wait
// for the server's analysis task. One place, so the two cannot drift (R584).
// Zero dependencies, like all of tools/.

/** A GET against the SonarQube server a scan just reported to, authorised with the scanner's own token. */
export function sonarAsker(serverUrl, token) {
  return async (path) => {
    const response = await fetch(`${serverUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) {
      throw new Error(`SonarQube answered ${response.status} to ${path.split('?')[0]}`);
    }
    return response.json();
  };
}

/**
 * Waits for a queued analysis to settle — shared by every scan path, BRANCH,
 * MAIN and PROJECT alike. Throws rather than reports: every caller runs
 * inside `scanQuality`'s own try/catch, which turns it into an error reading.
 */
export async function waitForAnalysis(ask, ceTaskId, deadline, timeoutSeconds) {
  let settled = null;
  while (Date.now() < deadline) {
    const { task: current } = await ask(`/api/ce/task?id=${encodeURIComponent(ceTaskId)}`);
    if (['SUCCESS', 'FAILED', 'CANCELED'].includes(current?.status)) {
      settled = current;
      break;
    }
    await new Promise((wake) => setTimeout(wake, 3000));
  }
  if (!settled) {
    throw new Error(`SonarQube had not finished analysing after ${timeoutSeconds}s.`);
  }
  if (settled.status !== 'SUCCESS') {
    throw new Error(settled.errorMessage ?? `SonarQube ${settled.status.toLowerCase()} the analysis.`);
  }
  return settled;
}

/** `key=value` lines — the shape of the scanner's `report-task.txt`. */
export function parseProperties(text) {
  const parsed = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) {
      parsed[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
  }
  return parsed;
}
