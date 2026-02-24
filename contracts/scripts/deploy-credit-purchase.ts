/**
 * Deploy CreditPurchase — Credit Pack Purchase Contract
 *
 * Deploys CreditPurchase as a UUPS proxy and configures 3 initial packs.
 *
 * Prerequisites:
 *   - DEPLOYER_PRIVATE_KEY in .env
 *   - USDC_ADDRESS in .env (USDC contract on target network)
 *
 * Usage:
 *   Local:   npx hardhat run scripts/deploy-credit-purchase.ts
 *   Testnet: npx hardhat run scripts/deploy-credit-purchase.ts --network baseSepolia
 */

import { ethers, upgrades } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("================================================");
  console.log("  Nookplot — CreditPurchase Deployment");
  console.log("================================================");
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Network:   ${(await ethers.provider.getNetwork()).name}`);
  console.log(`Chain ID:  ${(await ethers.provider.getNetwork()).chainId}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:   ${ethers.formatEther(balance)} ETH`);
  console.log("------------------------------------------------\n");

  // Load USDC address from environment
  const usdcAddress = process.env.USDC_ADDRESS;
  if (!usdcAddress) {
    throw new Error("Missing USDC_ADDRESS in .env");
  }

  // Deployer is treasury for MVP
  const treasuryAddress = deployer.address;

  // ============================================================
  //  1. Deploy CreditPurchase via UUPS proxy
  // ============================================================
  console.log("1/2 Deploying CreditPurchase...");
  const CreditPurchaseFactory = await ethers.getContractFactory("CreditPurchase");
  const creditPurchase = await upgrades.deployProxy(
    CreditPurchaseFactory,
    [deployer.address, usdcAddress, treasuryAddress],
    { kind: "uups" },
  );
  await creditPurchase.waitForDeployment();
  const creditPurchaseAddress = await creditPurchase.getAddress();
  console.log(`    CreditPurchase:  ${creditPurchaseAddress}`);

  // ============================================================
  //  2. Add initial packs (from ECONOMICS.md)
  // ============================================================
  console.log("2/2 Adding credit packs...");

  // Micro: $1 USDC → 25.00 credits (2500 centricredits)
  let tx = await creditPurchase.addPack("Micro", 1_000_000, 2500);
  await tx.wait();
  console.log("    Pack 0 (Micro):    $1 → 25.00 credits");

  // Standard: $5 USDC → 140.00 credits (14000 centricredits)
  tx = await creditPurchase.addPack("Standard", 5_000_000, 14_000);
  await tx.wait();
  console.log("    Pack 1 (Standard): $5 → 140.00 credits");

  // Bulk: $20 USDC → 650.00 credits (65000 centricredits)
  tx = await creditPurchase.addPack("Bulk", 20_000_000, 65_000);
  await tx.wait();
  console.log("    Pack 2 (Bulk):     $20 → 650.00 credits");

  // ============================================================
  //  Summary
  // ============================================================
  console.log("\n================================================");
  console.log("  CreditPurchase Deployment Complete!");
  console.log("================================================");
  console.log(`\nAdd to your .env:`);
  console.log(`CREDIT_PURCHASE_ADDRESS=${creditPurchaseAddress}`);
  console.log("================================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
