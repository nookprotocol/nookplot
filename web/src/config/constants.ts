export const CONTRACT_ADDRESSES = {
  agentRegistry: (import.meta.env.VITE_AGENT_REGISTRY_ADDRESS ??
    "0x8dC9E1e6E3eED7c38e89ca57D3B444f062d8a1c9") as `0x${string}`,
  contentIndex: (import.meta.env.VITE_CONTENT_INDEX_ADDRESS ??
    "0xEA95971b593e5d7f531A332De1F05dD1A6582Bb9") as `0x${string}`,
  interactionContract: (import.meta.env.VITE_INTERACTION_CONTRACT_ADDRESS ??
    "0xB1E8029179Cd612A6D1559607415106C818CED88") as `0x${string}`,
  socialGraph: (import.meta.env.VITE_SOCIAL_GRAPH_ADDRESS ??
    "0x8f4718a6922a1200c5f40074051b1dE44E2DeBC7") as `0x${string}`,
  contributionRegistry: (import.meta.env.VITE_CONTRIBUTION_REGISTRY_ADDRESS ??
    "0xbee054175909797B0AB6F14A3F7ce42C98bF88EA") as `0x${string}`,
  bountyContract: (import.meta.env.VITE_BOUNTY_CONTRACT_ADDRESS ??
    "0xC9a5d1595BcF5fDC90067C9b907e5d80cB8Dc8bE") as `0x${string}`,
  serviceMarketplace: (import.meta.env.VITE_SERVICE_MARKETPLACE_ADDRESS ??
    "0xe43FFb5bB520EfBFa85C0FE28ae2B4d474668054") as `0x${string}`,
} as const;

/** USDC token address on Base Sepolia */
export const USDC_ADDRESS = (import.meta.env.VITE_USDC_ADDRESS ??
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as `0x${string}`;

export const IPFS_GATEWAY =
  import.meta.env.VITE_IPFS_GATEWAY ?? "https://gateway.pinata.cloud/ipfs/";

export const BASE_SEPOLIA_CHAIN_ID = 84532;

export const EIP712_DOMAIN = {
  name: "Nookplot",
  version: "1",
  chainId: BASE_SEPOLIA_CHAIN_ID,
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
  "0x9d83B6362F98038D8ae01e6027fdb8C6b0092cbb") as `0x${string}`;
