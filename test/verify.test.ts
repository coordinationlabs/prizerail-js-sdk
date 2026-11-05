import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashEntrant, verifyDraw, wasEntered } from "../src/index.js";
import * as script from "../src/verify-draw.mjs";
import {
  type EntrantRow,
  entrantsRoot,
  verifyProof,
  winnerHash,
} from "../src/verify-draw.mjs";

// Runtime exports of the verify script that its .d.mts doesn't declare.
type Rolled = { randomValue: string; roll: number; tier: number };
const helpers = script as unknown as {
  selectWinners(
    entropy: string,
    campaignId: string,
    drawingNumber: number,
    list: [string, number][],
    winnerCount: number,
    repeat?: boolean
  ): { entrantIndex: number; selectionValue: string; pick: number }[];
  winnerRandomValue(
    entropy: string,
    campaignId: string,
    drawingNumber: number,
    position: number,
    denominator: number
  ): string;
  rollFor(randomValue: string, denominator: number): number;
  tierForRoll(tiers: { weight: number }[], roll: number): number;
  applyTopTierRule(rolled: Rolled[]): number[];
};

const ENTROPY = `0x${"5a".repeat(32)}`;
const TIERS = [
  { amountCents: 10_000, weight: 1 },
  { amountCents: 500, weight: 9 },
  { amountCents: 100, weight: 90 },
];

/**
 * An honest draw over `ids` (weights 1, 2, 3, ...), built with the script's
 * own math, so verifyProof should pass it unchanged.
 */
function honestDraw(ids: string[], winnersRequested: number, repeat: boolean) {
  const campaignId = "repeat-test";
  const drawingNumber = 3;
  const entrants: EntrantRow[] = ids.map((id, i) => [i, winnerHash(id), i + 1]);
  const list = entrants.map(([, hash, weight]): [string, number] => [
    hash,
    weight,
  ]);
  const slots = repeat
    ? winnersRequested
    : Math.min(winnersRequested, ids.length);
  const picks = helpers.selectWinners(
    ENTROPY,
    campaignId,
    drawingNumber,
    list,
    slots,
    repeat
  );
  const rolled = picks.map((_, position) => {
    const randomValue = helpers.winnerRandomValue(
      ENTROPY,
      campaignId,
      drawingNumber,
      position,
      100
    );
    const roll = helpers.rollFor(randomValue, 100);
    return { randomValue, roll, tier: helpers.tierForRoll(TIERS, roll) };
  });
  const tiers = helpers.applyTopTierRule(rolled);
  const proof = {
    format: "prizerail-draw-proof/3",
    campaign: { id: campaignId, name: "Repeat test" },
    drawing: { id: "d", number: drawingNumber, drawAt: "2026-11-05T00:00:00Z" },
    entrantList: {
      root: entrantsRoot(list),
      count: ids.length,
      totalWeight: list.reduce((n, [, w]) => n + w, 0),
      winnersRequested,
      repeatWinners: repeat,
      lockedAt: null,
    },
    entropy: { provider: "mock", value: ENTROPY },
    prizeTable: { denominator: 100, tiers: TIERS },
    results: picks.map((p, position) => ({
      position,
      winner: ids[p.entrantIndex],
      entrantPosition: p.entrantIndex,
      selectionValue: p.selectionValue,
      pick: p.pick,
      randomValue: rolled[position].randomValue,
      roll: rolled[position].roll,
      amountCents: TIERS[tiers[position]].amountCents,
    })),
  };
  return { proof, entrants };
}

const failures = (proof: unknown, entrants: EntrantRow[]) =>
  verifyProof(proof, entrants).filter(c => c.ok === false);

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

describe("verifyProof with repeat winners", () => {
  const ids = ["ana", "ben", "cy", "dee", "eli"];

  it("passes a draw that fills more slots than there are entrants", () => {
    const { proof, entrants } = honestDraw(ids, 40, true);
    expect(proof.results).toHaveLength(40);
    const winners = proof.results.map(r => r.winner);
    expect(new Set(winners).size).toBeLessThan(winners.length);
    expect(failures(proof, entrants)).toEqual([]);
  });

  it("fails a repeat-winners proof cut down to one slot per entrant", () => {
    const { proof, entrants } = honestDraw(ids, 40, true);
    const cut = { ...proof, results: proof.results.slice(0, ids.length) };
    expect(failures(cut, entrants).length).toBeGreaterThan(0);
  });

  it("fails the same picks checked as a once-per-draw draw", () => {
    const { proof, entrants } = honestDraw(ids, 4, true);
    const flipped = {
      ...proof,
      entrantList: { ...proof.entrantList, repeatWinners: false },
    };
    expect(failures(proof, entrants)).toEqual([]);
    expect(failures(flipped, entrants).length).toBeGreaterThan(0);
  });

  it("still checks older proofs with no repeatWinners field once per draw", () => {
    const { proof, entrants } = honestDraw(ids, 8, false);
    expect(proof.results).toHaveLength(ids.length);
    const { repeatWinners: _, ...older } = proof.entrantList;
    expect(failures({ ...proof, entrantList: older }, entrants)).toEqual([]);
  });
});
