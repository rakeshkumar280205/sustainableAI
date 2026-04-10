import { v4 as uuidv4 } from "uuid";
import type { Request, Response, NextFunction } from "express";

/**
 * Middleware to attach a unique request ID to every incoming request.
 * This enables request-level tracing and correlation in logs.
 */
export function requestIdMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
): void {
    // Generate unique request ID
    const requestId = uuidv4();

    // Attach to request for access in handlers/logging
    (req as any).id = requestId;

    // Attach to response headers for client tracking
    res.setHeader("X-Request-ID", requestId);

    next();
}
