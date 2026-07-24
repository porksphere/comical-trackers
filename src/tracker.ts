/**
 * AniList tracker — syncs manga reading progress to https://anilist.co
 *
 * Authentication: OAuth 2.0 implicit grant (AniList has no PKCE support, so an
 * authorization-code exchange would require a client secret; the implicit grant needs none).
 * Register one app at https://anilist.co/settings/developer, set ANILIST_CLIENT_ID below, and
 * leave the app's redirect URI unset — AniList then redirects to its own token-display page,
 * where the user copies the token back into Comical.
 *
 * All API calls use the single GraphQL endpoint (POST https://graphql.anilist.co).
 * The rate limit is 90 req/min per IP; 1 req/700 ms keeps well inside that.
 */
import {
  TrackerBase,
  defineTracker,
  defineSettings,
  type InferSettings,
  type PagedResults,
  type SettingDescriptor,
  type TrackerEntryUpdate,
  type TrackerInfo,
  type TrackerLibraryEntry,
  type TrackerSearchResult,
  type TrackerStatus,
} from "@comical/sdk";

const GQL_ENDPOINT = "https://graphql.anilist.co";
const PER_PAGE = 50;

// Register once at https://anilist.co/settings/developer — no redirect URI needed for the
// implicit grant (AniList defaults to its own token-display page when none is set).
const ANILIST_CLIENT_ID = "43038";

const SETTINGS = defineSettings([
  {
    type: "oauth-pin",
    key: "token",
    label: "AniList Account",
    description:
      "Open AniList, authorize Comical, then paste the token AniList shows you back here.",
    required: true,
    // Pin the redirect to AniList's own token-display page explicitly, rather than relying on the
    // developer app's default registered redirect URI. Omitting it makes AniList fall back to
    // whatever redirect is registered for client 43038 — and if that's ever pointed at a custom
    // scheme (e.g. the app's `comical://oauth-callback/...` deep link), the browser can't render it
    // and the paste flow breaks. Being explicit keeps the oauth-pin flow working regardless.
    authUrl:
      "https://anilist.co/api/v2/oauth/authorize" +
      `?client_id=${ANILIST_CLIENT_ID}` +
      "&response_type=token" +
      `&redirect_uri=${encodeURIComponent("https://anilist.co/api/v2/oauth/pin")}`,
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
    version: "0.1.1",
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

  async getLibrary(page: number): Promise<PagedResults<TrackerLibraryEntry>> {
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
      if (entry.media.coverImage.medium) item.thumbnailUrl = entry.media.coverImage.medium;
      return item;
    });

    return { items, page, hasNextPage: data.Page.pageInfo.hasNextPage };
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

    await this.gql<{ SaveMediaListEntry: { id: number } }>(
      `mutation ($mediaId: Int, $status: MediaListStatus, $progress: Int, $score: Float, $notes: String) {
        SaveMediaListEntry(mediaId: $mediaId, status: $status, progress: $progress, score: $score, notes: $notes) {
          id
        }
      }`,
      vars,
    );
  }

  // ── search ────────────────────────────────────────────────────────────────

  async search(query: string, page: number): Promise<PagedResults<TrackerSearchResult>> {
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

    return { items, page, hasNextPage: data.Page.pageInfo.hasNextPage };
  }
}

export default defineTracker((host) => new AniListTracker(host));
