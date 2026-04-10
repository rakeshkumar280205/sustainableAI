import mongoose from "mongoose";
import { logger } from "./logger";
import { dbConfig } from "./config";
import { RecipeHistoryModel, type IRecipeHistory, type InsertRecipeHistory } from "./schema/recipeHistory";

// Re-export models and types
export { RecipeHistoryModel };
export type { IRecipeHistory, InsertRecipeHistory };

// ─── CONNECTION SETUP ─────────────────────────────────────────────────────

let connection: typeof mongoose | null = null;

export async function connectDB(): Promise<void> {
  const mongoUri = dbConfig.mongodbUri;

  if (!mongoUri) {
    logger.warn(
      "MONGODB_URI not set. Database operations will be skipped. This is OK for development without persistence.",
    );
    return;
  }

  try {
    connection = await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      retryWrites: true,
      w: "majority",
    });

    logger.info("MongoDB connected successfully");
  } catch (err) {
    logger.error("Failed to connect to MongoDB", { err: String(err) });
    logger.warn("Continuing without database persistence");
  }
}

export function isConnected(): boolean {
  return connection?.connection?.readyState === 1;
}

export function getConnection(): typeof mongoose | null {
  return connection;
}
