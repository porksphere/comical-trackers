/**
 * Publish this tracker repo as a Comical registry: emits `index.json` + the served bundles at the
 * repo root (commit them; Comical reads `<repo>/main/index.json` via raw.githubusercontent).
 * Uses the local comical CLI (../comical) — replace with `bunx comical` once it ships to npm.
 *
 *   COMICAL_BASE_URL=https://raw.githubusercontent.com/porksphere/comical-trackers/main \
 *     [COMICAL_KEY=registry.key.json] bun run publish:registry
 */
import { join } from "node:path";

const ROOT = import.meta.dir;
const cli = join(ROOT, "..", "comical", "packages", "cli", "src", "index.ts");
const baseUrl =
  process.env.COMICAL_BASE_URL ??
  "https://raw.githubusercontent.com/porksphere/comical-trackers/main";

const args = [
  "run", cli, "registry", "publish",
  "--trackers-dir", join(ROOT, ".build"),
  "--base-url", baseUrl,
  "--out", ROOT,
];
if (process.env.COMICAL_KEY) args.push("--key", process.env.COMICAL_KEY);

const proc = Bun.spawn(["bun", ...args], { stdout: "inherit", stderr: "inherit" });
process.exit(await proc.exited);
