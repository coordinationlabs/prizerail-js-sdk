#!/usr/bin/env node
import { existsSync } from "node:fs";
import { checkCampaign } from "./check.js";
import { Prizerail, VERSION } from "./client.js";
import { type Check, type VerifyResult, verifyDraw } from "./verify.js";

const USAGE = `prizerail ${VERSION}

Usage:
  prizerail verify <proof.json link or file> [entrants link or file]
  prizerail verify <campaign slug> <drawing id> [--site https://www.prizerail.com]
  prizerail check <campaign slug> [--draw] [--site https://www.prizerail.com]

verify checks a draw from its public proof: the locked entrant list, the
random value, and every winner and prize. Exits 0 when every check passes, 1
when one fails, and 2 when the proof can't be read.

check reads a campaign with PRIZERAIL_API_KEY and checks the integration:
the key and its environment, the campaign and its open drawing, and the
entrant ids and entries it has. With --draw, in the sandbox, it draws the
open drawing now and verifies the result.

A slug is looked up on the site the key belongs to: www.prizerail.com, or
sandbox.prizerail.com for a pr_sandbox_ key. --site points anywhere else.`;

function printChecks(checks: Check[], passed: string) {
  for (const { ok, label, detail } of checks) {
    const mark = ok === true ? "✓" : ok === false ? "✗" : "i";
    console.log(`${mark} ${label}${detail ? `\n    ${detail}` : ""}`);
  }
  const failed = checks.filter(c => c.ok === false).length;
  console.log(
    failed
      ? `\n${failed} check${failed === 1 ? "" : "s"} failed.`
      : `\n${passed}`
  );
  return failed ? 1 : 0;
}

function print(result: VerifyResult) {
  const { proof, checks } = result;
  // A malformed proof may lack these, and its failed checks still print.
  console.log(
    `\n${proof?.campaign?.name ?? "Unknown campaign"}, draw of ${proof?.drawing?.drawAt ?? "unknown date"} (${proof?.drawing?.id ?? "unknown drawing"})\n`
  );
  return printChecks(checks, "Every result follows from the inputs.");
}

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const siteAt = args.indexOf("--site");
  const site = siteAt === -1 ? undefined : args.splice(siteAt, 2)[1];
  const [command, a, b] = args;
  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return 0;
  }
  if (command === "check" && a) {
    const draw = args.includes("--draw");
    const apiKey = process.env.PRIZERAIL_API_KEY;
    if (!apiKey) {
      console.error("Set PRIZERAIL_API_KEY to your pr_… key.");
      return 2;
    }
    const campaign = new Prizerail({ siteUrl: site, apiKey }).campaign(a);
    console.log(`\nChecking ${a} at ${campaign.prizerail.siteUrl}\n`);
    const result = await checkCampaign(campaign, { draw });
    return printChecks(
      result.checks,
      draw
        ? "The integration works end to end."
        : "The integration looks right. Add --draw in the sandbox to run a whole draw."
    );
  }
  if (command !== "verify" || !a) {
    console.log(USAGE);
    return command === undefined || command === "--help" || command === "-h"
      ? 0
      : 2;
  }
  // A link or any file on disk is a proof. Anything else is a campaign slug.
  const looksLikeProof = /^https?:\/\//.test(a) || existsSync(a);
  if (looksLikeProof) return print(await verifyDraw(a, { entrants: b }));
  if (!b) {
    console.log(USAGE);
    return 2;
  }
  // The key only picks the site: proofs are public, so nothing is sent with it.
  const campaign = new Prizerail({
    siteUrl: site,
    apiKey: process.env.PRIZERAIL_API_KEY,
  }).campaign(a);
  return print(await campaign.drawings.verify(b));
}

// exitCode rather than exit(), so a long report piped to a file isn't cut off.
main(process.argv.slice(2)).then(
  code => {
    process.exitCode = code;
  },
  error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
);
