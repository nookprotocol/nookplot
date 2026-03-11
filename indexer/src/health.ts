import http from "http";
import { ethers } from "ethers";
import { pool } from "./db/pool.js";
import { config } from "./config.js";

let server: http.Server | null = null;

export function startHealthServer() {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);

  server = http.createServer(async (req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      try {
        const [stateResult, chainHead] = await Promise.all([
          pool.query("SELECT last_block, updated_at FROM idx_state WHERE id = 1"),
          provider.getBlockNumber(),
        ]);

        const state = stateResult.rows[0];
        const lastBlock = state?.last_block ?? 0;
        const behind = chainHead - lastBlock;
        const updatedAt = state?.updated_at ?? null;

        // Consider healthy if within 50 blocks of head
        const status = behind <= 50 ? "ok" : "syncing";

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status,
          lastBlock,
          chainHead,
          behind,
          updatedAt,
        }));
      } catch (err) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "error",
          error: (err as Error).message,
        }));
      }
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  server.listen(config.port, () => {
    console.log(`[health] Listening on port ${config.port}`);
  });
}

export function stopHealthServer() {
  server?.close();
}
