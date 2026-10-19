import {
  type Check,
  type EntrantRow,
  readEntrants,
  verifyProof,
  winnerHash,
} from "./verify-draw.mjs";

export type { Check, EntrantRow };

/**
 * A draw's proof, `prizerail-draw-proof/3`. The fields the SDK reads are
 * typed, and verifyDraw checks the rest, so treat a proof from elsewhere
 * as untrusted until it has.
 */
export type DrawProof = {
  format: string;
  campaign: { id: string; slug?: string; name: string };
  drawing: { id: string; number: number; drawAt: string };
  entrantList?: {
    url: string;
    root: string;
    count: number;
    totalWeight: number;
    winnersRequested: number;
    lockedAt: string | null;
  };
  [field: string]: unknown;
};

export type VerifyResult = {
  /** True when no check failed. Checks with `ok: null` are notes. */
  ok: boolean;
  checks: Check[];
  proof: DrawProof;
  /** The locked entrant list, when the draw has one and it was read. */
  entrants?: EntrantRow[];
};

export type VerifyOptions = {
  /**
   * The entrant list: rows already read, or a link or file to read them
   * from. By default, the proof's own `entrantList.url`.
   */
  entrants?: EntrantRow[] | string;
  /** Where a proof passed as an object came from, to find its list. */
  proofUrl?: string;
  /** Used for the proof and each page of the list. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Per request. Defaults to 30 seconds. */
  timeoutMs?: number;
};

const isUrl = (s: string) => /^https?:\/\//.test(s);

async function readProof(
  source: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<DrawProof> {
  if (isUrl(source)) {
    const res = await fetchImpl(source, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${source}: HTTP ${res.status}`);
    return (await res.json()) as DrawProof;
  }
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(source, "utf8")) as DrawProof;
}

/**
 * Checks a draw from its proof alone: the entrant list's fingerprint, the
 * random value, and each winner and prize. `source` is the proof, or a link
 * or file path to it. This is the same code as the public verify script.
 */
export async function verifyDraw(
  source: string | DrawProof,
  {
    entrants,
    proofUrl,
    fetch: fetchImpl = globalThis.fetch,
    timeoutMs = 30_000,
  }: VerifyOptions = {}
): Promise<VerifyResult> {
  const base = typeof source === "string" ? source : proofUrl;
  const proof =
    typeof source === "string"
      ? await readProof(source, fetchImpl, timeoutMs)
      : source;
  let rows = Array.isArray(entrants) ? entrants : undefined;
  // A list the caller names wins. Otherwise the proof's own link, if any.
  const listUrl = proof.entrantList?.url;
  const listSource =
    typeof entrants === "string"
      ? entrants
      : rows || typeof listUrl !== "string"
        ? undefined
        : base && isUrl(base)
          ? new URL(listUrl, base).href
          : isUrl(listUrl)
            ? listUrl
            : undefined;
  if (listSource) {
    rows = await readEntrants(listSource, { fetch: fetchImpl, timeoutMs });
  }
  let checks: Check[];
  try {
    checks = verifyProof(proof, rows);
  } catch (error) {
    // A proof missing a field the checks need is a failed draw, not a crash.
    checks = [
      {
        ok: false,
        label: "The proof is well formed",
        detail: error instanceof Error ? error.message : String(error),
      },
    ];
  }
  return {
    ok: !checks.some(c => c.ok === false),
    checks,
    proof,
    entrants: rows,
  };
}

/**
 * Where an entrant id is in a locked list, or null if it isn't there. The
 * list holds keccak256 of each id, so this hashes the id and looks it up.
 */
export function wasEntered(
  entrantId: string,
  rows: EntrantRow[]
): { index: number; weight: number } | null {
  const hash = winnerHash(entrantId);
  const row = rows.find(r => r[1].toLowerCase() === hash);
  return row ? { index: row[0], weight: row[2] } : null;
}
