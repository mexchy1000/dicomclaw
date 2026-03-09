/**
 * WADO-URI provider is handled inline in web.ts via the /api/wado endpoint.
 * This module provides additional DICOM file serving utilities if needed.
 */

import fs from "node:fs";
import path from "node:path";
import { getDb } from "../db.js";

/**
 * Get all DICOM file paths for a series, sorted by instance number.
 */
export function getSeriesFilePaths(seriesUid: string): string[] {
  const db = getDb();
  const instances = db
    .prepare(
      "SELECT file_path FROM dicom_instances WHERE series_uid = ? ORDER BY instance_number ASC",
    )
    .all(seriesUid) as Array<{ file_path: string }>;

  return instances
    .map((i) => i.file_path)
    .filter((p) => fs.existsSync(p));
}

/**
 * Get wadouri URL list for Cornerstone.js to load a series.
 */
export function getWadoUriList(seriesUid: string, baseUrl: string): string[] {
  const db = getDb();
  const instances = db
    .prepare(
      "SELECT sop_instance_uid FROM dicom_instances WHERE series_uid = ? ORDER BY instance_number ASC",
    )
    .all(seriesUid) as Array<{ sop_instance_uid: string }>;

  return instances.map(
    (i) => `${baseUrl}/api/wado?objectUID=${encodeURIComponent(i.sop_instance_uid)}`,
  );
}
