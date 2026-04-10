import { defineConfig } from "drizzle-kit";
import path from "path";
import { dbConfig } from "./src/config";

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: dbConfig.databaseUrl || "postgresql://",
  },
});
