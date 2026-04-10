import type { NextFunction, Request, Response } from "express";
import config from "../config.js";
import { logger } from "../lib/logger.js";
import {
    ErrorEnvelopeSchema,
    sendValidatedResponse,
} from "../lib/responseValidation.js";

function readApiKeyHeader(req: Request): string | null {
    const headerValue = req.headers["x-api-key"];
    if (Array.isArray(headerValue)) {
        return headerValue[0] ?? null;
    }

    return typeof headerValue === "string" ? headerValue : null;
}

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
    if (config.isDevelopment) {
        next();
        return;
    }

    const providedKey = readApiKeyHeader(req);
    const requestId = (req as any).id;

    if (!config.internalApiKey || !providedKey || providedKey !== config.internalApiKey) {
        logger.warn(
            { requestId, path: req.path, method: req.method },
            "Unauthorized API key attempt",
        );

        sendValidatedResponse(
            res,
            401,
            ErrorEnvelopeSchema,
            {
                success: false,
                data: null,
                error: { message: "Unauthorized" },
            },
            "apiKeyAuth",
            requestId,
        );
        return;
    }

    next();
}
