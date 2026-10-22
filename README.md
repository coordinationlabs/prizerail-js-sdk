# prizerail

The Prizerail SDK for JavaScript and TypeScript. Send entries, read results and prizes, and verify any draw from its public proof.

- Typed client for the [partner API](https://docs.prizerail.com/api/authentication), with paging and safe retries.
- `verifyDraw`, the same checks as the public verify script, plus `wasEntered` to find someone in a locked list.
- `npx prizerail verify` from the command line.
- No dependencies. Node 20.19+ or 22.12+, with `import` or `require()`, Deno, Bun, and edge runtimes with `fetch` and WebCrypto.

```sh
npm install prizerail
```

Versions follow [semver](https://semver.org): within 1.x nothing is removed or renamed, and new features come in minor versions. A status, such as a drawing's, can gain a new value in a minor version, so give a `switch` over one a default case. Each release is in the [changelog](https://docs.prizerail.com/changelog).

## Use it from your server

Call Prizerail from your backend, or a proxy you run, never from a website or a mobile app. The API key can send entries for every campaign under your account, and anything shipped to a browser or an app can be read out of it. Your app tells your server what a user did, and your server sends the entries. To show results in your app, read them on your server and pass them on, or read the public proof, which needs no key.

The verify helpers (`verifyDraw`, `wasEntered` and `npx prizerail verify`) take no key, so they're safe to run anywhere.

## Send entries

```ts
import { Prizerail, hashEntrant } from "prizerail"

const prizerail = new Prizerail({ apiKey: process.env.PRIZERAIL_API_KEY })
const campaign = prizerail.campaign("your-campaign")

const entrants = await Promise.all(
  users.map(async user => ({
    entrantId: await hashEntrant(user.id, process.env.ENTRANT_ID_KEY!),
    entries: user.tickets,
  }))
)

const result = await campaign.entries.send(entrants)
// { drawing: { id, drawAt, cutoffAt }, sent, added, updated, unchanged, entrantCount, totalEntries, batches }
```

`entrantCount` and `totalEntries` are the drawing's own totals, so reconcile with those. `added`, `updated` and `unchanged` add up what each batch reported, and a batch that was stored before its response was lost comes back as `unchanged` on the retry.

`send` takes any number of entrants and sends them in requests of 1,000. It retries a `429`, a `5xx`, a timeout or a network error with a jittered, growing wait, and honors `Retry-After`.

Sending an entrant again before the cutoff only sets their entries, so a retry is safe until then. After the cutoff a retry would go to the next drawing, so every send is pinned to one drawing:

- Before the first batch it reads which drawing is taking entries, or uses the `drawing` you pass.
- It sends no batch and starts no retry within the request timeout (30 seconds) of that drawing's cutoff. It throws `PrizerailCutoffError` instead.
- If a batch still lands in another drawing, it throws `PrizerailDrawingChangedError`.

Both errors carry `progress`, which says how many entrants the drawing confirmed. Check what it has with `entries.list({ drawing })` before you send the rest.

```ts
import { PrizerailCutoffError } from "prizerail"

try {
  await campaign.entries.send(entrants)
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

An increment goes to the drawing taking entries when it arrives, so an event after a cutoff counts in the next draw. `drawings` lists each drawing the events added entries to. Events Prizerail had already seen stay in the drawing they first went to.

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

## Draw now, in the sandbox

In the sandbox, `campaign.drawings.run(id)` closes a drawing's entries now and draws it, so you can see a whole draw without waiting for its cutoff. It resolves with the drawing, usually settled within seconds. Anywhere else it throws a `PrizerailError` with code `sandbox_only`. See [Draw now](https://docs.prizerail.com/api/drawings#draw-now-sandbox-only).

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

A slug is looked up on www.prizerail.com. For a draw from a sandbox campaign, add `--site https://sandbox.prizerail.com`, or set `PRIZERAIL_API_KEY` to your `pr_sandbox_` key. The same goes for the public helpers without a key: `new Prizerail({ siteUrl: "https://sandbox.prizerail.com" })` reaches sandbox campaigns.

It exits 0 when every check passes, 1 when one fails, and 2 when the proof can't be read.

## Options

```ts
new Prizerail({
  apiKey: "pr_…",
  siteUrl: "https://www.prizerail.com", // the default, or https://sandbox.prizerail.com for a pr_sandbox_ key
  timeoutMs: 30_000, // per attempt
  maxRetries: 4,
  fetch, // your own fetch, if you need one
})
```

## Development

```sh
pnpm install
pnpm lint
pnpm type-check
pnpm test
pnpm build
```

Issues and pull requests are welcome. For a security problem, email team@coordinationlabs.com instead of opening an issue.

`src/verify-draw.mjs` is the public verify script that prizerail.com serves at `/verify/verify-draw.mjs`. Keep the two the same: a change to how draws are checked goes in both, and prizerail.com's tests fail if its copy differs from the one in the published package.

### Releasing

1. Bump `version` in `package.json` and `VERSION` in `src/client.ts`, and add the release to the [changelog](https://docs.prizerail.com/changelog).
2. Merge to `main`.
3. From an up-to-date `main`, run the checks and publish. `npm publish` builds `dist` first.

   ```sh
   pnpm install --frozen-lockfile
   pnpm lint && pnpm type-check && pnpm test
   npm publish
   ```

4. Tag the commit you published, so each npm version maps to its source:

   ```sh
   git tag v1.0.0
   git push origin v1.0.0
   ```
