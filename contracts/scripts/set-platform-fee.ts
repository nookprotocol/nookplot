/**
 * Set the platform fee on BountyContract and ServiceMarketplace.
 *
 * Calls setPlatformFeeBps(250) — a 2.5% fee on both contracts.
 * - BountyContract: deducted from the worker's payout on bounty approval.
 * - ServiceMarketplace: deducted from service settlement.
 *
 * Prerequisites:
 *   - DEPLOYER_PRIVATE_KEY in .env (must be the contract owner)
 *   - BOUNTY_CONTRACT_ADDRESS in .env
 *   - SERVICE_MARKETPLACE_ADDRESS in .env (optional — skipped if not set)
 *   - BASE_SEPOLIA_RPC_URL in .env
 *
 * Usage:
 *   npx hardhat run scripts/set-platform-fee.ts --network baseSepolia
 */

import { ethers } from "hardhat";

const FEE_BPS = 250; // 2.5%

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("================================================");
  console.log("  Nookplot — Set Platform Fees (2.5%)");
  console.log("================================================");
  console.log(`  Deployer:  ${deployer.address}`);
  console.log(`  Target Fee: ${FEE_BPS} bps (${FEE_BPS / 100}%)`);
  console.log();

  // -------------------------------------------------------
  //  BountyContract
  // -------------------------------------------------------
  const bountyAddress = process.env.BOUNTY_CONTRACT_ADDRESS;
  if (!bountyAddress) {
    throw new Error("BOUNTY_CONTRACT_ADDRESS not set in .env");
  }
  console.log(`  BountyContract: ${bountyAddress}`);

  const bountyContract = await ethers.getContractAt("BountyContract", bountyAddress);
  const currentBountyFee = await bountyContract.platformFeeBps();
  console.log(`  Current BountyContract fee: ${currentBountyFee} bps`);

  if (Number(currentBountyFee) === FEE_BPS) {
    console.log(`  Already set to ${FEE_BPS} bps. Skipping.`);
  } else {
    console.log(`  Setting BountyContract fee to ${FEE_BPS}...`);
    const tx = await bountyContract.setPlatformFeeBps(FEE_BPS);
    const receipt = await tx.wait();
    console.log(`  TX hash: ${receipt!.hash}`);
    console.log(`  Done!`);
  }
  console.log();

  // -------------------------------------------------------
  //  ServiceMarketplace
  // -------------------------------------------------------
  const marketplaceAddress = process.env.SERVICE_MARKETPLACE_ADDRESS;
  if (!marketplaceAddress) {
    console.log("  SERVICE_MARKETPLACE_ADDRESS not set — skipping ServiceMarketplace.");
    return;
  }
  console.log(`  ServiceMarketplace: ${marketplaceAddress}`);

  const marketplace = await ethers.getContractAt("ServiceMarketplace", marketplaceAddress);
  const currentMarketplaceFee = await marketplace.platformFeeBps();
  console.log(`  Current ServiceMarketplace fee: ${currentMarketplaceFee} bps`);

  if (Number(currentMarketplaceFee) === FEE_BPS) {
    console.log(`  Already set to ${FEE_BPS} bps. Skipping.`);
  } else {
    console.log(`  Setting ServiceMarketplace fee to ${FEE_BPS}...`);
    const tx = await marketplace.setPlatformFeeBps(FEE_BPS);
    const receipt = await tx.wait();
    console.log(`  TX hash: ${receipt!.hash}`);
    console.log(`  Done!`);
  }

  console.log("\n================================================");
  console.log("  Platform fees configured on both contracts.");
  console.log("================================================\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
