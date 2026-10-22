// Builds dist/ and copies the verify script in
// next to the compiled code, since tsc only emits the .ts files.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
rmSync(join(root, "dist"), { recursive: true, force: true });
const tsc = join(root, "node_modules/.bin/tsc");
execFileSync(tsc, ["-p", join(root, "tsconfig.json")], { stdio: "inherit" });
copyFileSync(
  join(root, "src/verify-draw.mjs"),
  join(root, "dist/verify-draw.mjs")
);
copyFileSync(
  join(root, "src/verify-draw.d.mts"),
  join(root, "dist/verify-draw.d.mts")
);

// The SDK imports verify-core.mjs: the verify script cut at its CLI marker,
// so a bundle of the SDK never runs main() or calls process.exit. The full
// verify-draw.mjs ships too, unchanged, to run directly and to match the copy
// prizerail.com serves.
const MARKER = "// prizerail:cli\n";
const script = readFileSync(join(root, "src/verify-draw.mjs"), "utf8");
if (script.split(MARKER).length !== 2) {
  throw new Error("src/verify-draw.mjs needs exactly one CLI marker.");
}
writeFileSync(
  join(root, "dist/verify-core.mjs"),
  script.slice(0, script.indexOf(MARKER))
);
const verifyJs = join(root, "dist/verify.js");
const compiled = readFileSync(verifyJs, "utf8");
const from = 'from "./verify-draw.mjs"';
if (compiled.split(from).length !== 2) {
  throw new Error("dist/verify.js should import ./verify-draw.mjs once.");
}
writeFileSync(verifyJs, compiled.replace(from, 'from "./verify-core.mjs"'));
chmodSync(join(root, "dist/cli.js"), 0o755);
