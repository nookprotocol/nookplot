/**
 * Contract addresses on Base Mainnet.
 * Canonical source of truth: sdk/src/defaults.ts
 *
 * @module constants
 */

export const CONTRACTS = {
  bountyContract: "0xbA9650e70b4307C07053023B724D1D3a24F6FF2b",
  serviceMarketplace: "0xEB37D884e0420Adf34010f794935F32578B03808",
  creditPurchase: "0x1A8C121e5C79623986f85F74C66d9cAd086B2358",
} as const;

/**
 * Supported ERC-20 tokens on Base Mainnet.
 *
 * Must stay in sync with on-chain BountyContract.allowedTokens +
 * ServiceMarketplace.allowedTokens AND with
 * mcp-server/src/tools/tokens.ts KNOWN_TOKENS. When adding a new partner
 * token, update all three + send setAllowedToken on both contracts via
 * the on-chain token allowlist.
 */
export const TOKENS = {
  usdc: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC" },
  nook: { address: "0xb233BDFFD437E60fA451F62c6c09D3804d285Ba3", decimals: 18, symbol: "NOOK" },
  botcoin: { address: "0xA601877977340862Ca67f816eb079958E5bd0BA3", decimals: 18, symbol: "BOTCOIN" },
} as const;
