import express from "express";
import { createServer } from "node:http";
import { Server as SocketIOServer, Socket } from "socket.io";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import pino from "pino";
import { PROJECT_ROOT } from "../config.js";
import {
  getDb, renameSession, deleteSession, addReactStep,
  getSessionFiles, getAllStudies, getStudySeries, getSeriesInstances,
  getStudyResults,
} from "../db.js";
import { getWadoUriList } from "../dicom/wado-provider.js";
import { queryVlm } from "../vlm-client.js";
import type { Channel, AppConfig, ReactStep } from "../types.js";

const logger = pino({ name: "web-channel" });

type MessageCallback = (sessionId: string, text: string) => Promise<void>;

export class WebChannel implements Channel {
  name = "web";
  private app: express.Express;
  private httpServer: ReturnType<typeof createServer>;
  private io: SocketIOServer;
  private config: AppConfig;
  private connected = false;
  private onMessage: MessageCallback;
  private activeSockets = new Map<string, Socket>();
  private planApprovalCallbacks = new Map<string, (data: { sessionId: string; feedback?: string }) => void>();
  private cancelAgentCallback: ((sessionId: string) => boolean) | null = null;
  private currentAgentStatus: {
    status: "idle" | "busy" | "queued";
    queueSize: number;
    currentSessionId: string | null;
  } = { status: "idle", queueSize: 0, currentSessionId: null };

  constructor(config: AppConfig, onMessage: MessageCallback) {
    this.config = config;
    this.onMessage = onMessage;

    this.app = express();
    this.app.use(cors());
    this.app.use(express.json({ limit: "20mb" }));

    this.httpServer = createServer(this.app);
    this.io = new SocketIOServer(this.httpServer, {
      cors: { origin: "*", methods: ["GET", "POST"] },
      maxHttpBufferSize: 10 * 1024 * 1024,
    });

    this.setupRoutes();
    this.setupSocketHandlers();
  }

  private setupRoutes(): void {
    // Serve static web UI
    const uiDist = path.join(PROJECT_ROOT, "web-ui", "dist");
    if (fs.existsSync(uiDist)) {
      this.app.use(express.static(uiDist));
    }

    // Serve results files
    this.app.use("/api/results", express.static(path.join(PROJECT_ROOT, "results")));

    // Health check
    this.app.get("/api/health", (_req, res) => {
      res.json({ status: "ok", uptime: process.uptime() });
    });

    // ── Settings API (runtime config) ──
    this.app.get("/api/settings", (_req, res) => {
      res.json({
        openrouterModel: this.config.openrouterModel,
        visionModel: this.config.visionModel,
        chatModel: this.config.chatModel,
        openrouterBaseUrl: this.config.openrouterBaseUrl,
        hasApiKey: !!this.config.openrouterApiKey,
      });
    });

    this.app.patch("/api/settings", (req, res) => {
      const { openrouterApiKey, openrouterModel, visionModel, chatModel, openrouterBaseUrl } = req.body;
      if (openrouterApiKey !== undefined) this.config.openrouterApiKey = openrouterApiKey;
      if (openrouterModel !== undefined) this.config.openrouterModel = openrouterModel;
      if (visionModel !== undefined) this.config.visionModel = visionModel;
      if (chatModel !== undefined) this.config.chatModel = chatModel;
      if (openrouterBaseUrl !== undefined) this.config.openrouterBaseUrl = openrouterBaseUrl;
      res.json({ ok: true });
    });

    // ── Sessions API ──
    this.app.get("/api/sessions", (_req, res) => {
      const db = getDb();
      const sessions = db
        .prepare("SELECT id, title, created_at, last_activity, message_count FROM sessions ORDER BY last_activity DESC")
        .all();
      res.json(sessions);
    });

    this.app.patch("/api/sessions/:id", (req, res) => {
      const { title } = req.body;
      if (typeof title !== "string") {
        res.status(400).json({ error: "title is required" });
        return;
      }
      renameSession(req.params.id, title);
      res.json({ ok: true });
    });

    this.app.delete("/api/sessions/:id", (req, res) => {
      const sessionId = req.params.id;
      const shouldDeleteFiles = req.query.deleteFiles === "true";

      if (shouldDeleteFiles) {
        // Get file paths before deleting DB records
        const files = getSessionFiles(sessionId);
        for (const f of files) {
          try {
            if (fs.existsSync(f.file_path)) {
              fs.unlinkSync(f.file_path);
              logger.info({ path: f.file_path }, "Deleted session result file");
            }
          } catch (err) {
            logger.warn({ path: f.file_path, err }, "Failed to delete file");
          }
        }
      }

      deleteSession(sessionId);
      res.json({ ok: true });
    });

    this.app.get("/api/sessions/:id/messages", (req, res) => {
      const db = getDb();
      const messages = db
        .prepare("SELECT id, role, content, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp ASC")
        .all(req.params.id);
      res.json(messages);
    });

    this.app.get("/api/sessions/:id/files", (req, res) => {
      const files = getSessionFiles(req.params.id);
      const mapped = files.map((f) => ({
        ...f,
        url: `/api/results/${f.relative_path}`,
      }));
      res.json(mapped);
    });

    this.app.get("/api/sessions/:id/files/:fileId/download", (req, res) => {
      const files = getSessionFiles(req.params.id);
      const file = files.find((f) => f.id === parseInt(req.params.fileId, 10));
      if (!file) { res.status(404).json({ error: "File not found" }); return; }
      if (!fs.existsSync(file.file_path)) { res.status(404).json({ error: "File no longer exists on disk" }); return; }
      res.download(file.file_path, file.file_name);
    });

    // ── Worklist API (DICOM Studies) ──
    this.app.get("/api/worklist", (_req, res) => {
      const studies = getAllStudies();
      res.json(studies);
    });

    this.app.get("/api/worklist/:studyUid/series", (req, res) => {
      const series = getStudySeries(req.params.studyUid);
      res.json(series);
    });

    this.app.get("/api/worklist/:studyUid/series/:seriesUid/instances", (req, res) => {
      const instances = getSeriesInstances(req.params.seriesUid);
      res.json(instances);
    });

    this.app.get("/api/worklist/:studyUid/series/:seriesUid/imageIds", (req, res) => {
      // Use relative URLs so it works behind tunnels/proxies (no mixed content)
      const imageIds = getWadoUriList(req.params.seriesUid, "");
      res.json(imageIds.map((url) => `wadouri:${url}`));
    });

    // ── WADO-URI endpoint: serve raw DICOM files ──
    this.app.get("/api/wado", (req, res) => {
      const { studyUID, seriesUID, objectUID } = req.query;
      if (!objectUID) { res.status(400).json({ error: "objectUID required" }); return; }

      const db = getDb();
      const instance = db
        .prepare("SELECT file_path FROM dicom_instances WHERE sop_instance_uid = ?")
        .get(objectUID as string) as { file_path: string } | undefined;

      if (!instance || !fs.existsSync(instance.file_path)) {
        res.status(404).json({ error: "DICOM instance not found" });
        return;
      }

      res.setHeader("Content-Type", "application/dicom");
      res.sendFile(instance.file_path);
    });

    // ── Results API ──
    this.app.get("/api/results-meta/:studyUid", (req, res) => {
      const results = getStudyResults(req.params.studyUid);
      res.json(results);
    });

    // ── Skills API ──
    this.app.get("/api/skills", (_req, res) => {
      const skills = [
        { name: "scan_dicom", description: "Scan DICOM study and list series", shortcut: "/scan" },
        { name: "generate_mip", description: "Generate MIP images from PET", shortcut: "/mip" },
        { name: "calc_suv", description: "Calculate organ SUV statistics", shortcut: "/suv" },
        { name: "quantify_lesion", description: "Detect and quantify lesions", shortcut: "/lesion" },
        { name: "segment_organ", description: "Segment organs from CT", shortcut: "/segment" },
        { name: "vision_interpret", description: "VLM image interpretation", shortcut: "/vision" },
        { name: "generate_report", description: "Generate analysis report", shortcut: "/report" },
      ];
      res.json(skills);
    });

    // ── Contour extraction endpoint ──
    const contourCache = new Map<string, { data: unknown; ts: number }>();
    const CONTOUR_CACHE_TTL = 600_000; // 10 min

    this.app.get("/api/overlays/:studyUid/contours", (req, res) => {
      const segPath = req.query.seg_path as string;
      if (!segPath) {
        res.status(400).json({ error: "seg_path query parameter required" });
        return;
      }

      // Resolve relative to results dir
      const resolved = path.resolve(path.join(PROJECT_ROOT, "results"), segPath);
      // Security: must be under results/
      if (!resolved.startsWith(path.join(PROJECT_ROOT, "results"))) {
        res.status(403).json({ error: "Path outside results directory" });
        return;
      }
      if (!fs.existsSync(resolved)) {
        res.status(404).json({ error: "Segmentation file not found" });
        return;
      }

      // Check cache
      const cacheKey = resolved;
      const cached = contourCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < CONTOUR_CACHE_TTL) {
        res.json(cached.data);
        return;
      }

      // Parse optional label names
      const labelsArg = req.query.labels as string | undefined;
      const args = ["-m", "analysis.utils.contour_extract", resolved];
      if (labelsArg) {
        args.push("--labels", labelsArg);
      }

      execFile("python3", args, {
        cwd: PROJECT_ROOT,
        env: { ...process.env, PYTHONPATH: PROJECT_ROOT },
        maxBuffer: 50 * 1024 * 1024,
        timeout: 60_000,
      }, (err, stdout, stderr) => {
        if (err) {
          logger.error({ err: err.message, stderr }, "Contour extraction failed");
          res.status(500).json({ error: "Contour extraction failed", detail: stderr || err.message });
          return;
        }
        try {
          const data = JSON.parse(stdout);
          contourCache.set(cacheKey, { data, ts: Date.now() });
          res.json(data);
        } catch (parseErr) {
          logger.error({ stdout: stdout.slice(0, 200) }, "Failed to parse contour JSON");
          res.status(500).json({ error: "Invalid contour JSON output" });
        }
      });
    });

    // ── Batch Analysis API ──
    this.app.post("/api/batch/analyze", (req, res) => {
      const { prompt, studyUids } = req.body;
      if (!prompt || !Array.isArray(studyUids) || studyUids.length === 0) {
        res.status(400).json({ error: "prompt and studyUids required" });
        return;
      }
      res.json({ ok: true, message: `Batch queued: ${studyUids.length} studies` });
      if (this._batchCallback) {
        this._batchCallback({ prompt, studyUids });
      }
    });

    // ── Batch Results browsing API ──
    this.app.get("/api/batch-results", (_req, res) => {
      const batchDir = path.join(PROJECT_ROOT, "results", "batch_analysis_results");
      if (!fs.existsSync(batchDir)) {
        res.json([]);
        return;
      }
      try {
        const runs = fs.readdirSync(batchDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => ({
            name: d.name,
            path: `batch_analysis_results/${d.name}`,
          }))
          .reverse(); // newest first
        res.json(runs);
      } catch {
        res.json([]);
      }
    });

    // ── Direct VLM Chat (no Python agent) ──
    this.app.post("/api/chat-vlm", async (req, res) => {
      const { sessionId, message, studyUid, images } = req.body as {
        sessionId: string; message: string; studyUid?: string;
        images?: string[];
      };
      if (!sessionId || !message) {
        res.status(400).json({ error: "sessionId and message required" });
        return;
      }

      const db = getDb();

      // Ensure session exists
      const existing = db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId);
      if (!existing) {
        db.prepare("INSERT INTO sessions (id) VALUES (?)").run(sessionId);
      }

      // Save user message
      db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)").run(sessionId, message);
      db.prepare("UPDATE sessions SET last_activity = datetime('now'), message_count = message_count + 1 WHERE id = ?").run(sessionId);

      // Load recent conversation history
      const recentMessages = db.prepare(
        "SELECT role, content FROM messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT 20"
      ).all(sessionId) as { role: string; content: string }[];
      recentMessages.reverse();

      // Load clinical context if study selected
      let clinicalInfo = "";
      if (studyUid) {
        const study = db.prepare(
          "SELECT patient_name, patient_id, clinical_context FROM dicom_studies WHERE study_uid = ?"
        ).get(studyUid) as { patient_name?: string; patient_id?: string; clinical_context?: string } | undefined;
        if (study) {
          clinicalInfo = `\nPatient: ${study.patient_name || "Unknown"} (${study.patient_id || ""})\n${study.clinical_context || ""}`;
        }
      }

      // Load analysis results metadata
      let resultsInfo = "";
      if (studyUid) {
        const results = db.prepare(
          "SELECT result_type, label_name, file_name FROM analysis_results WHERE study_uid = ? ORDER BY created_at DESC LIMIT 5"
        ).all(studyUid) as { result_type: string; label_name: string; file_name: string }[];
        if (results.length > 0) {
          resultsInfo = "\n\nPrevious analysis results:\n" +
            results.map((r) => `- ${r.result_type}: ${r.label_name || r.file_name}`).join("\n");
        }
      }

      const systemPrompt =
        "You are DICOMclaw, a medical image analysis assistant in Chat mode. " +
        "You are viewing the user's current DICOM viewer viewport images. " +
        "Provide concise, clinically relevant observations about what you see. " +
        "You are NOT a diagnostic tool — always recommend professional review." +
        clinicalInfo + resultsInfo;

      try {
        // Use recent history (exclude the just-saved user message which is the last one)
        const historyForVlm = recentMessages.slice(0, -1);

        const answer = await queryVlm(
          systemPrompt,
          message,
          images || [],
          {
            apiKey: this.config.openrouterApiKey,
            model: this.config.chatModel,
            baseUrl: this.config.openrouterBaseUrl,
          },
          historyForVlm,
        );

        // Save assistant message
        db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)").run(sessionId, answer);

        // Emit to socket so other clients see it
        this.io.to(sessionId).emit("agent-message", { sessionId, text: answer, timestamp: Date.now() });

        res.json({ ok: true, response: answer });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        res.status(500).json({ error: msg });
      }
    });

    // SPA fallback
    this.app.get("*", (_req, res) => {
      const indexPath = path.join(uiDist, "index.html");
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).json({ error: "Web UI not built. Run: npm run build:ui" });
      }
    });
  }

  private setupSocketHandlers(): void {
    this.io.on("connection", (socket: Socket) => {
      logger.info({ socketId: socket.id }, "Client connected");
      socket.emit("agent-status", this.currentAgentStatus);

      socket.on("join-session", (sessionId: string) => {
        this.activeSockets.set(sessionId, socket);
        socket.join(sessionId);
        logger.info({ socketId: socket.id, sessionId }, "Joined session");

        const db = getDb();
        const existing = db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId);
        if (!existing) {
          db.prepare("INSERT INTO sessions (id) VALUES (?)").run(sessionId);
        }

        // Re-emit saved overlay steps so VOIs restore on reconnect
        this.emitSessionOverlays(socket, sessionId);
      });

      // Re-send overlay steps for a session (optionally filtered by studyUid)
      socket.on("request-session-overlays", (data: { sessionId: string; studyUid?: string }) => {
        this.emitSessionOverlays(socket, data.sessionId, data.studyUid);
      });

      socket.on("send-message", async (data: { sessionId: string; text: string }) => {
        const { sessionId, text } = data;
        logger.info({ sessionId, textLen: text.length }, "Message received");

        const db = getDb();
        db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)").run(sessionId, text);
        db.prepare("UPDATE sessions SET last_activity = datetime('now'), message_count = message_count + 1 WHERE id = ?").run(sessionId);

        // Auto-title from first message
        const session = db.prepare("SELECT title, message_count FROM sessions WHERE id = ?")
          .get(sessionId) as { title: string | null; message_count: number } | undefined;
        if (session && !session.title && session.message_count <= 1) {
          const autoTitle = text.length > 50 ? text.slice(0, 47) + "..." : text;
          renameSession(sessionId, autoTitle);
          this.io.to(sessionId).emit("agent-session-title", { sessionId, title: autoTitle });
        }

        this.io.to(sessionId).emit("agent-typing", true);
        try {
          await this.onMessage(sessionId, text);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : "Unknown error";
          this.io.to(sessionId).emit("agent-error", errMsg);
        } finally {
          this.io.to(sessionId).emit("agent-typing", false);
        }
      });

      socket.on("rename-session", (data: { sessionId: string; title: string }) => {
        renameSession(data.sessionId, data.title);
        this.io.to(data.sessionId).emit("agent-session-title", { sessionId: data.sessionId, title: data.title });
      });

      socket.on("approve-plan", (data: { sessionId: string; feedback?: string }) => {
        logger.info({ sessionId: data.sessionId }, "Plan approved by user");
        this.io.to(data.sessionId).emit("plan-approved", { sessionId: data.sessionId });
        const cb = this.planApprovalCallbacks.get(data.sessionId);
        if (cb) cb(data);
      });

      socket.on("select-study", (data: { studyUid: string }) => {
        logger.info({ studyUid: data.studyUid }, "Study selected for viewer");
        // Broadcast to all clients in case of multi-window
        this.io.emit("study-selected", data);
      });

      socket.on("cancel-agent", (data: { sessionId?: string }) => {
        logger.info({ sessionId: data?.sessionId }, "Cancel-agent requested");
        const sid = data?.sessionId || "";
        const killed = this.cancelAgentCallback
          ? this.cancelAgentCallback(sid)
          : false;
        // Immediately reset UI state
        if (sid) {
          this.io.to(sid).emit("agent-typing", false);
          this.io.to(sid).emit("agent-cancelled", { sessionId: sid });
        }
        socket.emit("cancel-agent-result", { ok: killed });
      });

      socket.on("disconnect", () => {
        for (const [sid, s] of this.activeSockets.entries()) {
          if (s.id === socket.id) this.activeSockets.delete(sid);
        }
        logger.info({ socketId: socket.id }, "Client disconnected");
      });
    });
  }

  async connect(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer.listen(this.config.port, this.config.host, () => {
        this.connected = true;
        logger.info({ port: this.config.port, host: this.config.host }, "Web channel listening");
        resolve();
      });
    });
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    const cleaned = this.stripAbsolutePaths(text);
    const db = getDb();
    db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)").run(sessionId, cleaned);
    this.io.to(sessionId).emit("agent-message", { sessionId, text: cleaned, timestamp: Date.now() });
  }

  private stripAbsolutePaths(text: string): string {
    let result = text;
    const resultsDir = path.join(PROJECT_ROOT, "results") + "/";
    result = result.split(resultsDir).join("");
    const rootDir = PROJECT_ROOT + "/";
    result = result.split(rootDir).join("");
    result = result.replace(/\/home\/[^\s]*?\/results\//g, "");
    result = result.replace(/\/tmp\/[^\s]+/g, "(temporary file)");
    return result;
  }

  emitReactStep(sessionId: string, step: ReactStep): void {
    this.io.to(sessionId).emit("agent-react-step", { sessionId, ...step });
    const iterMatch = step.type === "iteration" ? step.content.match(/^(\d+)/) : null;
    const iteration = iterMatch ? parseInt(iterMatch[1], 10) : 0;
    addReactStep(sessionId, iteration, step.type, step.content);
  }

  /** Re-emit saved overlay steps for a session, optionally filtered by studyUid */
  private emitSessionOverlays(socket: Socket, sessionId: string, studyUid?: string): void {
    const db = getDb();
    const overlaySteps = db.prepare(
      "SELECT content FROM react_steps WHERE session_id = ? AND step_type = 'overlay' ORDER BY id"
    ).all(sessionId) as { content: string }[];
    for (const s of overlaySteps) {
      try {
        const parsed = JSON.parse(s.content);
        if (studyUid && parsed.study_uid !== studyUid) continue;
        socket.emit("overlay-available", { sessionId, ...parsed });
      } catch { /**/ }
    }
  }

  emitSessionFiles(sessionId: string): void {
    const files = getSessionFiles(sessionId);
    const mapped = files.map((f) => ({ ...f, url: `/api/results/${f.relative_path}` }));
    this.io.to(sessionId).emit("agent-files-updated", { sessionId, files: mapped });
  }

  emitOverlayAvailable(sessionId: string, data: { study_uid: string; path: string; labels: Array<{ name: string; suv_max?: number }> }): void {
    this.io.to(sessionId).emit("overlay-available", { sessionId, ...data });
  }

  emitViewerCommand(sessionId: string, data: { action: string; [key: string]: unknown }): void {
    this.io.to(sessionId).emit("viewer-command", { sessionId, ...data });
  }

  emitResultsUpdated(sessionId: string, studyUid: string): void {
    this.io.to(sessionId).emit("results-updated", { sessionId, studyUid });
  }

  onPlanApproved(sessionId: string, callback: (data: { sessionId: string; feedback?: string }) => void): void {
    this.planApprovalCallbacks.set(sessionId, callback);
  }

  offPlanApproved(sessionId: string): void {
    this.planApprovalCallbacks.delete(sessionId);
  }

  emitBatchStarted(sessionId: string): void {
    this.io.emit("batch-started", { sessionId });
  }

  emitBatchProgress(data: { studyUid: string; status: string; message?: string; percent?: number }): void {
    this.io.emit("batch-progress", data);
  }

  emitBatchPlan(plan: string): void {
    this.io.emit("batch-plan", { plan });
  }

  emitBatchComplete(): void {
    this.io.emit("batch-complete", {});
  }

  private _batchCallback: ((data: { prompt: string; studyUids: string[] }) => void) | null = null;

  onBatchStarted(callback: (data: { prompt: string; studyUids: string[] }) => void): void {
    this._batchCallback = callback;
  }

  emitAgentStatus(status: "idle" | "busy" | "queued", queueSize: number, currentSessionId: string | null): void {
    this.currentAgentStatus = { status, queueSize, currentSessionId };
    this.io.emit("agent-status", this.currentAgentStatus);
  }

  onCancelAgent(callback: (sessionId: string) => boolean): void {
    this.cancelAgentCallback = callback;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    this.io.close();
    this.httpServer.close();
    this.connected = false;
    logger.info("Web channel disconnected");
  }
}
