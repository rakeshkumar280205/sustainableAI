import mongoose, { Schema, Document } from "mongoose";
import config from "../config.js";
import { logger } from "../lib/logger.js";

// ─── CONNECTION SETUP ─────────────────────────────────────────────────────

let connection: typeof mongoose | null = null;

export async function connectDB(): Promise<void> {
    const mongoUri = config.mongodbUri;

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
        logger.error({ err }, "Failed to connect to MongoDB");
        logger.warn("Continuing without database persistence");
    }
}

export async function disconnectDB(): Promise<void> {
    if (!connection) {
        return;
    }

    try {
        await mongoose.disconnect();
        connection = null;
        logger.info("MongoDB disconnected cleanly");
    } catch (err) {
        logger.error({ err }, "Failed to disconnect from MongoDB");
        throw err;
    }
}

export function isConnected(): boolean {
    return connection?.connection?.readyState === 1;
}

// ─── RECIPE HISTORY MODEL ─────────────────────────────────────────────────

export interface IRecipeHistory extends Document {
    _id: mongoose.Types.ObjectId;
    ingredients: string;
    cuisine: string | null;
    recipeCount: number;
    missingCount: number;
    createdAt: Date;
}

const recipeHistorySchema = new Schema<IRecipeHistory>(
    {
        ingredients: {
            type: String,
            required: true,
            trim: true,
        },
        cuisine: {
            type: String,
            default: null,
            trim: true,
        },
        recipeCount: {
            type: Number,
            required: true,
            default: 0,
        },
        missingCount: {
            type: Number,
            required: true,
            default: 0,
        },
        createdAt: {
            type: Date,
            default: Date.now,
        },
    },
    {
        timestamps: false,
        collection: "recipe_history",
    }
);

recipeHistorySchema.index({ createdAt: -1 });

export const RecipeHistoryModel = mongoose.model<IRecipeHistory>(
    "RecipeHistory",
    recipeHistorySchema
);
