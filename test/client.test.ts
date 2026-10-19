import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRetryAfter } from "../src/http.js";
import {
  Prizerail,
  PrizerailCutoffError,
  PrizerailDrawingChangedError,
  PrizerailError,
} from "../src/index.js";

type Call = { method: string; url: URL; body?: unknown };
type Reply = Response | Error | ((call: Call) => Response | Error);

/** A fetch that answers from a script of replies, and records each call. */
function scripted(...replies: Reply[]) {
  const calls: Call[] = [];
  const fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? "GET",
        url: new URL(String(input)),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const next = replies.shift();
      if (!next) throw new Error(`unexpected ${call.method} ${call.url}`);
      const reply = typeof next === "function" ? next(call) : next;
      if (reply instanceof Error) throw reply;
      return reply;
    }
  );
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();
const drawingRef = (id: string, cutoffAt = inAnHour()) => ({
  id,
  drawAt: cutoffAt,
  cutoffAt,
});
const openPage = (id: string, cutoffAt?: string) =>
  json({
    drawing: { ...drawingRef(id, cutoffAt), status: "open" },
    count: 0,
    totalWeight: 0,
    entries: [],
    next: null,
  });
const accepted = (id: string, n: number, count: number, cutoffAt?: string) =>
  json({
    drawing: drawingRef(id, cutoffAt),
    added: n,
    updated: 0,
    unchanged: 0,
    count,
    totalWeight: count,
  });

function client(fetch: typeof globalThis.fetch) {
  return new Prizerail({
    apiKey: "pr_test",
    siteUrl: "https://pr.test",
    fetch,
  }).campaign("demo");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("requests", () => {
  it("sends the key and reads the campaign", async () => {
    const { fetch, calls } = scripted(json({ campaign: { slug: "demo" } }));
    expect(await client(fetch).get()).toEqual({ slug: "demo" });
    expect(calls[0].url.href).toBe("https://pr.test/api/v1/campaigns/demo");
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][1];
    expect(init.headers.authorization).toBe("Bearer pr_test");
  });

  it("throws the API's error code and does not retry a 4xx", async () => {
    const { fetch, calls } = scripted(
      json({ error: "not_found", detail: "No such campaign." }, 404)
    );
    const error = await client(fetch)
      .get()
      .catch(e => e);
    expect(error).toBeInstanceOf(PrizerailError);
    expect(error).toMatchObject({ status: 404, code: "not_found" });
    expect(calls).toHaveLength(1);
  });

  it("keeps the status of a non-JSON error from a proxy", async () => {
    const { fetch } = scripted(
      new Response("<html>Bad gateway</html>", { status: 400 })
    );
    const error = await client(fetch)
      .get()
      .catch(e => e);
    expect(error).toMatchObject({ status: 400, code: "http_400" });
    expect(error.detail).toContain("Bad gateway");
  });

  it("retries 429, 5xx and network errors, then succeeds", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { fetch, calls } = scripted(
      json({ error: "rate_limited" }, 429, { "retry-after": "0" }),
      json({ error: "internal" }, 503),
      new TypeError("fetch failed"),
      json({ campaign: { slug: "demo" } })
    );
    expect(await client(fetch).get()).toEqual({ slug: "demo" });
    expect(calls).toHaveLength(4);
  });

  it("gives up after maxRetries", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { fetch, calls } = scripted(
      json({ error: "internal" }, 500),
      json({ error: "internal" }, 500),
      json({ error: "internal" }, 500)
    );
    const c = new Prizerail({
      apiKey: "pr_test",
      fetch,
      maxRetries: 2,
    }).campaign("demo");
    await expect(c.get()).rejects.toMatchObject({ status: 500 });
    expect(calls).toHaveLength(3);
  });

  it("refuses to call the API without a key", async () => {
    const { fetch, calls } = scripted();
    const c = new Prizerail({ fetch }).campaign("demo");
    await expect(c.get()).rejects.toMatchObject({ code: "no_api_key" });
    expect(calls).toHaveLength(0);
  });
});

describe("bad responses and options", () => {
  it("doesn't retry a 2xx whose body isn't JSON", async () => {
    const { fetch, calls } = scripted(new Response("<html>", { status: 200 }));
    await expect(client(fetch).get()).rejects.toMatchObject({
      status: 200,
      code: "invalid_response",
    });
    expect(calls).toHaveLength(1);
  });

  it("gives up rather than wait out a Retry-After over 5 minutes", async () => {
    const { fetch, calls } = scripted(
      json({ error: "rate_limited" }, 429, { "retry-after": "600" })
    );
    await expect(client(fetch).get()).rejects.toMatchObject({ status: 429 });
    expect(calls).toHaveLength(1);
  });

  it("refuses options that would turn the cutoff guard off", async () => {
    const { fetch, calls } = scripted();
    const c = client(fetch);
    await expect(
      c.entries.send(["a"], {
        drawing: { id: "d1", drawAt: "x", cutoffAt: "soon" },
      })
    ).rejects.toThrow("cutoffAt");
    await expect(
      c.entries.send(["a"], { drawing: drawingRef("d1"), cutoffMarginMs: -1 })
    ).rejects.toThrow("cutoffMarginMs");
    expect(calls).toHaveLength(0);
    expect(() => new Prizerail({ fetch, timeoutMs: 0 })).toThrow("timeoutMs");
    expect(() => new Prizerail({ fetch, timeoutMs: 1.5 })).toThrow("timeoutMs");
    expect(() => new Prizerail({ fetch, timeoutMs: 2 ** 31 })).toThrow(
      "timeoutMs"
    );
    expect(() => new Prizerail({ fetch, maxRetries: 1.5 })).toThrow(
      "maxRetries"
    );
  });

  it("stops paging when a cursor repeats", async () => {
    const page = () =>
      json({
        drawing: { ...drawingRef("d1"), status: "open" },
        count: 9,
        totalWeight: 9,
        entries: [{ entrantId: "a", weight: 1 }],
        next: "5",
      });
    const { fetch } = scripted(page(), page());
    const seen: string[] = [];
    const run = async () => {
      for await (const e of client(fetch).entries.all()) seen.push(e.entrantId);
    };
    await expect(run()).rejects.toMatchObject({ code: "invalid_response" });
    expect(seen).toHaveLength(2);
  });

  it("stops when a drawings cursor doesn't move back", async () => {
    const at = "2026-10-01T00:00:00.000Z";
    const page = () => json({ drawings: [], nextBefore: at, nextAfter: null });
    const { fetch } = scripted(page(), page());
    const run = async () => {
      for await (const _ of client(fetch).drawings.all()) {
      }
    };
    await expect(run()).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds and HTTP dates", () => {
    const now = Date.parse("2026-10-19T12:00:00Z");
    expect(parseRetryAfter("3", now)).toBe(3000);
    expect(parseRetryAfter("Mon, 19 Oct 2026 12:00:10 GMT", now)).toBe(10_000);
    expect(parseRetryAfter("Mon, 19 Oct 2026 11:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });
});

describe("entries.send", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `e${i}`);

  it("pins one drawing and sends batches of 1,000", async () => {
    const { fetch, calls } = scripted(
      openPage("d1"),
      accepted("d1", 1000, 1000),
      accepted("d1", 1000, 2000),
      accepted("d1", 500, 2500)
    );
    const result = await client(fetch).entries.send(ids(2500));
    expect(result).toMatchObject({
      drawing: { id: "d1" },
      sent: 2500,
      added: 2500,
      count: 2500,
      batches: 3,
    });
    expect(calls[0].url.searchParams.get("limit")).toBe("1");
    const sizes = calls
      .slice(1)
      .map(c => (c.body as { entries: unknown[] }).entries.length);
    expect(sizes).toEqual([1000, 1000, 500]);
  });

  it("skips the lookup when given the drawing", async () => {
    const { fetch, calls } = scripted(accepted("d1", 2, 2));
    await client(fetch).entries.send(["a", "b"], { drawing: drawingRef("d1") });
    expect(calls.map(c => c.method)).toEqual(["POST"]);
  });

  it("stops when a batch lands in another drawing", async () => {
    const { fetch } = scripted(
      openPage("d1"),
      accepted("d1", 1000, 1000),
      accepted("d2", 1000, 1000)
    );
    const error = await client(fetch)
      .entries.send(ids(1500))
      .catch(e => e);
    expect(error).toBeInstanceOf(PrizerailDrawingChangedError);
    expect(error.landedIn.id).toBe("d2");
    expect(error.progress).toMatchObject({ sent: 1000, added: 1000 });
  });

  it("sends nothing when the cutoff is too close", async () => {
    const soon = new Date(Date.now() + 20_000).toISOString();
    const { fetch, calls } = scripted(openPage("d1", soon));
    const error = await client(fetch)
      .entries.send(["a"])
      .catch(e => e);
    expect(error).toBeInstanceOf(PrizerailCutoffError);
    expect(error.progress.sent).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("won't retry a failed batch into the next drawing", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const cutoff = new Date(Date.now() + 50_000).toISOString();
    const { fetch, calls } = scripted(
      openPage("d1", cutoff),
      // The server says wait a minute, past the cutoff.
      json({ error: "rate_limited" }, 429, { "retry-after": "60" })
    );
    const error = await client(fetch)
      .entries.send(["a"])
      .catch(e => e);
    expect(error).toBeInstanceOf(PrizerailCutoffError);
    expect(error.cause).toMatchObject({ status: 429 });
    expect(calls).toHaveLength(2);
  });

  it("checks the cutoff again when a retry timer fires late", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    // The machine sleeps through the wait: the timer fires a minute late.
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      clock += 60_000;
      fn();
      return 0;
    }) as unknown as typeof setTimeout);
    const cutoff = new Date(clock + 50_000).toISOString();
    const { fetch, calls } = scripted(
      openPage("d1", cutoff),
      new TypeError("socket hang up")
    );
    const error = await client(fetch)
      .entries.send(["a"])
      .catch(e => e);
    expect(error).toBeInstanceOf(PrizerailCutoffError);
    expect(calls.map(c => c.method)).toEqual(["GET", "POST"]);
  });

  it("retries a batch while the cutoff is far off", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { fetch, calls } = scripted(
      openPage("d1"),
      new TypeError("socket hang up"),
      accepted("d1", 1, 1)
    );
    const result = await client(fetch).entries.send(["a"]);
    expect(result.added).toBe(1);
    expect(calls.map(c => c.method)).toEqual(["GET", "POST", "POST"]);
  });
});

describe("paging", () => {
  it("pins entries.all to the first page's drawing", async () => {
    const page = (entries: string[], next: string | null) =>
      json({
        drawing: { ...drawingRef("d1"), status: "open" },
        count: 3,
        totalWeight: 3,
        entries: entries.map(entrantId => ({ entrantId, weight: 1 })),
        next,
      });
    // Real cursors are strings, and "1000" sorts before "999" as text.
    const { fetch, calls } = scripted(
      page(["a", "b"], "999"),
      page(["c"], "1000"),
      page(["d"], null)
    );
    const seen: string[] = [];
    for await (const e of client(fetch).entries.all({ pageSize: 2 })) {
      seen.push(e.entrantId);
    }
    expect(seen).toEqual(["a", "b", "c", "d"]);
    expect(calls[0].url.searchParams.get("drawing")).toBeNull();
    expect(calls[1].url.searchParams.get("drawing")).toBe("d1");
    expect(calls[1].url.searchParams.get("after")).toBe("999");
    expect(calls[2].url.searchParams.get("after")).toBe("1000");
  });

  it("follows nextBefore through drawings", async () => {
    const d = (id: string) => ({ id, drawAt: "2026-10-01T00:00:00.000Z" });
    const { fetch, calls } = scripted(
      json({
        drawings: [d("a")],
        nextBefore: "2026-10-01T00:00:00.000Z",
        nextAfter: null,
      }),
      json({ drawings: [d("b")], nextBefore: null, nextAfter: null })
    );
    const seen: string[] = [];
    for await (const x of client(fetch).drawings.all({ status: "paid" })) {
      seen.push(x.id);
    }
    expect(seen).toEqual(["a", "b"]);
    expect(calls[1].url.searchParams.get("before")).toBe(
      "2026-10-01T00:00:00.000Z"
    );
  });

  it("latest takes the newer of settled and paid", async () => {
    const reply = (call: Call) =>
      call.url.searchParams.get("status") === "settled"
        ? json({ drawings: [{ id: "s", drawAt: "2026-10-19T10:00:00Z" }] })
        : json({ drawings: [{ id: "p", drawAt: "2026-10-19T09:00:00Z" }] });
    const { fetch } = scripted(reply, reply);
    expect((await client(fetch).drawings.latest())?.id).toBe("s");
  });
});
