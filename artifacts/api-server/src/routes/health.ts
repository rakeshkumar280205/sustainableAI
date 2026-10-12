import { Router, type IRouter } from "express";
import { asyncHandler } from "../middlewares/errorHandler.js";
import { isConnected } from "../db/index.js";
import config from "../config.js";
import { logger } from "../lib/logger.js";
import { HealthCheckResponse } from "@zeroplate/api-zod";
import { sendValidatedResponse } from "../lib/responseValidation.js";

const router: IRouter = Router();

router.get("/healthz", asyncHandler(async (_req, res) => {
  const dbConnected = isConnected();

  const healthData = {
    status: "ok",
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv,
    port: config.port,
    database: dbConnected ? "connected" : "disconnected",
    ai: {
      openrouter: config.hasOpenRouter ? "available" : "missing",
      huggingface: config.hasHuggingFace ? "available" : "skipped",
      ollama: config.hasOllama ? "enabled" : "skipped",
    },
  };

  logger.debug(healthData, "Health check result");

  sendValidatedResponse(res, 200, HealthCheckResponse, {
    success: true,
    data: healthData,
    error: null,
  }, "GET /healthz");
}));

router.get("/ai/health", asyncHandler(async (req, res) => {
  const requestId = (req as any).id;
  const lastChecked = new Date().toISOString();

  const payload = {
    openrouter: config.hasOpenRouter ? "configured" : "missing",
    huggingface: config.hasHuggingFace ? "enabled" : "skipped",
    ollama: config.hasOllama ? "enabled" : "skipped",
    fallback: "available",
    lastChecked,
  };

  logger.info(
    {
      requestId,
      lastChecked,
      openrouter: payload.openrouter,
      huggingface: payload.huggingface,
      ollama: payload.ollama,
    },
    "AI provider health check completed"
  );

  res.status(200).json(payload);
}));

export default router;
