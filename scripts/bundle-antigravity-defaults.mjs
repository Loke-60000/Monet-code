import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

import dotenv from "dotenv";

const packageRoot = process.cwd();
const defaultsPath = join(
  packageRoot,
  "assets",
  "antigravity-oauth-defaults.json",
);

dotenv.config({ path: join(packageRoot, ".env") });

async function writeDefaults() {
  const clientId = process.env.MONET_ANTIGRAVITY_CLIENT_ID?.trim();
  const clientSecret = process.env.MONET_ANTIGRAVITY_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    await cleanDefaults();
    return;
  }

  await mkdir(dirname(defaultsPath), { recursive: true });
  await writeFile(
    defaultsPath,
    `${JSON.stringify({ clientId, clientSecret }, null, 2)}\n`,
    "utf8",
  );
}

async function cleanDefaults() {
  await rm(defaultsPath, { force: true });
}

async function main() {
  const command = process.argv[2];

  if (command === "write") {
    await writeDefaults();
    return;
  }

  if (command === "clean") {
    await cleanDefaults();
    return;
  }

  throw new Error(`Unknown command: ${command ?? "<missing>"}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
