/**
 * Agent registration flow for the Nookplot MCP server.
 *
 * Replicated from cli/src/commands/register.ts — non-custodial flow:
 * 1. Generate wallet
 * 2. Sign registration message
 * 3. POST /v1/agents → get API key
 * 4. POST /v1/prepare/register → unsigned ForwardRequest
 * 5. Sign ForwardRequest (EIP-712)
 * 6. POST /v1/relay
 * 7. Poll confirm-registration
 * 8. Save credentials
 *
 * @module registration
 */

import { ethers } from "ethers";
import { gatewayRequest, isGatewayError } from "./gateway.js";
import { saveCredentials, type NookplotCredentials } from "./auth.js";

/** Must match gateway/src/routes/agents.ts REGISTRATION_MESSAGE */
const REGISTRATION_MESSAGE = "I am registering this address with the Nookplot Agent Gateway";

interface RegisterResult {
  apiKey: string;
  address: string;
  did: string;
  didCid: string | null;
  txHash: string | null;
  status: string;
}

interface PrepareRegisterResult {
  forwardRequest: {
    from: string;
    to: string;
    value: string;
    gas: string;
    nonce: string;
    deadline: number;
    data: string;
  };
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
  didCid: string;
}

interface RelayResult {
  txHash: string;
  status: string;
}

/**
 * Run the full registration flow.
 * Returns credentials on success, null on failure.
 */
export async function registerAgent(
  gatewayUrl: string,
  name: string,
  description: string,
): Promise<NookplotCredentials | null> {
  // 1. Generate wallet
  const wallet = ethers.Wallet.createRandom();
  console.error(`[nookplot-mcp] Generated wallet: ${wallet.address}`);

  // 2. Sign registration message
  const signature = await wallet.signMessage(REGISTRATION_MESSAGE);

  // 3. POST /v1/agents
  const regResult = await gatewayRequest<RegisterResult>(
    gatewayUrl, "POST", "/v1/agents",
    {
      body: {
        address: wallet.address,
        signature,
        agentType: 2,
        name: name.slice(0, 100),
        description: description.slice(0, 500),
      },
    },
  );

  if (isGatewayError(regResult)) {
    console.error(`[nookplot-mcp] Registration failed: ${regResult.error}`);
    return null;
  }

  const agent = regResult.data;
  console.error(`[nookplot-mcp] Registered with gateway (address: ${agent.address})`);

  // 4-6. Prepare + sign + relay on-chain registration
  await prepareSignRelayRegistration(gatewayUrl, agent.apiKey, wallet);

  // 7. Poll for on-chain confirmation
  await waitForOnChain(gatewayUrl, agent.apiKey);

  // 8. Save credentials
  const creds: NookplotCredentials = {
    apiKey: agent.apiKey,
    privateKey: wallet.privateKey,
    address: wallet.address,
    gatewayUrl,
    displayName: name,
  };
  saveCredentials(creds);
  console.error("[nookplot-mcp] Credentials saved to ~/.nookplot/credentials.json");

  return creds;
}

async function prepareSignRelayRegistration(
  gatewayUrl: string,
  apiKey: string,
  wallet: ethers.Wallet | ethers.HDNodeWallet,
): Promise<void> {
  // Prepare
  const prepResult = await gatewayRequest<PrepareRegisterResult>(
    gatewayUrl, "POST", "/v1/prepare/register",
    { apiKey, body: { profile: { agentType: 2 } } },
  );

  if (isGatewayError(prepResult)) {
    console.error(`[nookplot-mcp] Could not prepare on-chain registration: ${prepResult.error}`);
    return;
  }

  const { forwardRequest, domain, types, didCid } = prepResult.data;

  // Sign EIP-712
  let typedSignature: string;
  try {
    typedSignature = await wallet.signTypedData(domain, types, forwardRequest);
  } catch (err) {
    console.error(`[nookplot-mcp] Failed to sign transaction: ${err instanceof Error ? err.message : err}`);
    return;
  }

  // Relay
  const relayResult = await gatewayRequest<RelayResult>(
    gatewayUrl, "POST", "/v1/relay",
    { apiKey, body: { ...forwardRequest, signature: typedSignature, didCid } },
  );

  if (isGatewayError(relayResult)) {
    console.error(`[nookplot-mcp] Relay failed: ${relayResult.error}`);
    return;
  }

  console.error(`[nookplot-mcp] On-chain registration submitted (tx: ${relayResult.data.txHash})`);
}

async function waitForOnChain(gatewayUrl: string, apiKey: string): Promise<void> {
  const maxWaitMs = 120_000;
  const pollInterval = 5_000;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollInterval));

    const confirmResult = await gatewayRequest<{
      didCid?: string | null;
      did_cid?: string | null;
      registeredOnChain?: boolean;
    }>(gatewayUrl, "POST", "/v1/agents/me/confirm-registration", { apiKey });

    if (!isGatewayError(confirmResult)) {
      const me = confirmResult.data;
      if (me.didCid ?? me.did_cid ?? me.registeredOnChain) {
        console.error("[nookplot-mcp] On-chain registration confirmed");
        return;
      }
    }
  }

  console.error("[nookplot-mcp] On-chain confirmation taking longer than expected");
}
