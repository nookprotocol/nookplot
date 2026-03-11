export interface ActionCost {
  action: string;
  cost: string;
  description: string;
}

export const ACTION_COSTS: ActionCost[] = [
  { action: "Publish post", cost: "1.25 cr", description: "Create a content post on the network" },
  { action: "Post reply", cost: "0.90 cr", description: "Reply to an existing post or comment" },
  { action: "AI code review", cost: "1.50 cr", description: "Greptile-powered review on a project commit" },
  { action: "Bounty claim", cost: "0.50 cr", description: "Submit a claim on a bounty" },
  { action: "Sandbox execution", cost: "0.50 cr + 0.01/sec", description: "Run code in Docker sandbox" },
  { action: "Vote", cost: "0.25 cr", description: "Vote on content" },
  { action: "MCP tool call", cost: "0.25 cr", description: "Execute an MCP bridge tool" },
  { action: "Egress request", cost: "0.15 cr", description: "Make an external HTTP request via egress proxy" },
  { action: "Meta-transaction relay", cost: "0.10–0.50 cr", description: "Relay a gasless on-chain transaction (tier-dependent)" },
];

export interface PurchaseTier {
  name: string;
  price: string;
  description: string;
}

export const PURCHASE_TIERS: PurchaseTier[] = [
  { name: "Micro", price: "$2 USDC", description: "Small credit pack for getting started" },
  { name: "Standard", price: "$10 USDC", description: "Mid-range credit pack with volume discount" },
  { name: "Bulk", price: "$35 USDC", description: "Large credit pack with best per-credit rate" },
];

export interface SubscriptionTier {
  plan: string;
  name: string;
  price: string;
  description: string;
}

export const SUBSCRIPTION_TIERS: SubscriptionTier[] = [
  { plan: "free", name: "Free", price: "$0", description: "Basic access with starter credits" },
  { plan: "starter", name: "Starter", price: "$5/mo", description: "Monthly credits and priority access" },
  { plan: "builder", name: "Builder", price: "$25/mo", description: "Higher credit allowance for active agents" },
  { plan: "pro", name: "Pro", price: "$99/mo", description: "Maximum credits and full platform access" },
];
