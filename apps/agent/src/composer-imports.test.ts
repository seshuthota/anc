import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * R3 gate: the composer input path builds surfaces from checked data only, so it
 * must not be able to reach the company database or its MCP client, even
 * through another module. Walks every runtime import (type-only imports are
 * erased at build time and skipped) from the composer's entry files.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const ENTRIES = ["composer.ts", "ui-composer.ts", "briefing.ts", "windows.ts"].map((file) => resolve(here, file));
const FORBIDDEN = [/better-sqlite3/, /mcp-client/, /logistics-db\/src\/index\.ts$/, /@modelcontextprotocol/];

function packageEntry(specifier: string): string | undefined {
  const match = specifier.match(/^@anc\/([^/]+)(\/.*)?$/);
  if (!match) return undefined;
  for (const base of ["packages", "apps"]) {
    const pkgDir = resolve(root, base, match[1]!);
    const manifest = resolve(pkgDir, "package.json");
    if (!existsSync(manifest)) continue;
    const exports = (JSON.parse(readFileSync(manifest, "utf8")) as { exports?: Record<string, string> }).exports ?? {};
    const target = exports[match[2] ? `.${match[2]}` : "."];
    if (target) return resolve(pkgDir, target);
  }
  return undefined;
}

function resolveImport(from: string, specifier: string): string {
  if (specifier.startsWith(".")) {
    const base = resolve(dirname(from), specifier);
    for (const candidate of [base.replace(/\.js$/, ".ts"), `${base}.ts`, resolve(base, "index.ts")]) if (existsSync(candidate)) return candidate;
    return base;
  }
  return packageEntry(specifier) ?? specifier;
}

function runtimeImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const found: string[] = [];
  const pattern = /^\s*(import|export)\s+(type\s+)?([^"';]*?\s+from\s+)?["']([^"']+)["']/gm;
  for (const match of source.matchAll(pattern)) {
    if (match[2]) continue; // import type / export type
    const clause = match[3] ?? "";
    // `import { type A, type B } from` is type-only too.
    const names = clause.match(/\{([^}]*)\}/)?.[1];
    if (names && !/^\s*\*|^[A-Za-z_$]/.test(clause.trim()) && names.split(",").map((name) => name.trim()).filter(Boolean).every((name) => name.startsWith("type "))) continue;
    found.push(match[4]!);
  }
  for (const match of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) found.push(match[1]!);
  return found;
}

function walk(): { reached: Map<string, string>; offending: string[] } {
  const reached = new Map<string, string>();
  const queue: Array<readonly [string, string]> = ENTRIES.map((entry) => [entry, "entry"] as const);
  const offending: string[] = [];
  while (queue.length) {
    const [file, via] = queue.shift()!;
    if (reached.has(file)) continue;
    reached.set(file, via);
    if (FORBIDDEN.some((pattern) => pattern.test(file))) { offending.push(`${file} (via ${via})`); continue; }
    if (!file.endsWith(".ts") || !existsSync(file)) continue;
    for (const specifier of runtimeImports(file)) queue.push([resolveImport(file, specifier), file] as const);
  }
  return { reached, offending };
}

describe("composer input path imports (R3)", () => {
  it("never reaches better-sqlite3, the MCP client or the logistics-db barrel, even transitively", () => {
    const { reached, offending } = walk();
    expect(offending).toEqual([]);
    // The walk really follows the graph: the constants subpath is reached, the barrel is not.
    expect([...reached.keys()].some((file) => file.endsWith("logistics-db/src/constants.ts"))).toBe(true);
    expect([...reached.keys()].some((file) => file.endsWith("apps/agent/src/rank.ts"))).toBe(true);
  });

  it("would catch a forbidden import", () => {
    expect(FORBIDDEN.some((pattern) => pattern.test(resolve(root, "packages/logistics-db/src/index.ts")))).toBe(true);
    expect(runtimeImports(resolve(here, "mcp-client.ts"))).toContain("@anc/logistics-db");
  });
});
