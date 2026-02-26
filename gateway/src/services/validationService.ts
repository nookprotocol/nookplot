/**
 * ERC-8004 Validation Registry service for the Agent Gateway.
 *
 * Manages the full validation lifecycle: agents request validation,
 * test runners evaluate capabilities, results are recorded locally
 * and optionally submitted on-chain to the ERC-8004 Validation Registry.
 *
 * Supports pluggable test runners: basic capability check (default),
 * LLM-as-judge inference testing (opt-in), EZKL/ZKML (future).
 *
 * @module services/validationService
 */

import type { Pool } from "pg";
import { ethers } from "ethers";
import { ERC8004_VALIDATION_REGISTRY_ABI } from "@nookplot/sdk/dist/abis.js";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ============================================================
//  Interfaces
// ============================================================

export interface ValidationServiceConfig {
  validationRegistryAddress: string;
  enabled: boolean;
  autoTrigger: boolean;
  cooldownMs: number;
  maxConcurrent: number;
}

export interface TestConfig {
  testType: "inference" | "capability" | "identity" | "custom";
  customConfig?: Record<string, unknown>;
}

export interface TestResult {
  score: number;
  metrics: Record<string, number>;
  testPrompt: string;
  testResponse: string;
  proofMethod: "direct" | "ezkl" | "tee" | "custom";
  proofData?: unknown;
}

export interface ValidationTestRunner {
  name: string;
  runTest(agentId: string, config: TestConfig): Promise<TestResult>;
}

interface IpfsUploader {
  uploadJson(data: Record<string, unknown>, name?: string): Promise<{ cid: string }>;
  getGatewayUrl(cid: string): string;
}

interface ValidationRequestRow {
  id: string;
  agent_id: string;
  erc8004_agent_id: string | null;
  validator_address: string;
  request_hash: string | null;
  request_uri: string | null;
  status: string;
  test_type: string;
  test_config: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

interface ValidationResultRow {
  id: string;
  request_id: string;
  agent_id: string;
  validator_address: string;
  response_score: number;
  response_uri: string | null;
  response_hash: string | null;
  tag: string;
  tx_hash: string | null;
  test_metrics: Record<string, number>;
  proof_method: string;
  created_at: Date;
}

interface ValidationSummaryRow {
  agent_id: string;
  total_validations: number;
  avg_score: number;
  last_validated: Date | null;
  last_score: number | null;
  badge_level: string;
  computed_at: Date;
}

// ============================================================
//  ValidationService
// ============================================================

export class ValidationService {
  private readonly pool: Pool;
  private readonly ipfs: IpfsUploader;
  private readonly contract: ethers.Contract | null;
  private readonly relayerAddress: string;
  private readonly config: ValidationServiceConfig;
  private readonly testRunners: Map<string, ValidationTestRunner> = new Map();
  private activeTests = 0;

  constructor(
    pool: Pool,
    ipfs: IpfsUploader,
    relayerWallet: ethers.Wallet,
    provider: ethers.JsonRpcProvider,
    config: ValidationServiceConfig,
  ) {
    this.pool = pool;
    this.ipfs = ipfs;
    this.config = config;
    this.relayerAddress = relayerWallet.address;

    if (config.validationRegistryAddress) {
      const connectedWallet = relayerWallet.connect(provider);
      this.contract = new ethers.Contract(
        config.validationRegistryAddress,
        ERC8004_VALIDATION_REGISTRY_ABI,
        connectedWallet,
      );
    } else {
      this.contract = null;
    }
  }

  /** Register a pluggable test runner (e.g. basic, inference, ezkl). */
  registerTestRunner(runner: ValidationTestRunner): void {
    this.testRunners.set(runner.name, runner);
  }

  // ============================================================
  //  Request Flow
  // ============================================================

  /**
   * Create a validation request for an agent.
   * Returns the request ID. Optionally submits on-chain if contract is configured.
   */
  async requestValidation(
    agentId: string,
    testType: string = "capability",
    customConfig?: Record<string, unknown>,
  ): Promise<{ requestId: string; status: string }> {
    // Validate test type
    const validTypes = ["inference", "capability", "identity", "custom"];
    if (!validTypes.includes(testType)) {
      throw new Error(`Invalid test type: ${testType}. Must be one of: ${validTypes.join(", ")}`);
    }

    // Check cooldown
    const { rows: recent } = await this.pool.query<{ created_at: Date }>(
      `SELECT created_at FROM validation_requests
       WHERE agent_id = $1 AND status IN ('pending','submitted','testing','completed')
       ORDER BY created_at DESC LIMIT 1`,
      [agentId],
    );
    if (recent.length > 0) {
      const elapsed = Date.now() - recent[0].created_at.getTime();
      if (elapsed < this.config.cooldownMs) {
        const waitMs = this.config.cooldownMs - elapsed;
        throw new Error(`Validation cooldown active. Try again in ${Math.ceil(waitMs / 60000)} minutes.`);
      }
    }

    // Look up ERC-8004 agent ID
    const { rows: agentRows } = await this.pool.query<{ erc8004_agent_id: string | null }>(
      `SELECT erc8004_agent_id::text FROM agents WHERE id = $1`,
      [agentId],
    );
    const erc8004AgentId = agentRows.length > 0 ? agentRows[0].erc8004_agent_id : null;

    // Create request
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO validation_requests (agent_id, erc8004_agent_id, validator_address, test_type, test_config)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [agentId, erc8004AgentId ? BigInt(erc8004AgentId) : null, this.relayerAddress, testType, JSON.stringify(customConfig ?? {})],
    );
    const requestId = rows[0].id;

    logSecurityEvent("info", "validation-request-created", {
      requestId,
      agentId,
      testType,
      erc8004AgentId,
    });

    // Auto-run if we have a runner for this test type
    const runnerName = testType === "capability" ? "capability" : testType;
    if (this.testRunners.has(runnerName) && this.activeTests < this.config.maxConcurrent) {
      this.runValidation(requestId).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logSecurityEvent("warn", "validation-auto-run-failed", { requestId, error: msg });
      });
    }

    return { requestId, status: "pending" };
  }

  // ============================================================
  //  Validator Flow (Nookplot as validator)
  // ============================================================

  /**
   * Run validation test for a pending request.
   * Executes the appropriate test runner, stores result, updates summary.
   */
  async runValidation(requestId: string): Promise<{ resultId: string; score: number; badge: string }> {
    // Load request
    const { rows: reqRows } = await this.pool.query<ValidationRequestRow>(
      `SELECT * FROM validation_requests WHERE id = $1`,
      [requestId],
    );
    if (reqRows.length === 0) throw new Error(`Validation request ${requestId} not found`);
    const request = reqRows[0];

    if (request.status === "completed") {
      throw new Error(`Validation request ${requestId} already completed`);
    }

    // Find runner
    const runner = this.testRunners.get(request.test_type);
    if (!runner) {
      throw new Error(`No test runner registered for type: ${request.test_type}`);
    }

    // Update status
    await this.pool.query(
      `UPDATE validation_requests SET status = 'testing', updated_at = NOW() WHERE id = $1`,
      [requestId],
    );
    this.activeTests++;

    try {
      // Run test
      const result = await runner.runTest(request.agent_id, {
        testType: request.test_type as TestConfig["testType"],
        customConfig: request.test_config,
      });

      // Clamp score to 0-100
      const score = Math.max(0, Math.min(100, Math.round(result.score)));

      // Build response metadata for IPFS
      const responseMeta: Record<string, unknown> = {
        version: "1.0",
        platform: "nookplot",
        validator: this.relayerAddress,
        agentId: request.agent_id,
        erc8004AgentId: request.erc8004_agent_id,
        testType: request.test_type,
        score,
        metrics: result.metrics,
        proofMethod: result.proofMethod,
        timestamp: Date.now(),
      };

      let responseUri: string | null = null;
      let responseHashHex: string | null = null;
      try {
        const { cid } = await this.ipfs.uploadJson(responseMeta, `validation-${requestId}`);
        responseUri = this.ipfs.getGatewayUrl(cid);
        responseHashHex = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(responseMeta)));
      } catch {
        // IPFS upload is best-effort
      }

      // Store result
      const { rows: resultRows } = await this.pool.query<{ id: string }>(
        `INSERT INTO validation_results
         (request_id, agent_id, validator_address, response_score, response_uri, response_hash,
          tag, test_prompt, test_response, test_metrics, proof_method, proof_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          requestId, request.agent_id, this.relayerAddress, score,
          responseUri, responseHashHex,
          "nookplot-validation",
          result.testPrompt.slice(0, 2000),
          result.testResponse.slice(0, 2000),
          JSON.stringify(result.metrics),
          result.proofMethod,
          result.proofData ? JSON.stringify(result.proofData) : null,
        ],
      );

      // Update request status
      await this.pool.query(
        `UPDATE validation_requests SET status = 'completed', updated_at = NOW() WHERE id = $1`,
        [requestId],
      );

      // Submit on-chain (best-effort)
      if (this.contract && request.erc8004_agent_id && responseHashHex) {
        this.submitResponseOnChain(
          request.erc8004_agent_id,
          requestId,
          score,
          responseUri ?? "",
          responseHashHex,
        ).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          logSecurityEvent("warn", "validation-on-chain-failed", { requestId, error: msg });
        });
      }

      // Recompute summary
      const badge = await this.recomputeSummary(request.agent_id);

      logSecurityEvent("info", "validation-completed", {
        requestId,
        resultId: resultRows[0].id,
        agentId: request.agent_id,
        score,
        badge,
        proofMethod: result.proofMethod,
      });

      return { resultId: resultRows[0].id, score, badge };
    } catch (error) {
      await this.pool.query(
        `UPDATE validation_requests SET status = 'failed', updated_at = NOW() WHERE id = $1`,
        [requestId],
      );
      throw error;
    } finally {
      this.activeTests--;
    }
  }

  /**
   * Submit validation response on-chain via the Validation Registry.
   * Builds a requestHash and calls validationResponse().
   */
  private async submitResponseOnChain(
    erc8004AgentId: string,
    requestId: string,
    score: number,
    responseUri: string,
    responseHash: string,
  ): Promise<string> {
    if (!this.contract) throw new Error("Validation Registry not configured");

    // Build requestHash: keccak256(validatorAddress, agentId, requestId)
    const requestHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "string"],
        [this.relayerAddress, BigInt(erc8004AgentId), requestId],
      ),
    );

    // First submit the request on-chain
    const reqTx = await this.contract.validationRequest(
      this.relayerAddress,
      BigInt(erc8004AgentId),
      `nookplot://validation/${requestId}`,
      requestHash,
    );
    await reqTx.wait();

    // Then submit the response
    const resTx = await this.contract.validationResponse(
      requestHash,
      score,
      responseUri,
      responseHash,
      "nookplot-validation",
    );
    const receipt = await resTx.wait();
    const txHash: string = receipt.hash;

    // Update result with tx hash
    await this.pool.query(
      `UPDATE validation_results SET tx_hash = $1 WHERE request_id = $2`,
      [txHash, requestId],
    );

    // Update request with hash
    await this.pool.query(
      `UPDATE validation_requests SET request_hash = $1, updated_at = NOW() WHERE id = $2`,
      [requestHash, requestId],
    );

    logSecurityEvent("info", "validation-on-chain-submitted", {
      requestId,
      erc8004AgentId,
      requestHash,
      txHash,
      score,
    });

    return txHash;
  }

  // ============================================================
  //  Queries
  // ============================================================

  /** Get validation request with its result (if completed). */
  async getValidationStatus(requestId: string): Promise<{
    request: ValidationRequestRow;
    result: ValidationResultRow | null;
  }> {
    const { rows: reqRows } = await this.pool.query<ValidationRequestRow>(
      `SELECT * FROM validation_requests WHERE id = $1`,
      [requestId],
    );
    if (reqRows.length === 0) throw new Error(`Validation request ${requestId} not found`);

    const { rows: resRows } = await this.pool.query<ValidationResultRow>(
      `SELECT * FROM validation_results WHERE request_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [requestId],
    );

    return { request: reqRows[0], result: resRows[0] ?? null };
  }

  /** Get agent's validation summary (from materialized table). */
  async getAgentSummary(agentId: string): Promise<ValidationSummaryRow | null> {
    const { rows } = await this.pool.query<ValidationSummaryRow>(
      `SELECT * FROM validation_summaries WHERE agent_id = $1`,
      [agentId],
    );
    return rows[0] ?? null;
  }

  /** Get agent summary by wallet address. */
  async getAgentSummaryByAddress(address: string): Promise<ValidationSummaryRow | null> {
    const { rows } = await this.pool.query<ValidationSummaryRow>(
      `SELECT vs.* FROM validation_summaries vs
       JOIN agents a ON a.id = vs.agent_id
       WHERE LOWER(a.address) = LOWER($1)`,
      [address],
    );
    return rows[0] ?? null;
  }

  /** List validation history for an agent. */
  async listValidations(
    agentId: string,
    limit = 20,
    offset = 0,
  ): Promise<ValidationResultRow[]> {
    const { rows } = await this.pool.query<ValidationResultRow>(
      `SELECT vr.* FROM validation_results vr
       WHERE vr.agent_id = $1
       ORDER BY vr.created_at DESC
       LIMIT $2 OFFSET $3`,
      [agentId, Math.min(limit, 100), offset],
    );
    return rows;
  }

  /** Query on-chain validation summary for cross-platform scores. */
  async getOnChainSummary(
    erc8004AgentId: bigint,
    tag = "nookplot-validation",
  ): Promise<{ count: bigint; averageResponse: number } | null> {
    if (!this.contract) return null;
    try {
      const [count, averageResponse] = await this.contract.getSummary(
        erc8004AgentId,
        [this.relayerAddress],
        tag,
      );
      return { count: BigInt(count), averageResponse: Number(averageResponse) };
    } catch {
      return null;
    }
  }

  // ============================================================
  //  Summary Materialization
  // ============================================================

  /** Recompute and store the validation summary for an agent. Returns badge level. */
  async recomputeSummary(agentId: string): Promise<string> {
    const { rows } = await this.pool.query<{ count: string; avg: string; max_date: Date | null; last_score: number | null }>(
      `SELECT COUNT(*)::text AS count, COALESCE(AVG(response_score), 0)::text AS avg,
              MAX(created_at) AS max_date,
              (SELECT response_score FROM validation_results WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1) AS last_score
       FROM validation_results WHERE agent_id = $1`,
      [agentId],
    );

    const count = parseInt(rows[0].count, 10);
    const avg = parseFloat(rows[0].avg);
    const badge = this.computeBadgeLevel(avg, count);

    await this.pool.query(
      `INSERT INTO validation_summaries (agent_id, total_validations, avg_score, last_validated, last_score, badge_level, computed_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (agent_id) DO UPDATE SET
         total_validations = $2, avg_score = $3, last_validated = $4,
         last_score = $5, badge_level = $6, computed_at = NOW()`,
      [agentId, count, avg, rows[0].max_date, rows[0].last_score, badge],
    );

    return badge;
  }

  private computeBadgeLevel(avgScore: number, count: number): string {
    if (count >= 10 && avgScore >= 85) return "elite";
    if (count >= 5 && avgScore >= 70) return "trusted";
    if (count >= 3 && avgScore >= 50) return "verified";
    if (count >= 1 && avgScore >= 30) return "basic";
    return "none";
  }
}
