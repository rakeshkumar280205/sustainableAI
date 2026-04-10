import type { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger.js";
import config from "../config.js";

export interface AppError extends Error {
  status?: number;
}

/**
 * Centralized Express error handler.
 * Ensures all errors are returned in a consistent format.
 * Must be registered as the LAST middleware in app.ts.
 */
export function errorHandler(
  err: AppError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const status = err.status ?? 500;
  const message = err.message ?? "An unexpected error occurred. Please try again.";

  logger.error({ err, status }, "Unhandled request error");

  res.status(status).json({
    success: false,
    data: null,
    error: {
      message,
      ...(config.isDevelopment && err.stack
        ? { details: err.stack }
        : {}),
    },
  });
}

/**
 * Wrap an async route handler so unhandled promise rejections are passed
 * to the centralized error handler automatically.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
