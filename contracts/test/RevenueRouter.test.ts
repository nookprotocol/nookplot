import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import {
  AgentFactory,
  AgentRegistry,
  ContentIndex,
  KnowledgeBundle,
  NookplotForwarder,
  MockERC20,
  RevenueRouter,
} from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("RevenueRouter", function () {
  let registry: AgentRegistry;
  let contentIndex: ContentIndex;
  let knowledgeBundle: KnowledgeBundle;
  let agentFactory: AgentFactory;
  let revenueRouter: RevenueRouter;
  let forwarder: NookplotForwarder;
  let mockToken: MockERC20;
  let owner: SignerWithAddress;
  let treasurySigner: SignerWithAddress;
  let creditPoolSigner: SignerWithAddress;
  let agentA: SignerWithAddress;
  let agentB: SignerWithAddress;
  let agentC: SignerWithAddress;
  let agentD: SignerWithAddress;
  let nonAgent: SignerWithAddress;

  const DID_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const CID_1 = "QmContent1ForTestingRouter12345678901234567890ab";
  const CID_2 = "QmContent2ForTestingRouter12345678901234567890ab";
  const CID_3 = "QmContent3ForTestingRouter12345678901234567890ab";
  const CID_4 = "QmContent4ForTestingRouter12345678901234567890ab";
  const SOUL_CID = "QmSoulDocumentForTestingRevenueRouterContract0001";
  const SOUL_CID_2 = "QmSoulDocumentForTestingRevenueRouterContract0002";
  const COMMUNITY = "general";

  const PROXY_OPTS = {
    kind: "uups" as const,
    unsafeAllow: ["constructor", "state-variable-immutable"] as any[],
  };

  /** Helper: create ContributorWeight tuples for KnowledgeBundle calls */
  function weights(entries: Array<{ addr: string; bps: number }>) {
    return entries.map((e) => ({ contributor: e.addr, weightBps: e.bps }));
  }

  /** Helper: mint tokens, approve revenueRouter, then return amount */
  async function fundAndApproveRouter(
    signer: SignerWithAddress,
    amount: bigint
  ): Promise<void> {
    await mockToken.mint(signer.address, amount);
    await mockToken
      .connect(signer)
      .approve(await revenueRouter.getAddress(), amount);
  }

  /** Helper: mint tokens, approve agentFactory */
  async function fundAndApproveFactory(
    signer: SignerWithAddress,
    amount: bigint
  ): Promise<void> {
    await mockToken.mint(signer.address, amount);
    await mockToken
      .connect(signer)
      .approve(await agentFactory.getAddress(), amount);
  }

  beforeEach(async function () {
    [
      owner,
      treasurySigner,
      creditPoolSigner,
      agentA,
      agentB,
      agentC,
      agentD,
      nonAgent,
    ] = await ethers.getSigners();

    // Deploy NookplotForwarder
    const ForwarderFactory =
      await ethers.getContractFactory("NookplotForwarder");
    forwarder =
      (await ForwarderFactory.deploy()) as unknown as NookplotForwarder;
    await forwarder.waitForDeployment();
    const forwarderAddress = await forwarder.getAddress();

    // Deploy AgentRegistry
    const RegistryFactory = await ethers.getContractFactory("AgentRegistry");
    registry = (await upgrades.deployProxy(
      RegistryFactory,
      [owner.address, treasurySigner.address],
      { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
    )) as unknown as AgentRegistry;
    await registry.waitForDeployment();

    // Deploy ContentIndex
    const ContentIndexFactory =
      await ethers.getContractFactory("ContentIndex");
    contentIndex = (await upgrades.deployProxy(
      ContentIndexFactory,
      [owner.address, await registry.getAddress(), treasurySigner.address],
      { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
    )) as unknown as ContentIndex;
    await contentIndex.waitForDeployment();

    // Deploy KnowledgeBundle
    const KnowledgeBundleFactory =
      await ethers.getContractFactory("KnowledgeBundle");
    knowledgeBundle = (await upgrades.deployProxy(
      KnowledgeBundleFactory,
      [
        owner.address,
        await registry.getAddress(),
        await contentIndex.getAddress(),
      ],
      { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
    )) as unknown as KnowledgeBundle;
    await knowledgeBundle.waitForDeployment();

    // Deploy MockERC20
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    mockToken = (await MockERC20Factory.deploy(
      "Mock NOOK",
      "MNOOK"
    )) as unknown as MockERC20;
    await mockToken.waitForDeployment();

    // Deploy AgentFactory
    const AgentFactoryFactory =
      await ethers.getContractFactory("AgentFactory");
    agentFactory = (await upgrades.deployProxy(
      AgentFactoryFactory,
      [
        owner.address,
        await registry.getAddress(),
        await knowledgeBundle.getAddress(),
        treasurySigner.address,
        creditPoolSigner.address,
      ],
      { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
    )) as unknown as AgentFactory;
    await agentFactory.waitForDeployment();

    // Deploy RevenueRouter
    const RevenueRouterFactory =
      await ethers.getContractFactory("RevenueRouter");
    revenueRouter = (await upgrades.deployProxy(
      RevenueRouterFactory,
      [
        owner.address,
        await agentFactory.getAddress(),
        await knowledgeBundle.getAddress(),
        await registry.getAddress(),
        treasurySigner.address,
      ],
      { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
    )) as unknown as RevenueRouter;
    await revenueRouter.waitForDeployment();

    // Register agents A, B, C, D in the registry
    await registry.connect(agentA).register(DID_CID);
    await registry.connect(agentB).register(DID_CID);
    await registry.connect(agentC).register(DID_CID);
    await registry.connect(agentD).register(DID_CID);

    // Publish content CIDs so they exist in ContentIndex
    await contentIndex.connect(agentA).publishPost(CID_1, COMMUNITY);
    await contentIndex.connect(agentA).publishPost(CID_2, COMMUNITY);
    await contentIndex.connect(agentB).publishPost(CID_3, COMMUNITY);
    await contentIndex.connect(agentC).publishPost(CID_4, COMMUNITY);

    // Create a knowledge bundle (bundleId = 0) with contributors A(60%) and B(40%)
    const contribs = weights([
      { addr: agentA.address, bps: 6000 },
      { addr: agentB.address, bps: 4000 },
    ]);
    await knowledgeBundle
      .connect(agentA)
      .createBundle("Test Bundle", "", [CID_1, CID_2], contribs);

    // Deploy agent A via AgentFactory (deployment with bundleId 0)
    await agentFactory
      .connect(agentA)
      .deployAgent(0, agentA.address, SOUL_CID, 0);

    // Spawn agent C from agent A (creating a spawn chain: C -> A)
    await agentFactory
      .connect(agentA)
      .spawnAgent(0, agentC.address, SOUL_CID_2, 0);
  });

  // ============================================================
  //                  INITIALIZATION & DEFAULTS
  // ============================================================

  describe("Initialization & defaults", function () {
    it("should set the owner correctly", async function () {
      expect(await revenueRouter.owner()).to.equal(owner.address);
    });

    it("should set agentFactory correctly", async function () {
      expect(await revenueRouter.agentFactory()).to.equal(
        await agentFactory.getAddress()
      );
    });

    it("should set knowledgeBundleContract correctly", async function () {
      expect(await revenueRouter.knowledgeBundleContract()).to.equal(
        await knowledgeBundle.getAddress()
      );
    });

    it("should set agentRegistryContract correctly", async function () {
      expect(await revenueRouter.agentRegistryContract()).to.equal(
        await registry.getAddress()
      );
    });

    it("should set treasury correctly", async function () {
      expect(await revenueRouter.treasury()).to.equal(treasurySigner.address);
    });

    it("should have defaultOwnerBps = 5000", async function () {
      expect(await revenueRouter.defaultOwnerBps()).to.equal(5000);
    });

    it("should have defaultReceiptChainBps = 4000", async function () {
      expect(await revenueRouter.defaultReceiptChainBps()).to.equal(4000);
    });

    it("should have defaultTreasuryBps = 1000", async function () {
      expect(await revenueRouter.defaultTreasuryBps()).to.equal(1000);
    });

    it("should have decayFactorBps = 5000", async function () {
      expect(await revenueRouter.decayFactorBps()).to.equal(5000);
    });

    it("should have maxChainDepth = 5", async function () {
      expect(await revenueRouter.maxChainDepth()).to.equal(5);
    });

    it("should not be paused initially", async function () {
      expect(await revenueRouter.paused()).to.be.false;
    });

    it("should have eventCount = 0 initially", async function () {
      expect(await revenueRouter.getEventCount()).to.equal(0);
    });
  });

  // ============================================================
  //                     SHARE CONFIGURATION
  // ============================================================

  describe("Share configuration", function () {
    it("should allow an agent to set its own config", async function () {
      await revenueRouter
        .connect(agentA)
        .setShareConfig(agentA.address, 6000, 3000, 1000, 0);

      const config = await revenueRouter.getShareConfig(agentA.address);
      expect(config.ownerBps).to.equal(6000);
      expect(config.receiptChainBps).to.equal(3000);
      expect(config.treasuryBps).to.equal(1000);
      expect(config.bundleId).to.equal(0);
      expect(config.isSet).to.be.true;
    });

    it("should allow the owner to set config for any agent", async function () {
      await revenueRouter
        .connect(owner)
        .setShareConfig(agentA.address, 3000, 5000, 2000, 0);

      const config = await revenueRouter.getShareConfig(agentA.address);
      expect(config.ownerBps).to.equal(3000);
      expect(config.receiptChainBps).to.equal(5000);
      expect(config.treasuryBps).to.equal(2000);
      expect(config.isSet).to.be.true;
    });

    it("should revert if shares do not sum to 10000", async function () {
      await expect(
        revenueRouter
          .connect(agentA)
          .setShareConfig(agentA.address, 5000, 3000, 1000, 0)
      ).to.be.revertedWithCustomError(revenueRouter, "InvalidShares");
    });

    it("should revert if non-owner non-agent tries to set config", async function () {
      await expect(
        revenueRouter
          .connect(agentB)
          .setShareConfig(agentA.address, 5000, 4000, 1000, 0)
      ).to.be.revertedWithCustomError(revenueRouter, "InvalidShares");
    });

    it("should emit ShareConfigSet event", async function () {
      await expect(
        revenueRouter
          .connect(agentA)
          .setShareConfig(agentA.address, 5000, 4000, 1000, 0)
      )
        .to.emit(revenueRouter, "ShareConfigSet")
        .withArgs(agentA.address, 5000, 4000, 1000, 0);
    });

    it("getShareConfig should return default (unset) for unconfigured agent", async function () {
      const config = await revenueRouter.getShareConfig(agentB.address);
      expect(config.isSet).to.be.false;
      expect(config.ownerBps).to.equal(0);
      expect(config.receiptChainBps).to.equal(0);
      expect(config.treasuryBps).to.equal(0);
    });
  });

  // ============================================================
  //         REVENUE DISTRIBUTION — ETH (FREE MODE)
  // ============================================================

  describe("Revenue distribution — ETH (free mode, paymentToken=address(0))", function () {
    const ETH_AMOUNT = ethers.parseEther("10");

    it("should distribute ETH with msg.value and split correctly", async function () {
      // Default shares: 50% owner, 40% chain, 10% treasury
      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentA.address, "bounty", { value: ETH_AMOUNT });

      // Owner portion: 50% of 10 ETH = 5 ETH credited to agentA
      const agentABalance = await revenueRouter.getClaimableEthBalance(
        agentA.address
      );

      // Treasury portion: 10% of 10 ETH = 1 ETH credited to treasury
      const treasuryBalance = await revenueRouter.getClaimableEthBalance(
        treasurySigner.address
      );

      // Owner gets 5 ETH directly
      expect(agentABalance).to.be.greaterThan(0);
      // Treasury gets at least 1 ETH (may get remainder from chain too)
      expect(treasuryBalance).to.be.greaterThan(0);
    });

    it("should emit RevenueDistributed event", async function () {
      await expect(
        revenueRouter
          .connect(nonAgent)
          .distributeRevenue(agentA.address, "bounty", { value: ETH_AMOUNT })
      )
        .to.emit(revenueRouter, "RevenueDistributed")
        .withArgs(
          0, // eventId
          agentA.address,
          "bounty",
          ETH_AMOUNT,
          true, // isEth
          ethers.parseEther("5"), // ownerAmount (50%)
          ethers.parseEther("4"), // receiptChainAmount (40%)
          ethers.parseEther("1"), // treasuryAmount (10%)
          (v: any) => v > 0 // timestamp
        );
    });

    it("should credit agent ETH balance for owner portion", async function () {
      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentA.address, "bounty", { value: ETH_AMOUNT });

      // agentA is deployed but has no spawn parent, so the receipt chain
      // portion (4 ETH) has no parent to walk to -> goes to treasury as remainder.
      // agentA gets ownerAmount = 5 ETH only.
      // Actually: agentA was deployed via deployAgent (not spawn), so getSpawnParent(agentA) = 0x0
      // Receipt chain: no parent found, remainder goes to treasury
      const agentAEth = await revenueRouter.getClaimableEthBalance(
        agentA.address
      );
      expect(agentAEth).to.equal(ethers.parseEther("5"));
    });

    it("should credit treasury for treasury portion", async function () {
      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentA.address, "bounty", { value: ETH_AMOUNT });

      // Treasury gets: treasuryAmount (1 ETH) + chain remainder (4 ETH, since agentA has no spawn parent)
      const treasuryEth = await revenueRouter.getClaimableEthBalance(
        treasurySigner.address
      );
      expect(treasuryEth).to.equal(ethers.parseEther("5"));
    });

    it("should send receipt chain portion to bundle contributors when agent has spawn parent", async function () {
      // agentC was spawned from agentA, so getSpawnParent(agentC) = agentA
      // Distribute revenue for agentC
      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentC.address, "service", { value: ETH_AMOUNT });

      // Default shares: 50% owner, 40% chain, 10% treasury
      // ownerAmount = 5 ETH -> credited to agentC
      // chainAmount = 4 ETH -> walk spawn tree
      // treasuryAmount = 1 ETH -> treasury

      // Gen 0: parent = agentA. thisGenAmount = 4 * 5000/10000 = 2 ETH
      // Distributed to bundle 0 contributors: A(60%)=1.2, B(40%)=0.8
      // Gen 1: parent of agentA = 0x0 -> stop. Remaining = 4 - 2 = 2 ETH -> treasury

      const agentCEth = await revenueRouter.getClaimableEthBalance(
        agentC.address
      );
      expect(agentCEth).to.equal(ethers.parseEther("5"));

      const agentAEth = await revenueRouter.getClaimableEthBalance(
        agentA.address
      );
      // agentA gets 60% of gen0 = 1.2 ETH
      expect(agentAEth).to.equal(ethers.parseEther("1.2"));

      const agentBEth = await revenueRouter.getClaimableEthBalance(
        agentB.address
      );
      // agentB gets 40% of gen0 = 0.8 ETH
      expect(agentBEth).to.equal(ethers.parseEther("0.8"));

      // Treasury: 1 ETH (direct) + 2 ETH (chain remainder) = 3 ETH
      const treasuryEth = await revenueRouter.getClaimableEthBalance(
        treasurySigner.address
      );
      expect(treasuryEth).to.equal(ethers.parseEther("3"));
    });

    it("should increment eventCount after distribution", async function () {
      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentA.address, "bounty", { value: ETH_AMOUNT });

      expect(await revenueRouter.getEventCount()).to.equal(1);
    });

    it("should revert with ZeroAmount when sending 0 ETH and no token set", async function () {
      await expect(
        revenueRouter
          .connect(nonAgent)
          .distributeRevenue(agentA.address, "bounty", { value: 0 })
      ).to.be.revertedWithCustomError(revenueRouter, "ZeroAmount");
    });
  });

  // ============================================================
  //            REVENUE DISTRIBUTION — TOKEN MODE
  // ============================================================

  describe("Revenue distribution — Token mode", function () {
    const TOKEN_AMOUNT = ethers.parseEther("100");

    beforeEach(async function () {
      // Enable token mode
      await revenueRouter
        .connect(owner)
        .setPaymentToken(await mockToken.getAddress());
    });

    it("should distribute tokens via distributeRevenueToken", async function () {
      await fundAndApproveRouter(nonAgent, TOKEN_AMOUNT);

      await revenueRouter
        .connect(nonAgent)
        .distributeRevenueToken(agentA.address, "service", TOKEN_AMOUNT);

      // ownerAmount = 100 * 5000/10000 = 50 tokens
      const agentABalance = await revenueRouter.getClaimableBalance(
        agentA.address
      );
      expect(agentABalance).to.equal(ethers.parseEther("50"));
    });

    it("should split tokens correctly (50% owner, 40% chain, 10% treasury)", async function () {
      // Distribute for agentC (has spawn parent agentA)
      await fundAndApproveRouter(nonAgent, TOKEN_AMOUNT);

      await revenueRouter
        .connect(nonAgent)
        .distributeRevenueToken(agentC.address, "service", TOKEN_AMOUNT);

      // ownerAmount = 50 tokens -> agentC
      const agentCBalance = await revenueRouter.getClaimableBalance(
        agentC.address
      );
      expect(agentCBalance).to.equal(ethers.parseEther("50"));

      // chainAmount = 40 tokens. Gen 0: 40*5000/10000 = 20 tokens
      // A gets 60% of 20 = 12, B gets 40% of 20 = 8
      const agentABalance = await revenueRouter.getClaimableBalance(
        agentA.address
      );
      expect(agentABalance).to.equal(ethers.parseEther("12"));

      const agentBBalance = await revenueRouter.getClaimableBalance(
        agentB.address
      );
      expect(agentBBalance).to.equal(ethers.parseEther("8"));

      // Treasury: 10 (direct) + 20 (chain remainder) = 30
      const treasuryBalance = await revenueRouter.getClaimableBalance(
        treasurySigner.address
      );
      expect(treasuryBalance).to.equal(ethers.parseEther("30"));
    });

    it("should credit token balances (not ETH balances) in token mode", async function () {
      await fundAndApproveRouter(nonAgent, TOKEN_AMOUNT);

      await revenueRouter
        .connect(nonAgent)
        .distributeRevenueToken(agentA.address, "service", TOKEN_AMOUNT);

      // Token balance should be set
      expect(
        await revenueRouter.getClaimableBalance(agentA.address)
      ).to.be.greaterThan(0);

      // ETH balance should remain 0
      expect(
        await revenueRouter.getClaimableEthBalance(agentA.address)
      ).to.equal(0);
    });

    it("should emit RevenueDistributed event in token mode", async function () {
      await fundAndApproveRouter(nonAgent, TOKEN_AMOUNT);

      await expect(
        revenueRouter
          .connect(nonAgent)
          .distributeRevenueToken(agentA.address, "service", TOKEN_AMOUNT)
      )
        .to.emit(revenueRouter, "RevenueDistributed")
        .withArgs(
          0,
          agentA.address,
          "service",
          TOKEN_AMOUNT,
          false, // isEth
          ethers.parseEther("50"),
          ethers.parseEther("40"),
          ethers.parseEther("10"),
          (v: any) => v > 0
        );
    });

    it("should revert distributeRevenueToken with amount=0", async function () {
      await expect(
        revenueRouter
          .connect(nonAgent)
          .distributeRevenueToken(agentA.address, "service", 0)
      ).to.be.revertedWithCustomError(revenueRouter, "ZeroAmount");
    });

    it("should revert distributeRevenueToken when no payment token set", async function () {
      // Reset payment token to address(0)
      await revenueRouter
        .connect(owner)
        .setPaymentToken(ethers.ZeroAddress);

      await expect(
        revenueRouter
          .connect(nonAgent)
          .distributeRevenueToken(
            agentA.address,
            "service",
            TOKEN_AMOUNT
          )
      ).to.be.revertedWithCustomError(revenueRouter, "ZeroAmount");
    });
  });

  // ============================================================
  //                   GENERATION DECAY
  // ============================================================

  describe("Generation decay", function () {
    const ETH_AMOUNT = ethers.parseEther("100");

    it("should credit gen 0 contributors for 1-gen chain", async function () {
      // agentC has parent agentA (1-gen chain)
      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentC.address, "bounty", { value: ETH_AMOUNT });

      // chainAmount = 40 ETH. Gen 0: 40*5000/10000 = 20 ETH to bundle contributors
      // A(60%) = 12, B(40%) = 8
      // Remaining = 20 ETH -> treasury
      const agentAEth = await revenueRouter.getClaimableEthBalance(
        agentA.address
      );
      expect(agentAEth).to.equal(ethers.parseEther("12"));

      const agentBEth = await revenueRouter.getClaimableEthBalance(
        agentB.address
      );
      expect(agentBEth).to.equal(ethers.parseEther("8"));
    });

    it("should apply decay across 2-gen chain (spawn D from C, C from A)", async function () {
      // Spawn D from C to create a 2-gen chain: D -> C -> A
      await agentFactory
        .connect(agentC)
        .spawnAgent(0, agentD.address, SOUL_CID_2, 0);

      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentD.address, "bounty", { value: ETH_AMOUNT });

      // Default: ownerBps=5000, chainBps=4000, treasuryBps=1000, decayFactorBps=5000
      // ownerAmount = 50 ETH -> agentD
      // chainAmount = 40 ETH
      // treasuryAmount = 10 ETH

      // Gen 0: parent of D = C. thisGenAmount = 40 * 5000/10000 = 20 ETH
      //   -> bundle contributors: A(60%)=12, B(40%)=8
      //   remaining = 20

      // Gen 1: parent of C = A. thisGenAmount = 20 * 5000/10000 = 10 ETH
      //   -> bundle contributors: A(60%)=6, B(40%)=4
      //   remaining = 10

      // Gen 2: parent of A = 0x0 -> stop. Remaining 10 -> treasury

      const agentDEth = await revenueRouter.getClaimableEthBalance(
        agentD.address
      );
      expect(agentDEth).to.equal(ethers.parseEther("50"));

      const agentAEth = await revenueRouter.getClaimableEthBalance(
        agentA.address
      );
      // A gets 12 (gen0) + 6 (gen1) = 18
      expect(agentAEth).to.equal(ethers.parseEther("18"));

      const agentBEth = await revenueRouter.getClaimableEthBalance(
        agentB.address
      );
      // B gets 8 (gen0) + 4 (gen1) = 12
      expect(agentBEth).to.equal(ethers.parseEther("12"));

      // Treasury: 10 (direct) + 10 (chain remainder) = 20
      const treasuryEth = await revenueRouter.getClaimableEthBalance(
        treasurySigner.address
      );
      expect(treasuryEth).to.equal(ethers.parseEther("20"));
    });

    it("should truncate chain at maxDepth", async function () {
      // Set maxDepth to 1 so only gen 0 is processed
      await revenueRouter.connect(owner).setMaxChainDepth(1);

      // Spawn D from C: chain D -> C -> A, but only 1 gen will be processed
      await agentFactory
        .connect(agentC)
        .spawnAgent(0, agentD.address, SOUL_CID_2, 0);

      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentD.address, "bounty", { value: ETH_AMOUNT });

      // chainAmount = 40 ETH
      // Gen 0: parent of D = C. 40 * 5000/10000 = 20 ETH to contributors
      // maxDepth=1 so gen 1 is skipped. Remaining = 20 -> treasury

      const agentAEth = await revenueRouter.getClaimableEthBalance(
        agentA.address
      );
      // Only gen0: A gets 60% of 20 = 12
      expect(agentAEth).to.equal(ethers.parseEther("12"));

      const agentBEth = await revenueRouter.getClaimableEthBalance(
        agentB.address
      );
      // Only gen0: B gets 40% of 20 = 8
      expect(agentBEth).to.equal(ethers.parseEther("8"));

      // Treasury: 10 (direct) + 20 (chain remainder) = 30
      const treasuryEth = await revenueRouter.getClaimableEthBalance(
        treasurySigner.address
      );
      expect(treasuryEth).to.equal(ethers.parseEther("30"));
    });

    it("should handle different decay factors", async function () {
      // Set decay to 80% (8000 bps)
      await revenueRouter.connect(owner).setDecayFactor(8000);

      // agentC has parent agentA (1-gen chain)
      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentC.address, "bounty", { value: ETH_AMOUNT });

      // chainAmount = 40 ETH
      // Gen 0: 40 * 8000/10000 = 32 ETH to contributors
      // A(60%) = 19.2, B(40%) = 12.8
      // Remaining = 8 -> treasury

      const agentAEth = await revenueRouter.getClaimableEthBalance(
        agentA.address
      );
      expect(agentAEth).to.equal(ethers.parseEther("19.2"));

      const agentBEth = await revenueRouter.getClaimableEthBalance(
        agentB.address
      );
      expect(agentBEth).to.equal(ethers.parseEther("12.8"));

      // Treasury: 10 + 8 = 18
      const treasuryEth = await revenueRouter.getClaimableEthBalance(
        treasurySigner.address
      );
      expect(treasuryEth).to.equal(ethers.parseEther("18"));
    });

    it("should send all chain remainder to treasury with zero decay", async function () {
      // Set decay to 0% — no revenue flows through chain
      await revenueRouter.connect(owner).setDecayFactor(0);

      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentC.address, "bounty", { value: ETH_AMOUNT });

      // chainAmount = 40 ETH, Gen 0: 40 * 0/10000 = 0 -> all 40 to treasury
      const agentAEth = await revenueRouter.getClaimableEthBalance(
        agentA.address
      );
      expect(agentAEth).to.equal(0);

      // Treasury: 10 + 40 = 50
      const treasuryEth = await revenueRouter.getClaimableEthBalance(
        treasurySigner.address
      );
      expect(treasuryEth).to.equal(ethers.parseEther("50"));
    });
  });

  // ============================================================
  //                      CLAIM PATTERN
  // ============================================================

  describe("Claim pattern", function () {
    it("claimEth should transfer ETH and zero the balance", async function () {
      // Generate claimable ETH for agentA
      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentA.address, "bounty", {
          value: ethers.parseEther("10"),
        });

      const claimable = await revenueRouter.getClaimableEthBalance(
        agentA.address
      );
      expect(claimable).to.be.greaterThan(0);

      const balanceBefore = await ethers.provider.getBalance(agentA.address);

      const tx = await revenueRouter.connect(agentA).claimEth();
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

      const balanceAfter = await ethers.provider.getBalance(agentA.address);
      expect(balanceAfter).to.equal(balanceBefore + claimable - gasUsed);

      // Balance should be zeroed
      expect(
        await revenueRouter.getClaimableEthBalance(agentA.address)
      ).to.equal(0);
    });

    it("claimEth should emit EarningsClaimed event", async function () {
      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentA.address, "bounty", {
          value: ethers.parseEther("10"),
        });

      const claimable = await revenueRouter.getClaimableEthBalance(
        agentA.address
      );

      await expect(revenueRouter.connect(agentA).claimEth())
        .to.emit(revenueRouter, "EarningsClaimed")
        .withArgs(agentA.address, claimable, true);
    });

    it("claim should transfer tokens and zero the balance", async function () {
      await revenueRouter
        .connect(owner)
        .setPaymentToken(await mockToken.getAddress());

      const amount = ethers.parseEther("100");
      await fundAndApproveRouter(nonAgent, amount);
      await revenueRouter
        .connect(nonAgent)
        .distributeRevenueToken(agentA.address, "service", amount);

      const claimable = await revenueRouter.getClaimableBalance(
        agentA.address
      );
      expect(claimable).to.be.greaterThan(0);

      const tokenBefore = await mockToken.balanceOf(agentA.address);
      await revenueRouter.connect(agentA).claim();
      const tokenAfter = await mockToken.balanceOf(agentA.address);

      expect(tokenAfter - tokenBefore).to.equal(claimable);
      expect(
        await revenueRouter.getClaimableBalance(agentA.address)
      ).to.equal(0);
    });

    it("claim should emit EarningsClaimed event for tokens", async function () {
      await revenueRouter
        .connect(owner)
        .setPaymentToken(await mockToken.getAddress());

      const amount = ethers.parseEther("100");
      await fundAndApproveRouter(nonAgent, amount);
      await revenueRouter
        .connect(nonAgent)
        .distributeRevenueToken(agentA.address, "service", amount);

      const claimable = await revenueRouter.getClaimableBalance(
        agentA.address
      );

      await expect(revenueRouter.connect(agentA).claim())
        .to.emit(revenueRouter, "EarningsClaimed")
        .withArgs(agentA.address, claimable, false);
    });

    it("should revert claimEth with NothingToClaim if balance is zero", async function () {
      await expect(
        revenueRouter.connect(agentA).claimEth()
      ).to.be.revertedWithCustomError(revenueRouter, "NothingToClaim");
    });

    it("should revert claim with NothingToClaim if token balance is zero", async function () {
      await expect(
        revenueRouter.connect(agentA).claim()
      ).to.be.revertedWithCustomError(revenueRouter, "NothingToClaim");
    });

    it("should not allow re-claim after claiming ETH", async function () {
      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentA.address, "bounty", {
          value: ethers.parseEther("10"),
        });

      await revenueRouter.connect(agentA).claimEth();

      // Second claim should revert
      await expect(
        revenueRouter.connect(agentA).claimEth()
      ).to.be.revertedWithCustomError(revenueRouter, "NothingToClaim");
    });

    it("should not allow re-claim after claiming tokens", async function () {
      await revenueRouter
        .connect(owner)
        .setPaymentToken(await mockToken.getAddress());

      const amount = ethers.parseEther("100");
      await fundAndApproveRouter(nonAgent, amount);
      await revenueRouter
        .connect(nonAgent)
        .distributeRevenueToken(agentA.address, "service", amount);

      await revenueRouter.connect(agentA).claim();

      await expect(
        revenueRouter.connect(agentA).claim()
      ).to.be.revertedWithCustomError(revenueRouter, "NothingToClaim");
    });
  });

  // ============================================================
  //                      VIEW FUNCTIONS
  // ============================================================

  describe("View functions", function () {
    const ETH_AMOUNT = ethers.parseEther("10");

    beforeEach(async function () {
      // Create a revenue event for agentC
      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentC.address, "bounty", { value: ETH_AMOUNT });
    });

    it("getClaimableBalance should return 0 for ETH-only distribution", async function () {
      expect(
        await revenueRouter.getClaimableBalance(agentC.address)
      ).to.equal(0);
    });

    it("getClaimableEthBalance should return credited ETH", async function () {
      expect(
        await revenueRouter.getClaimableEthBalance(agentC.address)
      ).to.equal(ethers.parseEther("5"));
    });

    it("getRevenueHistory should return event IDs for an agent", async function () {
      const history = await revenueRouter.getRevenueHistory(agentC.address);
      expect(history.length).to.equal(1);
      expect(history[0]).to.equal(0);
    });

    it("getRevenueHistory should return multiple event IDs", async function () {
      // Second distribution
      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentC.address, "service", { value: ETH_AMOUNT });

      const history = await revenueRouter.getRevenueHistory(agentC.address);
      expect(history.length).to.equal(2);
      expect(history[0]).to.equal(0);
      expect(history[1]).to.equal(1);
    });

    it("getRevenueEvent should return correct data", async function () {
      const event = await revenueRouter.getRevenueEvent(0);
      expect(event.agent).to.equal(agentC.address);
      expect(event.source).to.equal("bounty");
      expect(event.amount).to.equal(ETH_AMOUNT);
      expect(event.isEth).to.be.true;
      expect(event.ownerAmount).to.equal(ethers.parseEther("5"));
      expect(event.receiptChainAmount).to.equal(ethers.parseEther("4"));
      expect(event.treasuryAmount).to.equal(ethers.parseEther("1"));
      expect(event.timestamp).to.be.greaterThan(0);
    });

    it("getReceiptChain should walk the spawn tree", async function () {
      // agentC -> agentA (1 level)
      const chain = await revenueRouter.getReceiptChain(agentC.address);
      expect(chain.length).to.equal(1);
      expect(chain[0]).to.equal(agentA.address);
    });

    it("getReceiptChain should return multi-level chain", async function () {
      // Spawn D from C: D -> C -> A
      await agentFactory
        .connect(agentC)
        .spawnAgent(0, agentD.address, SOUL_CID_2, 0);

      const chain = await revenueRouter.getReceiptChain(agentD.address);
      expect(chain.length).to.equal(2);
      expect(chain[0]).to.equal(agentC.address);
      expect(chain[1]).to.equal(agentA.address);
    });

    it("getReceiptChain should return empty for agent with no parent", async function () {
      const chain = await revenueRouter.getReceiptChain(agentA.address);
      expect(chain.length).to.equal(0);
    });

    it("getTotalDistributed should track cumulative distribution", async function () {
      expect(await revenueRouter.getTotalDistributed()).to.equal(ETH_AMOUNT);

      // Distribute again
      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentA.address, "service", { value: ETH_AMOUNT });

      expect(await revenueRouter.getTotalDistributed()).to.equal(
        ETH_AMOUNT * 2n
      );
    });

    it("getAgentTotalDistributed should track per-agent distribution", async function () {
      expect(
        await revenueRouter.getAgentTotalDistributed(agentC.address)
      ).to.equal(ETH_AMOUNT);

      expect(
        await revenueRouter.getAgentTotalDistributed(agentA.address)
      ).to.equal(0);
    });

    it("getAddressTotalClaimed should track per-address claims", async function () {
      // Before claim
      expect(
        await revenueRouter.getAddressTotalClaimed(agentC.address)
      ).to.equal(0);

      // Claim
      await revenueRouter.connect(agentC).claimEth();

      expect(
        await revenueRouter.getAddressTotalClaimed(agentC.address)
      ).to.equal(ethers.parseEther("5"));
    });

    it("getTotalClaimed should track cumulative claims", async function () {
      expect(await revenueRouter.getTotalClaimed()).to.equal(0);

      await revenueRouter.connect(agentC).claimEth();

      expect(await revenueRouter.getTotalClaimed()).to.equal(
        ethers.parseEther("5")
      );
    });

    it("getEventCount should return number of revenue events", async function () {
      expect(await revenueRouter.getEventCount()).to.equal(1);
    });
  });

  // ============================================================
  //                     ADMIN FUNCTIONS
  // ============================================================

  describe("Admin functions", function () {
    it("setDefaultShares should update defaults when sum = 10000", async function () {
      await revenueRouter.connect(owner).setDefaultShares(6000, 3000, 1000);

      expect(await revenueRouter.defaultOwnerBps()).to.equal(6000);
      expect(await revenueRouter.defaultReceiptChainBps()).to.equal(3000);
      expect(await revenueRouter.defaultTreasuryBps()).to.equal(1000);
    });

    it("setDefaultShares should revert when sum != 10000", async function () {
      await expect(
        revenueRouter.connect(owner).setDefaultShares(5000, 3000, 1000)
      ).to.be.revertedWithCustomError(revenueRouter, "InvalidShares");
    });

    it("setDecayFactor should update the decay factor", async function () {
      await revenueRouter.connect(owner).setDecayFactor(7500);
      expect(await revenueRouter.decayFactorBps()).to.equal(7500);
    });

    it("setMaxChainDepth should update max depth", async function () {
      await revenueRouter.connect(owner).setMaxChainDepth(10);
      expect(await revenueRouter.maxChainDepth()).to.equal(10);
    });

    it("setTreasury should update treasury address", async function () {
      const newTreasury = ethers.Wallet.createRandom().address;
      await revenueRouter.connect(owner).setTreasury(newTreasury);
      expect(await revenueRouter.treasury()).to.equal(newTreasury);
    });

    it("setTreasury should revert on zero address", async function () {
      await expect(
        revenueRouter.connect(owner).setTreasury(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(revenueRouter, "ZeroAddress");
    });

    it("setPaymentToken should update the token address", async function () {
      const tokenAddr = await mockToken.getAddress();
      await revenueRouter.connect(owner).setPaymentToken(tokenAddr);
      expect(await revenueRouter.paymentToken()).to.equal(tokenAddr);
    });

    it("setPaymentToken should allow setting to zero address (disable token mode)", async function () {
      await revenueRouter
        .connect(owner)
        .setPaymentToken(await mockToken.getAddress());
      await revenueRouter
        .connect(owner)
        .setPaymentToken(ethers.ZeroAddress);
      expect(await revenueRouter.paymentToken()).to.equal(ethers.ZeroAddress);
    });

    it("setAgentFactory should update the factory address", async function () {
      const newFactory = ethers.Wallet.createRandom().address;
      await revenueRouter.connect(owner).setAgentFactory(newFactory);
      expect(await revenueRouter.agentFactory()).to.equal(newFactory);
    });

    it("setAgentFactory should revert on zero address", async function () {
      await expect(
        revenueRouter.connect(owner).setAgentFactory(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(revenueRouter, "ZeroAddress");
    });

    it("pause should pause the contract", async function () {
      await revenueRouter.connect(owner).pause();
      expect(await revenueRouter.paused()).to.be.true;
    });

    it("unpause should unpause the contract", async function () {
      await revenueRouter.connect(owner).pause();
      await revenueRouter.connect(owner).unpause();
      expect(await revenueRouter.paused()).to.be.false;
    });

    it("paused contract should reject distributeRevenue", async function () {
      await revenueRouter.connect(owner).pause();

      await expect(
        revenueRouter
          .connect(nonAgent)
          .distributeRevenue(agentA.address, "bounty", {
            value: ethers.parseEther("1"),
          })
      ).to.be.revertedWithCustomError(revenueRouter, "EnforcedPause");
    });

    it("paused contract should reject setShareConfig", async function () {
      await revenueRouter.connect(owner).pause();

      await expect(
        revenueRouter
          .connect(agentA)
          .setShareConfig(agentA.address, 5000, 4000, 1000, 0)
      ).to.be.revertedWithCustomError(revenueRouter, "EnforcedPause");
    });

    it("only owner can call setDefaultShares", async function () {
      await expect(
        revenueRouter.connect(agentA).setDefaultShares(6000, 3000, 1000)
      ).to.be.revertedWithCustomError(
        revenueRouter,
        "OwnableUnauthorizedAccount"
      );
    });

    it("only owner can call setDecayFactor", async function () {
      await expect(
        revenueRouter.connect(agentA).setDecayFactor(7500)
      ).to.be.revertedWithCustomError(
        revenueRouter,
        "OwnableUnauthorizedAccount"
      );
    });

    it("only owner can call setMaxChainDepth", async function () {
      await expect(
        revenueRouter.connect(agentA).setMaxChainDepth(10)
      ).to.be.revertedWithCustomError(
        revenueRouter,
        "OwnableUnauthorizedAccount"
      );
    });

    it("only owner can call setTreasury", async function () {
      await expect(
        revenueRouter.connect(agentA).setTreasury(agentA.address)
      ).to.be.revertedWithCustomError(
        revenueRouter,
        "OwnableUnauthorizedAccount"
      );
    });

    it("only owner can call setPaymentToken", async function () {
      await expect(
        revenueRouter
          .connect(agentA)
          .setPaymentToken(await mockToken.getAddress())
      ).to.be.revertedWithCustomError(
        revenueRouter,
        "OwnableUnauthorizedAccount"
      );
    });

    it("only owner can call setAgentFactory", async function () {
      await expect(
        revenueRouter.connect(agentA).setAgentFactory(agentA.address)
      ).to.be.revertedWithCustomError(
        revenueRouter,
        "OwnableUnauthorizedAccount"
      );
    });

    it("only owner can call pause", async function () {
      await expect(
        revenueRouter.connect(agentA).pause()
      ).to.be.revertedWithCustomError(
        revenueRouter,
        "OwnableUnauthorizedAccount"
      );
    });

    it("only owner can call unpause", async function () {
      await revenueRouter.connect(owner).pause();

      await expect(
        revenueRouter.connect(agentA).unpause()
      ).to.be.revertedWithCustomError(
        revenueRouter,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  // ============================================================
  //                       EDGE CASES
  // ============================================================

  describe("Edge cases", function () {
    it("should revert ZeroAmount when sending 0 ETH with no token", async function () {
      await expect(
        revenueRouter
          .connect(nonAgent)
          .distributeRevenue(agentA.address, "bounty", { value: 0 })
      ).to.be.revertedWithCustomError(revenueRouter, "ZeroAmount");
    });

    it("should accumulate balances across multiple distributions", async function () {
      const amount1 = ethers.parseEther("10");
      const amount2 = ethers.parseEther("20");

      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentA.address, "bounty1", { value: amount1 });
      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentA.address, "bounty2", { value: amount2 });

      // agentA has no spawn parent, so owner portion goes to agentA
      // ownerAmount1 = 5, ownerAmount2 = 10
      const agentAEth = await revenueRouter.getClaimableEthBalance(
        agentA.address
      );
      expect(agentAEth).to.equal(ethers.parseEther("15"));
    });

    it("should handle distribution for agent not spawned (no receipt chain)", async function () {
      // agentA was deployed via deployAgent, not spawn -> no parent
      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentA.address, "bounty", {
          value: ethers.parseEther("10"),
        });

      // Owner: 5 ETH -> agentA
      const agentAEth = await revenueRouter.getClaimableEthBalance(
        agentA.address
      );
      expect(agentAEth).to.equal(ethers.parseEther("5"));

      // Chain 4 ETH has no parent -> all goes to treasury as remainder
      // Treasury: 1 ETH (direct) + 4 ETH (chain remainder) = 5 ETH
      const treasuryEth = await revenueRouter.getClaimableEthBalance(
        treasurySigner.address
      );
      expect(treasuryEth).to.equal(ethers.parseEther("5"));
    });

    it("should handle concurrent distributions to same agent", async function () {
      const amount = ethers.parseEther("10");

      // Two distributions back to back
      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentC.address, "bounty1", { value: amount });
      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentC.address, "bounty2", { value: amount });

      // agentC ownerAmount per distribution = 5 ETH, total = 10 ETH
      const agentCEth = await revenueRouter.getClaimableEthBalance(
        agentC.address
      );
      expect(agentCEth).to.equal(ethers.parseEther("10"));

      // Events should be tracked separately
      const history = await revenueRouter.getRevenueHistory(agentC.address);
      expect(history.length).to.equal(2);
      expect(history[0]).to.equal(0);
      expect(history[1]).to.equal(1);

      expect(await revenueRouter.getEventCount()).to.equal(2);
    });

    it("should use custom share config when set", async function () {
      // Set agentC's config: 80% owner, 10% chain, 10% treasury
      await revenueRouter
        .connect(agentC)
        .setShareConfig(agentC.address, 8000, 1000, 1000, 0);

      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentC.address, "bounty", {
          value: ethers.parseEther("100"),
        });

      // ownerAmount = 100 * 8000/10000 = 80 ETH -> agentC
      const agentCEth = await revenueRouter.getClaimableEthBalance(
        agentC.address
      );
      expect(agentCEth).to.equal(ethers.parseEther("80"));

      // chainAmount = 100 * 1000/10000 = 10 ETH
      // Gen 0: parent = agentA, 10 * 5000/10000 = 5 ETH to contributors
      // Remaining = 5 -> treasury

      // treasuryAmount = 100 - 80 - 10 = 10 ETH (direct) + 5 (chain remainder) = 15
      const treasuryEth = await revenueRouter.getClaimableEthBalance(
        treasurySigner.address
      );
      expect(treasuryEth).to.equal(ethers.parseEther("15"));
    });

    it("should report the trusted forwarder (ERC-2771)", async function () {
      expect(
        await revenueRouter.isTrustedForwarder(await forwarder.getAddress())
      ).to.be.true;
    });

    it("should not report random address as trusted forwarder", async function () {
      expect(
        await revenueRouter.isTrustedForwarder(
          ethers.Wallet.createRandom().address
        )
      ).to.be.false;
    });

    it("should handle distribution with very small amount (1 wei)", async function () {
      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentC.address, "dust", { value: 1n });

      // 1 * 5000/10000 = 0 ownerAmount
      // 1 * 4000/10000 = 0 chainAmount
      // treasuryAmount = 1 - 0 - 0 = 1
      const treasuryEth = await revenueRouter.getClaimableEthBalance(
        treasurySigner.address
      );
      expect(treasuryEth).to.equal(1);

      expect(await revenueRouter.getTotalDistributed()).to.equal(1);
    });

    it("should handle distribution with large amount", async function () {
      const largeAmount = ethers.parseEther("1000");

      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentC.address, "mega-bounty", {
          value: largeAmount,
        });

      const agentCEth = await revenueRouter.getClaimableEthBalance(
        agentC.address
      );
      expect(agentCEth).to.equal(ethers.parseEther("500"));

      expect(await revenueRouter.getTotalDistributed()).to.equal(largeAmount);
    });

    it("should allow reads when paused", async function () {
      // Generate some state first
      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentC.address, "bounty", {
          value: ethers.parseEther("10"),
        });

      await revenueRouter.connect(owner).pause();

      // All reads should still work
      expect(await revenueRouter.getEventCount()).to.equal(1);
      expect(
        await revenueRouter.getClaimableEthBalance(agentC.address)
      ).to.equal(ethers.parseEther("5"));
      expect(await revenueRouter.getTotalDistributed()).to.equal(
        ethers.parseEther("10")
      );

      const event = await revenueRouter.getRevenueEvent(0);
      expect(event.agent).to.equal(agentC.address);

      const chain = await revenueRouter.getReceiptChain(agentC.address);
      expect(chain.length).to.equal(1);

      const config = await revenueRouter.getShareConfig(agentC.address);
      expect(config.isSet).to.be.false;
    });

    it("should emit ContributorCredited events during chain distribution", async function () {
      // agentC has parent agentA, bundle 0 has contributors A(60%) and B(40%)
      const tx = revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentC.address, "bounty", {
          value: ethers.parseEther("100"),
        });

      // Gen 0: chainAmount=40, gen0Amount=20
      // A gets 60% of 20 = 12, B gets 40% of 20 = 8
      await expect(tx)
        .to.emit(revenueRouter, "ContributorCredited")
        .withArgs(0, agentA.address, ethers.parseEther("12"), 0);
      await expect(tx)
        .to.emit(revenueRouter, "ContributorCredited")
        .withArgs(0, agentB.address, ethers.parseEther("8"), 0);
    });

    it("should handle maxChainDepth=0 (no chain distribution)", async function () {
      await revenueRouter.connect(owner).setMaxChainDepth(0);

      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentC.address, "bounty", {
          value: ethers.parseEther("100"),
        });

      // chainAmount = 40 ETH but maxDepth=0, so no gens processed
      // All 40 ETH goes to treasury as remainder

      const agentAEth = await revenueRouter.getClaimableEthBalance(
        agentA.address
      );
      expect(agentAEth).to.equal(0);

      // Treasury: 10 (direct) + 40 (chain remainder) = 50
      const treasuryEth = await revenueRouter.getClaimableEthBalance(
        treasurySigner.address
      );
      expect(treasuryEth).to.equal(ethers.parseEther("50"));
    });

    it("should handle receipt chain with 100% decay (all to gen 0)", async function () {
      await revenueRouter.connect(owner).setDecayFactor(10000);

      // Spawn D from C: chain D -> C -> A
      await agentFactory
        .connect(agentC)
        .spawnAgent(0, agentD.address, SOUL_CID_2, 0);

      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentD.address, "bounty", {
          value: ethers.parseEther("100"),
        });

      // chainAmount = 40 ETH
      // Gen 0: 40 * 10000/10000 = 40 ETH. Remaining = 0 after gen 0.
      // A(60%) = 24, B(40%) = 16

      const agentAEth = await revenueRouter.getClaimableEthBalance(
        agentA.address
      );
      expect(agentAEth).to.equal(ethers.parseEther("24"));

      const agentBEth = await revenueRouter.getClaimableEthBalance(
        agentB.address
      );
      expect(agentBEth).to.equal(ethers.parseEther("16"));

      // Treasury: 10 (direct) + 0 (no remainder) = 10
      const treasuryEth = await revenueRouter.getClaimableEthBalance(
        treasurySigner.address
      );
      expect(treasuryEth).to.equal(ethers.parseEther("10"));
    });

    it("should track totalDistributed correctly across ETH and token distributions", async function () {
      // ETH distribution
      await revenueRouter
        .connect(nonAgent)
        .distributeRevenue(agentA.address, "bounty", {
          value: ethers.parseEther("10"),
        });

      // Token distribution
      await revenueRouter
        .connect(owner)
        .setPaymentToken(await mockToken.getAddress());
      await fundAndApproveRouter(nonAgent, ethers.parseEther("20"));
      await revenueRouter
        .connect(nonAgent)
        .distributeRevenueToken(agentA.address, "service", ethers.parseEther("20"));

      expect(await revenueRouter.getTotalDistributed()).to.equal(
        ethers.parseEther("30")
      );
      expect(
        await revenueRouter.getAgentTotalDistributed(agentA.address)
      ).to.equal(ethers.parseEther("30"));
    });
  });
});
