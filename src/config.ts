import { config as dotenvConfig } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

dotenvConfig({ path: path.join(projectRoot, ".env") });

export function loadConfig(): AppConfig {
  return {
    port: parseInt(process.env.PORT || "8411", 10),
    host: process.env.HOST || "0.0.0.0",
    openrouterApiKey: process.env.OPENROUTER_API_KEY || "",
    openrouterBaseUrl:
      process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    openrouterModel:
      process.env.OPENROUTER_MODEL || "z-ai/glm-5",
    visionModel:
      process.env.VISION_MODEL || "moonshotai/kimi-k2.5",
    chatModel:
      process.env.CHAT_MODEL || "google/gemini-3.1-flash-lite-preview",
    maxConcurrent: parseInt(process.env.MAX_CONCURRENT || "3", 10),
    agentTimeout: parseInt(process.env.AGENT_TIMEOUT || "3600000", 10),
    logLevel: process.env.LOG_LEVEL || "info",
    studiesDir: path.join(projectRoot, "data", "studies"),
    resultsDir: path.join(projectRoot, "results"),
  };
}

export const PROJECT_ROOT = projectRoot;
