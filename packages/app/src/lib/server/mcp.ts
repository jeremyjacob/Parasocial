import { createMcp, type Mcp } from "@parasocial/mcp/server";
import { platform } from "./platform";

let m: Promise<Mcp> | null = null;
export function mcp(): Promise<Mcp> {
  return (m ??= platform().then((p) => createMcp({ db: p.db, store: p.store, config: { appOrigin: p.config.appOrigin, secret: p.config.secret } })));
}
