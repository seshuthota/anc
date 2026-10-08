import { fileURLToPath } from "node:url";

/** The network runs on India Standard Time, and every stored timestamp carries that offset. */
export const TIMEZONE = "Asia/Kolkata";
const OFFSET = "+05:30";
const OFFSET_MS = 330 * 60_000;

/** The fixed "now" of the simulation: Monday 07:00 IST, when the morning delivery runs should all have left. */
export const DEMO_CLOCK = `2026-09-21T07:00:00.000${OFFSET}`;
export const DATASET_VERSION = "india-parcel-network-v1";
export const DEFAULT_LOGISTICS_DB_PATH = fileURLToPath(new URL("../../../data/logistics.sqlite", import.meta.url));

/**
 * Formats an instant as IST wall-clock time. All timestamps use this one
 * format, so they sort and compare correctly as text and their first ten
 * characters are the local date.
 */
export function toLocalIso(ms: number): string {
  return new Date(ms + OFFSET_MS).toISOString().replace("Z", OFFSET);
}

/** Midnight IST at the start of the given local date (YYYY-MM-DD). */
export function localMidnight(date: string): number {
  return Date.parse(`${date}T00:00:00.000${OFFSET}`);
}
