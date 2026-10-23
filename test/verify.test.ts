import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashEntrant, verifyDraw, wasEntered } from "../src/index.js";
import { winnerHash } from "../src/verify-draw.mjs";

describe("hashEntrant", () => {
  it("matches Node's createHmac", async () => {
    const key = "test-key-not-a-secret";
    for (const id of ["1042", 1042, "user-é"]) {
      expect(await hashEntrant(id, key)).toBe(
        createHmac("sha256", key).update(String(id)).digest("hex")
      );
    }
  });

  it("needs a key", async () => {
    await expect(hashEntrant("1", "")).rejects.toThrow("secret key");
  });
});

describe("wasEntered", () => {
  it("finds an entrant by the hash of their id", () => {
    const rows: [number, string, number][] = [
      [0, winnerHash("alice"), 1],
      [1, winnerHash("bob").toUpperCase().replace("0X", "0x"), 3],
    ];
    expect(wasEntered("bob", rows)).toEqual({
      index: 1,
      entries: 3,
    });
    expect(wasEntered("carol", rows)).toBeNull();
  });
});

describe("verifyDraw", () => {
  it("fails a malformed proof instead of throwing", async () => {
    const result = await verifyDraw({
      format: "prizerail-draw-proof/3",
      campaign: { id: "c", name: "C" },
      drawing: { id: "d", number: 1, drawAt: "2026-10-19T00:00:00Z" },
    } as never);
    expect(result.ok).toBe(false);
  });

  it("reads the entrant list with the fetch it's given", async () => {
    const urls: string[] = [];
    const fetch = (async (url: string) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({
          format: "prizerail-entrants/2",
          page: 1,
          pages: 1,
          entrants: [],
          next: null,
        })
      );
    }) as unknown as typeof globalThis.fetch;
    await verifyDraw(
      {
        format: "prizerail-draw-proof/3",
        campaign: { id: "c", name: "C" },
        drawing: { id: "d", number: 1, drawAt: "2026-10-19T00:00:00Z" },
        entrantList: {
          url: "entrants.json",
          root: "0x",
          count: 0,
          totalWeight: 0,
          winnersRequested: 1,
          lockedAt: null,
        },
      },
      { proofUrl: "https://pr.test/campaigns/c/draws/d/proof.json", fetch }
    );
    expect(urls).toEqual(["https://pr.test/campaigns/c/draws/d/entrants.json"]);
  });

  it("reads an entrant list it's given even when the proof has no link", async () => {
    const urls: string[] = [];
    const fetch = (async (url: string) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({
          format: "prizerail-entrants/2",
          page: 1,
          pages: 1,
          entrants: [],
          next: null,
        })
      );
    }) as unknown as typeof globalThis.fetch;
    await verifyDraw(
      {
        format: "prizerail-draw-proof/3",
        campaign: { id: "c", name: "C" },
        drawing: { id: "d", number: 1, drawAt: "2026-10-19T00:00:00Z" },
      },
      { entrants: "https://pr.test/list.json", fetch }
    );
    expect(urls).toEqual(["https://pr.test/list.json"]);
  });
});
