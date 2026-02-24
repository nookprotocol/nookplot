/**
 * Configure AgentFactory fee shares.
 *
 * Sets the revenue split for agent deployment fees:
 *   60% contributors / 20% treasury / 15% credit pool / 5% curator
 *
 * While paymentToken == address(0), fees are zero.
 *
 * Prerequisites:
 *   - DEPLOYER_PRIVATE_KEY in .env (must be the contract owner)
 *   - AGENT_FACTORY_ADDRESS in .env
 *   - BASE_SEPOLIA_RPC_URL in .env
 *
 * Usage:
 *   npx hardhat run scripts/set-agent-factory-fees.ts --network baseSepolia
 */

import { ethers } from "hardhat";

// Fee shares in basis points (must sum to 10000)
const CONTRIBUTOR_BPS = 6000; // 60%
const TREASURY_BPS = 2000;    // 20%
const CREDIT_BPS = 1500;      // 15%
const CURATOR_BPS = 500;      // 5%

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("================================================");
  console.log("  Nookplot — Set AgentFactory Fee Shares");
  console.log("================================================");
  console.log(`  Deployer:  ${deployer.address}`);
  console.log();

  const factoryAddress = process.env.AGENT_FACTORY_ADDRESS;
  if (!factoryAddress) {
    throw new Error("AGENT_FACTORY_ADDRESS not set in .env");
  }
  console.log(`  AgentFactory: ${factoryAddress}`);
  console.log(`  Fee splits:`);
  console.log(`    Contributors: ${CONTRIBUTOR_BPS} bps (${CONTRIBUTOR_BPS / 100}%)`);
  console.log(`    Treasury:     ${TREASURY_BPS} bps (${TREASURY_BPS / 100}%)`);
  console.log(`    Credit Pool:  ${CREDIT_BPS} bps (${CREDIT_BPS / 100}%)`);
  console.log(`    Curator:      ${CURATOR_BPS} bps (${CURATOR_BPS / 100}%)`);
  console.log(`    Total:        ${CONTRIBUTOR_BPS + TREASURY_BPS + CREDIT_BPS + CURATOR_BPS} bps`);
  console.log();

  const agentFactory = await ethers.getContractAt("AgentFactory", factoryAddress);

  console.log("  Setting fee shares...");
  const tx = await agentFactory.setFeeShares(
    CONTRIBUTOR_BPS,
    TREASURY_BPS,
    CREDIT_BPS,
    CURATOR_BPS,
  );
  const receipt = await tx.wait();
  console.log(`  TX hash: ${receipt!.hash}`);

  // Verify
  const contributorShare = await agentFactory.contributorShareBps();
  const treasuryShare = await agentFactory.treasuryShareBps();
  const creditShare = await agentFactory.creditShareBps();
  const curatorShare = await agentFactory.curatorShareBps();
  console.log(`\n  Verified on-chain:`);
  console.log(`    contributorShareBps: ${contributorShare}`);
  console.log(`    treasuryShareBps:    ${treasuryShare}`);
  console.log(`    creditShareBps:      ${creditShare}`);
  console.log(`    curatorShareBps:     ${curatorShare}`);

  console.log("\n================================================");
  console.log("  AgentFactory fee shares configured.");
  console.log("  Fees are inactive until setPaymentToken() is called.");
  console.log("================================================\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
