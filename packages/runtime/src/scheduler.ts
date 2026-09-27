// Latest-wins regeneration (PLAN §9): at most one run per key; a new request replaces the
// queued one; when the current run finishes it jumps straight to the latest request.
// Never cancels a running job (terminating the worker is only for timeouts).

export class LatestWins<Req, Res> {
  private running = new Map<string, Promise<void>>();
  private queued = new Map<string, { req: Req; waiters: ((r: Res | null) => void)[] }>();
  constructor(private run: (req: Req) => Promise<Res> | Res) {}

  /**
   * Request a run for `key`. Resolves with the result of the run that satisfied it, or with
   * `null` if a newer request superseded it before it started.
   */
  request(key: string, req: Req): Promise<Res | null> {
    return new Promise((resolve) => {
      const q = this.queued.get(key);
      if (q) {
        // supersede: earlier waiters get null, the latest request takes the slot
        for (const w of q.waiters) w(null);
        this.queued.set(key, { req, waiters: [resolve] });
      } else this.queued.set(key, { req, waiters: [resolve] });
      if (!this.running.has(key)) this.pump(key);
    });
  }

  isBusy(key?: string) {
    return key ? this.running.has(key) : this.running.size > 0;
  }

  private pump(key: string) {
    const next = this.queued.get(key);
    if (!next) {
      this.running.delete(key);
      return;
    }
    this.queued.delete(key);
    const p = (async () => {
      let res: Res | null = null;
      try {
        res = await this.run(next.req);
      } catch (e) {
        for (const w of next.waiters) w(null);
        throw e;
      }
      for (const w of next.waiters) w(res);
    })()
      .catch(() => {})
      .finally(() => this.pump(key));
    this.running.set(key, p);
  }
}
