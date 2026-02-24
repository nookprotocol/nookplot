/**
 * Deploy ServiceMarketplace — Standalone Script
 *
 * Deploys ServiceMarketplace as a UUPS proxy to add the A2A marketplace
 * to an existing Nookplot deployment.
 *
 * Prerequisites:
 *   - DEPLOYER_PRIVATE_KEY in .env (must be the same deployer/owner)
 *   - FORWARDER_ADDRESS in .env (NookplotForwarder already deployed)
 *   - AGENT_REGISTRY_ADDRESS in .env (AgentRegistry already deployed)
 *
 * Usage:
 *   Local:   npx hardhat run scripts/deploy-service-marketplace.ts
 *   Testnet: npx hardhat run scripts/deploy-service-marketplace.ts --network baseSepolia
 */

import { ethers, upgrades } from "hardhat";

const PROXY_OPTS = {
  kind: "uups" as const,
  unsafeAllow: ["constructor", "state-variable-immutable"] as any[],
};

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("================================================");
  console.log("  Nookplot — ServiceMarketplace Deployment");
  console.log("================================================");
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Network:   ${(await ethers.provider.getNetwork()).name}`);
  console.log(`Chain ID:  ${(await ethers.provider.getNetwork()).chainId}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:   ${ethers.formatEther(balance)} ETH`);
  console.log("------------------------------------------------\n");

  // Load required addresses from environment
  const forwarderAddress = process.env.FORWARDER_ADDRESS;
  const agentRegistryAddress = process.env.AGENT_REGISTRY_ADDRESS;

  if (!forwarderAddress) {
    throw new Error("Missing FORWARDER_ADDRESS in .env");
  }
  if (!agentRegistryAddress) {
    throw new Error("Missing AGENT_REGISTRY_ADDRESS in .env");
  }

  // For MVP, deployer is both owner and treasury
  const ownerAddress = deployer.address;
  const treasuryAddress = deployer.address;

  // ============================================================
  //  1. Deploy ServiceMarketplace via UUPS proxy
  // ============================================================
  console.log("1/2 Deploying ServiceMarketplace...");
  const MarketplaceFactory = await ethers.getContractFactory("ServiceMarketplace");
  const marketplace = await upgrades.deployProxy(
    MarketplaceFactory,
    [ownerAddress, agentRegistryAddress, treasuryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
  );
  await marketplace.waitForDeployment();
  const marketplaceAddress = await marketplace.getAddress();
  console.log(`    ✔ ServiceMarketplace:  ${marketplaceAddress}`);

  // ============================================================
  //  2. Verify forwarder trust
  // ============================================================
  console.log("2/2 Verifying trusted forwarder...");
  const trusted = await marketplace.isTrustedForwarder(forwarderAddress);
  console.log(`    ${trusted ? "✔" : "✗"} isTrustedForwarder = ${trusted}`);

  if (!trusted) {
    console.error("    ✗ WARNING: ServiceMarketplace does not recognize the forwarder!");
  }

  // ============================================================
  //  Summary
  // ============================================================
  console.log("\n================================================");
  console.log("  ServiceMarketplace Deployment Complete!");
  console.log("================================================");
  console.log(`\nAdd to your .env:`);
  console.log(`SERVICE_MARKETPLACE_ADDRESS=${marketplaceAddress}`);
  console.log("\nThe marketplace starts in free mode (no payment token).");
  console.log("To activate token escrow, call:");
  console.log("  ServiceMarketplace.setPaymentToken(tokenAddress)");
  console.log("To set platform fees:");
  console.log("  ServiceMarketplace.setPlatformFeeBps(feeBps)  // max 1000 = 10%");
  console.log("\n================================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
