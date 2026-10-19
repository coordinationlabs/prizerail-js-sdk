// Builds dist/ and copies the verify script in
// next to the compiled code, since tsc only emits the .ts files.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
rmSync(join(root, "dist"), { recursive: true, force: true });
// The repo's TypeScript, from the app's node_modules.
const tsc = join(root, "../../node_modules/.bin/tsc");
execFileSync(tsc, ["-p", join(root, "tsconfig.json")], { stdio: "inherit" });
copyFileSync(
  join(root, "src/verify-draw.mjs"),
  join(root, "dist/verify-draw.mjs")
);
copyFileSync(
  join(root, "src/verify-draw.d.mts"),
  join(root, "dist/verify-draw.d.mts")
);
chmodSync(join(root, "dist/cli.js"), 0o755);
