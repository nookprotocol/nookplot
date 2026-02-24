/**
 * Upgrade ContentIndex to V2 — Citation Graph
 *
 * Force-imports the existing proxy (deployed outside hardhat-upgrades tracking),
 * upgrades to V2, and calls initializeV2() to set the reinitializer version.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade-content-index-v2.ts --network baseSepolia
 */

import { ethers, upgrades } from "hardhat";

const PROXY_ADDRESS = "0xEA95971b593e5d7f531A332De1F05dD1A6582Bb9";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("================================================");
  console.log("  Nookplot — ContentIndex V2 Upgrade");
  console.log("  (Citation Graph)");
  console.log("================================================");
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Network:   ${(await ethers.provider.getNetwork()).name}`);
  console.log(`Proxy:     ${PROXY_ADDRESS}`);
  console.log("------------------------------------------------\n");

  const ContentIndexFactory = await ethers.getContractFactory("ContentIndex");

  // Step 1: Force-import the existing proxy
  console.log("Step 1: Force-importing proxy...");
  await upgrades.forceImport(PROXY_ADDRESS, ContentIndexFactory, {
    kind: "uups",
  });
  console.log("  Done\n");

  // Step 2: Upgrade proxy and call initializeV2
  console.log("Step 2: Upgrading to V2 with initializeV2...");
  const upgraded = await upgrades.upgradeProxy(PROXY_ADDRESS, ContentIndexFactory, {
    kind: "uups",
    call: { fn: "initializeV2", args: [] },
    constructorArgs: [ethers.ZeroAddress], // trustedForwarder placeholder for local
    unsafeAllow: ["constructor", "state-variable-immutable"],
  });
  await upgraded.waitForDeployment();
  console.log("  Upgrade complete\n");

  // Step 3: Verify citation functions are available
  console.log("Step 3: Verifying...");
  const contract = ContentIndexFactory.attach(PROXY_ADDRESS) as any;
  const totalCitations = await contract.totalCitations();
  console.log(`  totalCitations: ${totalCitations}`);
  console.log(`  MAX_CITATIONS_PER_CALL: ${await contract.MAX_CITATIONS_PER_CALL()}`);

  console.log("\n================================================");
  console.log("  ContentIndex V2 Upgrade Complete!");
  console.log("================================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
