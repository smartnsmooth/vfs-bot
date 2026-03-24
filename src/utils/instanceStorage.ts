import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./logger";

interface InstanceData {
  credentials?: {
    username: string;
    password: string;
  };
  details?: Record<string, unknown>;
}

interface StorageData {
  instances: Record<string, InstanceData>;
}

const STORAGE_FILE = join(process.cwd(), "instances-data.json");

export function loadInstancesFromDisk(): StorageData {
  try {
    if (!existsSync(STORAGE_FILE)) {
      return { instances: {} };
    }
    const raw = readFileSync(STORAGE_FILE, "utf8");
    const data = JSON.parse(raw) as StorageData;
    return data;
  } catch (err) {
    logger.warn({ err, file: STORAGE_FILE }, "Failed to load instance data from disk, starting fresh");
    return { instances: {} };
  }
}

export function saveInstancesToDisk(data: StorageData): void {
  try {
    const json = JSON.stringify(data, null, 2);
    writeFileSync(STORAGE_FILE, json, "utf8");
  } catch (err) {
    logger.error({ err, file: STORAGE_FILE }, "Failed to save instance data to disk");
  }
}
