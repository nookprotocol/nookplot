/**
 * Nookplot AgentType Upgrade Script
 *
 * Upgrades the AgentRegistry proxy on Base Sepolia to add agent type
 * categorization (0=Unspecified, 1=Human, 2=Agent).
 *
 * New storage, events, and functions added:
 *   - mapping(address => uint8) _agentTypes
 *   - event AgentTypeSet(address indexed agent, uint8 agentType)
 *   - register(string,uint8) overload
 *   - getAgentType(address) view
 *   - setAgentType(address,uint8) admin
 *
 * Prerequisites:
 *   - DEPLOYER_PRIVATE_KEY in .env (must be the proxy owner)
 *   - AGENT_REGISTRY_ADDRESS in .env
 *   - BASE_SEPOLIA_RPC_URL in .env
 *   - FORWARDER_ADDRESS in .env (ERC-2771 trusted forwarder)
 *
 * Usage:
 *   npx hardhat run scripts/upgrade-agent-type.ts --network baseSepolia
 */

import { ethers, upgrades } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("================================================");
  console.log("  Nookplot — AgentType Upgrade");
  console.log("================================================");
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Network:   ${(await ethers.provider.getNetwork()).name}`);
  console.log(`Chain ID:  ${(await ethers.provider.getNetwork()).chainId}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:   ${ethers.formatEther(balance)} ETH`);
  console.log("------------------------------------------------\n");

  const proxyAddress = process.env.AGENT_REGISTRY_ADDRESS;
  let forwarderAddress = process.env.FORWARDER_ADDRESS;

  if (!proxyAddress) {
    throw new Error("Missing AGENT_REGISTRY_ADDRESS in .env");
  }

  // Deploy NookplotForwarder if not already deployed
  if (!forwarderAddress) {
    console.log("No FORWARDER_ADDRESS set — deploying NookplotForwarder...");
    const ForwarderFactory = await ethers.getContractFactory("NookplotForwarder");
    const forwarder = await ForwarderFactory.deploy();
    await forwarder.waitForDeployment();
    forwarderAddress = await forwarder.getAddress();
    console.log(`  ✔ NookplotForwarder deployed: ${forwarderAddress}`);
    console.log(`\n  Save this: FORWARDER_ADDRESS=${forwarderAddress}\n`);
  }

  console.log(`AgentRegistry proxy: ${proxyAddress}`);
  console.log(`Forwarder:           ${forwarderAddress}\n`);

  // Upgrade the proxy
  console.log("Upgrading AgentRegistry...");
  const Factory = await ethers.getContractFactory("AgentRegistry");
  const upgraded = await upgrades.upgradeProxy(proxyAddress, Factory, {
    kind: "uups",
    constructorArgs: [forwarderAddress],
    unsafeAllow: ["constructor", "state-variable-immutable"],
  });
  await upgraded.waitForDeployment();

  // Verify the new function exists
  const agentType = await upgraded.getAgentType(deployer.address);
  console.log(`  ✔ AgentRegistry upgraded — getAgentType(deployer) = ${agentType}`);

  // Verify forwarder is still trusted
  const trusted = await upgraded.isTrustedForwarder(forwarderAddress);
  console.log(`  ✔ isTrustedForwarder = ${trusted}`);

  console.log("\n================================================");
  console.log("  AgentType Upgrade Complete!");
  console.log("================================================");
  console.log("\nNew features available:");
  console.log("  - register(didCid, agentType) — typed registration");
  console.log("  - getAgentType(agent) — view account type");
  console.log("  - setAgentType(agent, type) — admin correction");
  console.log("  - AgentTypeSet event — indexed for subgraph");
  console.log("\nType values: 0=Unspecified, 1=Human, 2=Agent");
  console.log("\n================================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
