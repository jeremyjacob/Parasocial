/**
 * Svelte 5 adapter for Zero (runes). We own this instead of a community
 * binding (PLAN §12). The main risk is leaked subscriptions, so every view
 * this creates is destroyed by the owning effect's teardown: when the query
 * changes, when the component unmounts, or when an enclosing `$effect.root`
 * is disposed. test/svelte-adapter.test.ts checks exactly that.
 *
 *   // +layout.svelte (once)
 *   setZero(zero);
 *
 *   // any component
 *   const scripts = useQuery(() => queries.scripts({ documentID }));
 *   {#each scripts.data ?? [] as s (s.id)} … {/each}
 *
 * Results are held in `$state.raw` (PLAN §9: large lists use raw state; Zero
 * already hands out immutable snapshots, so deep proxies would only cost).
 */
import { getContext, setContext, untrack } from "svelte";
import type { ReadonlyJSONValue, ResultType, TypedView } from "@rocicorp/zero";

/** The slice of the Zero client this adapter needs (lets tests use a fake). */
export interface ZeroLike {
  materialize(query: any, options?: { ttl?: any }): TypedView<any>;
}

export type QueryError = { error: string; id?: string; name?: string; message?: string; details?: ReadonlyJSONValue };

export type QueryState<T> = {
  /** Rows (array for plural queries, row | undefined for `.one()`), or undefined before the first result. */
  readonly data: T | undefined;
  /** "unknown" until the server has confirmed the result, then "complete" (or "error"). */
  readonly status: ResultType;
  readonly error: QueryError | undefined;
};

const ZERO_KEY = Symbol("parasocial.zero");

export function setZero<Z extends ZeroLike>(zero: Z): Z {
  return setContext(ZERO_KEY, zero);
}

export function getZero<Z extends ZeroLike = ZeroLike>(): Z {
  const z = getContext<Z | undefined>(ZERO_KEY);
  if (!z) throw new Error("No Zero instance in context: call setZero(zero) in a parent component");
  return z;
}

export type UseQueryOptions = {
  /** Zero instance; defaults to the one from `setZero`. */
  zero?: ZeroLike | undefined;
  /** How long rows stay cached after the last subscriber goes away (Zero TTL, e.g. "5m"). */
  ttl?: string | number | undefined;
};

/**
 * Subscribes to a Zero query. `query` is read inside an effect, so any `$state`
 * it touches (e.g. a documentID prop) re-subscribes when it changes. Return a
 * falsy value to subscribe to nothing.
 *
 * Must be called during component initialisation or inside `$effect.root`.
 */
export function useQuery<T = any>(query: () => unknown, options: UseQueryOptions = {}): QueryState<T> {
  const zero = options.zero ?? getZero();
  let data = $state.raw<T | undefined>(undefined);
  let status = $state.raw<ResultType>("unknown");
  let error = $state.raw<QueryError | undefined>(undefined);

  $effect.pre(() => {
    const q = query();
    if (!q) {
      data = undefined;
      status = "unknown";
      error = undefined;
      return;
    }
    const view = untrack(() => zero.materialize(q, options.ttl !== undefined ? { ttl: options.ttl } : undefined));
    data = view.data as T;
    status = "unknown";
    error = undefined;
    // Zero may call the listener synchronously with the current result.
    const off = view.addListener((d, rt, err) => {
      data = d as T;
      status = rt;
      error = err as QueryError | undefined;
    });
    return () => {
      off();
      view.destroy();
    };
  });

  return {
    get data() {
      return data;
    },
    get status() {
      return status;
    },
    get error() {
      return error;
    },
  };
}
