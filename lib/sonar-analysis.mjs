// The SonarQube server side of a scan, shared by the runner daemon
// (tools/runner/runner.mjs, scanQuality) and `sonar.sh` (tools/quality/scan.mjs):
// the scanner's report-task.txt, a GET with the scanner's own token, and the wait
// for the server's analysis task. One place, so the two cannot drift (R584).
// Zero dependencies, like all of tools/.

export const SONAR_REQUEST_TIMEOUT_MS = 30_000;

const isAbort = (error) =>
  ['TimeoutError', 'AbortError'].includes(error?.name) || ['TimeoutError', 'AbortError'].includes(error?.cause?.name);

/**
 * A GET against the SonarQube server a scan just reported to, authorised with the
 * scanner's own token. Every request is bounded (R622): by `requestTimeoutMs`, by
 * the asker's `deadline`, and by a per-call `timeoutMs`, whichever is smallest.
 * A cut-off request throws an error with `code === 'SONAR_TIMEOUT'`, and
 * `byDeadline` true when the deadline or the per-call limit set the limit.
 */
export function sonarAsker(serverUrl, token, { requestTimeoutMs = SONAR_REQUEST_TIMEOUT_MS, deadline = Infinity } = {}) {
  return async (path, { timeoutMs } = {}) => {
    const pathOnly = path.split('?')[0];
    const left = Math.min(deadline - Date.now(), timeoutMs ?? Infinity);
    const byDeadline = left < requestTimeoutMs;
    const limit = Math.max(1, Math.min(requestTimeoutMs, left));
    try {
      const response = await fetch(`${serverUrl}${path}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(limit),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`SonarQube answered ${response.status} to ${pathOnly}`);
      }
      return await response.json();
    } catch (error) {
      if (!isAbort(error)) {
        throw error;
      }
      const timeout = new Error(
        byDeadline
          ? `SonarQube did not answer ${pathOnly} before the reading's time ran out`
          : `SonarQube did not answer ${pathOnly} within ${Math.ceil(limit / 1000)}s`,
      );
      timeout.code = 'SONAR_TIMEOUT';
      timeout.limitMs = limit;
      timeout.byDeadline = byDeadline;
      throw timeout;
    }
  };
}

/**
 * Waits for a queued analysis to settle — shared by every scan path, BRANCH,
 * MAIN and PROJECT alike. Throws rather than reports: every caller runs
 * inside `scanQuality`'s own try/catch, which turns it into an error reading.
 * Each poll is limited to the time left (R622), so one unanswered request
 * cannot outlive the deadline.
 */
export async function waitForAnalysis(ask, ceTaskId, deadline, timeoutSeconds) {
  let settled = null;
  while (Date.now() < deadline) {
    let current;
    try {
      ({ task: current } = await ask(`/api/ce/task?id=${encodeURIComponent(ceTaskId)}`, {
        timeoutMs: deadline - Date.now(),
      }));
    } catch (error) {
      if (error?.code === 'SONAR_TIMEOUT' && error.byDeadline) {
        break;
      }
      throw error;
    }
    if (['SUCCESS', 'FAILED', 'CANCELED'].includes(current?.status)) {
      settled = current;
      break;
    }
    await new Promise((wake) => setTimeout(wake, Math.min(3000, Math.max(0, deadline - Date.now()))));
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
