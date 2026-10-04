// Starts Stage: the panel and local API on PORT (default 3000, or the next free port when PORT isn't set explicitly),
// and the overlay (Onstage's voice and drawings, Backstage's agent widgets).
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { startPanel } from "./server.ts";

/**
 * where this launch tells its clients (Oni, the overlay) how to reach it: {port, token, pid}, readable by this user only.
 * The token is new every launch: every API route and the overlay socket require it, so another local process or a
 * sandboxed app can't start agents or get the screen described through Stage. Override with STAGE_SERVER_FILE.
 */
export const SERVER_FILE = process.env.STAGE_SERVER_FILE ?? join(homedir(), "Library", "Application Support", "Stage", "server.json");

const token = randomBytes(24).toString("base64url");
const explicitPort = process.env.PORT !== undefined;
const first = Number(process.env.PORT ?? 3000);
let server: ReturnType<typeof startPanel> | undefined;
// with PORT set, that port or nothing: a silent move to another port would leave whoever was told PORT looking at a
// dead (or someone else's) port
for (let port = first; port < (explicitPort ? first + 1 : first + 10) && !server; port++) {
  try {
    server = startPanel(port, token);
  } catch (e: any) {
    if (e?.code !== "EADDRINUSE") throw e;
    console.log(`port ${port} is in use${explicitPort ? "" : `, trying ${port + 1}…`}`);
  }
}
if (!server) {
  console.error(explicitPort
    ? `port ${first} is taken: stop whatever is using it (lsof -iTCP:${first} -sTCP:LISTEN) or pick another PORT`
    : `no free port between ${first} and ${first + 9}: stop the other Stage (pkill -f "src/main.ts") or set PORT`);
  process.exit(1);
}

mkdirSync(dirname(SERVER_FILE), { recursive: true, mode: 0o700 });
writeFileSync(SERVER_FILE, JSON.stringify({ port: server.port, token, pid: process.pid }), { mode: 0o600 });
chmodSync(SERVER_FILE, 0o600); // an older file keeps its old mode on overwrite
const cleanUp = () => { try { rmSync(SERVER_FILE, { force: true }); } catch { /* gone */ } process.exit(0); };
process.on("SIGINT", cleanUp);
process.on("SIGTERM", cleanUp);

console.log(`Stage panel  http://127.0.0.1:${server.port}/?token=${token}`);
console.log(`Stage server file: ${SERVER_FILE}`);
// the overlay reads the token from SERVER_FILE itself (never from its arguments, which other processes can see)
const overlay = join(import.meta.dir, "..", "overlay", "build", "Stage Overlay.app");
if (process.env.OVERLAY !== "off" && existsSync(overlay)) {
  Bun.spawn(["open", "-g", overlay, "--args", "--port", String(server.port)]);
  console.log("Onstage: hold Control + Option to talk, tap it to type (overlay in the menu bar)");
} else if (!existsSync(overlay)) console.log("Onstage and the agent widgets need the overlay: build it once with  bash scripts/build-overlay.sh");
console.log(`TypeSafe key ${process.env.TYPESAFE_API_KEY ? "set" : "MISSING"} · Anthropic key ${process.env.ANTHROPIC_API_KEY ? "set" : "MISSING"}`);
