// Batching a session's transcript for the platform, without losing a batch
// the network would not carry — R255.
//
// A batch that failed to send used to be spliced out of the pending queue
// before the send was even awaited, on the theory that "a dropped line is not
// worth failing a run over". True for one flaky beat; false for a laptop that
// loses Wi-Fi for two minutes, where every line the session produced during
// the gap went missing for good, with nothing in the transcript to say a gap
// had happened at all.
//
// Pure of the network and the daemon on purpose: `send(lines)` is the one
// edge this class touches, so the retry, the backoff and the ordering can be
// tested without a socket, a runner, or a platform to talk to. `runner.mjs`
// supplies the real `send` (a POST to `/output`) and the daemon-only tee to
// the attached terminal.

/**
 * @param {(lines: object[]) => Promise<unknown>} send POSTs a batch, in
 *   order; rejects on failure. Called with at most `max` lines.
 * @param {{every?: number, max?: number, maxRetryDelay?: number,
 *   onRetry?: (info: {lines: object[], delayMs: number, failure: Error}) => void}} [opts]
 *   `onRetry` is told about a failed send before the backoff timer is set —
 *   the daemon uses it to log; a test uses it to assert without waiting out
 *   real delays.
 */
export class TranscriptBatch {
  constructor(send, { every = 400, max = 100, maxRetryDelay = 20_000, onRetry } = {}) {
    this.send_ = send;
    this.every = every;
    this.max = max;
    this.maxRetryDelay = maxRetryDelay;
    this.onRetry = onRetry ?? (() => {});
    this.pending = [];
    this.sending = null;
    this.timer = null;
    this.retryDelay = every;
  }

  /** Queues one line, flushing immediately once `max` is reached. */
  push(line) {
    this.pending.push(line);
    if (this.pending.length >= this.max) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.every);
      this.timer.unref?.();
    }
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // One request at a time: awaiting the previous send is what keeps the
    // transcript in the order the session produced it, whether that send
    // succeeded or is about to be retried.
    this.sending = (this.sending ?? Promise.resolve()).then(() => this.send());
    await this.sending;
  }

  async send() {
    if (!this.pending.length) return;
    // A snapshot, not the live array: `push()` can append more lines while
    // this request is in flight, and those belong to the NEXT send, not this
    // one — splicing by count below removes exactly what was sent, whatever
    // arrived after it.
    const count = this.pending.length;
    const lines = this.pending.slice(0, count);
    try {
      await this.send_(lines);
      this.pending.splice(0, count);
      this.retryDelay = this.every;
    } catch (failure) {
      // Left in `pending` on purpose — see the module doc. Backed off rather
      // than hammered: a real outage does not clear in one beat, and there is
      // no point spending every one of them on a request that will fail the
      // same way.
      const delayMs = this.retryDelay;
      this.onRetry({ lines, delayMs, failure });
      this.retryDelay = Math.min(this.retryDelay * 2, this.maxRetryDelay);
      if (!this.timer) {
        this.timer = setTimeout(() => void this.flush(), delayMs);
        this.timer.unref?.();
      }
    }
  }
}
