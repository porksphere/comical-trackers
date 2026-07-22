# comical-trackers

Tracker implementations for [Comical](https://github.com/porksphere/comical) — sync manga reading
progress to third-party tracking services. Published as a Comical registry: point the app at this
repo's raw `index.json` and it can install trackers directly from GitHub, no separate hosting
needed.

## Use this registry in the app

**One-click (if you already have the Comical app installed):**
[Add the tracker registry](https://porksphere.github.io/comical-app/add-registry?url=https%3A%2F%2Fraw.githubusercontent.com%2Fporksphere%2Fcomical-trackers%2Fmain%2Findex.json)

Or point the app at the registry's `index.json` manually:

```
https://raw.githubusercontent.com/porksphere/comical-trackers/main/index.json
```

Set it as `EXPO_PUBLIC_COMICAL_REGISTRY` in the app's gitignored `apps/mobile/.env.local` (dev
pre-adds a single registry), or add it from the app's registry settings. For the desktop CLI:
`comical registry add https://raw.githubusercontent.com/porksphere/comical-trackers/main/index.json`.

## Trackers

| Tracker | Service | Auth |
|---------|---------|------|
| `anilist` | [AniList](https://anilist.co) | OAuth implicit grant — connect, then paste the token AniList shows you |
| `mal` | [MyAnimeList](https://myanimelist.net) | OAuth 2.0 with PKCE — fully automatic, no manual steps |

Both sync reading status, progress, and score, and support searching each service's catalog to
link an existing entry.

## Development

Requires the sibling [`comical`](https://github.com/porksphere/comical) repo checked out at
`../comical` (trackers resolve `@comical/*` via local `tsconfig` paths — no published package
yet).

```
bun run build              # bundle both trackers to .build/<id>/dist/tracker.js
COMICAL_BASE_URL=https://raw.githubusercontent.com/porksphere/comical-trackers/main \
  bun run publish:registry # regenerate index.json + trackers/<id>/<version>/tracker.js
```

Commit the regenerated `index.json` and `trackers/` output — that's what the registry actually
serves.

## Adding a tracker

Implement the `Tracker` interface from `@comical/sdk` (see `src/tracker.ts` or `src/mal.ts` for a
complete example), add it to `build.ts`, then publish. If the service supports PKCE, prefer an
`oauth-callback` setting with `exchange.pkce: true` — fully automatic, no client secret. If it
doesn't, an `oauth-pin` setting with no `exchange` falls back to an implicit-grant flow where the
user pastes a token manually. Either way, **never hardcode a client secret** — a tracker bundle
ships to every user's device/browser, so anything embedded in it is public.
