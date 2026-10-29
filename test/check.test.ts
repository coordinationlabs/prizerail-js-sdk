import { describe, expect, it, vi } from "vitest";
import {
  checkEntrantIds,
  checkEntries,
  idShape,
  looksSequential,
  untilText,
} from "../src/check.js";
import { checkCampaign, Prizerail } from "../src/index.js";
import type { SentEntrant } from "../src/types.js";

type Call = { method: string; url: URL; body?: unknown };
type Reply = Response | Error | ((call: Call) => Response | Error);

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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const HEX = "9f2c41e7a0b3d5c6e8f1a2b3c4d5e6f70123456789abcdef0123456789abcdef";
const entrant = (entrantId: string, entries = 1): SentEntrant => ({
  entrantId,
  entries,
  displayName: null,
  avatarUrl: null,
  position: null,
  receivedAt: "2026-10-28T00:00:00.000Z",
});
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();
const campaign = (status = "active", nextDrawing: unknown = undefined) => ({
  campaign: {
    slug: "demo",
    name: "Demo",
    status,
    nextDrawing:
      nextDrawing === undefined
        ? { id: "d1", drawAt: inAnHour(), cutoffAt: inAnHour() }
        : nextDrawing,
  },
});
const entriesPage = (entrants: SentEntrant[], totals?: [number, number]) =>
  json({
    drawing: {
      id: "d1",
      drawAt: inAnHour(),
      cutoffAt: inAnHour(),
      status: "open",
    },
    entrantCount: totals?.[0] ?? entrants.length,
    totalEntries: totals?.[1] ?? entrants.reduce((a, e) => a + e.entries, 0),
    entrants,
    next: null,
  });

function client(fetch: typeof globalThis.fetch, apiKey = "pr_sandbox_x") {
  return new Prizerail({
    apiKey,
    siteUrl: "https://sandbox.pr.test",
    fetch,
  }).campaign("demo");
}

const labels = (checks: { ok: boolean | null; label: string }[]) =>
  checks.map(
    c => `${c.ok === true ? "✓" : c.ok === false ? "✗" : "i"} ${c.label}`
  );

describe("idShape", () => {
  it("tells opaque ids from ones that point at a person", () => {
    expect(idShape(HEX)).toBe("opaque");
    expect(idShape(`0x${HEX}`)).toBe("opaque");
    expect(idShape("Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA")).toBe("opaque");
    expect(idShape("ada@example.com")).toBe("email");
    expect(idShape("ada_lovelace")).toBe("username");
    expect(idShape("1042")).toBe("number");
    expect(idShape("3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b")).toBe("uuid");
    expect(idShape("a1b2c3")).toBe("short");
    // Generated ids a partner stores: nanoid, CUID, prefixed random ids.
    expect(idShape("V1StGXR8_Z5jdHi6B-myT")).toBe("opaque");
    expect(idShape("cus_Nx6v2dG9mLk8Qa")).toBe("opaque");
    expect(idShape("clh3k2x9a0000qzrmn831i7rn")).toBe("opaque");
    // Random ids with no digit, or lowercase with digits inside.
    expect(idShape("XkjdPqLmNvBtRyUeWzAaBbCcDdEe")).toBe("opaque");
    expect(idShape("VStGXRZjdHiBmyTqwErtyU")).toBe("opaque");
    expect(idShape("usr_k3j9d8s7f6g5h4j3")).toBe("opaque");
    expect(idShape("af3a9b2c1d4e5f6a")).toBe("opaque");
    expect(idShape("wmxkjhdfgtrqpalzvbnmsjdu")).toBe("opaque");
    // Handles with a year are still handles.
    expect(idShape("ada_lovelace_1988")).toBe("username");
    expect(idShape("john.doe.1990")).toBe("username");
    expect(idShape("jsmith42")).toBe("username");
  });
});

describe("looksSequential", () => {
  it("spots a counter and ignores spread-out numbers", () => {
    expect(looksSequential(["1041", "1042", "1043", "1045"])).toBe(true);
    expect(looksSequential(["8812", "55120", "3", "900001"])).toBe(false);
    expect(looksSequential(["1", "2"])).toBe(false);
  });
});

describe("untilText", () => {
  it("rounds to the nearest useful unit", () => {
    const now = Date.parse("2026-10-28T12:00:00Z");
    expect(untilText("2026-10-28T12:00:40Z", now)).toBe("in 40s");
    expect(untilText("2026-10-28T12:05:00Z", now)).toBe("in 5m");
    expect(untilText("2026-10-28T14:05:00Z", now)).toBe("in 2h 5m");
    expect(untilText("2026-10-28T11:00:00Z", now)).toBe("passed");
  });
});

describe("checkEntrantIds", () => {
  it("passes opaque ids", () => {
    expect(
      labels(checkEntrantIds([entrant(HEX), entrant(`${HEX.slice(2)}aa`)]))
    ).toEqual(["✓ Entrant ids look opaque"]);
  });
  it("fails emails, usernames, and plain or sequential user ids", () => {
    const checks = checkEntrantIds([
      entrant("ada@example.com"),
      entrant("ada_l"),
      entrant("1041"),
      entrant("1042"),
      entrant("1043"),
    ]);
    expect(labels(checks)).toEqual([
      "✗ Entrant ids are not emails",
      "✗ Entrant ids are not usernames",
      "✗ Entrant ids are not your user ids",
    ]);
    expect(checks[2].detail).toContain("running in sequence");
  });
  it("notes UUIDs rather than failing them", () => {
    expect(
      labels(checkEntrantIds([entrant("3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b")]))
    ).toEqual(["i Entrant ids are UUIDs"]);
  });
});

describe("checkEntries", () => {
  it("notes when every entrant has one entry", () => {
    expect(labels(checkEntries([entrant("a"), entrant("b")]))).toEqual([
      "i Every entrant has 1 entry",
    ]);
  });
  it("passes a spread and notes an outlier", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      entrant(`e${i}`, 1 + (i % 3))
    );
    expect(labels(checkEntries(many))).toEqual(["✓ Entries look deliberate"]);
    const withOutlier = [...many, entrant("big", 5_000)];
    expect(labels(checkEntries(withOutlier))).toEqual([
      "✓ Entries look deliberate",
      "i One entrant has far more entries than the rest",
    ]);
  });
});

describe("checkCampaign", () => {
  it("reports a sandbox key sent to production as the key check", async () => {
    const { fetch } = scripted(json({ error: "unauthorized" }, 401));
    const c = new Prizerail({
      apiKey: "pr_sandbox_x",
      siteUrl: "https://www.prizerail.com",
      fetch,
    }).campaign("demo");
    const result = await checkCampaign(c);
    expect(result.ok).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].detail).toContain("pr_sandbox_ key");
  });

  it("reports an unknown campaign", async () => {
    const { fetch } = scripted(
      json({ error: "not_found", detail: "No such campaign." }, 404)
    );
    const result = await checkCampaign(client(fetch));
    expect(labels(result.checks)).toEqual([
      "✗ The campaign is under this key's account",
    ]);
  });

  it("fails a paused campaign with no open drawing", async () => {
    const { fetch } = scripted(json(campaign("paused", null)));
    const result = await checkCampaign(client(fetch));
    expect(labels(result.checks)).toEqual([
      "✓ The key works at https://sandbox.pr.test",
      '✗ Campaign "Demo" is active',
      "✗ A drawing is taking entries",
    ]);
  });

  it("checks the open drawing's ids and entries", async () => {
    const entrants = [entrant(HEX, 3), entrant(`${HEX.slice(2)}aa`, 1)];
    const { fetch, calls } = scripted(
      json(campaign()),
      entriesPage(entrants),
      entriesPage(entrants)
    );
    const result = await checkCampaign(client(fetch));
    expect(result.ok).toBe(true);
    expect(labels(result.checks)).toEqual([
      "✓ The key works at https://sandbox.pr.test",
      '✓ Campaign "Demo" is active',
      "✓ A drawing is taking entries",
      "✓ The open drawing has entries",
      "✓ Entrant ids look opaque",
      "✓ Entries look deliberate",
    ]);
    // Every entries read is pinned to the open drawing.
    expect(calls.slice(1).map(c => c.url.searchParams.get("drawing"))).toEqual([
      "d1",
      "d1",
    ]);
  });

  it("notes an empty drawing and won't draw it", async () => {
    const { fetch, calls } = scripted(json(campaign()), entriesPage([]));
    const result = await checkCampaign(client(fetch), { draw: true });
    expect(labels(result.checks).slice(3)).toEqual([
      "i The open drawing has no entries yet",
      "✗ A draw runs now",
    ]);
    expect(calls.some(c => c.method === "POST")).toBe(false);
  });

  it("fails draw now outside the sandbox", async () => {
    const entrants = [entrant(HEX)];
    const { fetch } = scripted(
      json(campaign()),
      entriesPage(entrants),
      entriesPage(entrants),
      json({ error: "sandbox_only" }, 403)
    );
    const result = await checkCampaign(client(fetch, "pr_prod_x"), {
      draw: true,
    });
    const last = result.checks.at(-1)!;
    expect(last).toMatchObject({ ok: false, label: "A draw runs now" });
    expect(last.detail).toContain("only in the sandbox");
  });

  it("stops polling a drawing that was skipped or needs attention", async () => {
    const entrants = [entrant(HEX)];
    const { fetch, calls } = scripted(
      json(campaign()),
      entriesPage(entrants),
      entriesPage(entrants),
      json({
        drawing: {
          id: "d1",
          status: "skipped",
          needsAttention: null,
          winners: [],
        },
      })
    );
    const result = await checkCampaign(client(fetch), {
      draw: true,
      pollMs: 1,
    });
    expect(result.checks.at(-1)).toMatchObject({
      ok: false,
      label: "A draw runs now",
    });
    expect(result.checks.at(-1)?.detail).toContain("without a draw");
    expect(
      calls.filter(c => c.url.pathname.endsWith("/drawings/d1"))
    ).toHaveLength(0);
  });

  it("reads the drawing when the run request got no answer, since it may have run", async () => {
    const entrants = [entrant(HEX)];
    const { fetch } = scripted(
      json(campaign()),
      entriesPage(entrants),
      entriesPage(entrants),
      new TypeError("fetch failed"),
      json({
        drawing: {
          id: "d1",
          status: "settled",
          needsAttention: null,
          winners: [{ position: 0, winner: HEX }],
        },
      }),
      json({
        format: "prizerail-draw-proof/3",
        campaign: { id: "c", name: "Demo" },
        drawing: { id: "d1", number: 1, drawAt: inAnHour() },
      })
    );
    const result = await checkCampaign(client(fetch), {
      draw: true,
      pollMs: 1,
    });
    expect(labels(result.checks).slice(-2)).toEqual([
      "✓ A draw runs now",
      "✗ Its proof verifies",
    ]);
  });

  it("says the draw didn't run when the request got no answer and the drawing is still open", async () => {
    const entrants = [entrant(HEX)];
    const { fetch } = scripted(
      json(campaign()),
      entriesPage(entrants),
      entriesPage(entrants),
      new TypeError("fetch failed"),
      json({
        drawing: {
          id: "d1",
          status: "open",
          needsAttention: null,
          winners: [],
        },
      })
    );
    const result = await checkCampaign(client(fetch), {
      draw: true,
      pollMs: 1,
    });
    expect(result.checks.at(-1)?.detail).toContain("didn't run");
  });

  it("verifies a settled drawing that is flagged for staff, with a note", async () => {
    const entrants = [entrant(HEX)];
    const { fetch } = scripted(
      json(campaign()),
      entriesPage(entrants),
      entriesPage(entrants),
      json({
        drawing: {
          id: "d1",
          status: "settled",
          needsAttention: "Campaign has no payout address",
          winners: [{ position: 0, winner: HEX }],
        },
      }),
      json({
        format: "prizerail-draw-proof/3",
        campaign: { id: "c", name: "Demo" },
        drawing: { id: "d1", number: 1, drawAt: inAnHour() },
      })
    );
    const result = await checkCampaign(client(fetch), {
      draw: true,
      pollMs: 1,
    });
    expect(labels(result.checks).slice(-3)).toEqual([
      "✓ A draw runs now",
      "i The drawing is flagged for staff",
      "✗ Its proof verifies",
    ]);
  });

  it("keeps the checks that passed when a later read throws", async () => {
    const { fetch } = scripted(
      json(campaign()),
      json({ error: "internal" }, 503),
      json({ error: "internal" }, 503),
      json({ error: "internal" }, 503),
      json({ error: "internal" }, 503),
      json({ error: "internal" }, 503)
    );
    const c = new Prizerail({
      apiKey: "pr_sandbox_x",
      siteUrl: "https://sandbox.pr.test",
      fetch,
      maxRetries: 0,
    }).campaign("demo");
    const result = await checkCampaign(c);
    expect(labels(result.checks)).toEqual([
      "✓ The key works at https://sandbox.pr.test",
      '✓ Campaign "Demo" is active',
      "✓ A drawing is taking entries",
      "✗ The check finished",
    ]);
  });

  it("gives the plain key message on a site that isn't prizerail.com", async () => {
    const { fetch } = scripted(json({ error: "unauthorized" }, 401));
    const result = await checkCampaign(client(fetch));
    expect(result.checks[0].detail).toContain(
      "Unknown or revoked key for this site"
    );
  });

  it("draws, polls until settled, and verifies the proof", async () => {
    const entrants = [entrant(HEX)];
    const settled = {
      id: "d1",
      status: "settled",
      needsAttention: null,
      winners: [{ position: 0, winner: HEX }],
    };
    const { fetch, calls } = scripted(
      json(campaign()),
      entriesPage(entrants),
      entriesPage(entrants),
      json({ drawing: { ...settled, status: "entropy_requested" } }),
      json({ drawing: settled }),
      // The proof: malformed on purpose, so verify reports a failed check
      // without a real draw's hashes.
      json({
        format: "prizerail-draw-proof/3",
        campaign: { id: "c", name: "Demo" },
        drawing: { id: "d1", number: 1, drawAt: inAnHour() },
      })
    );
    const result = await checkCampaign(client(fetch), {
      draw: true,
      pollMs: 1,
    });
    expect(calls.map(c => `${c.method} ${c.url.pathname}`).slice(3)).toEqual([
      "POST /api/v1/campaigns/demo/drawings/d1/run",
      "GET /api/v1/campaigns/demo/drawings/d1",
      "GET /campaigns/demo/draws/d1/proof.json",
    ]);
    expect(labels(result.checks).slice(-2)).toEqual([
      "✓ A draw runs now",
      "✗ Its proof verifies",
    ]);
    expect(result.drawing?.status).toBe("settled");
  });
});
