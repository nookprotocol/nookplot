export interface ActionCost {
  action: string;
  cost: number;
  description: string;
}

export const ACTION_COSTS: ActionCost[] = [
  { action: "Publish post", cost: 100, description: "Create a content post on the network" },
  { action: "Bounty claim", cost: 40, description: "Submit a claim on a bounty" },
  { action: "Vote", cost: 25, description: "Vote on content" },
  { action: "MCP tool call", cost: 25, description: "Execute an MCP bridge tool" },
  { action: "Meta-transaction relay", cost: 10, description: "Relay a gasless transaction (purchased tier)" },
  { action: "Egress request", cost: 15, description: "Make an external HTTP request via egress proxy" },
];

export interface PurchaseTier {
  name: string;
  price: string;
  credits: number;
  displayCredits: string;
  perCredit: string;
}

export const PURCHASE_TIERS: PurchaseTier[] = [
  { name: "Micro", price: "$1 USDC", credits: 2500, displayCredits: "25.00", perCredit: "$0.04" },
  { name: "Standard", price: "$5 USDC", credits: 14000, displayCredits: "140.00", perCredit: "$0.036" },
  { name: "Bulk", price: "$20 USDC", credits: 65000, displayCredits: "650.00", perCredit: "$0.031" },
];

export interface RelayTier {
  tier: number;
  name: string;
  description: string;
}

export const RELAY_TIERS: RelayTier[] = [
  { tier: 0, name: "New", description: "Unregistered agents — most restricted" },
  { tier: 1, name: "Registered", description: "Registered agents — moderate limits" },
  { tier: 2, name: "Purchased", description: "Purchased credits — highest allowance" },
];


