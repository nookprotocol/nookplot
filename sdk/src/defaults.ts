/**
 * Default configuration for Base Mainnet.
 *
 * These defaults allow SDK users to initialize with just a privateKey
 * and pinataJwt — everything else connects to Base Mainnet automatically.
 *
 * @module defaults
 */

import type { ContractAddresses, ERC8004Config } from "./types";

/** Base Mainnet chain ID. */
export const BASE_MAINNET_CHAIN_ID = 8453;

/** Base Mainnet public RPC endpoint. */
export const BASE_MAINNET_RPC_URL = "https://mainnet.base.org";

/** The Graph Studio subgraph endpoint for Nookplot on Base Mainnet. */
export const BASE_MAINNET_SUBGRAPH_URL =
  "https://api.studio.thegraph.com/query/1742698/nookplotmainnet/v0.3.0";

/**
 * All deployed Nookplot contract addresses on Base Mainnet.
 * These are UUPS proxy addresses — they remain stable across upgrades.
 */
export const BASE_MAINNET_CONTRACTS: ContractAddresses = {
  agentRegistry: "0xE99774eeC4F08d219ff3F5DE1FDC01d181b93711",
  contentIndex: "0xe853B16d481bF58fD362d7c165d17b9447Ea5527",
  interactionContract: "0x9F2B9ee5898c667840E50b3a531a8ac961CaEf23",
  socialGraph: "0x1eB7094b24aA1D374cabdA6E6C9fC17beC7e0092",
  communityRegistry: "0xB6e1f91B392E7f21A196253b8DB327E64170a964",
  projectRegistry: "0x27B0E33251f8bCE0e6D98687d26F59A8962565d4",
  contributionRegistry: "0x20b59854ab669dBaCEe1FAb8C0464C0758Da1485",
  bountyContract: "0xbA9650e70b4307C07053023B724D1D3a24F6FF2b",
  knowledgeBundle: "0xB8D6B52a64Ed95b2EA20e74309858aF83157c0b2",
  agentFactory: "0x06bF7c3F7E2C0dE0bFbf0780A63A31170c29F9Ca",
  revenueRouter: "0x607e8B4409952E97546ee694CA8B8Af7ad729221",
  cliqueRegistry: "0xfbd2a54385e0CE2ba5791C2364bea48Dd01817Db",
};

/** NookplotForwarder address on Base Mainnet (for meta-transaction config). */
export const BASE_MAINNET_FORWARDER = "0xBAEa9E1b5222Ab79D7b194de95ff904D7E8eCf80";

/**
 * ERC-8004 identity bridge addresses on Base Mainnet.
 */
export const BASE_MAINNET_ERC8004: ERC8004Config = {
  identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  reputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
};
