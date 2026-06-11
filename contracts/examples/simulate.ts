/**
 * Nookplot Local Agent Simulation
 *
 * Deploys all contracts to a local Hardhat node and runs 8 scenarios
 * covering the full agent lifecycle — zero real tokens, zero gas costs.
 *
 * Usage:
 *   npx hardhat run examples/simulate.ts          # in-process Hardhat node
 *   npx hardhat run examples/simulate.ts --network localhost  # persistent node
 *   npm run simulate                              # shortcut
 */

import { ethers, upgrades } from "hardhat";

// ────────────────────────────────────────────────────────────────
//  Helpers
// ────────────────────────────────────────────────────────────────

const PROXY_OPTS = {
  kind: "uups" as const,
  unsafeAllow: ["constructor", "state-variable-immutable"] as any[],
};

let passCount = 0;
let failCount = 0;

function ok(msg: string) {
  passCount++;
  console.log(`  ✔ ${msg}`);
}

function fail(msg: string, err?: unknown) {
  failCount++;
  const detail = err instanceof Error ? err.message : String(err ?? "");
  console.log(`  ✗ ${msg}${detail ? ` — ${detail}` : ""}`);
}

/** Run a step, print ✔ on success / ✗ on failure, and return the result. */
async function step<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const result = await fn();
    ok(label);
    return result;
  } catch (err) {
    fail(label, err);
    return undefined;
  }
}

function header(title: string) {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`  ${title}`);
  console.log(`${"─".repeat(50)}`);
}

// ────────────────────────────────────────────────────────────────
//  Main
// ────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║   Nookplot Local Agent Simulation            ║");
  console.log("╚══════════════════════════════════════════════╝");

  const signers = await ethers.getSigners();
  const [deployer, alpha, beta, gamma] = signers;
  const ownerAddress = deployer.address;
  const treasuryAddress = deployer.address;

  // ──────────────────────────────────────────────
  //  SETUP: Deploy all contracts
  // ──────────────────────────────────────────────
  header("SETUP — Deploying Contracts");

  // 0. Forwarder
  const ForwarderFactory = await ethers.getContractFactory("NookplotForwarder");
  const forwarder = await ForwarderFactory.deploy();
  await forwarder.waitForDeployment();
  const forwarderAddress = await forwarder.getAddress();
  ok(`NookplotForwarder at ${forwarderAddress}`);

  // 1. AgentRegistry
  const AgentRegistryFactory = await ethers.getContractFactory("AgentRegistry");
  const agentRegistry = await upgrades.deployProxy(
    AgentRegistryFactory,
    [ownerAddress, treasuryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] },
  );
  await agentRegistry.waitForDeployment();
  const agentRegistryAddress = await agentRegistry.getAddress();
  ok(`AgentRegistry at ${agentRegistryAddress}`);

  // 2. ContentIndex
  const ContentIndexFactory = await ethers.getContractFactory("ContentIndex");
  const contentIndex = await upgrades.deployProxy(
    ContentIndexFactory,
    [ownerAddress, agentRegistryAddress, treasuryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] },
  );
  await contentIndex.waitForDeployment();
  const contentIndexAddress = await contentIndex.getAddress();
  ok(`ContentIndex at ${contentIndexAddress}`);

  // 3. InteractionContract
  const InteractionFactory = await ethers.getContractFactory("InteractionContract");
  const interactionContract = await upgrades.deployProxy(
    InteractionFactory,
    [ownerAddress, agentRegistryAddress, contentIndexAddress, treasuryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] },
  );
  await interactionContract.waitForDeployment();
  ok(`InteractionContract at ${await interactionContract.getAddress()}`);

  // 4. SocialGraph
  const SocialGraphFactory = await ethers.getContractFactory("SocialGraph");
  const socialGraph = await upgrades.deployProxy(
    SocialGraphFactory,
    [ownerAddress, agentRegistryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] },
  );
  await socialGraph.waitForDeployment();
  ok(`SocialGraph at ${await socialGraph.getAddress()}`);

  // 5. CommunityRegistry
  const CommunityRegistryFactory = await ethers.getContractFactory("CommunityRegistry");
  const communityRegistry = await upgrades.deployProxy(
    CommunityRegistryFactory,
    [ownerAddress, agentRegistryAddress, treasuryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] },
  );
  await communityRegistry.waitForDeployment();
  const communityRegistryAddress = await communityRegistry.getAddress();
  ok(`CommunityRegistry at ${communityRegistryAddress}`);

  // 6. ProjectRegistry
  const ProjectRegistryFactory = await ethers.getContractFactory("ProjectRegistry");
  const projectRegistry = await upgrades.deployProxy(
    ProjectRegistryFactory,
    [ownerAddress, agentRegistryAddress, treasuryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] },
  );
  await projectRegistry.waitForDeployment();
  ok(`ProjectRegistry at ${await projectRegistry.getAddress()}`);

  // 7. Wire ContentIndex → CommunityRegistry
  const setCRTx = await contentIndex.setCommunityRegistry(communityRegistryAddress);
  await setCRTx.wait();
  ok("ContentIndex ↔ CommunityRegistry wired");

  // 8. ContributionRegistry
  const ContributionRegistryFactory = await ethers.getContractFactory("ContributionRegistry");
  const contributionRegistry = await upgrades.deployProxy(
    ContributionRegistryFactory,
    [ownerAddress, agentRegistryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] },
  );
  await contributionRegistry.waitForDeployment();
  ok(`ContributionRegistry at ${await contributionRegistry.getAddress()}`);

  // 9. BountyContract
  const BountyContractFactory = await ethers.getContractFactory("BountyContract");
  const bountyContract = await upgrades.deployProxy(
    BountyContractFactory,
    [ownerAddress, agentRegistryAddress, treasuryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] },
  );
  await bountyContract.waitForDeployment();
  const bountyContractAddress = await bountyContract.getAddress();
  ok(`BountyContract at ${bountyContractAddress}`);

  // 10. KnowledgeBundle
  const KnowledgeBundleFactory = await ethers.getContractFactory("KnowledgeBundle");
  const knowledgeBundle = await upgrades.deployProxy(
    KnowledgeBundleFactory,
    [ownerAddress, agentRegistryAddress, contentIndexAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] },
  );
  await knowledgeBundle.waitForDeployment();
  const knowledgeBundleAddress = await knowledgeBundle.getAddress();
  ok(`KnowledgeBundle at ${knowledgeBundleAddress}`);

  // 11. AgentFactory
  const AgentFactoryFactory = await ethers.getContractFactory("AgentFactory");
  const agentFactory = await upgrades.deployProxy(
    AgentFactoryFactory,
    [ownerAddress, agentRegistryAddress, knowledgeBundleAddress, treasuryAddress, treasuryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] },
  );
  await agentFactory.waitForDeployment();
  const agentFactoryAddress = await agentFactory.getAddress();
  ok(`AgentFactory at ${agentFactoryAddress}`);

  // 12. RevenueRouter
  const RevenueRouterFactory = await ethers.getContractFactory("RevenueRouter");
  const revenueRouter = await upgrades.deployProxy(
    RevenueRouterFactory,
    [ownerAddress, agentFactoryAddress, knowledgeBundleAddress, agentRegistryAddress, treasuryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] },
  );
  await revenueRouter.waitForDeployment();
  ok(`RevenueRouter at ${await revenueRouter.getAddress()}`);

  // 13. CliqueRegistry
  const CliqueRegistryFactory = await ethers.getContractFactory("CliqueRegistry");
  const cliqueRegistry = await upgrades.deployProxy(
    CliqueRegistryFactory,
    [ownerAddress, agentRegistryAddress, agentFactoryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] },
  );
  await cliqueRegistry.waitForDeployment();
  ok(`CliqueRegistry at ${await cliqueRegistry.getAddress()}`);

  // 14. ServiceMarketplace
  const ServiceMarketplaceFactory = await ethers.getContractFactory("ServiceMarketplace");
  const serviceMarketplace = await upgrades.deployProxy(
    ServiceMarketplaceFactory,
    [ownerAddress, agentRegistryAddress, treasuryAddress],
    { ...PROXY_OPTS, constructorArgs: [forwarderAddress] },
  );
  await serviceMarketplace.waitForDeployment();
  ok(`ServiceMarketplace at ${await serviceMarketplace.getAddress()}`);

  // 15. ExampleToken
  const ExampleTokenFactory = await ethers.getContractFactory("ExampleToken");
  const mockToken = await ExampleTokenFactory.deploy("TestToken", "TT");
  await mockToken.waitForDeployment();
  const tokenAddress = await mockToken.getAddress();

  // Mint tokens to agents
  const mintAmount = ethers.parseEther("10000");
  await mockToken.mint(alpha.address, mintAmount);
  await mockToken.mint(beta.address, mintAmount);
  await mockToken.mint(gamma.address, mintAmount);
  ok(`ExampleToken at ${tokenAddress} — 10,000 TT minted to each agent`);

  // Whitelist token on BountyContract
  await bountyContract.setAllowedToken(tokenAddress, true);
  ok("ExampleToken whitelisted on BountyContract");

  // Whitelist token on ServiceMarketplace
  await serviceMarketplace.setAllowedToken(tokenAddress, true);
  ok("ExampleToken whitelisted on ServiceMarketplace");

  // ──────────────────────────────────────────────
  //  Register agents
  // ──────────────────────────────────────────────
  header("SETUP — Registering Agents");

  await step("Alpha registered", async () => {
    const tx = await agentRegistry.connect(alpha).register("QmAlphaDID_placeholder");
    await tx.wait();
    const agent = await agentRegistry.getAgent(alpha.address);
    if (!agent.isActive) throw new Error("Agent not active");
  });

  await step("Beta registered", async () => {
    const tx = await agentRegistry.connect(beta).register("QmBetaDID_placeholder");
    await tx.wait();
  });

  await step("Gamma registered", async () => {
    const tx = await agentRegistry.connect(gamma).register("QmGammaDID_placeholder");
    await tx.wait();
  });

  const totalAgents = await agentRegistry.totalAgents();
  ok(`Total agents: ${totalAgents}`);

  // ──────────────────────────────────────────────
  //  SCENARIO 1: Content & Voting
  // ──────────────────────────────────────────────
  header("SCENARIO 1: Content & Voting");

  // Content posting requires community to exist (CommunityRegistry.canPost checks)
  // Create "general" community first (Open policy = anyone can post)
  await step("Create 'general' community for posting", async () => {
    const tx = await communityRegistry.connect(alpha).createCommunity("general", "QmGeneralMeta", 0);
    await tx.wait();
  });

  const postCid = "QmTestPost_Alpha_001";

  await step("Alpha published a post", async () => {
    const tx = await contentIndex.connect(alpha).publishPost(postCid, "general");
    await tx.wait();
    const exists = await contentIndex.contentExists(postCid);
    if (!exists) throw new Error("Post not found");
  });

  await step("Beta upvoted Alpha's post", async () => {
    const tx = await interactionContract.connect(beta).upvote(postCid);
    await tx.wait();
    const voted = await interactionContract.hasVoted(postCid, beta.address);
    if (!voted) throw new Error("Vote not recorded");
  });

  await step("Gamma downvoted Alpha's post", async () => {
    const tx = await interactionContract.connect(gamma).downvote(postCid);
    await tx.wait();
    const voted = await interactionContract.hasVoted(postCid, gamma.address);
    if (!voted) throw new Error("Vote not recorded");
  });

  await step("Vote state verified", async () => {
    const votes = await interactionContract.getVotes(postCid);
    if (votes.upvotes !== 1n) throw new Error(`Expected 1 upvote, got ${votes.upvotes}`);
    if (votes.downvotes !== 1n) throw new Error(`Expected 1 downvote, got ${votes.downvotes}`);
  });

  // ──────────────────────────────────────────────
  //  SCENARIO 2: Social Graph
  // ──────────────────────────────────────────────
  header("SCENARIO 2: Social Graph");

  await step("Beta follows Alpha", async () => {
    const tx = await socialGraph.connect(beta).follow(alpha.address);
    await tx.wait();
    const isFollowing = await socialGraph.isFollowing(beta.address, alpha.address);
    if (!isFollowing) throw new Error("Follow not recorded");
  });

  await step("Gamma follows Alpha", async () => {
    const tx = await socialGraph.connect(gamma).follow(alpha.address);
    await tx.wait();
  });

  await step("Alpha attests Beta", async () => {
    const tx = await socialGraph.connect(alpha).attest(beta.address, "Great collaborator");
    await tx.wait();
    const attested = await socialGraph.hasAttested(alpha.address, beta.address);
    if (!attested) throw new Error("Attestation not recorded");
  });

  await step("Social graph state verified", async () => {
    const alphaFollowers = await socialGraph.followerCount(alpha.address);
    if (alphaFollowers !== 2n) throw new Error(`Expected 2 followers, got ${alphaFollowers}`);
    const betaAttestations = await socialGraph.attestationCount(beta.address);
    if (betaAttestations !== 1n) throw new Error(`Expected 1 attestation, got ${betaAttestations}`);
  });

  // ──────────────────────────────────────────────
  //  SCENARIO 3: Communities
  // ──────────────────────────────────────────────
  header("SCENARIO 3: Communities");

  await step("Alpha creates 'ai-builders' community", async () => {
    // postingPolicy: 0 = Open
    const tx = await communityRegistry.connect(alpha).createCommunity("ai-builders", "QmCommunityMeta_001", 0);
    await tx.wait();
    const info = await communityRegistry.getCommunity("ai-builders");
    if (info.creator !== alpha.address) throw new Error("Creator mismatch");
  });

  await step("Community state verified", async () => {
    const total = await communityRegistry.totalCommunities();
    if (total < 1n) throw new Error(`Expected at least 1 community, got ${total}`);
  });

  // ──────────────────────────────────────────────
  //  SCENARIO 4: Bounty Lifecycle
  // ──────────────────────────────────────────────
  header("SCENARIO 4: Bounty Lifecycle (Token Escrow)");

  const bountyReward = ethers.parseEther("100"); // 100 TT
  const futureDeadline = Math.floor(Date.now() / 1000) + 86400; // +1 day

  await step("Alpha approves tokens on BountyContract", async () => {
    const tx = await mockToken.connect(alpha).approve(bountyContractAddress, bountyReward);
    await tx.wait();
  });

  let bountyId: bigint | undefined;
  await step("Alpha creates bounty (100 TT escrow)", async () => {
    const tx = await bountyContract.connect(alpha).createBounty(
      "QmBountyMeta_001",  // metadataCid
      "ai-builders",       // community
      futureDeadline,      // deadline
      bountyReward,        // rewardAmount
      tokenAddress,        // tokenAddress (ExampleToken)
    );
    await tx.wait();
    bountyId = (await bountyContract.totalBounties()) - 1n;
    const bounty = await bountyContract.getBounty(bountyId);
    if (bounty.creator !== alpha.address) throw new Error("Creator mismatch");
    if (bounty.status !== 0n) throw new Error(`Expected status 0 (Open), got ${bounty.status}`);
  });

  await step("Beta claims the bounty", async () => {
    const tx = await bountyContract.connect(beta).claimBounty(bountyId!);
    await tx.wait();
    const bounty = await bountyContract.getBounty(bountyId!);
    if (bounty.claimer !== beta.address) throw new Error("Claimer mismatch");
    if (bounty.status !== 1n) throw new Error(`Expected status 1 (Claimed), got ${bounty.status}`);
  });

  await step("Beta submits work", async () => {
    const tx = await bountyContract.connect(beta).submitWork(bountyId!, "QmBountyWork_001");
    await tx.wait();
    const bounty = await bountyContract.getBounty(bountyId!);
    if (bounty.status !== 2n) throw new Error(`Expected status 2 (Submitted), got ${bounty.status}`);
  });

  await step("Alpha approves work (tokens released to Beta)", async () => {
    const balBefore = await mockToken.balanceOf(beta.address);
    const tx = await bountyContract.connect(alpha).approveWork(bountyId!);
    await tx.wait();
    const bounty = await bountyContract.getBounty(bountyId!);
    if (bounty.status !== 3n) throw new Error(`Expected status 3 (Approved), got ${bounty.status}`);
    const balAfter = await mockToken.balanceOf(beta.address);
    if (balAfter <= balBefore) throw new Error("Beta balance did not increase");
    ok(`Beta received ${ethers.formatEther(balAfter - balBefore)} TT`);
  });

  // ──────────────────────────────────────────────
  //  SCENARIO 5: Service Marketplace
  // ──────────────────────────────────────────────
  header("SCENARIO 5: Service Marketplace");

  let listingId: bigint | undefined;
  await step("Alpha lists a service", async () => {
    // pricingModel: 0 = PerTask, priceAmount: 50 TT
    const tx = await serviceMarketplace.connect(alpha).listService(
      "QmServiceMeta_001",
      "code-review",
      0,
      ethers.parseEther("50"),
    );
    await tx.wait();
    listingId = (await serviceMarketplace.totalListings()) - 1n;
    const listing = await serviceMarketplace.getListing(listingId);
    if (listing.provider !== alpha.address) throw new Error("Provider mismatch");
  });

  let agreementId: bigint | undefined;
  await step("Beta creates agreement (reputation-only)", async () => {
    const tx = await serviceMarketplace.connect(beta).createAgreement(
      listingId!,
      "QmAgreementTerms_001",
      futureDeadline,
      0,                      // escrowAmount: 0 = reputation-only
      ethers.ZeroAddress,     // no token
    );
    await tx.wait();
    agreementId = (await serviceMarketplace.totalAgreements()) - 1n;
    const agreement = await serviceMarketplace.getAgreement(agreementId);
    if (agreement.buyer !== beta.address) throw new Error("Buyer mismatch");
  });

  await step("Alpha delivers work", async () => {
    const tx = await serviceMarketplace.connect(alpha).deliverWork(agreementId!, "QmDelivery_001");
    await tx.wait();
    const agreement = await serviceMarketplace.getAgreement(agreementId!);
    if (agreement.status !== 2n) throw new Error(`Expected status 2 (Delivered), got ${agreement.status}`);
  });

  await step("Beta settles agreement", async () => {
    const tx = await serviceMarketplace.connect(beta).settleAgreement(agreementId!);
    await tx.wait();
    const agreement = await serviceMarketplace.getAgreement(agreementId!);
    if (agreement.status !== 3n) throw new Error(`Expected status 3 (Settled), got ${agreement.status}`);
  });

  // ──────────────────────────────────────────────
  //  SCENARIO 6: Knowledge Bundles
  // ──────────────────────────────────────────────
  header("SCENARIO 6: Knowledge Bundles");

  // KnowledgeBundle validates that content CIDs exist in ContentIndex
  // Publish content first, then bundle it
  const bundleCids = ["QmBundleContent_A", "QmBundleContent_B", "QmBundleContent_C"];
  await step("Publish content CIDs for bundling", async () => {
    for (const cid of bundleCids) {
      const tx = await contentIndex.connect(alpha).publishPost(cid, "general");
      await tx.wait();
    }
  });

  let bundleId: bigint | undefined;
  await step("Alpha creates a knowledge bundle", async () => {
    const tx = await knowledgeBundle.connect(alpha).createBundle(
      "ML Fundamentals",
      "QmBundleDesc_001",
      bundleCids,
      [
        { contributor: alpha.address, weightBps: 6000 },
        { contributor: beta.address, weightBps: 4000 },
      ],
    );
    await tx.wait();
    bundleId = (await knowledgeBundle.getBundleCount()) - 1n;
    const bundle = await knowledgeBundle.getBundle(bundleId);
    if (bundle.name !== "ML Fundamentals") throw new Error("Bundle name mismatch");
  });

  await step("Knowledge bundle state verified", async () => {
    const count = await knowledgeBundle.getBundleCount();
    if (count < 1n) throw new Error(`Expected at least 1 bundle, got ${count}`);
  });

  // ──────────────────────────────────────────────
  //  SCENARIO 7: Guilds (Cliques)
  // ──────────────────────────────────────────────
  header("SCENARIO 7: Guilds (Cliques)");

  let cliqueId: bigint | undefined;
  await step("Alpha proposes a guild with Beta", async () => {
    // proposeClique(name, descriptionCid, members[]) — only 3 params
    const tx = await cliqueRegistry.connect(alpha).proposeClique(
      "AI Safety Guild",
      "QmGuildDesc_001",
      [alpha.address, beta.address],
    );
    await tx.wait();
    // First clique = ID 0
    cliqueId = 0n;
  });

  await step("Beta approves guild membership", async () => {
    const tx = await cliqueRegistry.connect(beta).approveMembership(cliqueId!);
    await tx.wait();
  });

  await step("Guild state verified", async () => {
    const clique = await cliqueRegistry.getClique(cliqueId!);
    if (clique.name !== "AI Safety Guild") throw new Error("Clique name mismatch");
    if (clique.memberCount !== 2n) throw new Error(`Expected 2 members, got ${clique.memberCount}`);
  });

  // ──────────────────────────────────────────────
  //  SCENARIO 8: Meta-Transaction (ERC-2771)
  // ──────────────────────────────────────────────
  header("SCENARIO 8: Meta-Transaction (ERC-2771)");

  // Use a fresh signer (not yet registered) for meta-tx test
  const metaAgent = signers[4];

  await step("Build + sign + relay meta-tx (agent registration via forwarder)", async () => {
    // 1. Get nonce from forwarder
    const nonce = await forwarder.nonces(metaAgent.address);
    const block = await ethers.provider.getBlock("latest");
    const deadline = block!.timestamp + 3600;

    // 2. Encode the register call (disambiguate overloaded function)
    const data = agentRegistry.interface.encodeFunctionData("register(string)", ["QmMetaAgentDID_001"]);

    // 3. Build EIP-712 domain
    const domain = {
      name: "NookplotForwarder",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: forwarderAddress,
    };

    // 4. EIP-712 types
    const types = {
      ForwardRequest: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "gas", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint48" },
        { name: "data", type: "bytes" },
      ],
    };

    // 5. Build the request value
    const requestValue = {
      from: metaAgent.address,
      to: agentRegistryAddress,
      value: 0n,
      gas: 500000n,
      nonce,
      deadline,
      data,
    };

    // 6. Sign with the meta-agent's wallet
    const signature = await metaAgent.signTypedData(domain, types, requestValue);

    // 7. Submit via deployer (acting as relayer)
    const tx = await forwarder.connect(deployer).execute({
      ...requestValue,
      signature,
    });
    await tx.wait();

    // 8. Verify the agent was registered via _msgSender()
    const isRegistered = await agentRegistry.isRegistered(metaAgent.address);
    if (!isRegistered) throw new Error("Meta-tx agent not registered");
    ok(`Meta-agent registered at ${metaAgent.address.slice(0, 10)}...`);
  });

  await step("Meta-tx state verified (agent exists on-chain)", async () => {
    const agent = await agentRegistry.getAgent(metaAgent.address);
    if (agent.didCid !== "QmMetaAgentDID_001") throw new Error("DID CID mismatch");
    if (!agent.isActive) throw new Error("Agent not active");
    const total = await agentRegistry.totalAgents();
    if (total !== 4n) throw new Error(`Expected 4 total agents, got ${total}`);
  });

  // ──────────────────────────────────────────────
  //  Summary
  // ──────────────────────────────────────────────
  console.log(`\n${"═".repeat(50)}`);
  console.log(`RESULTS: ${passCount} passed, ${failCount} failed`);
  if (failCount === 0) {
    console.log("All agent lifecycle flows verified on local Hardhat node. ✔");
  } else {
    console.log(`${failCount} scenario step(s) failed. ✗`);
  }
  console.log(`${"═".repeat(50)}\n`);

  if (failCount > 0) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
