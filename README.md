# prizerail

The Prizerail SDK for JavaScript and TypeScript. Send entries, read results and prizes, and verify any draw from its public proof.

- Typed client for the [partner API](https://docs.prizerail.com/api/authentication), with paging and safe retries.
- `verifyDraw`, the same checks as the public verify script, plus `wasEntered` to find someone in a locked list.
- `npx prizerail verify` from the command line.
- No dependencies. Node 20 or later, Deno, Bun, and edge runtimes with `fetch` and WebCrypto.

```sh
npm install prizerail
```

The API is early (v0.x), so names can change between minor versions. 0.3.0 adds `entries.increment()`. 0.2.0 says `entries` where 0.1.0 said `weight`: an entrant is `{ entrantId, entries }`, and totals are `entrantCount` and `totalEntries`. The old names still work, marked deprecated. Each change is in the [changelog](https://docs.prizerail.com/changelog).

## Send entries

```ts
import { Prizerail, hashEntrant } from "prizerail"

const prizerail = new Prizerail({ apiKey: process.env.PRIZERAIL_API_KEY })
const campaign = prizerail.campaign("your-campaign")

const entries = await Promise.all(
  users.map(async user => ({
    entrantId: await hashEntrant(user.id, process.env.ENTRANT_ID_KEY!),
    entries: user.tickets,
  }))
)

const result = await campaign.entries.send(entries)
// { drawing: { id, drawAt, cutoffAt }, sent, added, updated, unchanged, entrantCount, totalEntries, batches }
```

`entrantCount` and `totalEntries` are the drawing's own totals, so reconcile with those. `added`, `updated` and `unchanged` add up what each batch reported, and a batch that was stored before its response was lost comes back as `unchanged` on the retry.

`send` takes any number of entries and sends them in requests of 1,000. It retries a `429`, a `5xx`, a timeout or a network error with a jittered, growing wait, and honors `Retry-After`.

Sending an entrant again before the cutoff only sets their entries, so a retry is safe until then. After the cutoff a retry would go to the next drawing, so every send is pinned to one drawing:

- Before the first batch it reads which drawing is taking entries, or uses the `drawing` you pass.
- It sends no batch and starts no retry within the request timeout (30 seconds) of that drawing's cutoff. It throws `PrizerailCutoffError` instead.
- If a batch still lands in another drawing, it throws `PrizerailDrawingChangedError`.

Both errors carry `progress`, which says how many entries the drawing confirmed. Check what it has with `entries.list({ drawing })` before you send the rest.

```ts
import { PrizerailCutoffError } from "prizerail"

try {
  await campaign.entries.send(entries)
} catch (error) {
  if (!(error instanceof PrizerailCutoffError)) throw error
  console.log(`${error.progress.sent} sent to ${error.progress.drawing.id}`)
}
```

### Add entries as they happen

If you'd rather add entries when a user does something than send their running total, use `increment`. Each event carries an `eventId`, the id of the thing that happened, such as an order id or a referral id:

```ts
await campaign.entries.increment([
  { entrantId, entries: 10, eventId: referral.id },
])
// { added, updated, duplicates, sent, batches, drawings }
```

Prizerail records each `eventId` for the campaign and ignores it if it comes again, so retries and a queue that delivers an event twice never add twice, even across a cutoff. Set the id once, when the event happens, and send the same one every time. An id made fresh on each attempt would add the entries again. If you have no id for the event, make a UUID when it happens and store it with the event.

An increment goes to the drawing taking entries when it arrives, so an event after a cutoff counts in the next draw. `drawings` lists each drawing the batches went to.

### Entrant ids

Every locked list is published, hashed. Use an id that can't be guessed or linked back to a person. `hashEntrant(userId, key)` gives the HMAC-SHA256 of the user id as hex, the same as Node's `createHmac("sha256", key).update(id).digest("hex")`. Keep the key secret, and fixed for the life of the campaign. See [Entrant ids](https://docs.prizerail.com/getting-started/concepts#make-entrant-ids-with-an-hmac).

### Check what Prizerail has

```ts
let total = 0
for await (const entrant of campaign.entries.all()) total += entrant.entries
```

`entries.all()` pages through the drawing taking entries now, pinned to it after the first page. Pass `{ drawing: id }` for another drawing.

## Results and prizes

```ts
const info = await campaign.get()
// schedule, prizeTable.tiers with odds, guarantee, nextDrawing, termsUrl

const latest = await campaign.drawings.latest()
// the newest settled or paid drawing, with winners and payouts

for await (const drawing of campaign.drawings.all({ status: "paid" })) {
  console.log(drawing.number, drawing.winners)
}

const guarantees = await campaign.guarantees.list()
```

## Draw now, in test

In the test environment, `campaign.drawings.run(id)` closes a drawing's entries now and draws it, so you can see a whole draw without waiting for its cutoff. It resolves with the drawing, usually settled within seconds. Anywhere else it throws a `PrizerailError` with code `test_only`. See [Draw now](https://docs.prizerail.com/api/drawings#draw-now-test-only).

## Errors

Every API error is a `PrizerailError` with the HTTP `status`, the API's `code` (like `not_found` or `no_open_drawing`) and a `detail`. A request that never got a response has status 0 and code `network_error`. See [Errors](https://docs.prizerail.com/api/errors).

## Verify a draw

Anyone can check a draw from its public proof, with no API key.

```ts
import { verifyDraw, wasEntered } from "prizerail"

const result = await verifyDraw(
  "https://www.prizerail.com/campaigns/your-campaign/draws/DRAWING_ID/proof.json"
)
result.ok // true when every check passes
result.checks // [{ ok, label, detail }]

wasEntered(entrantId, result.entrants!) // { index, entries } or null
```

With a client, `campaign.drawings.verify(id)` does the same. The checks are the public [verify script](https://docs.prizerail.com/verification/verify-a-draw), shipped unchanged: the entrant list's Merkle root, the random value, and each winner and prize.

From the command line:

```sh
npx prizerail verify https://www.prizerail.com/campaigns/your-campaign/draws/DRAWING_ID/proof.json
npx prizerail verify your-campaign DRAWING_ID
```

It exits 0 when every check passes, 1 when one fails, and 2 when the proof can't be read.

## Options

```ts
new Prizerail({
  apiKey: "pr_…",
  siteUrl: "https://www.prizerail.com", // the default
  timeoutMs: 30_000, // per attempt
  maxRetries: 4,
  fetch, // your own fetch, if you need one
})
```

Keep the API key on your server. It can send entries for every campaign under your account.
