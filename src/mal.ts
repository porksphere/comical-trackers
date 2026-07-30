/**
 * MyAnimeList tracker — syncs manga reading progress to https://myanimelist.net
 *
 * Authentication: OAuth 2.0 with PKCE (plain method). Register one app at
 * https://myanimelist.net/apiconfig (choose "Other" type) and set MAL_CLIENT_ID below.
 * Users just click "Connect MAL" — no credential entry needed.
 *
 * API: MAL v2 — https://myanimelist.net/apiconfig/references/api/v2
 * Rate limit: ~60 req/min per IP; 1 req/second keeps comfortably inside that.
 */
import {
  TrackerBase,
  defineTracker,
  defineSettings,
  type Cursor,
  type InferSettings,
  type PagedRequest,
  type PagedResults,
  type SettingDescriptor,
  type TrackerEntryUpdate,
  type TrackerInfo,
  type TrackerLibraryEntry,
  type TrackerSearchResult,
  type TrackerStatus,
  encodeCursor,
  offsetFromCursor,
} from "@comical/sdk";

const API_BASE = "https://api.myanimelist.net/v2";
const AUTH_BASE = "https://myanimelist.net/v1/oauth2";
const PER_PAGE = 100;

// Register once at https://myanimelist.net/apiconfig (choose "Other" — no secret needed)
// Set redirect URI to: http://localhost:3100/oauth/callback (+ production URL when deployed)
const MAL_CLIENT_ID = "70ff35a48559cce9655338a1106f7c88";

const SETTINGS = defineSettings([
  {
    type: "oauth-callback",
    key: "token",
    label: "MAL Account",
    description: "Connect your MyAnimeList account to sync reading progress.",
    required: true,
    authUrlTemplate:
      `${AUTH_BASE}/authorize?response_type=code` +
      "&client_id={clientId}" +
      "&code_challenge={pkce}" +
      "&code_challenge_method=plain" +
      "&redirect_uri={callbackUrl}" +
      "&state={state}",
    exchange: {
      url: `${AUTH_BASE}/token`,
      clientId: MAL_CLIENT_ID,
      pkce: true,
      refreshUrl: `${AUTH_BASE}/token`,
    },
  },
]);
type Settings = InferSettings<typeof SETTINGS>;

// ── Status mapping ────────────────────────────────────────────────────────────

type MalStatus = "reading" | "completed" | "on_hold" | "dropped" | "plan_to_read" | "re_reading";

const TO_TRACKER: Readonly<Record<MalStatus, TrackerStatus>> = {
  reading: "reading",
  completed: "completed",
  on_hold: "on_hold",
  dropped: "dropped",
  plan_to_read: "planning",
  re_reading: "rereading",
};

const FROM_TRACKER: Readonly<Record<TrackerStatus, MalStatus>> = {
  reading: "reading",
  completed: "completed",
  on_hold: "on_hold",
  dropped: "dropped",
  planning: "plan_to_read",
  rereading: "re_reading",
};

// ── Wire DTOs ─────────────────────────────────────────────────────────────────

interface MalPicture { medium?: string }
interface MalTitle { romaji?: string }

interface MalMangaNode {
  id: number;
  title: string;
  main_picture?: MalPicture;
  synopsis?: string;
  num_chapters?: number;
}

interface MalListStatus {
  status: MalStatus;
  num_chapters_read: number;
  score: number;
}

interface MalListEntry {
  node: MalMangaNode;
  list_status: MalListStatus;
}

interface MalPage<T> {
  data: T[];
  paging: { next?: string; previous?: string };
}

/**
 * Cursor for the window after `offset`. MAL is offset-based but answers "is there more" with a
 * `paging.next` link rather than a total, so the offset comes from the rows actually returned and the
 * link decides whether there is a next window at all. An empty window ends the walk regardless of
 * the link — a cursor that doesn't advance is the infinite-scroll loop cursors exist to prevent.
 */
const nextWindow = (offset: number, count: number, next: string | undefined): Cursor | undefined =>
  count > 0 && next ? encodeCursor({ offset: offset + count }) : undefined;

// ── Tracker class ─────────────────────────────────────────────────────────────

class MalTracker extends TrackerBase<Settings> {
  readonly info: TrackerInfo = {
    id: "mal",
    name: "MyAnimeList",
    version: "0.1.1",
    contractVersion: "1.0.0",
    capabilities: ["library-sync", "status-sync", "search", "settings"],
    rateLimit: { maxConcurrent: 1, minIntervalMs: 1000 },
  };

  override getSettings(): SettingDescriptor[] {
    return [...SETTINGS];
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.requireString("token")}` };
  }

  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${API_BASE}${path}`);
    if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await this.request({ url: url.toString(), headers: this.authHeaders() });
    if (res.status === 401) throw new Error("MAL: invalid or expired access token");
    if (res.status >= 400) {
      const detail = tryParseError(res.body);
      throw new Error(`MAL error ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    return JSON.parse(res.body) as T;
  }

  private async patch(path: string, fields: Record<string, string>): Promise<void> {
    const res = await this.request({
      url: `${API_BASE}${path}`,
      method: "PATCH",
      headers: { ...this.authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
    if (res.status === 401) throw new Error("MAL: invalid or expired access token");
    if (res.status >= 400) {
      const detail = tryParseError(res.body);
      throw new Error(`MAL error ${res.status}${detail ? `: ${detail}` : ""}`);
    }
  }

  // ── library-sync ──────────────────────────────────────────────────────────

  async getLibrary(req: PagedRequest = {}): Promise<PagedResults<TrackerLibraryEntry>> {
    const offset = offsetFromCursor(req.cursor);
    const data = await this.get<MalPage<MalListEntry>>("/users/@me/mangalist", {
      fields: "list_status,main_picture,num_chapters",
      sort: "list_updated_at",
      limit: String(PER_PAGE),
      offset: String(offset),
    });

    const items: TrackerLibraryEntry[] = data.data.map(({ node, list_status }) => {
      const item: TrackerLibraryEntry = {
        externalId: node.id,
        title: node.title,
        status: TO_TRACKER[list_status.status] ?? "planning",
      };
      if (list_status.num_chapters_read > 0) item.chaptersRead = list_status.num_chapters_read;
      // MAL reports 0 for a series it has no chapter count for (ongoing or simply unrecorded).
      if (node.num_chapters !== undefined && node.num_chapters > 0) item.totalChapters = node.num_chapters;
      if (node.main_picture?.medium) item.thumbnailUrl = node.main_picture.medium;
      return item;
    });

    return { items, nextCursor: nextWindow(offset, items.length, data.paging.next) };
  }

  // ── status-sync ───────────────────────────────────────────────────────────

  async updateEntry(externalId: string | number, update: TrackerEntryUpdate): Promise<void> {
    const fields: Record<string, string> = {};
    if (update.status !== undefined) fields.status = FROM_TRACKER[update.status];
    if (update.chaptersRead !== undefined) fields.num_chapters_read = String(Math.floor(update.chaptersRead));
    // MAL score: 0–10 integer; contract score: 0–100
    if (update.score !== undefined) fields.score = String(Math.round(update.score / 10));
    // MAL takes reading dates as `YYYY-MM-DD` — the contract's shape verbatim, no conversion.
    if (update.startedAt !== undefined) fields.start_date = update.startedAt;
    if (update.finishedAt !== undefined) fields.finish_date = update.finishedAt;
    if (Object.keys(fields).length === 0) return;
    await this.patch(`/manga/${externalId}/my_list_status`, fields);
  }

  // ── search ────────────────────────────────────────────────────────────────

  async search(query: string, req: PagedRequest = {}): Promise<PagedResults<TrackerSearchResult>> {
    const offset = offsetFromCursor(req.cursor);
    const data = await this.get<MalPage<{ node: MalMangaNode }>>("/manga", {
      q: query,
      limit: "20",
      offset: String(offset),
      fields: "main_picture,synopsis",
    });

    const items: TrackerSearchResult[] = data.data.map(({ node }) => {
      const item: TrackerSearchResult = { externalId: node.id, title: node.title };
      if (node.main_picture?.medium) item.thumbnailUrl = node.main_picture.medium;
      if (node.synopsis) item.description = node.synopsis.slice(0, 300);
      return item;
    });

    return { items, nextCursor: nextWindow(offset, items.length, data.paging.next) };
  }
}

function tryParseError(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { message?: string; error?: string };
    return parsed.message ?? parsed.error;
  } catch { return undefined; }
}

export default defineTracker((host) => new MalTracker(host));
