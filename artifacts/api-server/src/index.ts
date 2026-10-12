import app from "./app.js";
import { logger } from "./lib/logger.js";
import config from "./config.js";
import { connectDB, disconnectDB, isConnected as isDbConnected } from "./db/index.js";

(async () => {
  let server: ReturnType<typeof app.listen> | null = null;
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info({ signal }, "Shutdown signal received");

    try {
      await new Promise<void>((resolve, reject) => {
        if (!server) {
          resolve();
          return;
        }

        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }

          resolve();
        });
      });

      logger.info("HTTP server closed");

      await disconnectDB();

      logger.info("Graceful shutdown completed");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "Graceful shutdown failed");
      process.exit(1);
    }
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  // Log startup information
  logger.info("====================================");
  logger.info("ZeroPlate Chef API Server Starting");
  logger.info("====================================");
  logger.info({
    environment: config.nodeEnv,
    port: config.port,
    logLevel: config.logLevel,
    hasGemini: config.hasGemini,
    hasHuggingFace: config.hasHuggingFace,
  }, "Configuration loaded");

  // Initialize database connection
  logger.info("Initializing MongoDB connection...");
  await connectDB();

  if (isDbConnected()) {
    logger.info("✓ Database connected and ready");
  } else {
    logger.warn("⚠ Database connection initialized with fallback mode");
  }

  // Log AI services status
  logger.info({
    gemini: config.hasGemini ? "✓ configured" : "✗ not configured",
    huggingface: config.huggingfaceApiKey ? "✓ configured" : "✗ not configured",
  }, "AI provider configuration");

  // Start server
  server = app.listen(config.port);

  server.once("error", async (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      logger.error({ port: config.port }, "Port is already in use. Stop the existing process or set PORT to another value.");
    } else {
      logger.error({ err }, "Error listening on port");
    }

    try {
      await disconnectDB();
    } catch (disconnectErr) {
      logger.error({ err: disconnectErr }, "Failed to disconnect DB after listen error");
    }

    process.exit(1);
  });

  server.once("listening", () => {
    logger.info(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║  🚀 Server started successfully                           ║
║                                                            ║
║  📍 http://localhost:${config.port}                             ║
║  🔍 Health: http://localhost:${config.port}/api/healthz        ║
║                                                            ║
║  Environment: ${config.nodeEnv.padEnd(35)} ║
║  Database:   ${isDbConnected() ? "Connected".padEnd(33) : "Fallback mode".padEnd(33)} ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
    `);
  });
})();
