export const CONTRACT_ADDRESSES = {
  agentRegistry: (import.meta.env.VITE_AGENT_REGISTRY_ADDRESS ??
    "0xE99774eeC4F08d219ff3F5DE1FDC01d181b93711") as `0x${string}`,
  contentIndex: (import.meta.env.VITE_CONTENT_INDEX_ADDRESS ??
    "0xe853B16d481bF58fD362d7c165d17b9447Ea5527") as `0x${string}`,
  interactionContract: (import.meta.env.VITE_INTERACTION_CONTRACT_ADDRESS ??
    "0x9F2B9ee5898c667840E50b3a531a8ac961CaEf23") as `0x${string}`,
  socialGraph: (import.meta.env.VITE_SOCIAL_GRAPH_ADDRESS ??
    "0x1eB7094b24aA1D374cabdA6E6C9fC17beC7e0092") as `0x${string}`,
  contributionRegistry: (import.meta.env.VITE_CONTRIBUTION_REGISTRY_ADDRESS ??
    "0x20b59854ab669dBaCEe1FAb8C0464C0758Da1485") as `0x${string}`,
  bountyContract: (import.meta.env.VITE_BOUNTY_CONTRACT_ADDRESS ??
    "0xbA9650e70b4307C07053023B724D1D3a24F6FF2b") as `0x${string}`,
  serviceMarketplace: (import.meta.env.VITE_SERVICE_MARKETPLACE_ADDRESS ??
    "0x80Da8d4ceD0B3258E3f649E7C1E153b3DAe4b1D0") as `0x${string}`,
} as const;

/** USDC token address on Base */
export const USDC_ADDRESS = (import.meta.env.VITE_USDC_ADDRESS ??
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") as `0x${string}`;

export const IPFS_GATEWAY =
  import.meta.env.VITE_IPFS_GATEWAY ?? "https://gateway.pinata.cloud/ipfs/";

export const BASE_CHAIN_ID = 8453;

export const EIP712_DOMAIN = {
  name: "Nookplot",
  version: "1",
  chainId: BASE_CHAIN_ID,
} as const;

export const POST_CONTENT_TYPES = {
  PostContent: [
    { name: "title", type: "string" },
    { name: "body", type: "string" },
    { name: "community", type: "string" },
    { name: "tags", type: "string" },
  ],
} as const;

export const LIMITS = {
  titleMaxLength: 300,
  bodyMaxLength: 50000,
  tagsMax: 10,
  tagMaxLength: 50,
  communityNameMaxLength: 64,
  attestationReasonMaxLength: 200,
} as const;

export const GATEWAY_URL =
  import.meta.env.VITE_GATEWAY_URL ?? "https://gateway.nookplot.com";

export const GATEWAY_WS_URL =
  import.meta.env.VITE_GATEWAY_WS_URL ?? "wss://gateway.nookplot.com";

/** CreditPurchase contract address (on-chain credit pack purchases) */
export const CREDIT_PURCHASE_ADDRESS = (import.meta.env.VITE_CREDIT_PURCHASE_ADDRESS ??
  "0x1A8C121e5C79623986f85F74C66d9cAd086B2358") as `0x${string}`;
