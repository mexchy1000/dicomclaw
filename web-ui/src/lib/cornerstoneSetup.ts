import {
  init as coreInit,
  metaData,
  volumeLoader,
  cornerstoneStreamingImageVolumeLoader,
} from "@cornerstonejs/core";
import {
  init as dicomImageLoaderInit,
} from "@cornerstonejs/dicom-image-loader";
import {
  init as toolsInit,
  addTool,
  WindowLevelTool,
  PanTool,
  ZoomTool,
  StackScrollTool,
} from "@cornerstonejs/tools";

let initialized = false;

/**
 * Custom metadata provider that calculates SUVbw scaling for PET images.
 * Cornerstone's dicom-image-loader does NOT include a scalingModule provider,
 * so we must register one manually. When present, the decode pipeline
 * automatically converts PET pixel values to SUV units.
 */
function suvScalingProvider(type: string, imageId: string) {
  if (type !== "scalingModule") return;

  // Only process wadouri PET images
  const petIsotopeModule = metaData.get("petIsotopeModule", imageId);
  const generalSeriesModule = metaData.get("generalSeriesModule", imageId);
  const patientStudyModule = metaData.get("patientStudyModule", imageId);

  if (!petIsotopeModule || !patientStudyModule) return;
  if (generalSeriesModule?.modality !== "PT") return;

  const {
    radiopharmaceuticalInfo: pharma,
  } = petIsotopeModule;

  if (!pharma) return;

  const weightKg = patientStudyModule.patientWeight;
  const dose = pharma.radionuclideTotalDose; // Bq
  const halfLife = pharma.radionuclideHalfLife; // seconds
  const injectionTime = pharma.radiopharmaceuticalStartTime;

  if (!weightKg || !dose || !halfLife) return;

  // Determine the reference time for decay calculation.
  // When DecayCorrection=START, pixel values are already decay-corrected
  // to the series reference time, so we MUST use SeriesTime (not per-frame
  // AcquisitionTime) to avoid per-bed-position errors (~8% for WB PET).
  const generalImageModule = metaData.get("generalImageModule", imageId);
  const petSeriesModule = metaData.get("petSeriesModule", imageId);
  const decayCorrection = petSeriesModule?.decayCorrection || "";

  // referenceTime & injectionTime may be parseTM objects or raw TM strings
  let referenceTime: unknown;
  if (decayCorrection.toUpperCase() === "START") {
    // Use series time — matches the decay-correction reference
    referenceTime = generalSeriesModule?.seriesTime;
  }
  if (!referenceTime) {
    // Fallback: per-image acquisition time
    referenceTime = generalImageModule?.acquisitionTime;
  }

  // Calculate decay factor
  let decayFactor = 1;
  if (injectionTime != null && referenceTime != null) {
    const secsSinceInjection = timeToSeconds(referenceTime) - timeToSeconds(injectionTime);
    if (secsSinceInjection > 0) {
      decayFactor = Math.exp((-Math.LN2 * secsSinceInjection) / halfLife);
    }
  }

  const suvbw = (weightKg * 1000) / (dose * decayFactor);

  // Debug: log first invocation to verify SUV calculation
  if (!(suvScalingProvider as any)._logged) {
    (suvScalingProvider as any)._logged = true;
    console.log("[SUV] suvbw=", suvbw, "decay=", decayCorrection,
      "refTime=", timeToSeconds(referenceTime), "injTime=", timeToSeconds(injectionTime),
      "decayFactor=", decayFactor, "weight=", weightKg, "dose=", dose);
  }

  return {
    suvbw,
    suvlbm: undefined,
    suvbsa: undefined,
  };
}

/**
 * Convert a DICOM TM value to seconds.  Cornerstone's dicom-parser parseTM()
 * returns an **object** `{hours, minutes, seconds, fractionalSeconds}`, not a
 * string.  The raw DICOM string format is `HHMMSS.FFFFFF`.  We handle both.
 */
function timeToSeconds(timeVal: unknown): number {
  if (timeVal == null) return 0;

  // parseTM object: {hours, minutes, seconds?, fractionalSeconds?}
  if (typeof timeVal === "object") {
    const t = timeVal as { hours?: number; minutes?: number; seconds?: number; fractionalSeconds?: number };
    return (t.hours || 0) * 3600 + (t.minutes || 0) * 60 + (t.seconds || 0)
      + (t.fractionalSeconds ? t.fractionalSeconds / 1e6 : 0);
  }

  // Raw DICOM TM string: HHMMSS.FFFFFF or numeric
  const s = String(timeVal).replace(/[^0-9.]/g, "");
  const h = parseInt(s.substring(0, 2), 10) || 0;
  const m = parseInt(s.substring(2, 4), 10) || 0;
  const sec = parseFloat(s.substring(4)) || 0;
  return h * 3600 + m * 60 + sec;
}

export async function initCornerstone(): Promise<void> {
  if (initialized) return;

  // 1. Core (preserveDrawingBuffer enables canvas toDataURL for viewport capture)
  await coreInit({
    rendering: { preferSizeOverAccuracy: true },
    gpuTier: { glAttributes: { preserveDrawingBuffer: true } } as any,
    debug: {},
  });

  // 2. Tools
  await toolsInit();

  // 3. DICOM image loader (synchronous)
  dicomImageLoaderInit({
    maxWebWorkers: navigator.hardwareConcurrency || 1,
  });

  // 4. Register SUV scaling provider (higher priority = checked first)
  metaData.addProvider(suvScalingProvider, 10000);

  // 5. Register streaming volume loader for volume viewports
  volumeLoader.registerVolumeLoader(
    "cornerstoneStreamingImageVolume",
    cornerstoneStreamingImageVolumeLoader as any,
  );

  // 6. Register tools
  addTool(WindowLevelTool);
  addTool(PanTool);
  addTool(ZoomTool);
  addTool(StackScrollTool);

  initialized = true;
  console.log("Cornerstone3D initialized with SUV provider");
}
