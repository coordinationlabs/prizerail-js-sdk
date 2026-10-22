import {
  PrizerailCutoffError,
  PrizerailDrawingChangedError,
  PrizerailError,
  type SendProgress,
} from "./errors.js";
import { Http } from "./http.js";
import type {
  Campaign,
  Drawing,
  DrawingRef,
  DrawingStatus,
  DrawingsPage,
  Entrant,
  EntrantEvent,
  EntriesPage,
  Guarantee,
  SendEntriesResponse,
  SentEntrant,
} from "./types.js";
import { type DrawProof, type VerifyResult, verifyDraw } from "./verify.js";

export const VERSION = "1.0.0";

const badPage = (detail: string) =>
  new PrizerailError(0, "invalid_response", `Paging stopped: ${detail}.`);

/** The API takes up to this many entries per request. */
export const ENTRIES_PER_REQUEST = 1000;

export type PrizerailOptions = {
  /** Your `pr_…` key. Only the public helpers work without one. */
  apiKey?: string;
  /**
   * Defaults to https://sandbox.prizerail.com for a `pr_sandbox_` key and
   * https://www.prizerail.com otherwise. Set it to point anywhere else, such
   * as a local server.
   */
  siteUrl?: string;
  /** Per attempt. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Retries for 429s, 5xx and network errors. Defaults to 4. */
  maxRetries?: number;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
};

export type SendOptions = {
  /**
   * The drawing to send to, as `entries.list()` or a previous send returned
   * it. By default, the one taking entries now.
   */
  drawing?: DrawingRef;
  /**
   * No batch is sent, and no retry started, this close to the cutoff, so
   * no request arrives after it. Defaults to the request timeout.
   */
  cutoffMarginMs?: number;
};

/**
 * `entrantCount` and `totalEntries` are the drawing's totals after the last
 * batch. `added`, `updated` and `unchanged` sum what each batch reported, so
 * a batch stored before its response was lost, then retried, counts as
 * unchanged. Reconcile with `entrantCount`, not with `added`.
 */
/**
 * What `entries.increment()` did. Its batches go to the drawing taking
 * entries when each arrives, so a cutoff mid-way splits them between
 * drawings, which is correct for events that happened either side of it.
 */
export type IncrementResult = {
  /** Entrants new to their drawing, and entrants given more entries. */
  added: number;
  updated: number;
  /** Events Prizerail had already seen in this campaign, so ignored. */
  duplicates: number;
  /** Events in the batches Prizerail confirmed. */
  sent: number;
  batches: number;
  /**
   * Each drawing these events added entries to, in order. A batch that was
   * all duplicates adds none, since those events are in the drawing they
   * first went to, which can be an earlier one.
   */
  drawings: DrawingRef[];
};

export type SendResult = SendEntriesResponse & {
  /** Entrants in the batches the drawing confirmed. */
  sent: number;
  batches: number;
};

/** The API's limits on an event, as it checks them. */
const ID_MAX = 200;
const ENTRIES_MAX = 2 ** 32 - 1;

/**
 * Every event checked against the API's rules before the first request. The
 * same eventId twice is fine if it's the same event, which the API ignores,
 * but not for another entrant or count.
 */
function checkEvents(events: EntrantEvent[]) {
  const seen = new Map<string, EntrantEvent>();
  for (const [i, e] of events.entries()) {
    const id = typeof e.entrantId === "string" ? e.entrantId.trim() : "";
    if (id === "" || e.entrantId.length > ID_MAX) {
      throw new TypeError(
        `Event ${i}: entrantId must be a non-empty string of ${ID_MAX} characters or fewer.`
      );
    }
    const eventId = typeof e.eventId === "string" ? e.eventId.trim() : "";
    if (eventId === "" || e.eventId.length > ID_MAX) {
      throw new TypeError(
        `Event ${i} (${id}) needs an eventId of ${ID_MAX} characters or fewer: the id of the event behind these entries, the same on every retry.`
      );
    }
    // An event takes `entries`. The older `weight` is refused by the API in
    // this body, so it's refused here, before any batch is sent.
    if ((e as { weight?: unknown }).weight !== undefined) {
      throw new TypeError(
        `Event ${i} (${eventId}): use entries, not the older weight.`
      );
    }
    const entries = e.entries ?? 1;
    if (!Number.isInteger(entries) || entries < 1 || entries > ENTRIES_MAX) {
      throw new TypeError(
        `Event ${i} (${eventId}): entries must be a whole number from 1 to ${ENTRIES_MAX}.`
      );
    }
    if (e.displayName != null && typeof e.displayName !== "string") {
      throw new TypeError(
        `Event ${i} (${eventId}): displayName must be a string.`
      );
    }
    if (
      e.avatarUrl != null &&
      e.avatarUrl !== "" &&
      !isAvatarUrl(e.avatarUrl)
    ) {
      throw new TypeError(
        `Event ${i} (${eventId}): avatarUrl must be an https URL of ${AVATAR_URL_MAX} characters or fewer.`
      );
    }
    const was = seen.get(eventId);
    if (
      was &&
      (was.entrantId.trim() !== id || (was.entries ?? 1) !== entries)
    ) {
      throw new TypeError(
        `eventId "${eventId}" is used for two different events. Give each event its own id.`
      );
    }
    seen.set(eventId, e);
  }
}

/** The API's rule for an avatar: https, and 2,048 characters at most. */
const AVATAR_URL_MAX = 2048;
function isAvatarUrl(value: unknown) {
  if (typeof value !== "string" || value.length > AVATAR_URL_MAX) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** An increment response, checked before its counts are added up. */
function checkIncrementResponse(r: unknown) {
  const res = r as {
    drawing?: { id?: unknown };
    added?: unknown;
    updated?: unknown;
    duplicates?: unknown;
  } | null;
  if (
    typeof res?.drawing?.id !== "string" ||
    !isCount(res.added) ||
    !isCount(res.updated) ||
    !isCount(res.duplicates ?? 0)
  ) {
    throw badResponse("The increment response has no valid drawing or counts.");
  }
  return res as SendEntriesResponse & { duplicates?: number };
}

/**
 * An entrant as the API takes it. The older `weight` is gone from 1.0.0, so
 * it's refused rather than sent, which would count the entrant once.
 */
function toWire(entrant: Entrant): Entrant {
  if (typeof entrant === "string") return entrant;
  if ((entrant as { weight?: unknown }).weight !== undefined) {
    throw new TypeError(
      `Entrant ${entrant.entrantId}: use entries, not the older weight.`
    );
  }
  return entrant;
}

/** A drawing's totals as the server sends them. */
type WireTotals = {
  entrantCount?: unknown;
  totalEntries?: unknown;
};

const badResponse = (detail: string) =>
  new PrizerailError(0, "invalid_response", detail);

const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** A total the response must carry as a whole number from 0. */
function count(r: WireTotals, name: keyof WireTotals) {
  const value = r[name];
  if (!isCount(value)) {
    throw badResponse(`The response has no valid ${name}.`);
  }
  return value;
}

/** The drawing's totals, checked. */
function totals(r: WireTotals) {
  return {
    entrantCount: count(r, "entrantCount"),
    totalEntries: count(r, "totalEntries"),
  };
}

/** A page with its totals and entrants checked. */
function normalizePage(
  page: WireTotals & {
    drawing: EntriesPage["drawing"];
    entrants?: SentEntrant[];
    next: string | null;
  }
): EntriesPage {
  const rows = page.entrants;
  if (!Array.isArray(rows)) {
    throw badResponse("The response has no entrants list.");
  }
  const entrants = rows.map(e => {
    if (
      !isCount(e.entries) ||
      e.entries < 1 ||
      typeof e.entrantId !== "string"
    ) {
      throw badResponse(
        "An entrant in the response has no valid id or entries."
      );
    }
    const { weight: _, ...rest } = e as SentEntrant & { weight?: number };
    return rest;
  });
  return {
    drawing: page.drawing,
    ...totals(page),
    entrants,
    next: page.next,
  };
}

/** The site a key belongs to: sandbox keys only work in the sandbox. */
function defaultSiteUrl(apiKey?: string): string {
  return apiKey?.trim().startsWith("pr_sandbox_")
    ? "https://sandbox.prizerail.com"
    : "https://www.prizerail.com";
}

export class Prizerail {
  readonly siteUrl: string;
  /** @internal */
  readonly http: Http;

  constructor(options: PrizerailOptions = {}) {
    this.siteUrl = (options.siteUrl ?? defaultSiteUrl(options.apiKey)).replace(
      /\/+$/,
      ""
    );
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) throw new Error("No fetch here. Pass options.fetch.");
    const timeoutMs = options.timeoutMs ?? 30_000;
    const maxRetries = options.maxRetries ?? 4;
    // AbortSignal.timeout takes whole ms up to the platform's timer limit.
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 2 ** 31 - 1
    ) {
      throw new TypeError(
        "timeoutMs must be a whole number of ms, from 1 to 2147483647."
      );
    }
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new TypeError("maxRetries must be a whole number from 0.");
    }
    this.http = new Http({
      apiKey: options.apiKey,
      baseUrl: `${this.siteUrl}/api/v1`,
      fetch: fetchImpl.bind(globalThis),
      timeoutMs,
      maxRetries,
      userAgent: `prizerail-js/${VERSION}`,
    });
  }

  /** A campaign under your account, by slug. */
  campaign(slug: string): CampaignClient {
    if (!slug) throw new Error("campaign() needs a slug.");
    return new CampaignClient(this, slug);
  }
}

export class CampaignClient {
  readonly entries: EntriesClient;
  readonly drawings: DrawingsClient;
  readonly guarantees: { list(): Promise<Guarantee[]> };

  constructor(
    readonly prizerail: Prizerail,
    readonly slug: string
  ) {
    this.entries = new EntriesClient(this);
    this.drawings = new DrawingsClient(this);
    this.guarantees = {
      list: async () =>
        (
          await this.http.request<{ guarantees: Guarantee[] }>(
            "GET",
            this.path("/guarantees")
          )
        ).guarantees,
    };
  }

  /** @internal */
  get http() {
    return this.prizerail.http;
  }

  /** @internal */
  path(rest = "") {
    return `campaigns/${encodeURIComponent(this.slug)}${rest}`;
  }

  /** Schedule, prize table with odds, guarantee, next drawing, terms. */
  async get(): Promise<Campaign> {
    return (await this.http.request<{ campaign: Campaign }>("GET", this.path()))
      .campaign;
  }
}

export class EntriesClient {
  constructor(private readonly campaign: CampaignClient) {}

  /**
   * Sends entries to one drawing, in requests of 1,000, retrying 429s, 5xx
   * and network errors. Sending an entrant again before the cutoff only sets
   * their weight, so a retry is safe, but a retry after the cutoff would go
   * to the next drawing. So the send is pinned to one drawing: it stops with
   * a PrizerailCutoffError rather than send or retry near its cutoff, and
   * with a PrizerailDrawingChangedError if a batch lands anywhere else.
   */
  async send(
    entrants: Entrant[],
    options: SendOptions = {}
  ): Promise<SendResult> {
    const entries = entrants.map(toWire);
    if (entries.length === 0) throw new Error("send() needs entries.");
    const margin =
      options.cutoffMarginMs ?? this.campaign.http.options.timeoutMs;
    // A bad margin or cutoff would turn the cutoff guard off, so refuse them.
    if (!Number.isFinite(margin) || margin < 0) {
      throw new TypeError("cutoffMarginMs must be a number of ms from 0.");
    }
    const target = options.drawing ?? (await this.openDrawing());
    const cutoff = Date.parse(target.cutoffAt);
    if (!target.id || !Number.isFinite(cutoff)) {
      throw new TypeError(
        "drawing must have the id and cutoffAt that entries.list() or a send returned."
      );
    }
    const progress: SendProgress = {
      drawing: target,
      sent: 0,
      added: 0,
      updated: 0,
      unchanged: 0,
    };
    const stop = (detail: string, cause?: unknown) =>
      new PrizerailCutoffError(detail, { ...progress }, cause);

    let last: SendEntriesResponse | undefined;
    let batches = 0;
    for (let i = 0; i < entries.length; i += ENTRIES_PER_REQUEST) {
      if (Date.now() + margin >= cutoff) {
        throw stop(
          `Drawing ${target.id}'s cutoff is at ${target.cutoffAt}, so the rest wasn't sent.`
        );
      }
      const batch = entries.slice(i, i + ENTRIES_PER_REQUEST);
      const res = await this.campaign.http.request<SendEntriesResponse>(
        "POST",
        this.campaign.path("/entries"),
        {
          body: { entrants: batch },
          deadline: cutoff - margin,
          onDeadline: cause =>
            stop(
              `A batch failed and a retry would reach drawing ${target.id}'s cutoff. Check what it has before sending again.`,
              cause
            ),
        }
      );
      if (res.drawing.id !== target.id) {
        throw new PrizerailDrawingChangedError({ ...progress }, res.drawing);
      }
      progress.sent += batch.length;
      progress.added += res.added;
      progress.updated += res.updated;
      progress.unchanged += res.unchanged;
      last = res;
      batches++;
    }
    const final = last!;
    return {
      drawing: final.drawing,
      added: progress.added,
      updated: progress.updated,
      unchanged: progress.unchanged,
      ...totals(final),
      sent: progress.sent,
      batches,
    };
  }

  /**
   * Adds entries to entrants, one event at a time: `{ entrantId, entries,
   * eventId }`. Prizerail records each `eventId` for the campaign and
   * ignores it if it comes again, so this is safe to retry and safe for a
   * queue that delivers an event twice, even after a cutoff. Sent in
   * requests of 1,000, retried like `send`. An `eventId` reused for a
   * different entrant or count throws a PrizerailError, `event_conflict`.
   */
  async increment(events: EntrantEvent[]): Promise<IncrementResult> {
    if (events.length === 0) throw new Error("increment() needs events.");
    // Checked before anything is sent, so a bad event late in the list can't
    // leave the batches before it stored and the call failed.
    checkEvents(events);
    const result: IncrementResult = {
      added: 0,
      updated: 0,
      duplicates: 0,
      sent: 0,
      batches: 0,
      drawings: [],
    };
    for (let i = 0; i < events.length; i += ENTRIES_PER_REQUEST) {
      const batch = events.slice(i, i + ENTRIES_PER_REQUEST);
      // Retries are safe here at any time: a repeated eventId is ignored.
      const res = checkIncrementResponse(
        await this.campaign.http.request<unknown>(
          "POST",
          this.campaign.path("/entries"),
          { body: { mode: "increment", entrants: batch } }
        )
      );
      result.added += res.added;
      result.updated += res.updated;
      result.duplicates += res.duplicates ?? 0;
      result.sent += batch.length;
      result.batches++;
      // Only a batch that added entries names where they went. One that was
      // all duplicates, such as a retry after the cutoff of a batch already
      // stored, names the next drawing, not the one the events are in.
      if (
        res.added + res.updated > 0 &&
        result.drawings.at(-1)?.id !== res.drawing.id
      ) {
        result.drawings.push(res.drawing);
      }
    }
    return result;
  }

  /** The drawing taking entries now. */
  async openDrawing(): Promise<DrawingRef> {
    const { drawing } = await this.list({ limit: 1 });
    return {
      id: drawing.id,
      drawAt: drawing.drawAt,
      cutoffAt: drawing.cutoffAt,
    };
  }

  /** One page of a drawing's entries, in arrival order. */
  async list(
    query: { drawing?: string; limit?: number; after?: string } = {}
  ): Promise<EntriesPage> {
    return normalizePage(
      await this.campaign.http.request<Parameters<typeof normalizePage>[0]>(
        "GET",
        this.campaign.path("/entries"),
        { query }
      )
    );
  }

  /**
   * Every entrant in a drawing, page by page. Without `drawing`, the one
   * taking entries now, pinned by id after the first page so a cutoff
   * mid-read can't mix in the next drawing.
   */
  async *all(
    query: { drawing?: string; pageSize?: number } = {}
  ): AsyncGenerator<SentEntrant> {
    let drawing = query.drawing;
    let after: string | undefined;
    for (;;) {
      const page = await this.list({
        drawing,
        limit: query.pageSize ?? ENTRIES_PER_REQUEST,
        after,
      });
      drawing ??= page.drawing.id;
      if (page.drawing.id !== drawing) {
        throw badPage(
          `a page came from drawing ${page.drawing.id}, not ${drawing}`
        );
      }
      yield* page.entrants;
      if (page.next === null) return;
      // Each cursor must move forward, or a bad page would loop forever.
      // Cursors are whole numbers sent as strings, so compare them as numbers.
      if (
        !/^\d+$/.test(page.next) ||
        BigInt(page.next) <= BigInt(after ?? -1)
      ) {
        throw badPage(`next ${page.next} doesn't move past ${after}`);
      }
      after = page.next;
    }
  }
}

export class DrawingsClient {
  constructor(private readonly campaign: CampaignClient) {}

  /**
   * One page. Open drawings come soonest first and page with `after`; the
   * rest come newest first and page with `before`.
   */
  list(
    query: {
      status?: DrawingStatus;
      limit?: number;
      before?: string;
      after?: string;
    } = {}
  ): Promise<DrawingsPage> {
    return this.campaign.http.request<DrawingsPage>(
      "GET",
      this.campaign.path("/drawings"),
      { query }
    );
  }

  /** Every drawing, following the cursors. */
  async *all(
    query: { status?: DrawingStatus; pageSize?: number } = {}
  ): AsyncGenerator<Drawing> {
    let cursor: { before?: string; after?: string } = {};
    for (;;) {
      const page = await this.list({
        status: query.status,
        limit: query.pageSize ?? 100,
        ...cursor,
      });
      yield* page.drawings;
      // Each cursor must move on, or a bad page would loop forever.
      if (page.nextAfter) {
        if (cursor.after && !(page.nextAfter > cursor.after)) {
          throw badPage(
            `nextAfter ${page.nextAfter} doesn't move past ${cursor.after}`
          );
        }
        cursor = { after: page.nextAfter };
      } else if (page.nextBefore) {
        if (cursor.before && !(page.nextBefore < cursor.before)) {
          throw badPage(
            `nextBefore ${page.nextBefore} doesn't move past ${cursor.before}`
          );
        }
        cursor = { before: page.nextBefore };
      } else return;
    }
  }

  async get(id: string): Promise<Drawing> {
    return (
      await this.campaign.http.request<{ drawing: Drawing }>(
        "GET",
        this.campaign.path(`/drawings/${encodeURIComponent(id)}`)
      )
    ).drawing;
  }

  /**
   * Sandbox only: closes the drawing's entries now and draws it,
   * instead of waiting for its cutoff. Resolves with the drawing, settled or
   * paid, or still `entropy_requested` if the random value is on its way, in
   * which case read it again with `get(id)`. Elsewhere it throws a
   * PrizerailError with code `sandbox_only`.
   */
  async run(id: string): Promise<Drawing> {
    return (
      await this.campaign.http.request<{ drawing: Drawing }>(
        "POST",
        this.campaign.path(`/drawings/${encodeURIComponent(id)}/run`),
        // A repeat after a lost answer would only be refused, so never retry,
        // and wait out the route's own 90 seconds rather than the default 30.
        { maxRetries: 0, timeoutMs: 90_000 }
      )
    ).drawing;
  }

  /**
   * The newest drawing with final winners, `settled` or `paid`, or null.
   * A large prize paid by hand can keep a newer draw at `settled`, so this
   * reads both and takes the later.
   */
  async latest(): Promise<Drawing | null> {
    // In this order, so a draw that turns paid between the two reads still
    // shows in one of them.
    const settled = await this.list({ status: "settled", limit: 1 });
    const paid = await this.list({ status: "paid", limit: 1 });
    // Paid first, so a drawing that moved from settled to paid between the
    // two reads ties to its paid copy (the sort is stable).
    const found = [...paid.drawings, ...settled.drawings];
    found.sort((a, b) => Date.parse(b.drawAt) - Date.parse(a.drawAt));
    return found[0] ?? null;
  }

  /** The public proof link for a drawing. */
  proofUrl(id: string): string {
    const site = this.campaign.prizerail.siteUrl;
    return `${site}/campaigns/${encodeURIComponent(this.campaign.slug)}/draws/${encodeURIComponent(id)}/proof.json`;
  }

  /** The drawing's public proof. Needs no API key. */
  proof(id: string): Promise<DrawProof> {
    return this.campaign.http.getPublic<DrawProof>(this.proofUrl(id));
  }

  /** Fetches the proof and entrant list and checks the draw. */
  async verify(id: string): Promise<VerifyResult> {
    const proof = await this.proof(id);
    const { fetch, timeoutMs } = this.campaign.http.options;
    return verifyDraw(proof, { proofUrl: this.proofUrl(id), fetch, timeoutMs });
  }
}
