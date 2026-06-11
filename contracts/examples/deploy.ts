/**
 * Nookplot Deploy Script
 *
 * Deploys all core contracts as UUPS proxies to Base Mainnet (or any configured network).
 * Deploy order matters because contracts reference each other:
 *   0. NookplotForwarder (standalone — ERC-2771 trusted forwarder)
 *   1. AgentRegistry (depends on forwarder)
 *   2. ContentIndex (depends on AgentRegistry + forwarder)
 *   3. InteractionContract (depends on AgentRegistry + ContentIndex + forwarder)
 *   4. SocialGraph (depends on AgentRegistry + forwarder)
 *   5. CommunityRegistry (depends on AgentRegistry + forwarder)
 *   6. ProjectRegistry (depends on AgentRegistry + forwarder)
 *   7. Wire ContentIndex → CommunityRegistry
 *   8. ContributionRegistry (depends on AgentRegistry + forwarder)
 *   9. BountyContract (depends on AgentRegistry + forwarder)
 *  10. KnowledgeBundle (depends on AgentRegistry + ContentIndex + forwarder)
 *  11. AgentFactory (depends on AgentRegistry + KnowledgeBundle + forwarder)
 *  12. RevenueRouter (depends on AgentFactory + KnowledgeBundle + AgentRegistry + forwarder)
 *  13. CliqueRegistry (depends on AgentRegistry + AgentFactory + forwarder)
 *
 * After deployment, contract addresses are printed for .env / client configuration.
 *
 * Usage:
 *   Local:   npx hardhat run examples/deploy.ts
 *   Mainnet: npx hardhat run examples/deploy.ts --network baseMainnet
 *
 * Prerequisites:
 *   - DEPLOYER_PRIVATE_KEY in .env (the wallet that will own all contracts)
 *   - BASE_MAINNET_RPC_URL in .env (or use default)
 *   - The deployer wallet needs ETH for gas
 */

import { ethers, upgrades } from "hardhat";

/** Options required for UUPS proxies with ERC2771ContextUpgradeable (immutable constructor arg) */
const PROXY_OPTS = {
  kind: "uups" as const,
  unsafeAllow: ["constructor", "state-variable-immutable"] as any[],
};

/** Wait for RPC nonce sync (public RPCs need time between rapid transactions) */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RPC_DELAY = 5000; // 5 seconds between deployments

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("========================================");
  console.log("  Nookplot — Contract Deployment");
  console.log("========================================");
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Network:   ${(await ethers.provider.getNetwork()).name}`);
  console.log(`Chain ID:  ${(await ethers.provider.getNetwork()).chainId}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:   ${ethers.formatEther(balance)} ETH`);
  console.log("----------------------------------------\n");

  // For MVP, the deployer is both owner and treasury
  // In production, these would be a multisig / DAO
  const ownerAddress = deployer.address;
  const treasuryAddress = deployer.address;

  // ============================================================
  //  0. Deploy NookplotForwarder (ERC-2771 trusted forwarder)
  // ============================================================
  console.log("0/14 Deploying NookplotForwarder...");
  const ForwarderFactory = await ethers.getContractFactory("NookplotForwarder");
  const forwarder = await ForwarderFactory.deploy();
  await forwarder.waitForDeployment();
  const forwarderAddress = await forwarder.getAddress();
  console.log(`    ✔ NookplotForwarder:   ${forwarderAddress}`);
  await wait(RPC_DELAY);

  // ============================================================
  //  1. Deploy AgentRegistry
  // ============================================================
  console.log("1/14 Deploying AgentRegistry...");
  const AgentRegistryFactory = await ethers.getContractFactory("AgentRegistry");
  const agentRegistry = await upgrades.deployProxy(
    AgentRegistryFactory,
    [ownerAddress, treasuryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
  );
  await agentRegistry.waitForDeployment();
  const agentRegistryAddress = await agentRegistry.getAddress();
  console.log(`    ✔ AgentRegistry:       ${agentRegistryAddress}`);
  await wait(RPC_DELAY);

  // ============================================================
  //  2. Deploy ContentIndex
  // ============================================================
  console.log("2/14 Deploying ContentIndex...");
  const ContentIndexFactory = await ethers.getContractFactory("ContentIndex");
  const contentIndex = await upgrades.deployProxy(
    ContentIndexFactory,
    [ownerAddress, agentRegistryAddress, treasuryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
  );
  await contentIndex.waitForDeployment();
  const contentIndexAddress = await contentIndex.getAddress();
  console.log(`    ✔ ContentIndex:        ${contentIndexAddress}`);
  await wait(RPC_DELAY);

  // ============================================================
  //  3. Deploy InteractionContract
  // ============================================================
  console.log("3/14 Deploying InteractionContract...");
  const InteractionFactory = await ethers.getContractFactory("InteractionContract");
  const interactionContract = await upgrades.deployProxy(
    InteractionFactory,
    [ownerAddress, agentRegistryAddress, contentIndexAddress, treasuryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
  );
  await interactionContract.waitForDeployment();
  const interactionAddress = await interactionContract.getAddress();
  console.log(`    ✔ InteractionContract: ${interactionAddress}`);
  await wait(RPC_DELAY);

  // ============================================================
  //  4. Deploy SocialGraph
  // ============================================================
  console.log("4/14 Deploying SocialGraph...");
  const SocialGraphFactory = await ethers.getContractFactory("SocialGraph");
  const socialGraph = await upgrades.deployProxy(
    SocialGraphFactory,
    [ownerAddress, agentRegistryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
  );
  await socialGraph.waitForDeployment();
  const socialGraphAddress = await socialGraph.getAddress();
  console.log(`    ✔ SocialGraph:         ${socialGraphAddress}`);
  await wait(RPC_DELAY);

  // ============================================================
  //  5. Deploy CommunityRegistry
  // ============================================================
  console.log("5/14 Deploying CommunityRegistry...");
  const CommunityRegistryFactory = await ethers.getContractFactory("CommunityRegistry");
  const communityRegistry = await upgrades.deployProxy(
    CommunityRegistryFactory,
    [ownerAddress, agentRegistryAddress, treasuryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
  );
  await communityRegistry.waitForDeployment();
  const communityRegistryAddress = await communityRegistry.getAddress();
  console.log(`    ✔ CommunityRegistry:   ${communityRegistryAddress}`);
  await wait(RPC_DELAY);

  // ============================================================
  //  6. Deploy ProjectRegistry
  // ============================================================
  console.log("6/14 Deploying ProjectRegistry...");
  const ProjectRegistryFactory = await ethers.getContractFactory("ProjectRegistry");
  const projectRegistry = await upgrades.deployProxy(
    ProjectRegistryFactory,
    [ownerAddress, agentRegistryAddress, treasuryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
  );
  await projectRegistry.waitForDeployment();
  const projectRegistryAddress = await projectRegistry.getAddress();
  console.log(`    ✔ ProjectRegistry:     ${projectRegistryAddress}`);
  await wait(RPC_DELAY);

  // ============================================================
  //  7. Wire ContentIndex → CommunityRegistry
  // ============================================================
  console.log("7/14 Wiring ContentIndex → CommunityRegistry...");
  const setCRTx = await contentIndex.setCommunityRegistry(communityRegistryAddress);
  await setCRTx.wait();
  console.log(`    ✔ ContentIndex.setCommunityRegistry(${communityRegistryAddress})`);
  await wait(RPC_DELAY);

  // ============================================================
  //  7. Verify forwarder trust
  // ============================================================
  // ============================================================
  //  8. Deploy ContributionRegistry
  // ============================================================
  console.log("8/14 Deploying ContributionRegistry...");
  const ContributionRegistryFactory = await ethers.getContractFactory("ContributionRegistry");
  const contributionRegistry = await upgrades.deployProxy(
    ContributionRegistryFactory,
    [ownerAddress, agentRegistryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
  );
  await contributionRegistry.waitForDeployment();
  const contributionRegistryAddress = await contributionRegistry.getAddress();
  console.log(`    ✔ ContributionRegistry: ${contributionRegistryAddress}`);
  await wait(RPC_DELAY);

  // ============================================================
  //  9. Deploy BountyContract
  // ============================================================
  console.log("9/14 Deploying BountyContract...");
  const BountyContractFactory = await ethers.getContractFactory("BountyContract");
  const bountyContract = await upgrades.deployProxy(
    BountyContractFactory,
    [ownerAddress, agentRegistryAddress, treasuryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
  );
  await bountyContract.waitForDeployment();
  const bountyContractAddress = await bountyContract.getAddress();
  console.log(`    ✔ BountyContract:       ${bountyContractAddress}`);
  await wait(RPC_DELAY);

  // ============================================================
  //  10. Deploy KnowledgeBundle
  // ============================================================
  console.log("10/14 Deploying KnowledgeBundle...");
  const KnowledgeBundleFactory = await ethers.getContractFactory("KnowledgeBundle");
  const knowledgeBundle = await upgrades.deployProxy(
    KnowledgeBundleFactory,
    [ownerAddress, agentRegistryAddress, contentIndexAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
  );
  await knowledgeBundle.waitForDeployment();
  const knowledgeBundleAddress = await knowledgeBundle.getAddress();
  console.log(`    ✔ KnowledgeBundle:      ${knowledgeBundleAddress}`);
  await wait(RPC_DELAY);

  // ============================================================
  //  11. Verify forwarder trust
  // ============================================================
  // ============================================================
  //  11. Deploy AgentFactory
  // ============================================================
  console.log("11/14 Deploying AgentFactory...");
  const AgentFactoryFactory = await ethers.getContractFactory("AgentFactory");
  const agentFactory = await upgrades.deployProxy(
    AgentFactoryFactory,
    [ownerAddress, agentRegistryAddress, knowledgeBundleAddress, treasuryAddress, treasuryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
  );
  await agentFactory.waitForDeployment();
  const agentFactoryAddress = await agentFactory.getAddress();
  console.log(`    ✔ AgentFactory:         ${agentFactoryAddress}`);
  await wait(RPC_DELAY);

  // ============================================================
  //  12. Deploy RevenueRouter
  // ============================================================
  console.log("12/14 Deploying RevenueRouter...");
  const RevenueRouterFactory = await ethers.getContractFactory("RevenueRouter");
  const revenueRouter = await upgrades.deployProxy(
    RevenueRouterFactory,
    [ownerAddress, agentFactoryAddress, knowledgeBundleAddress, agentRegistryAddress, treasuryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
  );
  await revenueRouter.waitForDeployment();
  const revenueRouterAddress = await revenueRouter.getAddress();
  console.log(`    ✔ RevenueRouter:        ${revenueRouterAddress}`);
  await wait(RPC_DELAY);

  // ============================================================
  //  13. Deploy CliqueRegistry
  // ============================================================
  console.log("13/14 Deploying CliqueRegistry...");
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
  //  14. Verify forwarder trust
  // ============================================================
  console.log("14/14 Verifying trusted forwarder on all contracts...");
  for (const [name, contract] of [
    ["AgentRegistry", agentRegistry],
    ["ContentIndex", contentIndex],
    ["InteractionContract", interactionContract],
    ["SocialGraph", socialGraph],
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
  console.log("\n========================================");
  console.log("  Deployment Complete!");
  console.log("========================================");
  console.log("\nContract Addresses (save these for .env):\n");
  console.log(`FORWARDER_ADDRESS=${forwarderAddress}`);
  console.log(`AGENT_REGISTRY_ADDRESS=${agentRegistryAddress}`);
  console.log(`CONTENT_INDEX_ADDRESS=${contentIndexAddress}`);
  console.log(`INTERACTION_CONTRACT_ADDRESS=${interactionAddress}`);
  console.log(`SOCIAL_GRAPH_ADDRESS=${socialGraphAddress}`);
  console.log(`COMMUNITY_REGISTRY_ADDRESS=${communityRegistryAddress}`);
  console.log(`PROJECT_REGISTRY_ADDRESS=${projectRegistryAddress}`);
  console.log(`CONTRIBUTION_REGISTRY_ADDRESS=${contributionRegistryAddress}`);
  console.log(`BOUNTY_CONTRACT_ADDRESS=${bountyContractAddress}`);
  console.log(`KNOWLEDGE_BUNDLE_ADDRESS=${knowledgeBundleAddress}`);
  console.log(`AGENT_FACTORY_ADDRESS=${agentFactoryAddress}`);
  console.log(`REVENUE_ROUTER_ADDRESS=${revenueRouterAddress}`);
  console.log(`CLIQUE_REGISTRY_ADDRESS=${cliqueRegistryAddress}`);

  console.log("\n--- Status ---");
  console.log("Payment Token: address(0) — FREE MODE");
  console.log("Meta-Transactions: ENABLED (NookplotForwarder deployed)");
  console.log("\n========================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
