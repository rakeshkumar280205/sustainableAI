import express, { type Express } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import config from "./config.js";

const app: Express = express();

import { requestIdMiddleware } from "./middlewares/requestId.js";

// ─── REQUEST ID TRACKING (FIRST middleware) ────────────────────────────
// Must be BEFORE logging to ensure request.id is available for all logs
app.use(requestIdMiddleware);

// ─── SECURITY MIDDLEWARE (before everything else) ────────────────────────

// Helmet: Set secure HTTP headers
app.use(helmet());

// Rate limiting: 100 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: "Too many requests from this IP, please try again later.",
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  skip: (_req, _res) => !config.isProduction, // Only enforce in production
});

// ─── REQUEST LOGGING ────────────────────────────────────────────────────

app.use(
  (pinoHttp as unknown as (options: Record<string, unknown>) => express.RequestHandler)({
    logger,
    serializers: {
      req(req: any) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res: any) {
        return { statusCode: res.statusCode };
      },
    },
  })
);

// ─── CORS ──────────────────────────────────────────────────────────────

// CORS configuration for production
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, etc)
      if (!origin) return callback(null, true);

      if (config.corsOrigins.includes(origin)) {
        callback(null, true);
      } else if (config.isDevelopment) {
        // In development, allow any origin
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ─── BODY PARSING ──────────────────────────────────────────────────────

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ─── RATE LIMITING (apply to API routes) ──────────────────────────────

app.use("/api", limiter);

// ─── ROUTES ────────────────────────────────────────────────────────────

app.use("/api", router);

// ─── ERROR HANDLER (must be last) ──────────────────────────────────────

// Centralized error handler — must be last
app.use(errorHandler);

export default app;
