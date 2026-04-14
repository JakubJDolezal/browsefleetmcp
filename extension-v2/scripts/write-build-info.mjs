import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const targetPath = path.join(extensionRoot, "src/generated/build-info.ts");

await mkdir(path.dirname(targetPath), { recursive: true });
await writeFile(
  targetPath,
  [
    `export const EXTENSION_BUILD_SOURCE_ROOT = ${JSON.stringify(extensionRoot)};`,
    `export const EXTENSION_BUILD_TIMESTAMP = ${JSON.stringify(new Date().toISOString())};`,
    "",
  ].join("\n"),
  "utf8",
);
