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
  EntriesPage,
  Entry,
  Guarantee,
  SendEntriesResponse,
  SentEntry,
} from "./types.js";
import { type DrawProof, type VerifyResult, verifyDraw } from "./verify.js";

export const VERSION = "0.1.0";

const badPage = (detail: string) =>
  new PrizerailError(0, "invalid_response", `Paging stopped: ${detail}.`);

/** The API takes up to this many entries per request. */
export const ENTRIES_PER_REQUEST = 1000;

export type PrizerailOptions = {
  /** Your `pr_…` key. Only the public helpers work without one. */
  apiKey?: string;
  /** Defaults to https://www.prizerail.com. */
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
 * `count` and `totalWeight` are the drawing's totals after the last batch.
 * `added`, `updated` and `unchanged` sum what each batch reported, so a
 * batch stored before its response was lost, then retried, counts as
 * unchanged. Reconcile with `count`, not with `added`.
 */
export type SendResult = SendEntriesResponse & {
  /** Entries in the batches the drawing confirmed. */
  sent: number;
  batches: number;
};

export class Prizerail {
  readonly siteUrl: string;
  /** @internal */
  readonly http: Http;

  constructor(options: PrizerailOptions = {}) {
    this.siteUrl = (options.siteUrl ?? "https://www.prizerail.com").replace(
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
  async send(entries: Entry[], options: SendOptions = {}): Promise<SendResult> {
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
          body: { entries: batch },
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
      count: final.count,
      totalWeight: final.totalWeight,
      sent: progress.sent,
      batches,
    };
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
  list(
    query: { drawing?: string; limit?: number; after?: string } = {}
  ): Promise<EntriesPage> {
    return this.campaign.http.request<EntriesPage>(
      "GET",
      this.campaign.path("/entries"),
      { query }
    );
  }

  /**
   * Every entry in a drawing, page by page. Without `drawing`, the one
   * taking entries now, pinned by id after the first page so a cutoff
   * mid-read can't mix in the next drawing.
   */
  async *all(
    query: { drawing?: string; pageSize?: number } = {}
  ): AsyncGenerator<SentEntry> {
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
      yield* page.entries;
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
