import { fileURLToPath } from "node:url";

export const DEMO_CLOCK = "2026-09-20T08:00:00.000Z";
export const DATASET_VERSION = "sync-regression-v1";
export const DEFAULT_COMPANY_DB_PATH = fileURLToPath(new URL("../../../data/company.sqlite", import.meta.url));
