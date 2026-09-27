// Scoped cleanup of embind objects. OCCT handles must be `delete()`d explicitly.
// Temporaries (gp_Pnt, builders, adaptors) go into the current arena and are freed
// when the scope ends; long-lived shapes are owned by the op cache instead.

type Deletable = { delete(): void; isDeleted?(): boolean };

export class Arena {
  private items: Deletable[] = [];
  track<T>(obj: T): T {
    if (obj && typeof (obj as any).delete === "function") this.items.push(obj as any);
    return obj;
  }
  dispose() {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const o = this.items[i];
      try {
        if (!o.isDeleted?.()) o.delete();
      } catch {}
    }
    this.items.length = 0;
  }
  get size() {
    return this.items.length;
  }
}

const stack: Arena[] = [];

/** Register a temporary with the innermost arena (no-op outside a scope, so it leaks: always scope). */
export function tmp<T>(obj: T): T {
  const a = stack[stack.length - 1];
  return a ? a.track(obj) : obj;
}

export function scoped<T>(fn: () => T): T {
  const a = new Arena();
  stack.push(a);
  try {
    return fn();
  } finally {
    stack.pop();
    a.dispose();
  }
}

/** Enter a long-lived arena (e.g. one regeneration). Returns a disposer. */
export function enterArena(a: Arena) {
  stack.push(a);
  return () => {
    const i = stack.lastIndexOf(a);
    if (i >= 0) stack.splice(i, 1);
  };
}
