/**
 * AniList tracker — syncs manga reading progress to https://anilist.co
 *
 * Authentication: OAuth 2.0 implicit grant (AniList has no PKCE support, so an
 * authorization-code exchange would require a client secret; the implicit grant needs none).
 * Register one app at https://anilist.co/settings/developer, set ANILIST_CLIENT_ID below, and set
 * the app's "Redirect URL" to the Comical app's own static OAuth relay page (see the comment on
 * ANILIST_CLIENT_ID). AniList redirects the token there and the relay hands it straight back into
 * the app (custom-scheme deep link on native, postMessage on web), so nothing is ever copy-pasted.
 *
 * All API calls use the single GraphQL endpoint (POST https://graphql.anilist.co).
 * The rate limit is 90 req/min per IP; 1 req/700 ms keeps well inside that.
 */
import {
  TrackerBase,
  defineTracker,
  defineSettings,
  type InferSettings,
  type PagedRequest,
  type PagedResults,
  type SettingDescriptor,
  type TrackerEntryUpdate,
  type TrackerInfo,
  type TrackerLibraryEntry,
  type TrackerSearchResult,
  type TrackerStatus,
  nextPageCursor,
  pageFromCursor,
} from "@comical/sdk";

const GQL_ENDPOINT = "https://graphql.anilist.co";
const PER_PAGE = 50;

// Register once at https://anilist.co/settings/developer. The app for this client id MUST have its
// "Redirect URL" set to exactly the relay page below — AniList's implicit grant takes the redirect
// from the app's *settings*, NOT from a `redirect_uri` query param (see the authUrl note):
//
//     https://porksphere.github.io/comical-app/oauth-relay.html
//
// AniList only redirects an implicit token to a registered **https** URL — a custom `comical://`
// scheme is rejected — so we register the Comical app's own static relay page (served from its web
// deploy). AniList lands there with the token in the URL fragment, and the relay bounces it back
// into the app: to the `comical://` scheme inside the native in-app auth session, or via postMessage
// to the opener on web. One registered https URL serves every platform, with no client secret and no
// copy-paste. Keep it byte-for-byte identical to the AniList app setting AND the relay's deployed path.
const ANILIST_CLIENT_ID = "43038";

const SETTINGS = defineSettings([
  {
    type: "oauth-pin",
    key: "token",
    label: "AniList Account",
    description: "Sign in to AniList to sync your reading progress.",
    required: true,
    // Implicit grant (`response_type=token`): AniList returns a long-lived access token directly in
    // the redirect's URL fragment — no code exchange, so no client secret (which we deliberately
    // don't ship). The client recognises an implicit-grant oauth-pin and captures the fragment token
    // via an in-app auth session (native) or a popup (web) instead of a copy-paste box.
    //
    // NB: the implicit grant takes NO `redirect_uri` query param — AniList redirects to whatever is
    // configured in the app's settings (the relay page; see ANILIST_CLIENT_ID above). Passing a
    // `redirect_uri` here is a *code*-grant parameter and makes AniList reject the request with
    // `unsupported_grant_type`. So this URL is only `client_id` + `response_type=token`. (We also do
    // NOT use AniList's `/oauth/pin` page — its front end runs a secret-based code exchange.)
    authUrl:
      "https://anilist.co/api/v2/oauth/authorize" +
      `?client_id=${ANILIST_CLIENT_ID}` +
      "&response_type=token",
  },
]);
type Settings = InferSettings<typeof SETTINGS>;

// ── Status mapping ────────────────────────────────────────────────────────────

type AniListStatus = "CURRENT" | "PLANNING" | "COMPLETED" | "DROPPED" | "PAUSED" | "REPEATING";

const TO_TRACKER: Readonly<Record<AniListStatus, TrackerStatus>> = {
  CURRENT: "reading",
  PLANNING: "planning",
  COMPLETED: "completed",
  DROPPED: "dropped",
  PAUSED: "on_hold",
  REPEATING: "rereading",
};

const FROM_TRACKER: Readonly<Record<TrackerStatus, AniListStatus>> = {
  reading: "CURRENT",
  planning: "PLANNING",
  completed: "COMPLETED",
  dropped: "DROPPED",
  on_hold: "PAUSED",
  rereading: "REPEATING",
};

/**
 * Split the contract's `YYYY-MM-DD` into AniList's `FuzzyDateInput`. The shape is deliberately
 * loose on AniList's side (any component may be null), but the contract's schema guarantees all
 * three here, so this is a pure reshape.
 */
function fuzzyDate(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return { year, month, day };
}

// ── Wire DTOs ─────────────────────────────────────────────────────────────────

interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface MediaTitle {
  romaji: string;
  english: string | null;
}

interface CoverImage {
  medium: string | null;
}

interface Media {
  id: number;
  title: MediaTitle;
  coverImage: CoverImage;
  description: string | null;
  /** AniList's own chapter count. Null while a series is ongoing or simply unrecorded. */
  chapters?: number | null;
}

interface MediaListEntry {
  media: Media;
  status: AniListStatus;
  progress: number;
  score: number;
}

interface PageInfo {
  hasNextPage: boolean;
}

// ── Tracker class ─────────────────────────────────────────────────────────────

class AniListTracker extends TrackerBase<Settings> {
  readonly info: TrackerInfo = {
    id: "anilist",
    name: "AniList",
    version: "0.1.5",
    contractVersion: "1.0.0",
    capabilities: ["library-sync", "status-sync", "search", "settings"],
    rateLimit: { maxConcurrent: 1, minIntervalMs: 700 },
  };

  // Cached after first successful Viewer query — safe because the instance is reused
  // per server session and invalidated when settings change.
  private viewerId: number | undefined;

  override getSettings(): SettingDescriptor[] {
    return [...SETTINGS];
  }

  private authHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${this.requireString("token")}`,
    };
  }

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.request({
      url: GQL_ENDPOINT,
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ query, variables }),
    });

    // Always try to parse the body — AniList puts useful error details in it even on 4xx.
    let parsed: GqlResponse<T> | undefined;
    try { parsed = JSON.parse(res.body) as GqlResponse<T>; } catch { /* fall through */ }

    if (res.status === 401) throw new Error("AniList: invalid or expired access token");
    if (res.status >= 400) {
      const detail = parsed?.errors?.map((e) => e.message).join("; ");
      throw new Error(`AniList error ${res.status}${detail ? `: ${detail}` : `: ${res.statusText}`}`);
    }

    if (parsed?.errors?.length) {
      throw new Error(`AniList: ${parsed.errors.map((e) => e.message).join("; ")}`);
    }
    if (!parsed?.data) throw new Error("AniList: empty response data");
    return parsed.data;
  }

  private async getViewerId(): Promise<number> {
    if (this.viewerId !== undefined) return this.viewerId;
    const data = await this.gql<{ Viewer: { id: number } }>(
      `query { Viewer { id } }`,
      {},
    );
    this.viewerId = data.Viewer.id;
    return this.viewerId;
  }

  // ── library-sync ──────────────────────────────────────────────────────────

  async getLibrary(req: PagedRequest = {}): Promise<PagedResults<TrackerLibraryEntry>> {
    // AniList's Page type is page-numbered and reports hasNextPage, so the cursor is a page number.
    const page = pageFromCursor(req.cursor);
    const userId = await this.getViewerId();
    const data = await this.gql<{
      Page: { pageInfo: PageInfo; mediaList: MediaListEntry[] };
    }>(
      `query ($userId: Int, $page: Int, $perPage: Int) {
        Page(page: $page, perPage: $perPage) {
          pageInfo { hasNextPage }
          mediaList(userId: $userId, type: MANGA, sort: [UPDATED_TIME_DESC]) {
            media {
              id
              title { romaji english }
              coverImage { medium }
              description(asHtml: false)
              chapters
            }
            status
            progress
            score(format: POINT_100)
          }
        }
      }`,
      { userId, page, perPage: PER_PAGE },
    );

    const items: TrackerLibraryEntry[] = data.Page.mediaList.map((entry) => {
      const title = entry.media.title.english ?? entry.media.title.romaji;
      const item: TrackerLibraryEntry = {
        externalId: entry.media.id,
        title,
        status: TO_TRACKER[entry.status] ?? "planning",
      };
      if (entry.progress > 0) item.chaptersRead = entry.progress;
      // Only meaningful when AniList actually knows the count — it reports null for ongoing series.
      if (entry.media.chapters && entry.media.chapters > 0) item.totalChapters = entry.media.chapters;
      if (entry.media.coverImage.medium) item.thumbnailUrl = entry.media.coverImage.medium;
      return item;
    });

    return { items, nextCursor: nextPageCursor(page, data.Page.pageInfo.hasNextPage) };
  }

  // ── status-sync ───────────────────────────────────────────────────────────

  async updateEntry(externalId: string | number, update: TrackerEntryUpdate): Promise<void> {
    const mediaId = typeof externalId === "string" ? parseInt(externalId, 10) : externalId;
    const vars: Record<string, unknown> = { mediaId };

    if (update.status !== undefined) vars.status = FROM_TRACKER[update.status];
    // AniList progress is integer chapters; floor decimal chapter numbers
    if (update.chaptersRead !== undefined) vars.progress = Math.floor(update.chaptersRead);
    // AniList score is 0–100 on POINT_100 format, matching the contract's 0–100 range
    if (update.score !== undefined) vars.score = update.score;
    if (update.notes !== undefined) vars.notes = update.notes;
    // AniList models reading dates as FuzzyDateInput — each component independently nullable — so
    // the contract's `YYYY-MM-DD` splits into it directly. Note the naming: the mutation's finish
    // date is `completedAt`, not `finishedAt`.
    if (update.startedAt !== undefined) vars.startedAt = fuzzyDate(update.startedAt);
    if (update.finishedAt !== undefined) vars.completedAt = fuzzyDate(update.finishedAt);

    await this.gql<{ SaveMediaListEntry: { id: number } }>(
      `mutation ($mediaId: Int, $status: MediaListStatus, $progress: Int, $score: Float, $notes: String,
                 $startedAt: FuzzyDateInput, $completedAt: FuzzyDateInput) {
        SaveMediaListEntry(mediaId: $mediaId, status: $status, progress: $progress, score: $score, notes: $notes,
                           startedAt: $startedAt, completedAt: $completedAt) {
          id
        }
      }`,
      vars,
    );
  }

  // ── search ────────────────────────────────────────────────────────────────

  async search(query: string, req: PagedRequest = {}): Promise<PagedResults<TrackerSearchResult>> {
    const page = pageFromCursor(req.cursor);
    const data = await this.gql<{
      Page: { pageInfo: PageInfo; media: Media[] };
    }>(
      `query ($search: String, $page: Int, $perPage: Int) {
        Page(page: $page, perPage: $perPage) {
          pageInfo { hasNextPage }
          media(search: $search, type: MANGA, sort: SEARCH_MATCH) {
            id
            title { romaji english }
            coverImage { medium }
            description(asHtml: false)
          }
        }
      }`,
      { search: query, page, perPage: 20 },
    );

    const items: TrackerSearchResult[] = data.Page.media.map((m) => {
      const title = m.title.english ?? m.title.romaji;
      const item: TrackerSearchResult = { externalId: m.id, title };
      if (m.coverImage.medium) item.thumbnailUrl = m.coverImage.medium;
      // Strip HTML tags from description and truncate
      if (m.description) {
        item.description = m.description.replace(/<[^>]*>/g, "").slice(0, 300);
      }
      return item;
    });

    return { items, nextCursor: nextPageCursor(page, data.Page.pageInfo.hasNextPage) };
  }
}

export default defineTracker((host) => new AniListTracker(host));
