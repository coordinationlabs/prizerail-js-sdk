#!/usr/bin/env node
/**
 * Prizerail draw verifier. Checks a draw's proof without trusting Prizerail's
 * servers: it recomputes every number from the proof's inputs and reports any
 * that don't match.
 *
 *   node verify-draw.mjs <proof.json file or link>
 *
 * Needs Node.js 18 or later and nothing else. The hashing is written out
 * below so there's nothing to install; it checks itself against published
 * keccak256 test values before it runs. To cross-check with a library you
 * already trust, viem's keccak256 and encodeAbiParameters give the same
 * results.
 *
 * What it checks, in the order a draw happens. It's the same math the
 * Prizerail contract runs onchain:
 *
 * 1. The prize table's rolls add up: tier weights sum to the denominator,
 *    tiers run top prize first, and each threshold is the running total.
 * 2. The entrant list's root: an OpenZeppelin StandardMerkleTree over
 *    (uint256 index, bytes32 keccak256(bytes(entrantId)), uint64 weight).
 *    The tree sorts its leaves, so the root is a commitment to the set of
 *    entries, and the index is the only order: rows are sorted by index,
 *    and the indices must run exactly 0 to count - 1. A shuffled list gives
 *    the same root and the same winners.
 * 3. Each winner slot j's selection value: the first
 *    keccak256(abi.encode(bytes32 entropy, bytes32 campaignId,
 *    uint64 drawingNumber, bytes32 "prizerail.entrant", uint256 j, uint256 k))
 *    at or above 2^256 mod the weight of the entrants not picked yet. The
 *    pick is that value mod the same weight, and the winner is the entrant
 *    whose range holds it, counting the ones still in, in index order. They
 *    sit out later slots, unless the proof's entrantList.repeatWinners is
 *    true: then nobody sits out, and one entrant can fill several slots.
 * 4. Each winner's ID hashes to the entry the pick landed on.
 * 5. Each winner's random value is the first
 *    keccak256(abi.encode(bytes32 entropy, bytes32 campaignId,
 *    uint64 drawingNumber, uint256 position, uint256 k)) for k = 0, 1, …
 *    that is at least 2^256 mod denominator. The campaign ID is ASCII,
 *    right-padded to 32 bytes. In practice k is always 0.
 * 6. Their roll is random value mod denominator, 0 to denominator - 1.
 * 7. The prize is the first tier whose threshold is above the roll.
 * 8. The top prize is won at most once per draw. If two or more winners roll
 *    it, the one with the lowest random value keeps it and the others get
 *    the second prize. Only the top tier works this way.
 *
 * The list comes from the proof's entrantList.url, in pages, or a file:
 *
 *   node verify-draw.mjs <proof.json> [entrants.json file or link]
 *
 * Note: Python's hashlib.sha3_256 is NOT keccak256. They pad differently and
 * give different hashes, so a check written with it will always fail.
 */

/* ---------- keccak256 ---------- */

const MASK = (1n << 64n) - 1n;

const ROUND_CONSTANTS = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];

// Rotation for lane (x, y), indexed x + 5y.
const ROTATIONS = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18,
  2, 61, 56, 14,
];

const rotl = (lane, n) =>
  n === 0 ? lane : ((lane << BigInt(n)) | (lane >> BigInt(64 - n))) & MASK;

function keccakF(state) {
  for (const rc of ROUND_CONSTANTS) {
    // Theta
    const c = [0, 1, 2, 3, 4].map(
      x =>
        state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20]
    );
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) state[x + y] ^= d;
    }
    // Rho and pi
    const b = new Array(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(
          state[x + 5 * y],
          ROTATIONS[x + 5 * y]
        );
      }
    }
    // Chi
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        state[x + y] =
          b[x + y] ^ (~b[((x + 1) % 5) + y] & MASK & b[((x + 2) % 5) + y]);
      }
    }
    // Iota
    state[0] ^= rc;
  }
}

/** keccak256 as Ethereum and Solidity use it. Bytes in, 0x hex out. */
export function keccak256(bytes) {
  const rate = 136;
  // Keccak padding: 0x01, zeros, then 0x80 on the last byte of the block.
  const padded = new Uint8Array(Math.floor(bytes.length / rate) * rate + rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const state = new Array(25).fill(0n);
  for (let block = 0; block < padded.length; block += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) {
        lane = (lane << 8n) | BigInt(padded[block + i * 8 + j]);
      }
      state[i] ^= lane;
    }
    keccakF(state);
  }
  let hex = "0x";
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 8; j++) {
      hex += Number((state[i] >> BigInt(8 * j)) & 0xffn)
        .toString(16)
        .padStart(2, "0");
    }
  }
  return hex;
}

/* ---------- ABI encoding, as Solidity's abi.encode ---------- */

function word(value) {
  const out = new Uint8Array(32);
  let v = BigInt(value);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function hexBytes(hex) {
  if (!/^0x[0-9a-fA-F]*$/.test(hex) || hex.length % 2) {
    throw new Error(`not hex: ${hex}`);
  }
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  }
  return out;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** keccak256(bytes(winner)): how the contract takes each winner. */
export function winnerHash(winner) {
  return keccak256(new TextEncoder().encode(winner));
}

/** A campaign ID as bytes32: ASCII, right-padded. */
export function campaignIdBytes32(campaignId) {
  if (!/^[\x20-\x7e]{1,32}$/.test(campaignId)) {
    throw new Error(`campaign ID ${campaignId} isn't 1 to 32 ASCII characters`);
  }
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode(campaignId));
  return out;
}

/**
 * The first keccak256(abi.encode(bytes32 entropy, bytes32 campaignId,
 * uint64 drawingNumber, uint256 position, uint256 k)) at or above
 * 2^256 mod denominator.
 */
export function winnerRandomValue(
  entropy,
  campaignId,
  drawingNumber,
  position,
  denominator
) {
  const entropyBytes = hexBytes(entropy);
  if (entropyBytes.length !== 32) throw new Error("entropy must be 32 bytes");
  const threshold = (1n << 256n) % BigInt(denominator);
  const id = campaignIdBytes32(campaignId);
  for (let k = 0n; ; k++) {
    const r = keccak256(
      concat([entropyBytes, id, word(drawingNumber), word(position), word(k)])
    );
    if (BigInt(r) >= threshold) return r;
  }
}

/** random value mod denominator, 0 to denominator - 1 */
export function rollFor(randomValue, denominator) {
  return Number(BigInt(randomValue) % BigInt(denominator));
}

/** Index of the first tier, top prize first, whose threshold is above `roll`. */
export function tierForRoll(tiers, roll) {
  let threshold = 0;
  for (const [i, tier] of tiers.entries()) {
    threshold += tier.weight;
    if (roll < threshold) return i;
  }
  return -1;
}

/* ---------- Entrant list ---------- */

const HASH = /^0x[0-9a-fA-F]{64}$/;
const MAX_WEIGHT = 2 ** 32 - 1;
/** /2 rows carry their index. /1 rows didn't. */
const ENTRANTS_FORMATS = ["prizerail-entrants/1", "prizerail-entrants/2"];
/** More pages than any list has: 100,000 entrants at 20,000 a page is 5. */
const MAX_PAGES = 1000;

/** "prizerail.entrant", ASCII, right-padded to 32 bytes. */
const ENTRANT_TAG = (() => {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode("prizerail.entrant"));
  return out;
})();

const compareHex = (a, b) => {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** OpenZeppelin's sorted-pair hash. */
const hashPair = (a, b) =>
  keccak256(
    concat(
      compareHex(a, b) < 0
        ? [hexBytes(a), hexBytes(b)]
        : [hexBytes(b), hexBytes(a)]
    )
  );

/**
 * OpenZeppelin's standard leaf for entry `position`:
 * keccak256(keccak256(abi.encode(uint256 position, bytes32 hash, uint64 weight))).
 */
export function entrantLeaf(position, hash, weight) {
  return keccak256(
    hexBytes(keccak256(concat([word(position), hexBytes(hash), word(weight)])))
  );
}

/**
 * The root of OpenZeppelin's StandardMerkleTree over the list, given as
 * [hash, weight] in list order: leaves sorted, stored from the end of a flat
 * array, each node the sorted-pair hash of its two children.
 */
export function entrantsRoot(list) {
  if (list.length === 0) throw new Error("an entrant list can't be empty");
  const leaves = list
    .map(([hash, weight], position) => entrantLeaf(position, hash, weight))
    .sort(compareHex);
  const tree = new Array(2 * leaves.length - 1);
  for (const [i, leaf] of leaves.entries()) tree[tree.length - 1 - i] = leaf;
  for (let i = tree.length - 1 - leaves.length; i >= 0; i--) {
    tree[i] = hashPair(tree[2 * i + 1], tree[2 * i + 2]);
  }
  return tree[0];
}

/**
 * The winners picked from the list, slot by slot, as
 * { entrantIndex, selectionValue, pick }. Sums over the entrants still in
 * are kept in a Fenwick tree, so each pick and removal takes log time.
 */
export function selectWinners(
  entropy,
  campaignId,
  drawingNumber,
  list,
  winnerCount,
  repeat = false
) {
  const weights = list.map(([, weight]) => weight);
  const sums = new Array(weights.length + 1).fill(0);
  const add = (index, delta) => {
    for (let i = index + 1; i < sums.length; i += i & -i) sums[i] += delta;
  };
  const find = target => {
    let at = 0;
    let rest = target;
    for (let step = 2 ** Math.floor(Math.log2(sums.length)); step >= 1; ) {
      const next = at + step;
      if (next < sums.length && sums[next] <= rest) {
        at = next;
        rest -= sums[next];
      }
      step = Math.floor(step / 2);
    }
    return at;
  };
  for (const [i, w] of weights.entries()) add(i, w);
  let remaining = weights.reduce((a, b) => a + b, 0);
  const entropyBytes = hexBytes(entropy);
  const id = campaignIdBytes32(campaignId);
  const picks = [];
  const slots = repeat ? winnerCount : Math.min(winnerCount, list.length);
  for (let slot = 0; slot < slots; slot++) {
    const threshold = (1n << 256n) % BigInt(remaining);
    let r;
    for (let k = 0n; ; k++) {
      r = keccak256(
        concat([
          entropyBytes,
          id,
          word(drawingNumber),
          ENTRANT_TAG,
          word(slot),
          word(k),
        ])
      );
      if (BigInt(r) >= threshold) break;
    }
    const pick = Number(BigInt(r) % BigInt(remaining));
    const entrantIndex = find(pick);
    picks.push({ entrantIndex, selectionValue: r, pick });
    if (repeat) continue;
    add(entrantIndex, -weights[entrantIndex]);
    remaining -= weights[entrantIndex];
  }
  return picks;
}

/**
 * The top prize is won at most once per draw. Of the winners whose roll
 * lands in the top tier (index 0, top prize first), the lowest random value
 * keeps it and the rest get the second tier, index 1. Takes each winner's
 * { randomValue, tier } and returns the final tier indexes.
 */
export function applyTopTierRule(rolled) {
  let keeper = -1;
  for (const [i, w] of rolled.entries()) {
    if (
      w.tier === 0 &&
      (keeper === -1 ||
        BigInt(w.randomValue) < BigInt(rolled[keeper].randomValue))
    ) {
      keeper = i;
    }
  }
  return rolled.map((w, i) => (w.tier === 0 && i !== keeper ? 1 : w.tier));
}

/* ---------- Checking a proof ---------- */

const enc = new TextEncoder();
const SELF_TEST = [
  ["", "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"],
  ["abc", "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"],
];

const usd = cents =>
  `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: cents % 100 ? 2 : 0,
  })}`;

/**
 * Why a proof value can't be checked, naming its field, or "" if it can.
 * `want` is "string" or "whole number".
 */
function fieldProblem(value, field, want) {
  if (want === "string" ? typeof value === "string" : Number.isInteger(value)) {
    return "";
  }
  if (value === undefined || value === null) return `${field} is missing`;
  const got = Array.isArray(value) ? "a list" : `a ${typeof value}`;
  return `${field} is ${got}, not a ${want}`;
}

const isObject = value => typeof value === "object" && value !== null;

/**
 * A proof value as text for a check's label or detail, whatever JSON it is.
 * Turning an arbitrary object into a string can throw, so this never does.
 */
const show = value => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "an unreadable value";
  }
};

/** A number for arithmetic, or NaN for anything else, so a sum never throws. */
const num = value => (typeof value === "number" ? value : Number.NaN);

/**
 * Every check on a proof, as { ok, label, detail? }. `ok` is true, false, or
 * null for something worth knowing that the math can't settle.
 */
/** The draw contract's limits. */
const MAX_TIERS = 16;
const MAX_WINNERS = 500;

export function verifyProof(proof, entrants) {
  const checks = [];
  const check = (ok, label, detail) => checks.push({ ok, label, detail });

  for (const [input, want] of SELF_TEST) {
    if (keccak256(enc.encode(input)) !== want) {
      check(false, "keccak256 self-test", `hash of "${input}" is wrong`);
      return checks;
    }
  }

  if (!isObject(proof)) {
    check(false, "The proof is a JSON object");
    return checks;
  }
  const idProblem =
    fieldProblem(proof.campaign?.id, "campaign.id", "string") ||
    (/^[\x20-\x7e]{1,32}$/.test(proof.campaign.id)
      ? ""
      : "campaign.id isn't 1 to 32 ASCII characters");
  const keyProblems = [
    idProblem,
    fieldProblem(proof.drawing?.number, "drawing.number", "whole number"),
  ].filter(Boolean);
  if (keyProblems.length > 0) {
    check(
      false,
      "The proof names its campaign ID and drawing number",
      `${keyProblems.join(", ")}. This script reads ${proof.format ?? "an unknown format"} proofs only if they have both`
    );
    return checks;
  }

  const { denominator, tiers } = proof.prizeTable ?? {};
  if (!Array.isArray(tiers) || !tiers.every(isObject)) {
    check(
      false,
      "The proof has a prize table",
      "prizeTable.tiers is missing or isn't a list of tiers"
    );
    return checks;
  }
  if (!Array.isArray(proof.results) || !proof.results.every(isObject)) {
    check(
      false,
      "The proof has results",
      "results is missing or isn't a list of results"
    );
    return checks;
  }
  const total = tiers.reduce((n, t) => n + num(t.weight), 0);
  let running = 0;
  const tableOk =
    Number.isInteger(denominator) &&
    denominator > 0 &&
    tiers.length >= 2 &&
    tiers.length <= MAX_TIERS &&
    tiers.every(t => Number.isInteger(t.weight) && t.weight > 0) &&
    tiers.every(t => Number.isInteger(t.amountCents) && t.amountCents >= 0) &&
    total === denominator &&
    tiers.every(
      (t, i) => i === 0 || tiers[i - 1].amountCents >= t.amountCents
    ) &&
    tiers.every(t => {
      running += t.weight;
      return t.threshold === undefined || t.threshold === running;
    });
  check(
    tableOk,
    `Prize table: 2 to ${MAX_TIERS} tiers, weights adding up to ${total.toLocaleString("en-US")} of ${num(denominator).toLocaleString("en-US")} rolls, top prize first`
  );
  // Every prize below comes from the table, so there's nothing more to check.
  if (!tableOk) return checks;
  const withinLimit = proof.results.length <= MAX_WINNERS;
  check(
    withinLimit,
    `At most ${MAX_WINNERS} winners, the contract's limit (${proof.results.length})`
  );
  // The contract can't have drawn more, so don't spend time on the rest.
  if (!withinLimit) return checks;
  const resultAt = new Map(proof.results.map(r => [r.position, r]));

  const entrantList = proof.entrantList;
  if (!isObject(entrantList)) {
    check(
      false,
      "The proof has an entrant list",
      `not an entrants draw proof (${proof.format ?? "unknown format"}). This script checks prizerail-draw-proof/3 proofs`
    );
    return checks;
  }
  // Every pick and roll comes from the random value, but the list's root
  // doesn't, so a missing one still leaves the root to check.
  const entropy = proof.entropy?.value;
  const entropyProblem =
    fieldProblem(entropy, "entropy.value", "string") ||
    (HASH.test(entropy) ? "" : "entropy.value isn't 32 bytes of hex");
  if (entropyProblem) {
    check(
      false,
      "The proof has its random value",
      `${entropyProblem}, so no pick or roll was checked`
    );
  }
  const badPositions = proof.results
    .map((r, i) =>
      fieldProblem(r.position, `results[${i}].position`, "whole number")
    )
    .filter(Boolean);
  if (badPositions.length > 0) {
    check(false, "Every result has a position", badPositions.join(", "));
  }
  // The winners are the results in slot order, picked from the list.
  const winners = [...proof.results]
    .sort((a, b) => num(a.position) - num(b.position))
    .map(r => r.winner);
  checkEntrants(proof, entrants, check, resultAt, !entropyProblem);
  check(
    proof.results.length === winners.length,
    `One result per winner (${proof.results.length})`
  );
  if (!entropyProblem) checkRolls(proof, check, resultAt, winners);

  const { lockedAt } = entrantList;
  const { revealedAt, provider, requestId } = proof.entropy ?? {};
  // Both times are required: a proof without one could hide a list that
  // was locked after the random value was known.
  const isTime = value =>
    typeof value === "string" && !Number.isNaN(Date.parse(value));
  check(
    isTime(lockedAt) &&
      isTime(revealedAt) &&
      Date.parse(lockedAt) < Date.parse(revealedAt),
    "The list was locked before the random value was revealed",
    !isTime(lockedAt)
      ? "entrantList.lockedAt is missing or isn't a time"
      : !isTime(revealedAt)
        ? "entropy.revealedAt is missing or isn't a time"
        : "by Prizerail's own timestamps"
  );
  if (provider === "mock") {
    check(
      null,
      "Random value source: test randomness",
      "made by Prizerail in a test environment, so it can't be checked independently"
    );
  } else {
    check(
      null,
      `Random value source: ${show(provider)}${requestId ? ` request ${show(requestId)}` : ""}`,
      "this script doesn't look up the request onchain yet; check it on the chain's explorer"
    );
  }
  return checks;
}

/** Each winner's random value, roll and prize. */
function checkRolls(proof, check, resultAt, winners) {
  const entropy = proof.entropy.value;
  const { denominator, tiers } = proof.prizeTable;
  // Every winner's roll first, since the top-tier rule looks across them.
  const rolled = winners.map((_, position) => {
    const randomValue = winnerRandomValue(
      entropy,
      proof.campaign.id,
      proof.drawing.number,
      position,
      denominator
    );
    const roll = rollFor(randomValue, denominator);
    return { randomValue, roll, tier: tierForRoll(tiers, roll) };
  });
  const finalTiers = applyTopTierRule(rolled);
  for (const [position, winner] of winners.entries()) {
    const result = resultAt.get(position);
    const label = `Winner ${position} (${show(winner)})`;
    if (!result || result.winner !== winner) {
      check(false, label, "no result for this position and winner");
      continue;
    }
    const { randomValue, roll } = rolled[position];
    const tier = finalTiers[position];
    const amountCents = tier === -1 ? null : tiers[tier].amountCents;
    const demoted = rolled[position].tier === 0 && tier === 1;
    const problems = [
      fieldProblem(winner, "winner", "string"),
      fieldProblem(result.randomValue, "randomValue", "string") ||
        (randomValue !== result.randomValue.toLowerCase() &&
          `random value should be ${randomValue}`),
      fieldProblem(result.roll, "roll", "whole number") ||
        (roll !== result.roll && `roll should be ${roll}`),
      fieldProblem(result.amountCents, "amountCents", "whole number") ||
        (amountCents !== result.amountCents &&
          `prize should be ${amountCents === null ? "none" : usd(amountCents)}`),
    ].filter(Boolean);
    const wins = Number.isInteger(result.amountCents)
      ? usd(result.amountCents)
      : "an unstated prize";
    check(
      problems.length === 0,
      `${label}: roll ${roll.toLocaleString("en-US")} wins ${wins}${demoted ? ", the second prize, since another winner with a lower random value kept the top one" : ""}`,
      problems.join(", ") || undefined
    );
  }
}

/**
 * The entrant list's checks: its root, then every pick, if the proof has a
 * usable random value (`picksCheckable`).
 */
function checkEntrants(proof, entrants, check, results, picksCheckable) {
  const { root, count, totalWeight, winnersRequested } = proof.entrantList;
  // Proofs from before the setting have no field, and those draws took
  // each winner out.
  const repeat = proof.entrantList.repeatWinners === true;
  const repeatValue = proof.entrantList.repeatWinners;
  const fieldProblems = [
    repeatValue === undefined || typeof repeatValue === "boolean"
      ? ""
      : "entrantList.repeatWinners isn't true or false",
    fieldProblem(root, "entrantList.root", "string") ||
      (HASH.test(root) ? "" : "entrantList.root isn't 32 bytes of hex"),
    fieldProblem(count, "entrantList.count", "whole number") ||
      (count < 1 ? "entrantList.count is below 1" : ""),
    fieldProblem(totalWeight, "entrantList.totalWeight", "whole number") ||
      (Number.isSafeInteger(totalWeight)
        ? ""
        : "entrantList.totalWeight is too big"),
    fieldProblem(
      winnersRequested,
      "entrantList.winnersRequested",
      "whole number"
    ) ||
      (winnersRequested < 1 || winnersRequested > MAX_WINNERS
        ? `entrantList.winnersRequested isn't from 1 to ${MAX_WINNERS}`
        : ""),
  ].filter(Boolean);
  if (fieldProblems.length > 0) {
    check(
      false,
      "The proof's entrant list fields are well formed",
      fieldProblems.join(", ")
    );
    return;
  }
  // Without repeat winners each entrant fills at most one slot, so the draw
  // has as many winners as asked for, or as entrants if fewer. With them,
  // every slot asked for is filled. Draws the first contracts ran never
  // repeat, so their proofs say false or leave the field out.
  const expected = repeat
    ? winnersRequested
    : Math.min(winnersRequested, count);
  check(
    proof.results.length === expected,
    `${expected} winner${expected === 1 ? "" : "s"}: ${winnersRequested} asked for, from ${count.toLocaleString("en-US")} entrants${repeat ? ", repeat winners allowed" : ""}`
  );
  if (!Array.isArray(entrants)) {
    // The root and the picks are what make an entrants draw checkable, so
    // a run that couldn't load the list hasn't verified the draw.
    check(
      false,
      "Entrant list loaded",
      "the root and the picks weren't checked. Pass the proof's link, or the list's link or file as a second argument"
    );
    return;
  }
  const bad = entrants.findIndex(
    e =>
      !Array.isArray(e) ||
      e.length !== 3 ||
      !Number.isInteger(e[0]) ||
      typeof e[1] !== "string" ||
      !HASH.test(e[1]) ||
      !Number.isInteger(e[2]) ||
      e[2] < 1 ||
      e[2] > MAX_WEIGHT
  );
  if (bad !== -1) {
    check(
      false,
      "Entrant list is well formed",
      `row ${bad} isn't [index, 32-byte hash, whole weight from 1 to 2^32 - 1]`
    );
    return;
  }
  // The root is a set commitment: the index in each row is the list's only
  // order, so rows are sorted by it, and the indices must be exactly
  // 0 to count - 1, with no duplicate, gap or stray.
  const sorted = [...entrants].sort((a, b) => a[0] - b[0]);
  const stray = sorted.findIndex((e, i) => e[0] !== i);
  if (stray !== -1) {
    check(
      false,
      `Entrant indices run exactly 0 to ${(entrants.length - 1).toLocaleString("en-US")}`,
      `found index ${sorted[stray][0]} where ${stray} belongs, so the list has a duplicate, a gap or a stray index`
    );
    return;
  }
  const list = sorted.map(([, hash, weight]) => [hash, weight]);
  const total = list.reduce((n, [, weight]) => n + weight, 0);
  const sized =
    entrants.length === count &&
    Number.isSafeInteger(total) &&
    total === totalWeight;
  check(
    sized,
    `Entrant list has ${count.toLocaleString("en-US")} entrants and ${totalWeight.toLocaleString("en-US")} total weight`,
    sized ? undefined : `got ${entrants.length} entrants and ${total} weight`
  );
  // The root and the picks are only defined for the committed list.
  if (!sized) return;
  const computed = entrantsRoot(list);
  check(
    computed === root.toLowerCase(),
    "Entrant list root matches the list",
    computed === root.toLowerCase() ? undefined : `computed ${computed}`
  );
  if (!picksCheckable) return;
  const picks = selectWinners(
    proof.entropy.value,
    proof.campaign.id,
    proof.drawing.number,
    list,
    expected,
    repeat
  );
  for (const [slot, pick] of picks.entries()) {
    const result = results.get(slot);
    const label = `Slot ${slot} pick`;
    if (!result) {
      check(false, label, "no result for this slot");
      continue;
    }
    const entry = list.at(pick.entrantIndex);
    const problems = [
      fieldProblem(result.selectionValue, "selectionValue", "string") ||
        (pick.selectionValue !== result.selectionValue.toLowerCase() &&
          `selection value should be ${pick.selectionValue}`),
      fieldProblem(result.pick, "pick", "whole number") ||
        (pick.pick !== result.pick && `pick should be ${pick.pick}`),
      fieldProblem(result.entrantPosition, "entrantPosition", "whole number") ||
        (pick.entrantIndex !== result.entrantPosition &&
          `winner should be entrant ${pick.entrantIndex}`),
      fieldProblem(result.winner, "winner", "string") ||
        (winnerHash(result.winner) !== entry[0].toLowerCase() &&
          `${result.winner} doesn't hash to entrant ${pick.entrantIndex}`),
    ].filter(Boolean);
    check(
      problems.length === 0,
      `${label}: lands on entrant ${pick.entrantIndex.toLocaleString("en-US")} (${show(result.winner)})`,
      problems.join(", ") || undefined
    );
  }
}

/**
 * Reads JSON from a link or a file. Links use `fetch` (the global one by
 * default) and give up after `timeoutMs`.
 */
async function readJson(
  source,
  { fetch = globalThis.fetch, timeoutMs = 30_000 } = {}
) {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`);
    return response.json();
  }
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(source, "utf8"));
}

/**
 * Every page of an entrant list, as [index, hash, weight] rows in the order
 * served (checkEntrants sorts them by index). Pages are followed in order,
 * on the site the first one came from, exactly up to the page count the
 * first page states. A prizerail-entrants/1 page, from before rows carried
 * their index, has [hash, weight] rows indexed by place. `options` can
 * carry the `fetch` to use and a per-page `timeoutMs`.
 */
export async function readEntrants(source, options = {}) {
  const remote = /^https?:\/\//.test(source);
  const origin = remote ? new URL(source).origin : null;
  const list = [];
  let next = source;
  let pages = null;
  for (let expected = 1; ; expected++) {
    const page = await readJson(next, options);
    if (!isObject(page)) {
      throw new Error(`${next} isn't page ${expected} of the entrant list`);
    }
    pages ??= page.pages;
    if (
      page.page !== expected ||
      page.pages !== pages ||
      !Number.isInteger(pages) ||
      pages < 1 ||
      pages > MAX_PAGES ||
      !Array.isArray(page.entrants) ||
      !ENTRANTS_FORMATS.includes(page.format)
    ) {
      throw new Error(`${next} isn't page ${expected} of the entrant list`);
    }
    if (page.format === "prizerail-entrants/1") {
      if (!Number.isInteger(page.from)) {
        throw new Error(`${next} is a /1 page with no "from"`);
      }
      const bad = page.entrants.findIndex(row => !Array.isArray(row));
      if (bad !== -1) {
        throw new Error(`${next} row ${bad} isn't a list`);
      }
      list.push(...page.entrants.map((row, i) => [page.from + i, ...row]));
    } else {
      list.push(...page.entrants);
    }
    if (!page.next) {
      if (expected < pages) {
        throw new Error(
          `${next} is page ${expected} of ${pages} but links no further`
        );
      }
      return list;
    }
    if (!remote) {
      throw new Error(
        `${next} is one page of ${pages}. Pass the list's link instead, so every page is fetched.`
      );
    }
    if (expected >= pages) {
      throw new Error(`${next} links past the list's last page, ${pages}`);
    }
    const url = new URL(page.next, next);
    if (url.origin !== origin) {
      throw new Error(`${url.href} is on another site, so it wasn't fetched`);
    }
    next = url.href;
  }
}

async function main() {
  const source = process.argv[2];
  if (!source) {
    console.log(
      "Usage: node verify-draw.mjs <proof.json file or link> [entrants.json file or link]"
    );
    process.exit(2);
  }
  const proof = await readJson(source);
  let entrants;
  if (proof?.entrantList) {
    const listUrl = proof.entrantList.url;
    const listSource =
      process.argv[3] ??
      (/^https?:\/\//.test(source) && typeof listUrl === "string"
        ? new URL(listUrl, source).href
        : undefined);
    if (listSource) entrants = await readEntrants(listSource);
  }
  console.log(
    `\n${show(proof?.campaign?.name ?? "Unnamed campaign")}, draw of ${show(proof?.drawing?.drawAt ?? "an unknown time")} (${show(proof?.drawing?.id ?? "no draw ID")})\n`
  );
  const checks = verifyProof(proof, entrants);
  for (const { ok, label, detail } of checks) {
    const mark = ok === true ? "✓" : ok === false ? "✗" : "i";
    console.log(`${mark} ${label}${detail ? `\n    ${detail}` : ""}`);
  }
  const failed = checks.filter(c => c.ok === false).length;
  console.log(
    failed
      ? `\n${failed} check${failed === 1 ? "" : "s"} failed.`
      : "\nEvery result follows from the inputs."
  );
  process.exit(failed ? 1 : 0);
}

// Run main() only when called as a script, not when imported.
if (typeof process !== "undefined" && process.argv?.[1]) {
  const { pathToFileURL } = await import("node:url");
  if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
      console.error(error.message);
      process.exit(2);
    });
  }
}
