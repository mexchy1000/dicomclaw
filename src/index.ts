import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import pino from "pino";
import { loadConfig, PROJECT_ROOT } from "./config.js";
import { WebChannel } from "./channels/web.js";
import { GroupQueue } from "./group-queue.js";
import { ensureDicomIndex } from "./dicom/index-builder.js";
import { getDb, closeDb, addSessionFile } from "./db.js";

// ── Active child process tracking ──
const activeChildren = new Map<string, ChildProcess>();

function cancelAgent(sessionId: string): boolean {
  const child = activeChildren.get(sessionId);
  if (child) {
    child.kill("SIGTERM");
    setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 3000);
    activeChildren.delete(sessionId);
    return true;
  }
  return false;
}

const logger = pino({
  name: "dicomclaw",
  transport: { target: "pino-pretty" },
});

async function main(): Promise<void> {
  const config = loadConfig();

  logger.info("=== DICOMclaw ===");
  logger.info({ port: config.port, model: config.openrouterModel });

  // Ensure data directories exist
  fs.mkdirSync(config.studiesDir, { recursive: true });
  fs.mkdirSync(config.resultsDir, { recursive: true });
  fs.mkdirSync(path.join(PROJECT_ROOT, "data"), { recursive: true });
  fs.mkdirSync(path.join(PROJECT_ROOT, "logs"), { recursive: true });

  // Step 1: Index DICOM studies
  ensureDicomIndex(config);

  // Step 2: Create web channel with message handler
  let activeWebChannel: WebChannel | null = null;

  const queue = new GroupQueue(async (sessionId, text) => {
    await handleMessage(sessionId, text, config, activeWebChannel, queue);
  });

  const webChannel = new WebChannel(config, async (sessionId, text) => {
    await queue.enqueue(sessionId, text);
    if (queue.isProcessing() && queue.getQueueSize() > 0) {
      webChannel.emitAgentStatus("busy", queue.getQueueSize(), null);
    }
  });

  activeWebChannel = webChannel;

  // Register cancel-agent callback
  webChannel.onCancelAgent((sessionId) => {
    const killed = cancelAgent(sessionId);
    queue.clearQueue();
    webChannel.emitAgentStatus("idle", 0, null);
    return killed;
  });

  // Register batch analysis handler
  webChannel.onBatchStarted(async (data) => {
    const { prompt, studyUids } = data;
    logger.info({ count: studyUids.length }, "Batch analysis started");

    // Create a single batch session visible in the chat
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const batchSessionId = `batch-${timestamp}`;
    const db = getDb();
    db.prepare("INSERT OR IGNORE INTO sessions (id, title) VALUES (?, ?)").run(
      batchSessionId,
      `BatchAnalyze (${studyUids.length})`,
    );

    // Create batch results directory
    const batchResultsDir = path.join(config.resultsDir, "batch_analysis_results", timestamp);
    fs.mkdirSync(batchResultsDir, { recursive: true });

    // Notify frontend to switch to this session
    webChannel.emitBatchStarted(batchSessionId);

    // Send initial message to the batch session
    await webChannel.sendMessage(
      batchSessionId,
      `**Batch Analysis Started**\n\nPrompt: ${prompt}\nStudies: ${studyUids.length}\nResults: batch_analysis_results/${timestamp}/`,
    );

    // Process each study sequentially
    for (let i = 0; i < studyUids.length; i++) {
      const uid = studyUids[i];

      // Look up patient info
      const study = db.prepare("SELECT patient_name, patient_id FROM dicom_studies WHERE study_uid = ?")
        .get(uid) as { patient_name: string; patient_id: string } | undefined;
      const patientName = study?.patient_name || "Unknown";

      await webChannel.sendMessage(
        batchSessionId,
        `**[${i + 1}/${studyUids.length}] Processing: ${patientName}** (${uid.slice(0, 30)}...)`,
      );

      // Build prompt with context — override RESULTS_DIR to batch subdir
      const studyBatchDir = path.join(batchResultsDir, uid.slice(0, 40));
      fs.mkdirSync(studyBatchDir, { recursive: true });

      const batchPrompt = `[Context: study_uid=${uid}, patient=${patientName}]\n${prompt}`;

      try {
        // Snapshot before
        const beforeSnapshot = snapshotResultFiles(config.resultsDir);

        const response = await runLocalAgent(batchPrompt, batchSessionId, config, webChannel);

        // Detect new files and track them
        const afterSnapshot = snapshotResultFiles(config.resultsDir);
        const newFiles: string[] = [];
        for (const [filePath, mtime] of afterSnapshot) {
          const prevMtime = beforeSnapshot.get(filePath);
          if (prevMtime === undefined || mtime > prevMtime) {
            newFiles.push(filePath);
          }
        }

        if (newFiles.length > 0) {
          for (const fp of newFiles) {
            const fileName = path.basename(fp);
            if (fileName.endsWith(".nii.gz") || fileName.endsWith(".nii")
              || /^mip[_.].*\.png$/i.test(fileName)) {
              continue;
            }
            const relativePath = path.relative(config.resultsDir, fp);
            const fileType = detectFileType(fileName);
            const size = fs.statSync(fp).size;
            addSessionFile(batchSessionId, fileName, fileType, fp, relativePath, size);
          }
          webChannel.emitSessionFiles(batchSessionId);
        }

        await webChannel.sendMessage(batchSessionId, response);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        await webChannel.sendMessage(batchSessionId, `**Error** processing ${patientName}: ${msg}`);
      }
    }

    await webChannel.sendMessage(
      batchSessionId,
      `**Batch Analysis Complete**\n\n${studyUids.length} studies processed.\nResults: batch_analysis_results/${timestamp}/`,
    );
    webChannel.emitBatchComplete();
    logger.info("Batch analysis complete");
  });

  // Step 3: Connect web channel
  await webChannel.connect();

  logger.info(`Server ready at http://${config.host}:${config.port}`);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    await webChannel.disconnect();
    closeDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ── Output file snapshot helpers ──

function snapshotResultFiles(resultsDir: string): Map<string, number> {
  const snapshot = new Map<string, number>();
  if (!fs.existsSync(resultsDir)) return snapshot;

  function walkDir(dir: string) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fp);
        } else if (entry.isFile() && entry.name !== ".gitkeep") {
          snapshot.set(fp, fs.statSync(fp).mtimeMs);
        }
      }
    } catch { /* ignore */ }
  }

  walkDir(resultsDir);
  return snapshot;
}

function detectFileType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".svg", ".gif", ".webp"].includes(ext)) return "image";
  if ([".md", ".txt", ".log"].includes(ext)) return "document";
  if ([".csv", ".tsv", ".xlsx"].includes(ext)) return "table";
  if ([".nii", ".nii.gz", ".dcm"].includes(ext)) return "data";
  if ([".pdf"].includes(ext)) return "pdf";
  if ([".html"].includes(ext)) return "html";
  return "other";
}

// ── Message handler ──

async function handleMessage(
  sessionId: string,
  text: string,
  config: ReturnType<typeof loadConfig>,
  webChannel: WebChannel | null,
  queue?: GroupQueue,
): Promise<void> {
  logger.info({ sessionId, textLen: text.length }, "Processing message");

  const qs = queue?.getQueueSize() ?? 0;
  webChannel?.emitAgentStatus("busy", qs, sessionId);

  // Snapshot results before agent run
  const beforeSnapshot = snapshotResultFiles(config.resultsDir);

  // Run Python agent
  logger.info({ sessionId }, "Starting runLocalAgent");
  const response = await runLocalAgent(text, sessionId, config, webChannel);
  logger.info({ sessionId, responseLen: response.length }, "Agent finished");

  // Detect new/modified files
  const afterSnapshot = snapshotResultFiles(config.resultsDir);
  const newFiles: string[] = [];
  for (const [filePath, mtime] of afterSnapshot) {
    const prevMtime = beforeSnapshot.get(filePath);
    if (prevMtime === undefined || mtime > prevMtime) {
      newFiles.push(filePath);
    }
  }

  // Track new files in DB and notify client (skip intermediate artifacts)
  if (newFiles.length > 0) {
    logger.info({ sessionId, count: newFiles.length }, "New result files detected");
    for (const fp of newFiles) {
      const fileName = path.basename(fp);
      // Skip NIfTI intermediates and MIP images (viewer makes them redundant)
      if (fileName.endsWith(".nii.gz") || fileName.endsWith(".nii")
        || /^mip[_.].*\.png$/i.test(fileName)) {
        continue;
      }
      const relativePath = path.relative(config.resultsDir, fp);
      const fileType = detectFileType(fileName);
      const size = fs.statSync(fp).size;
      addSessionFile(sessionId, fileName, fileType, fp, relativePath, size);
    }
    if (webChannel) {
      webChannel.emitSessionFiles(sessionId);
    }
  }

  // Send response
  if (webChannel) {
    await webChannel.sendMessage(sessionId, response);
  }

  webChannel?.emitAgentStatus("idle", 0, null);
}

// ── Local Python agent runner ──

async function runLocalAgent(
  prompt: string,
  sessionId: string,
  config: ReturnType<typeof loadConfig>,
  webChannel: WebChannel | null,
): Promise<string> {
  return new Promise((resolve) => {
    // Extract study_uid from [Context: study_uid=..., patient=...] prefix
    const contextMatch = prompt.match(/\[Context:\s*study_uid=([^,\]]+)/);
    const studyUid = contextMatch ? contextMatch[1].trim() : null;

    // Extract pre-selected series UIDs
    const ctSeriesMatch = prompt.match(/ct_series=([^,\]]+)/);
    const petSeriesMatch = prompt.match(/pet_series=([^,\]]+)/);
    const ctSeriesUid = ctSeriesMatch ? ctSeriesMatch[1].trim() : null;
    const petSeriesUid = petSeriesMatch ? petSeriesMatch[1].trim() : null;

    // Extract any additional clinical context from [Clinical: ...] prefix
    const clinicalMatch = prompt.match(/\[Clinical:\s*([^\]]+)\]/);
    const clinicalContext = clinicalMatch ? clinicalMatch[1].trim() : null;

    const args = ["-m", "analysis.local_agent", "--prompt", prompt];
    if (studyUid) args.push("--study-uid", studyUid);
    if (clinicalContext) args.push("--clinical-context", clinicalContext);
    if (ctSeriesUid) args.push("--ct-series", ctSeriesUid);
    if (petSeriesUid) args.push("--pet-series", petSeriesUid);

    // Pass saved overlay (VOI) metadata so the agent knows about active VOIs
    if (studyUid) {
      const db = getDb();
      const overlaySteps = db.prepare(
        "SELECT content FROM react_steps WHERE session_id = ? AND step_type = 'overlay' ORDER BY id"
      ).all(sessionId) as { content: string }[];
      if (overlaySteps.length > 0) {
        const overlayMeta = overlaySteps.map((s) => {
          try { return JSON.parse(s.content); } catch { return null; }
        }).filter(Boolean);
        if (overlayMeta.length > 0) {
          args.push("--overlays", JSON.stringify(overlayMeta));
        }
      }
    }

    logger.info({ sessionId, studyUid, promptLen: prompt.length }, "Spawning Python agent");

    const child = spawn(
      "python",
      args,
      {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          OPENROUTER_API_KEY: config.openrouterApiKey,
          OPENROUTER_BASE_URL: config.openrouterBaseUrl,
          OPENROUTER_MODEL: config.openrouterModel,
          VISION_MODEL: config.visionModel,
          STUDIES_DIR: config.studiesDir,
          RESULTS_DIR: config.resultsDir,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    logger.info({ sessionId, pid: child.pid }, "Agent process spawned");
    activeChildren.set(sessionId, child);

    let stdout = "";
    let stderr = "";

    // Plan approval handler
    const planHandler = (data: { sessionId: string; feedback?: string }) => {
      if (data.sessionId === sessionId && child.stdin) {
        if (data.feedback) {
          child.stdin.write(`MODIFY:${data.feedback}\n`);
        } else {
          child.stdin.write("APPROVED\n");
        }
      }
    };
    if (webChannel) {
      webChannel.onPlanApproved(sessionId, planHandler);
    }

    child.stdout.on("data", (data: Buffer) => {
      const chunk = data.toString();
      // Process and strip any [REACT:*] markers that LLM may embed in stdout
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        const reactMatch = trimmed.match(/\[REACT:(\w+)](.*)/);
        if (reactMatch && webChannel) {
          const [, type, rawContent] = reactMatch;
          const typeLower = type.toLowerCase();
          if (typeLower === "overlay") {
            try {
              const parsed = JSON.parse(rawContent);
              if (parsed.path) {
                const resultsPrefix = path.join(config.resultsDir, "/");
                if (parsed.path.startsWith(resultsPrefix)) {
                  parsed.path = parsed.path.slice(resultsPrefix.length);
                }
              }
              webChannel.emitOverlayAvailable(sessionId, parsed);
            } catch { /* */ }
          }
          // Don't include REACT markers in stdout text
          continue;
        }
      }
      // Append cleaned text (strip REACT lines)
      const cleaned = chunk.split("\n")
        .filter((l) => !l.trim().match(/^\[REACT:\w+]/))
        .join("\n");
      stdout += cleaned;
    });

    child.stderr.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const reactMatch = trimmed.match(/\[REACT:(\w+)](.*)/);
        if (reactMatch && webChannel) {
          const [, type, rawContent] = reactMatch;
          const typeLower = type.toLowerCase();
          const content = typeLower === "plan"
            ? rawContent.replace(/\\n/g, "\n")
            : rawContent;

          // Handle special DICOM-specific markers
          if (typeLower === "overlay" || typeLower === "viewer_cmd" || typeLower === "report" || typeLower === "progress") {
            try {
              const parsed = JSON.parse(content);
              if (typeLower === "overlay") {
                // Normalize path: convert absolute to relative (under results/)
                if (parsed.path) {
                  const resultsPrefix = path.join(config.resultsDir, "/");
                  if (parsed.path.startsWith(resultsPrefix)) {
                    parsed.path = parsed.path.slice(resultsPrefix.length);
                  } else if (parsed.path.startsWith("/")) {
                    // Try stripping any absolute prefix ending with /results/
                    const idx = parsed.path.indexOf("/results/");
                    if (idx >= 0) {
                      parsed.path = parsed.path.slice(idx + "/results/".length);
                    }
                  }
                }
                webChannel.emitOverlayAvailable(sessionId, parsed);
              } else if (typeLower === "viewer_cmd") {
                webChannel.emitViewerCommand(sessionId, parsed);
              }
            } catch { /* non-JSON content, emit as step */ }
          }

          webChannel.emitReactStep(sessionId, {
            type: typeLower as "iteration" | "thought" | "action" | "observation" | "final" | "plan" | "overlay" | "viewer_cmd" | "report" | "progress",
            content,
            timestamp: new Date().toISOString(),
          });
        } else {
          logger.info({ src: "agent" }, trimmed);
        }
      }
    });

    const timeout = setTimeout(() => {
      logger.warn("Agent timeout, killing process");
      child.kill("SIGTERM");
    }, config.agentTimeout);

    child.on("close", (code) => {
      clearTimeout(timeout);
      activeChildren.delete(sessionId);
      if (webChannel) webChannel.offPlanApproved(sessionId);

      if (code !== 0) {
        logger.error({ sessionId, code, stderrTail: stderr.slice(-500) }, "Agent process exited with error");
        resolve(`Analysis encountered an error.\n\nError: ${stderr.slice(0, 500)}`);
      } else {
        logger.info({ sessionId, code, stdoutLen: stdout.length }, "Agent process exited OK");
        resolve(stdout || "Analysis completed successfully.");
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      activeChildren.delete(sessionId);
      if (webChannel) webChannel.offPlanApproved(sessionId);
      logger.error({ sessionId, error: err.message }, "Agent process spawn error");
      resolve(`Failed to start analysis: ${err.message}`);
    });
  });
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal error");
  process.exit(1);
});
