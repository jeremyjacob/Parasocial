// Client for the engine pool (used by the MCP tools on the app server).
export type PoolOp = { op: string; [k: string]: unknown };
export type PoolResult<T = unknown> = { ok: true; value: T } | { ok: false; error: string; timeout?: boolean };

export class PoolClient {
  constructor(
    private url = process.env.ENGINE_POOL_URL ?? "http://127.0.0.1:5190",
    private token = process.env.POOL_TOKEN,
  ) {}

  async run(job: { document: string; scripts: Record<string, string>; overrides?: Record<string, Record<string, string | number>>; units?: string; ops: PoolOp[] }): Promise<PoolResult<any>[]> {
    const res = await fetch(`${this.url}/v1/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(job),
    });
    const body = (await res.json().catch(() => ({}))) as { results?: PoolResult[]; error?: string };
    if (!res.ok || !body.results) throw new Error(`engine pool: ${body.error ?? res.status}`);
    return body.results;
  }
}
