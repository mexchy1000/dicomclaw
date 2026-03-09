import { execSync } from "node:child_process";
import fs from "node:fs";
import pino from "pino";
import { PROJECT_ROOT } from "../config.js";
import type { AppConfig } from "../types.js";

const logger = pino({ name: "index-builder" });

/**
 * Trigger DICOM index build by running the Python scanner.
 * Called at server startup to populate the worklist.
 */
export function ensureDicomIndex(config: AppConfig): void {
  if (!fs.existsSync(config.studiesDir)) {
    logger.warn("No data/studies/ directory found. Creating it.");
    fs.mkdirSync(config.studiesDir, { recursive: true });
    return;
  }

  // Check if any files exist in studies dir
  const entries = fs.readdirSync(config.studiesDir);
  if (entries.length === 0) {
    logger.info("No studies found in data/studies/. Worklist will be empty.");
    return;
  }

  logger.info("Running DICOM index scan...");
  try {
    execSync(
      `python -m analysis.bootstrap.scan_studies --studies-dir "${config.studiesDir}"`,
      {
        cwd: PROJECT_ROOT,
        stdio: "inherit",
        timeout: 300000, // 5 min timeout for large datasets
      },
    );
    logger.info("DICOM indexing completed successfully");
  } catch (err) {
    logger.error({ err }, "DICOM indexing failed. Worklist may be incomplete.");
  }
}
