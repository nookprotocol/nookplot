/**
 * SDK factory — provides read-only SDK access and relayer management.
 *
 * Non-custodial model: the gateway never holds agent private keys.
 * Read operations use a shared provider. Write operations go through
 * the prepare + relay flow (agents sign locally, gateway relays).
 *
 * @module sdkFactory
 */

import { ethers } from "ethers";
import { NookplotSDK } from "@nookplot/sdk";
import { MetaTransactionManager } from "@nookplot/sdk/dist/metatx.js";

export interface SdkFactoryConfig {
  rpcUrl: string;
  pinataJwt: string;
  chainId: number;
  contracts: {
    agentRegistry: string;
    contentIndex: string;
    interactionContract: string;
    socialGraph: string;
    communityRegistry?: string;
    projectRegistry?: string;
    contributionRegistry?: string;
    bountyContract?: string;
    knowledgeBundle?: string;
    agentFactory?: string;
    revenueRouter?: string;
    cliqueRegistry?: string;
    serviceMarketplace?: string;
  };
  graphqlEndpoint?: string;
  forwarderAddress: string;
  relayerPrivateKey: string;
}

/** Singleton read-only SDK (created lazily). */
let _readOnlySDK: NookplotSDK | null = null;

/** Singleton relayer MetaTransactionManager (created lazily). */
let _relayer: MetaTransactionManager | null = null;

/** Singleton provider (created lazily). */
let _provider: ethers.JsonRpcProvider | null = null;

/** Cached config ref for lazy init. */
let _config: SdkFactoryConfig | null = null;

/**
 * Initialize the SDK factory with config. Call once at server startup.
 */
export function initSdkFactory(config: SdkFactoryConfig): void {
  _config = config;
  // Reset singletons so they re-init with new config
  _readOnlySDK = null;
  _relayer = null;
  _provider = null;
}

/**
 * Get a shared read-only NookplotSDK instance.
 *
 * Uses a throwaway private key — this SDK is only used for read operations
 * (contract reads, intelligence queries, subgraph queries). It never signs
 * transactions on behalf of any agent.
 */
export function getReadOnlySDK(): NookplotSDK {
  if (_readOnlySDK) return _readOnlySDK;
  if (!_config) throw new Error("SDK factory not initialized. Call initSdkFactory() first.");

  // Use a random throwaway key for read-only access.
  // This wallet is never funded and never signs user transactions.
  const readOnlyKey = ethers.Wallet.createRandom().privateKey;

  _readOnlySDK = new NookplotSDK({
    rpcUrl: _config.rpcUrl,
    privateKey: readOnlyKey,
    pinataJwt: _config.pinataJwt,
    contracts: _config.contracts,
    graphqlEndpoint: _config.graphqlEndpoint,
  });

  return _readOnlySDK;
}

/**
 * Get the shared relayer MetaTransactionManager.
 *
 * The relayer pays gas for all agent meta-transactions. Agents sign
 * ForwardRequests locally; the relayer submits them through the forwarder.
 */
export function getRelayer(): MetaTransactionManager {
  if (_relayer) return _relayer;
  if (!_config) throw new Error("SDK factory not initialized. Call initSdkFactory() first.");

  const provider = getProvider();
  const relayerWallet = new ethers.Wallet(_config.relayerPrivateKey);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _relayer = new MetaTransactionManager(
    _config.forwarderAddress,
    relayerWallet as any,
    provider as any,
    _config.chainId,
  );

  return _relayer;
}

/**
 * Get the shared JSON-RPC provider.
 */
export function getProvider(): ethers.JsonRpcProvider {
  if (_provider) return _provider;
  if (!_config) throw new Error("SDK factory not initialized. Call initSdkFactory() first.");
  _provider = new ethers.JsonRpcProvider(_config.rpcUrl);
  return _provider;
}

/**
 * Get the current SDK factory config.
 */
export function getSdkConfig(): SdkFactoryConfig {
  if (!_config) throw new Error("SDK factory not initialized. Call initSdkFactory() first.");
  return _config;
}
