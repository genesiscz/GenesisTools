import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Load environment variables from .env.local (TanStack Start convention)
config({ path: ".env.local" });

export default defineConfig({
    // Schema file location
    schema: "./src/drizzle/schema.ts",

    // Output directory for generated migrations
    out: "./src/drizzle/migrations",

    // Database dialect (PostgreSQL via Neon)
    dialect: "postgresql",

    // Database connection credentials
    dbCredentials: {
        url: process.env.DATABASE_URL!,
    },

    // Verbose output for debugging
    verbose: true,

    // Strict mode for safety
    strict: true,
});
