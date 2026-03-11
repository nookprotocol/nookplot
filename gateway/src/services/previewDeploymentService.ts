/**
 * Preview Deployment Service
 *
 * Manages Docker container lifecycle + credit billing for agent project
 * preview deployments. Containers run on the gateway host with port-based
 * routing and hourly credit billing.
 */

import type pg from "pg";
import type Docker from "dockerode";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import * as http from "http";
import { logSecurityEvent } from "../middleware/auditLog.js";
import { SECRET_PATTERNS } from "./execService.js";
import type { CreditManager } from "./creditManager.js";
import { gatewayConfig } from "../config.js";

export interface DeployOpts {
  agentId: string;
  projectId: string;
  runtime: string;
  startCommand: string;
  image: string;
  files: Record<string, string>;
  deploymentCid?: string;
  txHash?: string;
  deploymentNumber?: number;
}

export interface DeploymentRecord {
  id: string;
  agent_id: string;
  project_id: string;
  tx_hash: string | null;
  deployment_cid: string | null;
  deployment_number: number;
  status: string;
  runtime: string;
  start_command: string;
  image: string;
  container_id: string | null;
  host_port: number | null;
  deploy_credits: number;
  hourly_rate: number;
  credits_prepaid: number;
  credits_used: number;
  next_bill_at: string | null;
  last_health_at: string | null;
  health_fails: number;
  build_log: string | null;
  error_message: string | null;
  memory_mb: number;
  deployed_at: string | null;
  stopped_at: string | null;
  created_at: string;
  updated_at: string;
}

const ALLOWED_PREVIEW_IMAGES = new Set([
  "node:20-slim",
  "node:22-slim",
  "python:3.12-slim",
  "python:3.13-slim",
  "denoland/deno:2.0",
]);

export class PreviewDeploymentService {
  private pool: pg.Pool;
  private docker: Docker;
  private creditManager: CreditManager;

  constructor(pool: pg.Pool, docker: Docker, creditManager: CreditManager) {
    this.pool = pool;
    this.docker = docker;
    this.creditManager = creditManager;
  }

  /**
   * Detect runtime from project files.
   */
  detectRuntime(files: Record<string, string>): {
    runtime: string;
    image: string;
    startCommand: string;
  } {
    const fileNames = Object.keys(files);

    if (fileNames.includes("deno.json") || fileNames.includes("deno.jsonc")) {
      const mainFile = fileNames.find(
        (f) => f === "main.ts" || f === "main.js" || f === "mod.ts",
      ) ?? "main.ts";
      return {
        runtime: "deno",
        image: "denoland/deno:2.0",
        startCommand: `deno run --allow-net --allow-read ${mainFile}`,
      };
    }

    if (fileNames.includes("requirements.txt")) {
      const mainFile = fileNames.find(
        (f) => f === "app.py" || f === "main.py" || f === "server.py",
      ) ?? "app.py";
      return {
        runtime: "python",
        image: "python:3.12-slim",
        startCommand: `pip install -r requirements.txt && python ${mainFile}`,
      };
    }

    if (fileNames.includes("package.json")) {
      try {
        const pkg = JSON.parse(files["package.json"]);
        if (pkg.scripts?.start) {
          return {
            runtime: "node",
            image: "node:20-slim",
            startCommand: "npm install && npm start",
          };
        }
      } catch {
        // ignore parse errors
      }
      const mainFile = fileNames.find(
        (f) => f === "index.js" || f === "server.js" || f === "app.js",
      ) ?? "index.js";
      return {
        runtime: "node",
        image: "node:20-slim",
        startCommand: `npm install && node ${mainFile}`,
      };
    }

    // Fallback: node
    const mainFile = fileNames.find(
      (f) => f === "index.js" || f === "server.js" || f === "app.js",
    ) ?? "index.js";
    return {
      runtime: "node",
      image: "node:20-slim",
      startCommand: `node ${mainFile}`,
    };
  }

  /**
   * Deploy a preview container.
   * Returns immediately with deployment ID; build runs async.
   */
  async deploy(
    opts: DeployOpts,
    prepaidHours: number,
  ): Promise<{ deploymentId: string; status: string }> {
    const config = gatewayConfig;

    // Validate image
    if (!ALLOWED_PREVIEW_IMAGES.has(opts.image)) {
      throw new Error(
        `Image not allowed: ${opts.image}. Allowed: ${[...ALLOWED_PREVIEW_IMAGES].join(", ")}`,
      );
    }

    // Check per-agent limit
    const { rows: agentRows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM preview_deployments
       WHERE agent_id = $1 AND status IN ('building','running','paused')`,
      [opts.agentId],
    );
    if (Number(agentRows[0].count) >= config.previewMaxPerAgent) {
      throw new Error(
        `Per-agent deployment limit reached (max ${config.previewMaxPerAgent})`,
      );
    }

    // Check global limit
    const { rows: globalRows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM preview_deployments
       WHERE status IN ('building','running','paused')`,
    );
    if (Number(globalRows[0].count) >= config.previewMaxGlobal) {
      throw new Error(
        `Global deployment limit reached (max ${config.previewMaxGlobal})`,
      );
    }

    // Secret-scan files
    for (const [filePath, content] of Object.entries(opts.files)) {
      for (const [patternName, regex] of SECRET_PATTERNS) {
        if (regex.test(content)) {
          throw new Error(
            `Secret detected in ${filePath}: ${patternName}. Remove secrets before deploying.`,
          );
        }
      }
    }

    // Validate prepaid hours
    const hours = Math.max(
      config.previewPrepayMinHours,
      Math.min(prepaidHours, config.previewPrepayMaxHours),
    );

    // Calculate total credit cost
    const totalCost =
      config.previewDeployCredits + hours * config.previewHourlyRate;

    // Deduct credits upfront
    await this.creditManager.deductCredits(
      opts.agentId,
      totalCost,
      `preview-deploy-${opts.projectId}-${Date.now()}`,
      "preview_deploy",
    );

    // Insert DB row
    const { rows: inserted } = await this.pool.query<{ id: string }>(
      `INSERT INTO preview_deployments
         (agent_id, project_id, tx_hash, deployment_cid, deployment_number,
          status, runtime, start_command, image,
          deploy_credits, hourly_rate, credits_prepaid, memory_mb)
       VALUES ($1, $2, $3, $4, $5,
               'building', $6, $7, $8,
               $9, $10, $11, $12)
       RETURNING id`,
      [
        opts.agentId,
        opts.projectId,
        opts.txHash ?? null,
        opts.deploymentCid ?? null,
        opts.deploymentNumber ?? 1,
        opts.runtime,
        opts.startCommand,
        opts.image,
        config.previewDeployCredits,
        config.previewHourlyRate,
        hours * config.previewHourlyRate,
        config.previewMemoryMb,
      ],
    );

    const deploymentId = inserted[0].id;

    // Async build + start (fire-and-forget)
    this.buildAndStart(deploymentId, opts, hours).catch((err) => {
      logSecurityEvent("error", "preview-build-failed", {
        deploymentId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return { deploymentId, status: "building" };
  }

  /**
   * Async build and start a container.
   */
  private async buildAndStart(
    deploymentId: string,
    opts: DeployOpts,
    prepaidHours: number,
  ): Promise<void> {
    let port: number | null = null;
    let tmpDir: string | null = null;

    try {
      // Allocate port
      port = await this.allocatePort(deploymentId);

      // Write files to temp dir
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nk-preview-"));
      for (const [filePath, content] of Object.entries(opts.files)) {
        const fullPath = path.resolve(tmpDir, filePath);
        if (!fullPath.startsWith(tmpDir + path.sep) && fullPath !== tmpDir) {
          throw new Error(`Path escape detected: ${filePath}`);
        }
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content, "utf8");
      }

      // Make workspace writable by container user
      await fs.chmod(tmpDir, 0o777);
      for (const [filePath] of Object.entries(opts.files)) {
        const fullPath = path.resolve(tmpDir, filePath);
        await fs.chmod(fullPath, 0o666);
        let dir = path.dirname(fullPath);
        while (dir !== tmpDir && dir.startsWith(tmpDir)) {
          await fs.chmod(dir, 0o777);
          dir = path.dirname(dir);
        }
      }

      // Create container
      const container = await this.docker.createContainer({
        Image: opts.image,
        Cmd: ["sh", "-c", opts.startCommand],
        WorkingDir: "/workspace",
        User: "1000:1000",
        Env: [`PORT=3000`],
        ExposedPorts: { "3000/tcp": {} },
        HostConfig: {
          Binds: [`${tmpDir}:/workspace:rw`],
          Memory: gatewayConfig.previewMemoryMb * 1024 * 1024,
          NanoCpus: 512e6,
          PidsLimit: 128,
          NetworkMode: "bridge",
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
          AutoRemove: false,
          PortBindings: {
            "3000/tcp": [{ HostPort: String(port) }],
          },
        },
        Tty: false,
        OpenStdin: false,
      });

      await container.start();

      const containerInfo = await container.inspect();
      const containerId = containerInfo.Id;

      // Update DB with container info
      await this.pool.query(
        `UPDATE preview_deployments
         SET container_id = $1, host_port = $2, status = 'building',
             updated_at = NOW()
         WHERE id = $3`,
        [containerId, port, deploymentId],
      );

      // Poll health check (30s timeout)
      const healthy = await this.pollHealth(port, 30000);

      if (healthy) {
        const nextBill = new Date(
          Date.now() + prepaidHours * 60 * 60 * 1000,
        ).toISOString();
        await this.pool.query(
          `UPDATE preview_deployments
           SET status = 'running', deployed_at = NOW(), next_bill_at = $1,
               last_health_at = NOW(), updated_at = NOW()
           WHERE id = $2`,
          [nextBill, deploymentId],
        );
        logSecurityEvent("info", "preview-deployed", {
          deploymentId,
          port,
          agentId: opts.agentId,
          projectId: opts.projectId,
        });
      } else {
        // Failed to start — stop container, refund credits
        try {
          await container.stop({ t: 5 });
        } catch {
          /* ignore */
        }
        try {
          await container.remove({ force: true });
        } catch {
          /* ignore */
        }
        await this.releasePort(port);

        // Refund prepaid hosting credits (not deploy cost)
        const refund = prepaidHours * gatewayConfig.previewHourlyRate;
        if (refund > 0) {
          try {
            await this.creditManager.addCredits(
              opts.agentId,
              refund,
              `preview-refund-${deploymentId}`,
              "preview_refund",
            );
          } catch {
            /* best effort */
          }
        }

        await this.pool.query(
          `UPDATE preview_deployments
           SET status = 'failed', error_message = 'Health check timed out after 30s',
               stopped_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [deploymentId],
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (port) {
        await this.releasePort(port).catch(() => {});
      }
      await this.pool.query(
        `UPDATE preview_deployments
         SET status = 'failed', error_message = $1, stopped_at = NOW(), updated_at = NOW()
         WHERE id = $2`,
        [msg, deploymentId],
      );
    } finally {
      // Clean up temp dir after container is running (bind mount is active)
      // Note: we intentionally do NOT delete tmpDir here — the container needs it
    }
  }

  /**
   * Poll health check on container port.
   */
  private async pollHealth(
    port: number,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const ok = await this.httpGet(port, "/", 3000);
        if (ok) return true;
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  /**
   * HTTP GET to localhost:port, returns true if response received (any status).
   */
  private httpGet(
    port: number,
    path: string,
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.request(
        { hostname: "127.0.0.1", port, path, method: "GET", timeout: timeoutMs },
        (res) => {
          res.resume();
          resolve(true);
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  /**
   * Stop a deployment.
   */
  async stop(deploymentId: string, agentId: string): Promise<void> {
    const dep = await this.getDeployment(deploymentId);
    if (!dep) throw new Error("Deployment not found");
    if (dep.agent_id !== agentId) throw new Error("Not authorized");
    if (dep.status === "stopped" || dep.status === "failed")
      throw new Error("Deployment already stopped");

    if (dep.container_id) {
      try {
        const container = this.docker.getContainer(dep.container_id);
        await container.stop({ t: 5 });
      } catch {
        /* ignore if already stopped */
      }
    }

    if (dep.host_port) {
      await this.releasePort(dep.host_port);
    }

    await this.pool.query(
      `UPDATE preview_deployments
       SET status = 'stopped', stopped_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [deploymentId],
    );

    logSecurityEvent("info", "preview-stopped", { deploymentId, agentId });
  }

  /**
   * Pause a deployment (called by billing when credits deplete).
   */
  async pause(deploymentId: string): Promise<void> {
    const dep = await this.getDeployment(deploymentId);
    if (!dep || dep.status !== "running") return;

    if (dep.container_id) {
      try {
        const container = this.docker.getContainer(dep.container_id);
        await container.stop({ t: 5 });
      } catch {
        /* ignore */
      }
    }

    await this.pool.query(
      `UPDATE preview_deployments
       SET status = 'paused', updated_at = NOW()
       WHERE id = $1`,
      [deploymentId],
    );

    logSecurityEvent("info", "preview-paused", {
      deploymentId,
      agentId: dep.agent_id,
    });
  }

  /**
   * Resume a paused deployment.
   */
  async resume(deploymentId: string, agentId: string): Promise<void> {
    const dep = await this.getDeployment(deploymentId);
    if (!dep) throw new Error("Deployment not found");
    if (dep.agent_id !== agentId) throw new Error("Not authorized");
    if (dep.status !== "paused") throw new Error("Deployment is not paused");

    const config = gatewayConfig;
    const resumeCost = config.previewResumeCost + config.previewHourlyRate; // resume + 1hr prepay

    await this.creditManager.deductCredits(
      agentId,
      resumeCost,
      `preview-resume-${deploymentId}`,
      "preview_resume",
    );

    if (dep.container_id) {
      try {
        const container = this.docker.getContainer(dep.container_id);
        await container.start();
      } catch {
        throw new Error("Failed to restart container");
      }
    }

    const nextBill = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await this.pool.query(
      `UPDATE preview_deployments
       SET status = 'running', next_bill_at = $1,
           credits_prepaid = credits_prepaid + $2,
           updated_at = NOW()
       WHERE id = $3`,
      [nextBill, config.previewHourlyRate, deploymentId],
    );

    logSecurityEvent("info", "preview-resumed", { deploymentId, agentId });
  }

  /**
   * Delete a deployment entirely.
   */
  async delete(deploymentId: string, agentId: string): Promise<void> {
    const dep = await this.getDeployment(deploymentId);
    if (!dep) throw new Error("Deployment not found");
    if (dep.agent_id !== agentId) throw new Error("Not authorized");

    if (dep.container_id) {
      try {
        const container = this.docker.getContainer(dep.container_id);
        await container.stop({ t: 5 });
      } catch {
        /* ignore */
      }
      try {
        const container = this.docker.getContainer(dep.container_id);
        await container.remove({ force: true });
      } catch {
        /* ignore */
      }
    }

    if (dep.host_port) {
      await this.releasePort(dep.host_port);
    }

    await this.pool.query(`DELETE FROM preview_deployments WHERE id = $1`, [
      deploymentId,
    ]);

    logSecurityEvent("info", "preview-deleted", { deploymentId, agentId });
  }

  /**
   * Billing tick — charge running deployments that are past their next_bill_at.
   */
  async tickBilling(): Promise<void> {
    const { rows } = await this.pool.query<DeploymentRecord>(
      `SELECT * FROM preview_deployments
       WHERE status = 'running' AND next_bill_at <= NOW()`,
    );

    for (const dep of rows) {
      try {
        await this.creditManager.deductCredits(
          dep.agent_id,
          dep.hourly_rate,
          `preview-billing-${dep.id}-${Date.now()}`,
          "preview_hosting",
        );

        const nextBill = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        await this.pool.query(
          `UPDATE preview_deployments
           SET credits_used = credits_used + $1, next_bill_at = $2, updated_at = NOW()
           WHERE id = $3`,
          [dep.hourly_rate, nextBill, dep.id],
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "INSUFFICIENT_CREDITS" || msg === "ACCOUNT_NOT_FOUND") {
          await this.pause(dep.id);
          logSecurityEvent("info", "preview-paused-no-credits", {
            deploymentId: dep.id,
            agentId: dep.agent_id,
          });
        } else {
          logSecurityEvent("warn", "preview-billing-error", {
            deploymentId: dep.id,
            error: msg,
          });
        }
      }
    }
  }

  /**
   * Health check a specific deployment.
   */
  async healthCheck(deploymentId: string): Promise<boolean> {
    const dep = await this.getDeployment(deploymentId);
    if (!dep || dep.status !== "running" || !dep.host_port) return false;

    const healthy = await this.httpGet(dep.host_port, "/", 5000);

    if (healthy) {
      await this.pool.query(
        `UPDATE preview_deployments
         SET last_health_at = NOW(), health_fails = 0, updated_at = NOW()
         WHERE id = $1`,
        [deploymentId],
      );
    } else {
      await this.pool.query(
        `UPDATE preview_deployments
         SET health_fails = health_fails + 1, updated_at = NOW()
         WHERE id = $1`,
        [deploymentId],
      );
    }

    return healthy;
  }

  /**
   * Get a deployment by ID.
   */
  async getDeployment(
    deploymentId: string,
  ): Promise<DeploymentRecord | null> {
    const { rows } = await this.pool.query<DeploymentRecord>(
      `SELECT * FROM preview_deployments WHERE id = $1`,
      [deploymentId],
    );
    return rows[0] ?? null;
  }

  /**
   * List deployments for an agent.
   */
  async listByAgent(agentId: string): Promise<DeploymentRecord[]> {
    const { rows } = await this.pool.query<DeploymentRecord>(
      `SELECT * FROM preview_deployments WHERE agent_id = $1 ORDER BY created_at DESC`,
      [agentId],
    );
    return rows;
  }

  /**
   * List deployments for a project.
   */
  async listByProject(projectId: string): Promise<DeploymentRecord[]> {
    const { rows } = await this.pool.query<DeploymentRecord>(
      `SELECT * FROM preview_deployments WHERE project_id = $1 ORDER BY created_at DESC`,
      [projectId],
    );
    return rows;
  }

  /**
   * Get container logs.
   */
  async getLogs(
    deploymentId: string,
    agentId: string,
    tail: number = 100,
  ): Promise<string> {
    const dep = await this.getDeployment(deploymentId);
    if (!dep) throw new Error("Deployment not found");
    if (dep.agent_id !== agentId) throw new Error("Not authorized");
    if (!dep.container_id) return "";

    try {
      const container = this.docker.getContainer(dep.container_id);
      const logs = await container.logs({
        stdout: true,
        stderr: true,
        tail,
        follow: false,
      });
      return logs.toString("utf8");
    } catch {
      return "";
    }
  }

  /**
   * Allocate a port from the pool.
   */
  private async allocatePort(deploymentId: string): Promise<number> {
    const start = gatewayConfig.previewPortRangeStart;
    const end = gatewayConfig.previewPortRangeEnd;

    // Try random ports until one sticks (PK constraint prevents collision)
    for (let attempt = 0; attempt < 100; attempt++) {
      const port = start + Math.floor(Math.random() * (end - start + 1));
      try {
        await this.pool.query(
          `INSERT INTO preview_port_allocations (host_port, deployment_id) VALUES ($1, $2)`,
          [port, deploymentId],
        );
        return port;
      } catch {
        // PK violation — port taken, try another
      }
    }

    throw new Error("Failed to allocate port after 100 attempts");
  }

  /**
   * Release a port back to the pool.
   */
  private async releasePort(port: number): Promise<void> {
    await this.pool.query(
      `DELETE FROM preview_port_allocations WHERE host_port = $1`,
      [port],
    );
  }
}
