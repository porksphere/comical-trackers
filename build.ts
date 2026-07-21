/**
 * Build all trackers to self-contained CJS bundles Comical can load. Output uses the transient
 * `.build/<id>/dist/tracker.js` layout (gitignored) so `comical registry publish --trackers-dir
 * ./.build` discovers them; the published index.json + served bundles land at the repo root.
 * @comical/* is resolved via tsconfig paths (local link to ../comical for now).
 */
import { join } from "node:path";

const ROOT = import.meta.dir;

const trackers: Array<{ id: string; src: string }> = [
  { id: "anilist", src: "tracker.ts" },
  { id: "mal", src: "mal.ts" },
];

for (const { id, src } of trackers) {
  const result = await Bun.build({
    entrypoints: [join(ROOT, "src", src)],
    outdir: join(ROOT, ".build", id, "dist"),
    target: "browser",
    format: "cjs",
    naming: "tracker.js",
    minify: false,
    sourcemap: "external",
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new AggregateError(result.logs, `${id} tracker build failed`);
  }
  console.log(`✓ built → .build/${id}/dist/tracker.js`);
}
