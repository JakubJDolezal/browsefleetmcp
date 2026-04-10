import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(__dirname, "..");

function loadEsbuild() {
  try {
    return require("esbuild");
  } catch {
    return require(path.resolve(extensionRoot, "..", "node_modules", "esbuild"));
  }
}

const esbuild = loadEsbuild();

await esbuild.build({
  entryPoints: [path.join(extensionRoot, "src", "content", "index.ts")],
  outfile: path.join(extensionRoot, "dist", "content-script.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome114"],
  legalComments: "none",
});
