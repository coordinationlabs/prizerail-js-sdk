---
name: prizerail-draw
description: "Check the status of a Prizerail campaign's draws (whether a draw is open, locked, drawn or paid, who won what), independently verify a draw using only public endpoints, and answer how Prizerail works from its docs. Use when someone asks about a Prizerail draw, its winners or prizes, whether it has been drawn or paid, or wants to verify or audit one, and when they ask how Prizerail works: entries and winning, sending entries and cutoffs, who can enter, how winners claim and are ID-checked, or free entry."
---

# Prizerail draws: status and verification

Prizerail runs prize draws for partner apps. Through each period the partner sends Prizerail its entrants. At the cutoff Prizerail locks the entrant list, a random value draws the winners from it and decides each winner's prize from the campaign's prize table, and the prizes are sent to the partner to pay out. Everything below uses public endpoints: no keys, no accounts.

**Never compute the hashes yourself.** keccak256 can't be done reliably by reasoning, and Python's `hashlib.sha3_256` is a different hash (different padding) that gives different answers. Run the verify script below and report what it prints.

## Concepts

- **Campaign:** a partner's draw, found by its slug in `https://www.prizerail.com/campaigns/{slug}`. Draws run on a schedule (hourly, daily, weekly or monthly) in the campaign's time zone.
- **Entrants:** the partner sends them, each an id with a number of `entries` (1 unless it sends more), which the proof calls its `weight`. Nobody picks who wins: the random value draws the winners from the locked list, each entrant in proportion to their weight, and nobody wins twice in one draw. A draw proves the winners and prizes are fair for the list it was given.
- **Cutoff:** the partner can send entries until `cutoffAt`. Each campaign sets how long before `drawAt` that is, from minutes to days.
- **Entrant list fingerprint:** the root of an OpenZeppelin `StandardMerkleTree` over `(uint256 index, bytes32 keccak256(bytes(entrantId)), uint64 weight)`. The tree sorts its leaves, so the root commits to the set of entries and the index is the only order: indices must run exactly 0 to `count - 1`. It is recorded and published, with the hashed list, when the list locks, before the random value exists.
- **Winners:** for slot `j`, `r` is the first `keccak256(abi.encode(bytes32 entropy, bytes32 campaignId, uint64 drawingId, bytes32 "prizerail.entrant", uint256 j, uint256 k))` for `k = 0, 1, …` that is at least `2^256 mod remaining`, where `remaining` is the weight of the entrants not drawn yet. `pick = r mod remaining`, and the winner is the entrant whose run of weight holds `pick`, counting the ones still in, in index order
- **Prize:** the same math the Prizerail contract runs onchain. For the winner in slot `i`:
  - `campaignId` is the proof's `campaign.id` as ASCII, right-padded to 32 bytes, and `drawingId` is `drawing.number`
  - `randomValue` is the first `keccak256(abi.encode(bytes32 entropy, bytes32 campaignId, uint64 drawingId, uint256 i, uint256 k))` for `k = 0, 1, …` that is at least `2^256 mod denominator`. In practice `k` is always 0
  - `roll = randomValue mod denominator`, from 0 to `denominator - 1`
  - the prize is the first tier in the proof's list whose `threshold` is above `roll`. Tiers run top prize first, each `weight` rolls wide
  - the top prize is won at most once per draw. If two or more winners roll it, the one with the lowest `randomValue` (as a 256-bit number) keeps it, and every other one gets the second tier. Only the top tier works this way
- **Guarantee draws:** a draw with `kind: "guarantee"` is a guarantee period's own draw: one winner, picked from everyone who entered the period, each person once. Its proof's `campaign.id` ends in `-g`, its own drawing-number sequence, and both prize tiers pay the guarantee amount. Verify it like any draw.
- **Random value source:** real campaigns draw with Pyth Entropy through the Prizerail contract on Base mainnet, which isn't live yet, so no real campaign has drawn. Test draws on Base Sepolia use Pyth through the same contract, with `entropy.provider` set to `pyth`, and their proof's `entropy.chain` names the contract and transactions to check onchain. Older test draws have source `mock`, test randomness made by Prizerail. A `mock` draw can't be checked independently, so its order "locked before the random value" rests on Prizerail's own timestamps. Say so when you report on one.

## Questions about how Prizerail works

For questions beyond one draw, such as whether a person can win twice, how partners send entries, when draws close, how winners claim and are ID-checked, who can enter, or how free entry works, answer from the docs rather than from memory: the [Partner FAQ](https://docs.prizerail.com/getting-started/faq) and [Winners and eligibility](https://docs.prizerail.com/campaigns/winners), or all of the docs at [llms-full.txt](https://docs.prizerail.com/llms-full.txt). Say when something there is marked as coming soon.

## Stages

| `stage` | Meaning | What's public |
|---|---|---|
| `open` | Taking entries until `cutoffAt` | Times only |
| `locked` | Entrant list locked | `winnersCommitment` (the list's fingerprint), `entrants` (count, total weight, link to the hashed list), `lockedAt` |
| `drawing` | Random value requested | The same |
| `drawn` | Prizes decided | `proof` link with every input and result |
| `paid` | Prizes sent to the partner to pay winners | The same, plus `paidAt` |

A draw still `open` well after its `cutoffAt`, or stuck in `locked` or `drawing` for more than about 30 minutes after `drawAt`, is behind. Say so.

## Endpoints

Base `https://www.prizerail.com`. Public, with CORS `*`.

| Endpoint | Returns |
|---|---|
| `GET /campaigns/{slug}/draws.json` | `campaign` (name, status, cadence, timezone, winnersPerDraw, payout chain and token), `draws[]` newest first (`id`, `number`, `drawAt`, `cutoffAt`, `stage`, `winners`, `winnersCommitment`, `entrants`, `lockedAt`, `settledAt`, `paidAt`, `proof`), and `nextBefore`. Page back with `?before={nextBefore}`. `?limit=` up to 100, default 30 |
| `GET /campaigns/{slug}/draws/{id}/proof.json` | A drawn draw's proof: `entrantList` (`root`, `count`, `totalWeight`, `winnersRequested`, `lockedAt`, `url` of the list), `entropy` (`provider`, `requestId`, `value`, `revealedAt`), `prizeTable` (`denominator`, `tiers[]` of `amountCents` and `weight`), `results[]` (`position`, `winner`, `displayName`, `entrantPosition`, `selectionValue`, `pick`, `randomValue`, `roll`, `amountCents`). `displayName` is the partner's public name for the winner, shown only and never hashed. |
| `GET /campaigns/{slug}/draws/{id}/entrants.json?page=1` | A locked draw's entrant list, hashed: `entrants[]` of `[index, keccak256(bytes(entrantId)), weight]` sorted by index, 20,000 a page, with `root`, `count`, `totalWeight`, `page`, `pages` and `next` |
| `GET /verify/verify-draw.mjs` | The verify script (Node.js 18+, no dependencies) |

Amounts are US cents: `amountCents: 1000` is $10. Times are ISO 8601 in UTC. Show them in the user's time zone if you know it, otherwise in UTC.

An unknown campaign returns `404 {"error": "No such campaign."}`, and a draw that isn't drawn yet returns `404` for its proof.

## Workflow: status of a campaign's draws

1. **Find the slug.** It is the last part of the campaign page's link. If the user gives a name instead, ask for the link.
2. **Fetch** `GET /campaigns/{slug}/draws.json`.
3. **Pick the draw.**
   - "next" or "today's": the earliest `open` draw.
   - "latest": the newest `drawn` or `paid` draw.
   - A date: the draw whose `drawAt` falls on that date in the campaign's `timezone`.
4. **Report** in this shape.

```
{campaign.name}: draw of {drawAt}. Stage: {stage}
Entrants: {entrants.count} entrants, fingerprint {winnersCommitment}, locked {lockedAt}
Prizes: {for each result: winner, roll, prize}   (from the proof, once drawn)
Proof: {proof link}
```

## Verify a draw

Run this whenever asked to verify, audit or double-check a draw:

```sh
curl -sO https://www.prizerail.com/verify/verify-draw.mjs
node verify-draw.mjs https://www.prizerail.com/campaigns/{slug}/draws/{id}/proof.json
```

The script is short and readable. Read it first if the user wants to know what it does. It:

- tests its own keccak256 against published values
- checks that the prize table's weights add up to its denominator
- fetches the hashed entrant list and recomputes its fingerprint
- redraws every winner from the list, and checks each winner's id hashes to the entry their pick landed on
- recomputes every winner's random value, roll and prize, and compares them with the proof

It prints `✓` for a check that passes, `✗` for one that fails, and `i` for information the math can't settle (such as the random value's source). It exits 0 only if nothing failed. Report each `✗` and `i` line to the user as printed.

If the user can't run code, the campaign page has a "Verify in your browser" button on each draw that runs the same script. Mention that it runs on Prizerail's own site, so downloading and running the script is the independent check.

To cross-check with a library instead, viem's `keccak256(encodeAbiParameters(...))` with the types above gives the same values.

## Gotchas

- **The index is the order, not the row.** A shuffled `entrants.json` gives the same root and winners. A duplicate, missing or out-of-range index makes the list invalid, and the verify script reports it.
- **Rolls run from 0 to `denominator - 1`.**
- **Tier order:** tiers in the proof are top prize first, and the top prize owns the lowest rolls.
- **One top prize per draw:** a winner whose roll lands in the top tier can still get the second prize, if another winner rolled the top tier with a lower random value. That's the rule working, not a mismatch.
- **A slot's prize doesn't depend on who fills it.** Each slot's roll uses only the random value, the campaign, the draw's number and the slot.
- **Fairness scope:** the proof shows the winners and prizes follow from the list and the random value. Whether the right people are on the list is the partner's own record of who entered. Anyone on it can check they're in from their own id.
- **Entrant IDs are public, hashed.** Every locked list is published hashed, and winners' IDs are in each proof. If you're helping a partner choose IDs, recommend an HMAC of their user ID with a secret key, kept fixed for the campaign, or a random ID they store. Never suggest a plain hash: a hash of a sequential or public user ID can be reversed by hashing guesses. Never use emails or usernames.
