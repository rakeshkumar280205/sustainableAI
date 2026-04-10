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
  const aiAvailable = !!config.openaiApiKey;

  const healthData = {
    status: "ok",
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv,
    port: config.port,
    database: dbConnected ? "connected" : "disconnected",
    ai: {
      openai: aiAvailable ? "available" : "fallback",
      huggingface: !!config.huggingfaceApiKey ? "available" : "unavailable",
    },
  };

  logger.debug(healthData, "Health check result");

  sendValidatedResponse(res, 200, HealthCheckResponse, {
    success: true,
    data: healthData,
    error: null,
  }, "GET /healthz");
}));

export default router;
