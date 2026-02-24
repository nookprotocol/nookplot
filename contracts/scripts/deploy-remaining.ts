/**
 * Nookplot — Deploy Remaining Contracts (Incremental)
 *
 * Upgrades existing contracts to latest code, then deploys the 8 new contracts.
 *
 * Already deployed: NookplotForwarder, AgentRegistry (upgraded), ContentIndex,
 *   InteractionContract, SocialGraph
 *
 * Step 1: Upgrade ContentIndex, InteractionContract, SocialGraph to latest code
 *   (adds ERC-2771, setCommunityRegistry, and other post-deploy features)
 * Step 2: Deploy 8 new contracts + wire ContentIndex → CommunityRegistry
 *
 * Prerequisites:
 *   - DEPLOYER_PRIVATE_KEY in .env (must be proxy owner)
 *   - FORWARDER_ADDRESS, AGENT_REGISTRY_ADDRESS, CONTENT_INDEX_ADDRESS,
 *     INTERACTION_CONTRACT_ADDRESS, SOCIAL_GRAPH_ADDRESS in .env
 *
 * Usage:
 *   npx hardhat run scripts/deploy-remaining.ts --network baseSepolia
 */

import { ethers, upgrades } from "hardhat";

const PROXY_OPTS = {
  kind: "uups" as const,
  unsafeAllow: ["constructor", "state-variable-immutable"] as any[],
};

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing ${name} in .env`);
  return val;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("========================================");
  console.log("  Nookplot — Deploy Remaining Contracts");
  console.log("========================================");
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Network:   ${(await ethers.provider.getNetwork()).name}`);
  console.log(`Chain ID:  ${(await ethers.provider.getNetwork()).chainId}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:   ${ethers.formatEther(balance)} ETH`);
  console.log("----------------------------------------\n");

  // Read existing addresses
  const forwarderAddress = requireEnv("FORWARDER_ADDRESS");
  const agentRegistryAddress = requireEnv("AGENT_REGISTRY_ADDRESS");
  const contentIndexAddress = requireEnv("CONTENT_INDEX_ADDRESS");
  const interactionContractAddress = requireEnv("INTERACTION_CONTRACT_ADDRESS");
  const socialGraphAddress = requireEnv("SOCIAL_GRAPH_ADDRESS");

  console.log("Existing contracts:");
  console.log(`  Forwarder:           ${forwarderAddress}`);
  console.log(`  AgentRegistry:       ${agentRegistryAddress} (already upgraded)`);
  console.log(`  ContentIndex:        ${contentIndexAddress}`);
  console.log(`  InteractionContract: ${interactionContractAddress}`);
  console.log(`  SocialGraph:         ${socialGraphAddress}`);
  console.log();

  const ownerAddress = deployer.address;
  const treasuryAddress = deployer.address;

  let step = 0;
  const totalSteps = 12;

  // ============================================================
  //  PHASE 1: Upgrade existing contracts to latest code
  // ============================================================
  console.log("=== PHASE 1: Upgrade existing contracts ===\n");

  const contractsToUpgrade = [
    { name: "ContentIndex", address: contentIndexAddress },
    { name: "InteractionContract", address: interactionContractAddress },
    { name: "SocialGraph", address: socialGraphAddress },
  ];

  for (const { name, address } of contractsToUpgrade) {
    step++;
    console.log(`${step}/${totalSteps} Upgrading ${name} at ${address}...`);
    const Factory = await ethers.getContractFactory(name);
    const upgraded = await upgrades.upgradeProxy(address, Factory, {
      ...PROXY_OPTS,
      constructorArgs: [forwarderAddress],
    });
    await upgraded.waitForDeployment();
    const trusted = await upgraded.isTrustedForwarder(forwarderAddress);
    console.log(`    ✔ ${name} upgraded — isTrustedForwarder = ${trusted}`);
  }

  // ============================================================
  //  PHASE 2: Deploy new contracts
  // ============================================================
  console.log("\n=== PHASE 2: Deploy new contracts ===\n");

  // 4. CommunityRegistry
  step++;
  console.log(`${step}/${totalSteps} Deploying CommunityRegistry...`);
  const CommunityRegistryFactory = await ethers.getContractFactory("CommunityRegistry");
  const communityRegistry = await upgrades.deployProxy(
    CommunityRegistryFactory,
    [ownerAddress, agentRegistryAddress, treasuryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
  );
  await communityRegistry.waitForDeployment();
  const communityRegistryAddress = await communityRegistry.getAddress();
  console.log(`    ✔ CommunityRegistry:    ${communityRegistryAddress}`);

  // 5. Wire ContentIndex → CommunityRegistry
  step++;
  console.log(`${step}/${totalSteps} Wiring ContentIndex → CommunityRegistry...`);
  const contentIndex = await ethers.getContractAt("ContentIndex", contentIndexAddress);
  const setCRTx = await contentIndex.setCommunityRegistry(communityRegistryAddress);
  await setCRTx.wait();
  console.log(`    ✔ ContentIndex.setCommunityRegistry(${communityRegistryAddress})`);

  // 6. ProjectRegistry
  step++;
  console.log(`${step}/${totalSteps} Deploying ProjectRegistry...`);
  const ProjectRegistryFactory = await ethers.getContractFactory("ProjectRegistry");
  const projectRegistry = await upgrades.deployProxy(
    ProjectRegistryFactory,
    [ownerAddress, agentRegistryAddress, treasuryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
  );
  await projectRegistry.waitForDeployment();
  const projectRegistryAddress = await projectRegistry.getAddress();
  console.log(`    ✔ ProjectRegistry:      ${projectRegistryAddress}`);

  // 7. ContributionRegistry
  step++;
  console.log(`${step}/${totalSteps} Deploying ContributionRegistry...`);
  const ContributionRegistryFactory = await ethers.getContractFactory("ContributionRegistry");
  const contributionRegistry = await upgrades.deployProxy(
    ContributionRegistryFactory,
    [ownerAddress, agentRegistryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
  );
  await contributionRegistry.waitForDeployment();
  const contributionRegistryAddress = await contributionRegistry.getAddress();
  console.log(`    ✔ ContributionRegistry: ${contributionRegistryAddress}`);

  // 8. BountyContract
  step++;
  console.log(`${step}/${totalSteps} Deploying BountyContract...`);
  const BountyContractFactory = await ethers.getContractFactory("BountyContract");
  const bountyContract = await upgrades.deployProxy(
    BountyContractFactory,
    [ownerAddress, agentRegistryAddress, treasuryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
  );
  await bountyContract.waitForDeployment();
  const bountyContractAddress = await bountyContract.getAddress();
  console.log(`    ✔ BountyContract:       ${bountyContractAddress}`);

  // 9. KnowledgeBundle
  step++;
  console.log(`${step}/${totalSteps} Deploying KnowledgeBundle...`);
  const KnowledgeBundleFactory = await ethers.getContractFactory("KnowledgeBundle");
  const knowledgeBundle = await upgrades.deployProxy(
    KnowledgeBundleFactory,
    [ownerAddress, agentRegistryAddress, contentIndexAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
  );
  await knowledgeBundle.waitForDeployment();
  const knowledgeBundleAddress = await knowledgeBundle.getAddress();
  console.log(`    ✔ KnowledgeBundle:      ${knowledgeBundleAddress}`);

  // 10. AgentFactory
  step++;
  console.log(`${step}/${totalSteps} Deploying AgentFactory...`);
  const AgentFactoryFactory = await ethers.getContractFactory("AgentFactory");
  const agentFactory = await upgrades.deployProxy(
    AgentFactoryFactory,
    [ownerAddress, agentRegistryAddress, knowledgeBundleAddress, treasuryAddress, treasuryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
  );
  await agentFactory.waitForDeployment();
  const agentFactoryAddress = await agentFactory.getAddress();
  console.log(`    ✔ AgentFactory:         ${agentFactoryAddress}`);

  // 11. RevenueRouter
  step++;
  console.log(`${step}/${totalSteps} Deploying RevenueRouter...`);
  const RevenueRouterFactory = await ethers.getContractFactory("RevenueRouter");
  const revenueRouter = await upgrades.deployProxy(
    RevenueRouterFactory,
    [ownerAddress, agentFactoryAddress, knowledgeBundleAddress, agentRegistryAddress, treasuryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
  );
  await revenueRouter.waitForDeployment();
  const revenueRouterAddress = await revenueRouter.getAddress();
  console.log(`    ✔ RevenueRouter:        ${revenueRouterAddress}`);

  // 12. CliqueRegistry
  step++;
  console.log(`${step}/${totalSteps} Deploying CliqueRegistry...`);
  const CliqueRegistryFactory = await ethers.getContractFactory("CliqueRegistry");
  const cliqueRegistry = await upgrades.deployProxy(
    CliqueRegistryFactory,
    [ownerAddress, agentRegistryAddress, agentFactoryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
  );
  await cliqueRegistry.waitForDeployment();
  const cliqueRegistryAddress = await cliqueRegistry.getAddress();
  console.log(`    ✔ CliqueRegistry:       ${cliqueRegistryAddress}`);

  // ============================================================
  //  Verify forwarder trust on all new contracts
  // ============================================================
  console.log("\nVerifying trusted forwarder on new contracts...");
  for (const [name, contract] of [
    ["CommunityRegistry", communityRegistry],
    ["ProjectRegistry", projectRegistry],
    ["ContributionRegistry", contributionRegistry],
    ["BountyContract", bountyContract],
    ["KnowledgeBundle", knowledgeBundle],
    ["AgentFactory", agentFactory],
    ["RevenueRouter", revenueRouter],
    ["CliqueRegistry", cliqueRegistry],
  ] as const) {
    const trusted = await (contract as any).isTrustedForwarder(forwarderAddress);
    console.log(`    ${trusted ? "✔" : "✗"} ${name}.isTrustedForwarder = ${trusted}`);
  }

  // ============================================================
  //  Summary
  // ============================================================
  const endBalance = await ethers.provider.getBalance(deployer.address);
  const gasUsed = balance - endBalance;

  console.log("\n========================================");
  console.log("  Deployment Complete!");
  console.log("========================================");
  console.log(`\nGas spent: ${ethers.formatEther(gasUsed)} ETH`);
  console.log(`Remaining: ${ethers.formatEther(endBalance)} ETH`);
  console.log("\nUpgraded contracts (same proxy addresses):");
  console.log(`  ContentIndex:        ${contentIndexAddress}`);
  console.log(`  InteractionContract: ${interactionContractAddress}`);
  console.log(`  SocialGraph:         ${socialGraphAddress}`);
  console.log("\nNew contract addresses (add to .env):\n");
  console.log(`COMMUNITY_REGISTRY_ADDRESS=${communityRegistryAddress}`);
  console.log(`PROJECT_REGISTRY_ADDRESS=${projectRegistryAddress}`);
  console.log(`CONTRIBUTION_REGISTRY_ADDRESS=${contributionRegistryAddress}`);
  console.log(`BOUNTY_CONTRACT_ADDRESS=${bountyContractAddress}`);
  console.log(`KNOWLEDGE_BUNDLE_ADDRESS=${knowledgeBundleAddress}`);
  console.log(`AGENT_FACTORY_ADDRESS=${agentFactoryAddress}`);
  console.log(`REVENUE_ROUTER_ADDRESS=${revenueRouterAddress}`);
  console.log(`CLIQUE_REGISTRY_ADDRESS=${cliqueRegistryAddress}`);
  console.log("\n========================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
