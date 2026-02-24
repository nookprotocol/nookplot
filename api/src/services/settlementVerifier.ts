/**
 * Independent on-chain settlement verification for the Nookplot x402 API.
 *
 * After the x402 facilitator confirms a settlement, this service
 * asynchronously verifies the transaction on-chain by:
 * 1. Fetching the transaction receipt
 * 2. Checking receipt.status === 1 (success)
 * 3. Parsing USDC Transfer events from the receipt logs
 * 4. Verifying the payer (from) and payee (to) match expectations
 * 5. Verifying the transfer amount matches the endpoint's expected price
 *
 * This runs fire-and-forget — it never blocks or delays the API response.
 * Mismatches are logged as security events for investigation.
 *
 * @module services/settlementVerifier
 */

import { ethers } from "ethers";
import { logSecurityEvent } from "../middleware/auditLog.js";

// ============================================================
//  USDC contract addresses (Base)
// ============================================================

/** USDC contract addresses keyed by CAIP-2 network ID. */
const USDC_ADDRESSES: Record<string, string> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",  // Base mainnet
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
};

/** Minimal ABI for parsing USDC Transfer events. */
const TRANSFER_EVENT_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

const TRANSFER_IFACE = new ethers.Interface(TRANSFER_EVENT_ABI);
const TRANSFER_TOPIC = TRANSFER_IFACE.getEvent("Transfer")!.topicHash;

// ============================================================
//  Verification logic
// ============================================================

interface VerificationParams {
  /** On-chain transaction hash from the facilitator's SettleResponse. */
  txHash: string;
  /** Claimed payer wallet address. */
  expectedPayer: string;
  /** Receiving wallet address (EVM_ADDRESS from config). */
  expectedPayee: string;
  /** CAIP-2 network ID (e.g., "eip155:84532"). */
  network: string;
  /** Expected USDC transfer amount in base units (6 decimals). Optional — if omitted, amount is logged but not verified. */
  expectedAmountBaseUnits?: string;
}

/**
 * Verify a single settlement transaction on-chain.
 *
 * Retries up to 3 times with 5-second delays — the TX may still be
 * pending when the onAfterSettle hook fires.
 */
async function verifySettlement(
  provider: ethers.JsonRpcProvider,
  params: VerificationParams,
): Promise<void> {
  const { txHash, expectedPayer, expectedPayee, network, expectedAmountBaseUnits } = params;

  const usdcAddress = USDC_ADDRESSES[network];
  if (!usdcAddress) {
    logSecurityEvent("warn", "settlement-verify-unknown-network", {
      txHash,
      network,
      knownNetworks: Object.keys(USDC_ADDRESSES),
    });
    return;
  }

  let receipt: ethers.TransactionReceipt | null = null;

  // Retry up to 3 times — TX may be pending when hook fires
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      receipt = await provider.getTransactionReceipt(txHash);
      if (receipt) break;
    } catch (error) {
      logSecurityEvent("debug", "settlement-verify-receipt-error", {
        txHash,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }

  if (!receipt) {
    logSecurityEvent("warn", "settlement-verify-no-receipt", {
      txHash,
      expectedPayer,
      message: "Transaction receipt not found after 3 attempts. May be pending or on wrong chain.",
    });
    return;
  }

  // Check transaction succeeded
  if (receipt.status !== 1) {
    logSecurityEvent("error", "settlement-mismatch", {
      txHash,
      reason: "transaction-failed",
      receiptStatus: receipt.status,
      expectedPayer,
      expectedPayee,
    });
    return;
  }

  // Parse Transfer events from USDC contract
  const usdcLower = usdcAddress.toLowerCase();
  const transferLogs = receipt.logs.filter(
    (log) =>
      log.address.toLowerCase() === usdcLower &&
      log.topics[0] === TRANSFER_TOPIC,
  );

  if (transferLogs.length === 0) {
    logSecurityEvent("error", "settlement-mismatch", {
      txHash,
      reason: "no-usdc-transfer",
      expectedPayer,
      expectedPayee,
      totalLogs: receipt.logs.length,
    });
    return;
  }

  // Verify at least one Transfer matches expected payer and payee
  let matched = false;
  for (const log of transferLogs) {
    try {
      const parsed = TRANSFER_IFACE.parseLog({
        topics: log.topics as string[],
        data: log.data,
      });
      if (!parsed) continue;

      const from = parsed.args[0] as string;
      const to = parsed.args[1] as string;

      if (
        from.toLowerCase() === expectedPayer.toLowerCase() &&
        to.toLowerCase() === expectedPayee.toLowerCase()
      ) {
        const actualAmount = parsed.args[2].toString();

        // Verify transfer amount matches expected price
        if (expectedAmountBaseUnits && actualAmount !== expectedAmountBaseUnits) {
          logSecurityEvent("error", "settlement-mismatch", {
            txHash,
            reason: "amount-mismatch",
            expectedAmount: expectedAmountBaseUnits,
            actualAmount,
            payer: from,
            payee: to,
            network,
          });
          return;
        }

        matched = true;
        logSecurityEvent("debug", "settlement-verified", {
          txHash,
          payer: from,
          payee: to,
          amount: actualAmount,
          expectedAmount: expectedAmountBaseUnits ?? "not-checked",
          network,
        });
        break;
      }
    } catch {
      // Skip unparseable logs
    }
  }

  if (!matched) {
    logSecurityEvent("error", "settlement-mismatch", {
      txHash,
      reason: "payer-payee-mismatch",
      expectedPayer,
      expectedPayee,
      transferCount: transferLogs.length,
    });
  }
}

// ============================================================
//  Factory
// ============================================================

interface SettlementVerifierConfig {
  /** JSON RPC provider for on-chain reads. */
  provider: ethers.JsonRpcProvider;
  /** Receiving wallet address. */
  payeeAddress: string;
  /** CAIP-2 network ID (e.g., "eip155:84532"). */
  network: string;
  /** Fraction of settlements to verify (0.0–1.0). Default: 1.0 (all). */
  sampleRate?: number;
}

/**
 * Create a settlement verification function.
 *
 * Call the returned function from the onAfterSettle hook.
 * It runs asynchronously — never blocks the response.
 */
export function createSettlementVerifier(config: SettlementVerifierConfig) {
  const sampleRate = config.sampleRate ?? parseFloat(
    process.env.SETTLEMENT_VERIFY_SAMPLE_RATE ?? "1.0",
  );

  return function triggerVerification(
    txHash: string,
    expectedPayer: string,
    expectedAmountBaseUnits?: string,
  ): void {
    // Sample rate check — skip verification for a fraction of settlements
    if (sampleRate < 1.0 && Math.random() > sampleRate) {
      return;
    }

    // Validate txHash format
    if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      logSecurityEvent("warn", "settlement-verify-invalid-txhash", {
        txHash,
        expectedPayer,
      });
      return;
    }

    // Fire-and-forget — never awaited, never blocks response
    verifySettlement(config.provider, {
      txHash,
      expectedPayer,
      expectedPayee: config.payeeAddress,
      network: config.network,
      expectedAmountBaseUnits,
    }).catch((error) => {
      logSecurityEvent("error", "settlement-verify-unexpected-error", {
        txHash,
        expectedPayer,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
}
