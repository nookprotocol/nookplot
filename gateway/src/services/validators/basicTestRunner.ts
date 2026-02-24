/**
 * Basic capability test runner — the default validation method.
 *
 * Checks verifiable facts about an agent without requiring LLM calls:
 * - On-chain registration in AgentRegistry
 * - ERC-8004 Identity NFT ownership
 * - Valid DID document on IPFS
 * - Profile completeness (name, description, capabilities)
 * - Wallet activity (at least 1 on-chain transaction)
 *
 * Each check contributes points toward a 0-100 score.
 * An agent passing all checks scores ~75-80.
 *
 * @module services/validators/basicTestRunner
 */

import type { Pool } from "pg";
import { ethers } from "ethers";
import type { ValidationTestRunner, TestConfig, TestResult } from "../validationService.js";
import { getReadOnlySDK, type SdkFactoryConfig } from "../../sdkFactory.js";
import { logSecurityEvent } from "../../middleware/auditLog.js";

interface AgentRow {
  id: string;
  address: string;
  display_name: string | null;
  description: string | null;
  capabilities: string[] | null;
  did_cid: string | null;
  erc8004_agent_id: number | null;
  model_provider: string | null;
  model_name: string | null;
}

export class BasicTestRunner implements ValidationTestRunner {
  name = "capability";

  constructor(
    private readonly pool: Pool,
    private readonly sdkConfig: SdkFactoryConfig,
  ) {}

  async runTest(agentId: string, _config: TestConfig): Promise<TestResult> {
    const checks: string[] = [];
    const metrics: Record<string, number> = {};
    let totalScore = 0;

    // Load agent from DB
    const { rows } = await this.pool.query<AgentRow>(
      `SELECT id, address, display_name, description, capabilities, did_cid,
              erc8004_agent_id, model_provider, model_name
       FROM agents WHERE id = $1`,
      [agentId],
    );
    if (rows.length === 0) throw new Error(`Agent ${agentId} not found`);
    const agent = rows[0];

    // --- Check 1: On-chain registration (20 points) ---
    let onChainRegistered = false;
    try {
      const sdk = getReadOnlySDK();
      const agentInfo = await sdk.contracts.getAgent(agent.address);
      if (agentInfo && agentInfo.didCid) {
        onChainRegistered = true;
        totalScore += 20;
        checks.push("PASS: Registered on-chain in AgentRegistry");
      } else {
        checks.push("FAIL: Not registered on-chain");
      }
    } catch {
      checks.push("FAIL: Could not query AgentRegistry");
    }
    metrics.onChainRegistration = onChainRegistered ? 100 : 0;

    // --- Check 2: ERC-8004 Identity NFT (20 points) ---
    const hasErc8004 = agent.erc8004_agent_id !== null;
    if (hasErc8004) {
      totalScore += 20;
      checks.push(`PASS: ERC-8004 Identity NFT #${agent.erc8004_agent_id}`);
    } else {
      checks.push("FAIL: No ERC-8004 Identity NFT");
    }
    metrics.erc8004Identity = hasErc8004 ? 100 : 0;

    // --- Check 3: DID document on IPFS (20 points) ---
    let didValid = false;
    if (agent.did_cid) {
      try {
        const res = await fetch(`https://gateway.pinata.cloud/ipfs/${agent.did_cid}`, {
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) {
          const didDoc = await res.json() as Record<string, unknown>;
          if (didDoc.id && didDoc["@context"]) {
            didValid = true;
            totalScore += 20;
            checks.push(`PASS: Valid DID document at ${agent.did_cid}`);
          } else {
            checks.push("FAIL: DID document missing required fields");
          }
        } else {
          checks.push(`FAIL: DID document fetch returned ${res.status}`);
        }
      } catch {
        checks.push("FAIL: Could not fetch DID document from IPFS");
      }
    } else {
      checks.push("FAIL: No DID CID recorded");
    }
    metrics.didDocument = didValid ? 100 : 0;

    // --- Check 4: Profile completeness (20 points) ---
    let profileScore = 0;
    if (agent.display_name && agent.display_name.length >= 2) profileScore += 5;
    if (agent.description && agent.description.length >= 10) profileScore += 5;
    if (agent.capabilities && agent.capabilities.length > 0) profileScore += 5;
    if (agent.model_provider || agent.model_name) profileScore += 5;
    totalScore += profileScore;
    const profilePct = (profileScore / 20) * 100;
    checks.push(`${profileScore >= 15 ? "PASS" : "PARTIAL"}: Profile completeness ${profileScore}/20`);
    metrics.profileCompleteness = profilePct;

    // --- Check 5: Wallet activity (20 points) ---
    let walletActive = false;
    try {
      const provider = new ethers.JsonRpcProvider(this.sdkConfig.rpcUrl);
      const txCount = await provider.getTransactionCount(agent.address);
      if (txCount > 0) {
        walletActive = true;
        totalScore += 20;
        checks.push(`PASS: Wallet has ${txCount} transaction(s)`);
      } else {
        checks.push("FAIL: Wallet has no transactions");
      }
    } catch {
      checks.push("FAIL: Could not query wallet transaction count");
    }
    metrics.walletActivity = walletActive ? 100 : 0;

    // Compose result
    const score = Math.min(100, totalScore);

    logSecurityEvent("info", "basic-validation-completed", {
      agentId,
      address: agent.address,
      score,
      checks: checks.length,
    });

    return {
      score,
      metrics,
      testPrompt: "Basic capability check: on-chain registration, ERC-8004 identity, DID document, profile, wallet activity",
      testResponse: checks.join("\n"),
      proofMethod: "direct",
    };
  }
}
