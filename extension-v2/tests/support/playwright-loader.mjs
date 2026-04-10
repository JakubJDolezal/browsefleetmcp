import { access, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findCachedPlaywrightIndex() {
  const npxRoot = path.join(os.homedir(), ".npm", "_npx");
  let entries;
  try {
    entries = await readdir(npxRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const indexPath = path.join(
      npxRoot,
      entry.name,
      "node_modules",
      "playwright",
      "index.mjs",
    );
    if (!(await fileExists(indexPath))) {
      continue;
    }

    const entryStat = await stat(indexPath);
    candidates.push({ indexPath, mtimeMs: entryStat.mtimeMs });
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.indexPath;
}

export async function loadPlaywright() {
  const envPath = process.env.PLAYWRIGHT_PACKAGE_PATH;
  if (envPath) {
    return await import(pathToFileURL(envPath).href);
  }

  try {
    const resolved = require.resolve("playwright/index.mjs");
    return await import(pathToFileURL(resolved).href);
  } catch {
    const cachedIndex = await findCachedPlaywrightIndex();
    if (cachedIndex) {
      return await import(pathToFileURL(cachedIndex).href);
    }
  }

  throw new Error(
    [
      "Unable to locate the Playwright package.",
      "Install it locally with `npm install -D playwright`,",
      "or set PLAYWRIGHT_PACKAGE_PATH to a playwright/index.mjs file.",
    ].join(" "),
  );
}
