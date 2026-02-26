/**
 * PostgreSQL database pool and migration runner for the Agent Gateway.
 *
 * Uses node-postgres (pg) with a connection pool. Migrations are plain SQL
 * files in the migrations/ directory, tracked by a migrations table.
 *
 * @module db
 */

import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;

let pool: pg.Pool | null = null;
let initializedUrl: string | null = null;

/**
 * Get or create the shared database pool.
 *
 * @throws If called again with a different URL (potential misconfiguration).
 */
export function getPool(databaseUrl: string): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    initializedUrl = databaseUrl;
  } else if (initializedUrl && initializedUrl !== databaseUrl) {
    throw new Error(
      "getPool() called with a different DATABASE_URL than the initial call. " +
      "This likely indicates a configuration error.",
    );
  }
  return pool;
}

/**
 * Run pending SQL migrations from the migrations/ directory.
 *
 * Creates a `migrations` tracking table if it doesn't exist, then runs any
 * migration files that haven't been applied yet (in filename sort order).
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const db = getPool(databaseUrl);

  // Ensure the migrations tracking table exists
  await db.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Find migration files
  const migrationsDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../migrations",
  );

  if (!fs.existsSync(migrationsDir)) {
    console.log("No migrations directory found — skipping.");
    return;
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  // Check which migrations have already been applied
  const { rows: applied } = await db.query<{ name: string }>(
    "SELECT name FROM migrations ORDER BY name",
  );
  const appliedSet = new Set(applied.map((r) => r.name));

  for (const file of files) {
    if (appliedSet.has(file)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
    console.log(`Running migration: ${file}`);

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`  Applied: ${file}`);
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(`  FAILED: ${file}`);
      throw error;
    } finally {
      client.release();
    }
  }

  console.log("Migrations complete.");
}

/**
 * Gracefully close the database pool.
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// If run directly (npm run migrate), run migrations
const isDirectRun = process.argv[1]?.includes("db.");
if (isDirectRun) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required. Set it in .env or environment.");
    process.exit(1);
  }
  runMigrations(url)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}
