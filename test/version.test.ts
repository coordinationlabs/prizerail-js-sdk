import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";

describe("VERSION", () => {
  it("matches package.json, so the User-Agent names the published version", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    );
    expect(VERSION).toBe(pkg.version);
  });
});
