// STUB engine pool (see Dockerfile). Replace in M5.
const port = Number(process.env.PORT ?? 4000);
Bun.serve({
  port,
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/health") return Response.json({ ok: true, stub: true });
    return Response.json({ error: "engine-pool is a stub (M5)" }, { status: 501 });
  },
});
console.log(`engine-pool STUB listening on :${port}`);
