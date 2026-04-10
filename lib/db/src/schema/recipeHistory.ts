import mongoose, { Schema, Document } from "mongoose";

// ─── TYPESCRIPT TYPES ─────────────────────────────────────────────────────

export interface IRecipeHistory extends Document {
  _id: mongoose.Types.ObjectId;
  ingredients: string;
  cuisine: string | null;
  recipeCount: number;
  missingCount: number;
  createdAt: Date;
}

export type RecipeHistory = Omit<IRecipeHistory, "_id" | "createdAt"> & {
  id: string;
  createdAt: string;
};

// ─── MONGOOSE SCHEMA ──────────────────────────────────────────────────────

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

// ─── MODEL ────────────────────────────────────────────────────────────────

export const RecipeHistoryModel = mongoose.model<IRecipeHistory>(
  "RecipeHistory",
  recipeHistorySchema
);

// ─── HELPER TYPES (for API compatibility) ────────────────────────────────

export type InsertRecipeHistory = Omit<IRecipeHistory, "_id" | "createdAt">;

