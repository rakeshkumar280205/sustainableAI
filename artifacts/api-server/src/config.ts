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
    openaiBaseUrl: string | null;
    openaiApiKey: string | null;
    huggingfaceApiKey: string | null;
    internalApiKey: string | null;
    hasOpenAI: boolean;
    hasHuggingFace: boolean;
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

    // CORS Origins - allow frontend and localhost
    let corsOrigins: string[] = [
        "http://localhost:3000",      // local backend for frontend
        "http://localhost:5173",      // local vite frontend
        "http://127.0.0.1:3000",
        "http://127.0.0.1:5173",
    ];

    // Add production origins if specified
    const productionOrigins = getEnvironmentVariable("CORS_ORIGINS");
    if (productionOrigins && isProduction) {
        corsOrigins = [
            ...corsOrigins,
            ...productionOrigins.split(",").map((o) => o.trim()),
        ];
    }

    // LOG_LEVEL - with default to info
    const logLevel = getEnvironmentVariable("LOG_LEVEL") || "info";

    // MONGODB_URI - optional
    const mongodbUri = getEnvironmentVariable("MONGODB_URI") || null;
    if (!mongodbUri && isProduction) {
        emitConfigWarning("MONGODB_URI not set in production. Database operations may fail.");
    }

    // OpenAI configuration - support both old and new naming conventions
    const openaiApiKey =
        getEnvironmentVariable("OPENAI_API_KEY") ||
        getEnvironmentVariable("AI_INTEGRATIONS_OPENAI_API_KEY") ||
        null;

    const openaiBaseUrl =
        getEnvironmentVariable("OPENAI_BASE_URL") ||
        getEnvironmentVariable("AI_INTEGRATIONS_OPENAI_BASE_URL") ||
        null;

    if (!openaiApiKey) {
        emitConfigWarning("OPENAI_API_KEY not set. OpenAI vision features will be unavailable.");
    }

    // HuggingFace configuration
    const huggingfaceApiKey =
        getEnvironmentVariable("HUGGINGFACE_API_KEY") ||
        null;

    if (!huggingfaceApiKey) {
        emitConfigWarning("HUGGINGFACE_API_KEY not set. HuggingFace fallback will be unavailable.");
    }

    const internalApiKey = getEnvironmentVariable("INTERNAL_API_KEY") || null;
    if (!internalApiKey && isProduction) {
        emitConfigWarning("INTERNAL_API_KEY not set in production. Protected routes will reject requests.");
    }

    const hasOpenAI = !!openaiApiKey;
    const hasHuggingFace = !!huggingfaceApiKey;

    return {
        port,
        nodeEnv,
        logLevel,
        isProduction,
        isDevelopment,
        corsOrigins,
        mongodbUri,
        openaiBaseUrl,
        openaiApiKey,
        huggingfaceApiKey,
        internalApiKey,
        hasOpenAI,
        hasHuggingFace,
    };
}

const config = loadConfig();

export default config;
