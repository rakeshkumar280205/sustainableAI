import path from "node:path";
import { existsSync } from "node:fs";
import dotenv from "dotenv";

// Load environment variables from the first existing .env candidate.
// This keeps runtime behavior stable whether scripts run from root or workspace subfolders.
const envCandidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "..", ".env"),
    path.resolve(process.cwd(), "..", "..", ".env"),
];

const envPath = envCandidates.find((candidate) => existsSync(candidate));

if (envPath) {
    dotenv.config({ path: envPath });
} else {
    dotenv.config();
}

/**
 * Centralized configuration system for the backend.
 *
 * All environment variables are loaded here and validated once at startup.
 * This ensures consistent, safe, and production-ready environment handling.
 */

interface Config {
    port: number;
    nodeEnv: "development" | "production" | "test";
    logLevel: string;
    isProduction: boolean;
    isDevelopment: boolean;
    corsOrigins: string[];
    mongodbUri: string | null;
    geminiApiKey: string;
    huggingfaceApiKey: string | null;
    hfFreeOnlyEnabled: boolean;
    openrouterApiKey: string | null;
    ollamaBaseUrl: string;
    ollamaModel: string;
    ollamaVisionModel: string;
    ollamaEnabled: boolean;
    ollamaTimeoutMs: number;
    internalApiKey: string | null;
    hasGemini: boolean;
    hasHuggingFace: boolean;
    hasOpenRouter: boolean;
    hasOllama: boolean;
    aiStrictMode: boolean;
}

function parseBooleanEnv(value: string | undefined, fallback = false): boolean {
    if (value === undefined) return fallback;
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return fallback;
}

function parseBoundedMilliseconds(value: string | undefined, fallback: number, maximum: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(Math.floor(parsed), maximum);
}

function getEnvironmentVariable(key: string): string | undefined {
    return process.env[key];
}

function emitConfigWarning(message: string): void {
    process.stderr.write(`[config] ${message}\n`);
}

function loadConfig(): Config {
    // PORT - with default fallback to 3000
    const rawPort = getEnvironmentVariable("PORT");
    let port = 3000;

    if (rawPort) {
        const parsed = Number(rawPort);
        if (!Number.isNaN(parsed) && parsed > 0) {
            port = parsed;
        } else {
            emitConfigWarning(`Invalid PORT value: "${rawPort}". Using default port 3000.`);
        }
    } else {
        emitConfigWarning("PORT not set. Using default port 3000.");
    }

    // NODE_ENV - with default to development
    const rawNodeEnv = getEnvironmentVariable("NODE_ENV");
    const nodeEnv: "development" | "production" | "test" = (
        ["production", "test"].includes(rawNodeEnv || "") ? rawNodeEnv : "development"
    ) as "development" | "production" | "test";

    const isProduction = nodeEnv === "production";
    const isDevelopment = nodeEnv === "development";

    // CORS origins are local-only by default in development and explicit in production.
    const productionOrigins = getEnvironmentVariable("CORS_ORIGINS");
    const corsOrigins = isProduction
        ? (productionOrigins
            ? productionOrigins.split(",").map((o) => o.trim()).filter(Boolean)
            : [])
        : [
            "http://localhost:3000",
            "http://localhost:5173",
            "http://127.0.0.1:3000",
            "http://127.0.0.1:5173",
        ];

    // LOG_LEVEL - with default to info
    const logLevel = getEnvironmentVariable("LOG_LEVEL") || "info";

    // MONGODB_URI - optional
    const mongodbUri = getEnvironmentVariable("MONGODB_URI") || null;
    if (!mongodbUri && isProduction) {
        emitConfigWarning("MONGODB_URI not set in production. Database operations may fail.");
    }

    const geminiApiKey = getEnvironmentVariable("GEMINI_API_KEY") || "";

    // HuggingFace configuration
    const huggingfaceApiKey =
        getEnvironmentVariable("HUGGINGFACE_API_KEY") ||
        null;
    const hfFreeOnlyEnabled = parseBooleanEnv(getEnvironmentVariable("HF_FREE_ONLY_ENABLED"), false);

    if (!huggingfaceApiKey) {
        emitConfigWarning("HUGGINGFACE_API_KEY not set. HuggingFace fallback will be unavailable.");
    } else if (!hfFreeOnlyEnabled) {
        emitConfigWarning("HF_FREE_ONLY_ENABLED is false. HuggingFace fallback is disabled.");
    }

    const openrouterApiKey = getEnvironmentVariable("OPENROUTER_API_KEY") || null;
    if (!openrouterApiKey) {
        emitConfigWarning("OPENROUTER_API_KEY not set. OpenRouter free routing will be unavailable.");
    }

    const ollamaEnabled = parseBooleanEnv(getEnvironmentVariable("OLLAMA_ENABLED"), false);
    const ollamaBaseUrl = getEnvironmentVariable("OLLAMA_BASE_URL") || "http://127.0.0.1:11434";
    const ollamaTextModel = getEnvironmentVariable("OLLAMA_TEXT_MODEL") || getEnvironmentVariable("OLLAMA_MODEL") || "qwen2.5vl:3b";
    const ollamaVisionModel = getEnvironmentVariable("OLLAMA_VISION_MODEL") || "qwen2.5vl:3b";
    const ollamaTimeoutMs = parseBoundedMilliseconds(
        getEnvironmentVariable("OLLAMA_TIMEOUT_MS"),
        120_000,
        120_000,
    );
    let safeOllamaBaseUrl = "http://127.0.0.1:11434";
    let ollamaUrlValid = false;
    try {
        const parsedOllamaUrl = new URL(ollamaBaseUrl);
        const allowedLocalHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
        if (parsedOllamaUrl.protocol === "http:" && allowedLocalHosts.has(parsedOllamaUrl.hostname)) {
            safeOllamaBaseUrl = parsedOllamaUrl.origin;
            ollamaUrlValid = true;
        } else if (ollamaEnabled) {
            emitConfigWarning("OLLAMA_BASE_URL must target the local loopback host. Ollama is disabled.");
        }
    } catch {
        if (ollamaEnabled) emitConfigWarning("Invalid OLLAMA_BASE_URL. Ollama is disabled.");
    }

    const internalApiKey = getEnvironmentVariable("INTERNAL_API_KEY") || null;
    if (!internalApiKey && isProduction) {
        emitConfigWarning("INTERNAL_API_KEY not set in production. Protected routes will reject requests.");
    }

    const hasGemini = geminiApiKey.length > 0;
    const hasHuggingFace = !!huggingfaceApiKey && hfFreeOnlyEnabled;
    const hasOpenRouter = !!openrouterApiKey;
    const hasOllama = ollamaEnabled && ollamaUrlValid && !!ollamaTextModel;
    const aiStrictMode = parseBooleanEnv(getEnvironmentVariable("AI_STRICT_MODE"), false);

    return {
        port,
        nodeEnv,
        logLevel,
        isProduction,
        isDevelopment,
        corsOrigins,
        mongodbUri,
        geminiApiKey,
        huggingfaceApiKey,
        hfFreeOnlyEnabled,
        openrouterApiKey,
        ollamaBaseUrl: safeOllamaBaseUrl,
        ollamaModel: ollamaTextModel,
        ollamaVisionModel,
        ollamaEnabled,
        ollamaTimeoutMs,
        internalApiKey,
        hasGemini,
        hasHuggingFace,
        hasOpenRouter,
        hasOllama,
        aiStrictMode,
    };
}

const config = loadConfig();

export default config;
