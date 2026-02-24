/**
 * Nookplot ProjectRegistry Upgrade Script
 *
 * Deploys ProjectRegistry as a new UUPS proxy on Base Sepolia (or upgrades
 * an existing proxy if PROJECT_REGISTRY_ADDRESS is set).
 *
 * This is for adding ProjectRegistry to an existing deployment that already
 * has the other 5 contracts deployed. If deploying from scratch, use deploy.ts.
 *
 * Prerequisites:
 *   - DEPLOYER_PRIVATE_KEY in .env (must be the contract owner)
 *   - AGENT_REGISTRY_ADDRESS in .env
 *   - FORWARDER_ADDRESS in .env (ERC-2771 trusted forwarder)
 *   - BASE_SEPOLIA_RPC_URL in .env
 *   - Optionally PROJECT_REGISTRY_ADDRESS in .env (to upgrade existing proxy)
 *
 * Usage:
 *   npx hardhat run scripts/upgrade-project-registry.ts --network baseSepolia
 */

import { ethers, upgrades } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("================================================");
  console.log("  Nookplot — ProjectRegistry Deploy/Upgrade");
  console.log("================================================");
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Network:   ${(await ethers.provider.getNetwork()).name}`);
  console.log(`Chain ID:  ${(await ethers.provider.getNetwork()).chainId}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:   ${ethers.formatEther(balance)} ETH`);
  console.log("------------------------------------------------\n");

  const agentRegistryAddress = process.env.AGENT_REGISTRY_ADDRESS;
  const forwarderAddress = process.env.FORWARDER_ADDRESS;
  const existingProxyAddress = process.env.PROJECT_REGISTRY_ADDRESS;

  if (!agentRegistryAddress) {
    throw new Error("Missing AGENT_REGISTRY_ADDRESS in .env");
  }
  if (!forwarderAddress) {
    throw new Error("Missing FORWARDER_ADDRESS in .env");
  }

  const treasuryAddress = deployer.address; // MVP default

  const Factory = await ethers.getContractFactory("ProjectRegistry");

  if (existingProxyAddress) {
    // Upgrade existing proxy
    console.log(`Upgrading existing ProjectRegistry proxy: ${existingProxyAddress}`);
    console.log(`Forwarder: ${forwarderAddress}\n`);

    const upgraded = await upgrades.upgradeProxy(existingProxyAddress, Factory, {
      kind: "uups",
      constructorArgs: [forwarderAddress],
      unsafeAllow: ["constructor", "state-variable-immutable"],
    });
    await upgraded.waitForDeployment();

    const total = await upgraded.totalProjects();
    console.log(`  ✔ ProjectRegistry upgraded — totalProjects = ${total}`);

    const trusted = await upgraded.isTrustedForwarder(forwarderAddress);
    console.log(`  ✔ isTrustedForwarder = ${trusted}`);
  } else {
    // Deploy new proxy
    console.log("Deploying new ProjectRegistry proxy...");
    console.log(`AgentRegistry: ${agentRegistryAddress}`);
    console.log(`Forwarder:     ${forwarderAddress}`);
    console.log(`Treasury:      ${treasuryAddress}\n`);

    const projectRegistry = await upgrades.deployProxy(
      Factory,
      [deployer.address, agentRegistryAddress, treasuryAddress],
      {
        kind: "uups",
        constructorArgs: [forwarderAddress],
        unsafeAllow: ["constructor", "state-variable-immutable"],
      }
    );
    await projectRegistry.waitForDeployment();
    const address = await projectRegistry.getAddress();

    console.log(`  ✔ ProjectRegistry deployed: ${address}`);

    const trusted = await projectRegistry.isTrustedForwarder(forwarderAddress);
    console.log(`  ✔ isTrustedForwarder = ${trusted}`);

    console.log(`\n  Save this: PROJECT_REGISTRY_ADDRESS=${address}\n`);
  }

  console.log("\n================================================");
  console.log("  ProjectRegistry Deploy/Upgrade Complete!");
  console.log("================================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
