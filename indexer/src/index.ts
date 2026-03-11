import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "./db/pool.js";
import { startCrawler, stopCrawler } from "./crawler.js";
import { startHealthServer, stopHealthServer } from "./health.js";
import { getHandlerCount } from "./mappings/index.js";
import { getContractAddresses, getAllTopic0s } from "./decoder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runMigrations() {
  const migrationsDir = path.join(__dirname, "db", "migrations");

  // Handle both dev (src/) and prod (dist/) layouts
  let dir = migrationsDir;
  if (!fs.existsSync(dir)) {
    dir = path.join(__dirname, "..", "src", "db", "migrations");
  }

  if (!fs.existsSync(dir)) {
    console.warn("[init] No migrations directory found, skipping");
    return;
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), "utf-8");
    console.log(`[init] Running migration ${file}...`);
    await pool.query(sql);
  }
  console.log("[init] Migrations complete");
}

async function main() {
  console.log("=== Nookplot Indexer ===");
  console.log(`Contracts: ${getContractAddresses().length}`);
  console.log(`Event signatures: ${getAllTopic0s().length}`);
  console.log(`Event handlers: ${getHandlerCount()}`);

  // Run migrations
  await runMigrations();

  // Start health endpoint
  startHealthServer();

  // Start crawler
  await startCrawler();
}

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[shutdown] SIGTERM received");
  stopCrawler();
  stopHealthServer();
  await pool.end();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[shutdown] SIGINT received");
  stopCrawler();
  stopHealthServer();
  await pool.end();
  process.exit(0);
});

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
