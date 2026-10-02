// Client for the engine pool (used by the MCP tools on the app server).
export type PoolOp = { op: string; [k: string]: unknown };
export type PoolResult<T = unknown> = { ok: true; value: T } | { ok: false; error: string; timeout?: boolean };
export type PoolHealth = { reachable: boolean; documents?: number; build?: string; ms: number; error?: string };

/** The pool couldn't run a job at all (unreachable, an error status, a reply that isn't its JSON): nothing about the request itself. */
export class EngineUnavailable extends Error {
  constructor(public reason: string) {
    super(`geometry engine unavailable (${reason}): retry shortly; this is not a problem with your request`);
  }
}

const why = (e: unknown) => (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timed out" : `unreachable: ${(e as Error)?.message ?? e}`);

export class PoolClient {
  constructor(
    private url = process.env.ENGINE_POOL_URL ?? "http://127.0.0.1:5190",
    private token = process.env.POOL_TOKEN,
  ) {}

  /** One result per op (per-op failures are results, not throws); EngineUnavailable when the job didn't run. */
  async run(job: { document: string; scripts: Record<string, string>; overrides?: Record<string, Record<string, string | number>>; units?: string; ops: PoolOp[] }): Promise<PoolResult<any>[]> {
    let res: Response, raw: string;
    try {
      res = await fetch(`${this.url}/v1/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify(job),
      });
      raw = await res.text();
    } catch (e) {
      throw new EngineUnavailable(why(e));
    }
    let body: { results?: PoolResult[]; error?: string };
    try {
      body = JSON.parse(raw);
    } catch {
      throw new EngineUnavailable(`HTTP ${res.status}, not JSON: ${raw.slice(0, 80).trim() || "empty"}`);
    }
    if (!res.ok || !Array.isArray(body.results)) throw new EngineUnavailable(`HTTP ${res.status}${body.error ? `: ${body.error}` : ""}`);
    return body.results;
  }

  /** The pool's /health: reachable, documents loaded, engine build. Never throws. */
  async health(timeoutMs = 3000): Promise<PoolHealth> {
    const t = performance.now();
    const ms = () => Math.round(performance.now() - t);
    try {
      const res = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      const body = (await res.json().catch(() => null)) as { documents?: number; build?: string } | null;
      if (!res.ok || !body) return { reachable: false, ms: ms(), error: `HTTP ${res.status}${body ? "" : ", not JSON"}` };
      return { reachable: true, documents: body.documents, build: body.build, ms: ms() };
    } catch (e) {
      return { reachable: false, ms: ms(), error: why(e) };
    }
  }
}
