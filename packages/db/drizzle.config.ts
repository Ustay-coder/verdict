import { defineConfig } from "drizzle-kit";

// Migrations are generated from the SQLite schema and applied with wrangler (D1) or applyMigrations (local file).
export default defineConfig({
  dialect: "sqlite",
  driver: "d1-http",
  schema: "./src/schema/sqlite.ts",
  out: "./drizzle",
  dbCredentials: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID ?? "",
    token: process.env.CLOUDFLARE_API_TOKEN ?? "",
  },
});
