/**
 * Nookplot ERC-2771 Upgrade Script
 *
 * Upgrades all 5 existing UUPS proxy contracts on Base Sepolia to support
 * ERC-2771 gasless meta-transactions via a NookplotForwarder.
 *
 * Steps:
 *   1. Deploy NookplotForwarder (standalone, not proxy)
 *   2. Upgrade each of the 5 proxy contracts with new implementations
 *      that inherit ERC2771ContextUpgradeable
 *   3. Verify isTrustedForwarder() returns true on each contract
 *
 * Prerequisites:
 *   - DEPLOYER_PRIVATE_KEY in .env (must be the proxy owner)
 *   - All 5 proxy addresses in .env
 *   - BASE_SEPOLIA_RPC_URL in .env
 *
 * Usage:
 *   npx hardhat run scripts/upgrade-erc2771.ts --network baseSepolia
 */

import { ethers, upgrades } from "hardhat";

/** Options for upgrading UUPS proxies with immutable constructor args */
const UPGRADE_OPTS = {
  kind: "uups" as const,
  unsafeAllow: ["constructor", "state-variable-immutable"] as any[],
};

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("================================================");
  console.log("  Nookplot — ERC-2771 Meta-Transaction Upgrade");
  console.log("================================================");
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Network:   ${(await ethers.provider.getNetwork()).name}`);
  console.log(`Chain ID:  ${(await ethers.provider.getNetwork()).chainId}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:   ${ethers.formatEther(balance)} ETH`);
  console.log("------------------------------------------------\n");

  // Load proxy addresses from environment
  const proxyAddresses = {
    agentRegistry: process.env.AGENT_REGISTRY_ADDRESS,
    contentIndex: process.env.CONTENT_INDEX_ADDRESS,
    interactionContract: process.env.INTERACTION_CONTRACT_ADDRESS,
    socialGraph: process.env.SOCIAL_GRAPH_ADDRESS,
    communityRegistry: process.env.COMMUNITY_REGISTRY_ADDRESS,
  };

  // Validate all addresses are set
  for (const [name, addr] of Object.entries(proxyAddresses)) {
    if (!addr) {
      throw new Error(`Missing ${name.toUpperCase().replace(/([A-Z])/g, '_$1').toUpperCase()} in .env`);
    }
  }

  // ============================================================
  //  1. Deploy NookplotForwarder
  // ============================================================
  console.log("1/6 Deploying NookplotForwarder...");
  const ForwarderFactory = await ethers.getContractFactory("NookplotForwarder");
  const forwarder = await ForwarderFactory.deploy();
  await forwarder.waitForDeployment();
  const forwarderAddress = await forwarder.getAddress();
  console.log(`    ✔ NookplotForwarder:   ${forwarderAddress}\n`);

  // ============================================================
  //  2-6. Upgrade each contract
  // ============================================================
  const contracts = [
    { name: "AgentRegistry", address: proxyAddresses.agentRegistry! },
    { name: "ContentIndex", address: proxyAddresses.contentIndex! },
    { name: "InteractionContract", address: proxyAddresses.interactionContract! },
    { name: "SocialGraph", address: proxyAddresses.socialGraph! },
    { name: "CommunityRegistry", address: proxyAddresses.communityRegistry! },
  ];

  for (let i = 0; i < contracts.length; i++) {
    const { name, address } = contracts[i];
    console.log(`${i + 2}/6 Upgrading ${name} at ${address}...`);

    const Factory = await ethers.getContractFactory(name);
    const upgraded = await upgrades.upgradeProxy(address, Factory, {
      ...UPGRADE_OPTS,
      constructorArgs: [forwarderAddress],
    });
    await upgraded.waitForDeployment();

    // Verify forwarder is trusted
    const trusted = await upgraded.isTrustedForwarder(forwarderAddress);
    console.log(`    ✔ ${name} upgraded — isTrustedForwarder = ${trusted}`);

    if (!trusted) {
      console.error(`    ✗ WARNING: ${name} does not recognize the forwarder!`);
    }
  }

  // ============================================================
  //  Summary
  // ============================================================
  console.log("\n================================================");
  console.log("  ERC-2771 Upgrade Complete!");
  console.log("================================================");
  console.log(`\nNookplotForwarder: ${forwarderAddress}`);
  console.log("\nAdd to your .env:");
  console.log(`FORWARDER_ADDRESS=${forwarderAddress}`);
  console.log("\nAll 5 contracts now support gasless meta-transactions.");
  console.log("Agents can sign requests off-chain, and a relayer submits");
  console.log("them through the forwarder. No ETH needed by agents.");
  console.log("\n================================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
