// Small dense linear algebra for the solver: systems here have tens of unknowns at most.

/** Solve the symmetric positive-definite system A x = b (A is n×n row-major, overwritten). Null if not SPD. */
export function solveSPD(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  // Cholesky: A = L Lᵀ, L in the lower triangle of A
  for (let j = 0; j < n; j++) {
    let d = A[j * n + j];
    for (let k = 0; k < j; k++) d -= A[j * n + k] ** 2;
    if (!(d > 0)) return null;
    const l = Math.sqrt(d);
    A[j * n + j] = l;
    for (let i = j + 1; i < n; i++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= A[i * n + k] * A[j * n + k];
      A[i * n + j] = s / l;
    }
  }
  const x = new Float64Array(b);
  for (let i = 0; i < n; i++) {
    let s = x[i];
    for (let k = 0; k < i; k++) s -= A[i * n + k] * x[k];
    x[i] = s / A[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i];
    for (let k = i + 1; k < n; k++) s -= A[k * n + i] * x[k];
    x[i] = s / A[i * n + i];
  }
  return x;
}

/** Numerical rank of an m×n row-major matrix (Gaussian elimination with full pivoting). */
export function rank(M: Float64Array, m: number, n: number, tol = 1e-8): number {
  const A = new Float64Array(M);
  let max = 0;
  for (const v of A) max = Math.max(max, Math.abs(v));
  if (max === 0) return 0;
  const eps = tol * max;
  const rows = [...Array(m).keys()];
  const cols = [...Array(n).keys()];
  let r = 0;
  for (; r < Math.min(m, n); r++) {
    let bi = -1,
      bj = -1,
      bv = eps;
    for (let i = r; i < m; i++)
      for (let j = r; j < n; j++) {
        const v = Math.abs(A[rows[i] * n + cols[j]]);
        if (v > bv) (bv = v), (bi = i), (bj = j);
      }
    if (bi < 0) break;
    [rows[r], rows[bi]] = [rows[bi], rows[r]];
    [cols[r], cols[bj]] = [cols[bj], cols[r]];
    const p = A[rows[r] * n + cols[r]];
    for (let i = r + 1; i < m; i++) {
      const f = A[rows[i] * n + cols[r]] / p;
      if (!f) continue;
      for (let j = r; j < n; j++) A[rows[i] * n + cols[j]] -= f * A[rows[r] * n + cols[j]];
    }
  }
  return r;
}
