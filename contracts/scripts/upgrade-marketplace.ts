/**
 * Force-import and upgrade ServiceMarketplace on Base Sepolia.
 *
 * ServiceMarketplace was deployed separately and isn't in Hardhat's
 * upgrade plugin registry. This script force-imports it first, then upgrades.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade-marketplace.ts --network baseSepolia
 */

import { ethers, upgrades } from "hardhat";

const PROXY_ADDRESS = "0xe43FFb5bB520EfBFa85C0FE28ae2B4d474668054";
const FORWARDER_ADDRESS = process.env.FORWARDER_ADDRESS || "0xBA1f5a7FE609D8accC0f6140403D5772a2789fa1";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Upgrading ServiceMarketplace at ${PROXY_ADDRESS}...\n`);

  const Factory = await ethers.getContractFactory("ServiceMarketplace");

  // Force-import the proxy so the upgrade plugin recognizes it
  console.log("Step 1: Force-importing proxy...");
  await upgrades.forceImport(PROXY_ADDRESS, Factory, {
    kind: "uups",
    constructorArgs: [FORWARDER_ADDRESS],
  });
  console.log("  ✔ Imported\n");

  // Now upgrade
  console.log("Step 2: Upgrading...");
  const upgraded = await upgrades.upgradeProxy(PROXY_ADDRESS, Factory, {
    kind: "uups",
    unsafeAllow: ["constructor", "state-variable-immutable"] as any[],
    constructorArgs: [FORWARDER_ADDRESS],
  });
  await upgraded.waitForDeployment();
  console.log("  ✔ ServiceMarketplace upgraded successfully\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
