// Per-op cache (PLAN §4): each op's output B-rep, topology, history and lazily built names,
// keyed by hash(op inputs). A change only reruns ops downstream of it. Records not touched
// for `keepGenerations` regenerations are released.
import { releaseRecord, type OpRecord } from "./record";

export class OpCache {
  private map = new Map<string, OpRecord>();
  private gen = 0;
  hits = 0;
  misses = 0;
  constructor(public keepGenerations = 3) {}

  /** Start a regeneration; returns its generation number. */
  begin(): number {
    this.hits = 0;
    this.misses = 0;
    return ++this.gen;
  }

  get(key: string): OpRecord | undefined {
    const r = this.map.get(key);
    if (r && !r._released) {
      r._gen = this.gen;
      this.hits++;
      return r;
    }
    this.misses++;
    return undefined;
  }

  put(r: OpRecord) {
    r._gen = this.gen;
    const prev = this.map.get(r.key);
    if (prev && prev !== r) releaseRecord(prev);
    this.map.set(r.key, r);
  }

  /** Release records unused for `keepGenerations` regenerations, except those in `pin`. */
  sweep(pin: Set<OpRecord> = new Set()) {
    for (const [k, r] of this.map) {
      if (pin.has(r)) continue;
      if (this.gen - (r._gen ?? 0) >= this.keepGenerations) {
        releaseRecord(r);
        this.map.delete(k);
      }
    }
  }

  clear() {
    for (const r of this.map.values()) releaseRecord(r);
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }
}
