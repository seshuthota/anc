import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function applyEnvFile(path: string) {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

applyEnvFile(resolve(root, ".env"));
for (const key of ["COMPANY_DB_PATH", "RUNTIME_DB_PATH"]) {
  const value = process.env[key];
  if (value && !isAbsolute(value)) process.env[key] = resolve(root, value);
}
if (process.env.VITEST === "true") {
  process.env.MODEL_PROVIDER = "fixture";
}
