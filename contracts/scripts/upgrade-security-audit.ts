/**
 * Security Audit Remediation — Contract Upgrade Script
 *
 * Upgrades all 13 UUPS proxy contracts on Base Sepolia with security
 * audit fixes: SafeERC20, CID dedup, dissolveProposedClique,
 * ContentNotActive check, WorkApproved event, attestation lock,
 * typed interfaces, rescueETH, range checks, etc.
 *
 * Prerequisites:
 *   - DEPLOYER_PRIVATE_KEY in .env (must be the proxy owner)
 *   - FORWARDER_ADDRESS in .env
 *   - BASE_SEPOLIA_RPC_URL in .env
 *
 * Usage:
 *   npx hardhat run scripts/upgrade-security-audit.ts --network baseSepolia
 */

import { ethers, upgrades } from "hardhat";

const UPGRADE_OPTS = {
  kind: "uups" as const,
  unsafeAllow: ["constructor", "state-variable-immutable"] as any[],
};

// All 13 proxy contracts to upgrade (NookplotForwarder is standalone, not upgradeable)
const CONTRACTS = [
  { name: "AgentRegistry", address: "0x8dC9E1e6E3eED7c38e89ca57D3B444f062d8a1c9" },
  { name: "ContentIndex", address: "0xEA95971b593e5d7f531A332De1F05dD1A6582Bb9" },
  { name: "InteractionContract", address: "0xB1E8029179Cd612A6D1559607415106C818CED88" },
  { name: "SocialGraph", address: "0x8f4718a6922a1200c5f40074051b1dE44E2DeBC7" },
  { name: "CommunityRegistry", address: "0x3e5dDBFF67EF121553E9624BFFb4fa30C428E99B" },
  { name: "ProjectRegistry", address: "0xeB4b53Ffd66ed976718E6Dede4b2E7a6f78149A7" },
  { name: "ContributionRegistry", address: "0xbee054175909797B0AB6F14A3F7ce42C98bF88EA" },
  { name: "BountyContract", address: "0xC9a5d1595BcF5fDC90067C9b907e5d80cB8Dc8bE" },
  { name: "KnowledgeBundle", address: "0x301f85005db99eE4156F23Aa710e4Ac174201643" },
  { name: "AgentFactory", address: "0xce75866f699030fdB1C209c7E0f651b38bca8a7d" },
  { name: "RevenueRouter", address: "0x26d2698430a0814D638aA8Fe875B7e576233D6c0" },
  { name: "CliqueRegistry", address: "0xcF8F4930B96ab17B7A4d37F037C1904b00596A9d" },
  { name: "ServiceMarketplace", address: "0xe43FFb5bB520EfBFa85C0FE28ae2B4d474668054" },
];

async function main() {
  const [deployer] = await ethers.getSigners();
  const forwarderAddress = process.env.FORWARDER_ADDRESS;

  if (!forwarderAddress) {
    throw new Error("Missing FORWARDER_ADDRESS in .env");
  }

  console.log("========================================================");
  console.log("  Nookplot — Security Audit Contract Upgrades");
  console.log("========================================================");
  console.log(`Deployer:   ${deployer.address}`);
  console.log(`Forwarder:  ${forwarderAddress}`);
  console.log(`Network:    ${(await ethers.provider.getNetwork()).name}`);
  console.log(`Chain ID:   ${(await ethers.provider.getNetwork()).chainId}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:    ${ethers.formatEther(balance)} ETH`);
  console.log(`Contracts:  ${CONTRACTS.length} to upgrade`);
  console.log("--------------------------------------------------------\n");

  const results: { name: string; status: string; error?: string }[] = [];

  for (let i = 0; i < CONTRACTS.length; i++) {
    const { name, address } = CONTRACTS[i];
    const step = `[${i + 1}/${CONTRACTS.length}]`;

    console.log(`${step} Upgrading ${name} at ${address}...`);

    try {
      const Factory = await ethers.getContractFactory(name);
      const upgraded = await upgrades.upgradeProxy(address, Factory, {
        ...UPGRADE_OPTS,
        constructorArgs: [forwarderAddress],
      });
      await upgraded.waitForDeployment();

      console.log(`  ✔ ${name} upgraded successfully`);
      results.push({ name, status: "✔ Success" });
    } catch (err: any) {
      const msg = err.message?.slice(0, 200) || String(err);
      console.error(`  ✗ ${name} FAILED: ${msg}`);
      results.push({ name, status: "✗ Failed", error: msg });
    }

    console.log();
  }

  // Summary
  console.log("========================================================");
  console.log("  Upgrade Summary");
  console.log("========================================================");

  const succeeded = results.filter((r) => r.status.startsWith("✔")).length;
  const failed = results.filter((r) => r.status.startsWith("✗")).length;

  for (const r of results) {
    console.log(`  ${r.status}  ${r.name}${r.error ? ` — ${r.error}` : ""}`);
  }

  console.log(`\n  Total: ${succeeded} succeeded, ${failed} failed`);
  console.log("========================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
