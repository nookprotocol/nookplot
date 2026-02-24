import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import {
  AgentFactory,
  AgentRegistry,
  ContentIndex,
  KnowledgeBundle,
  NookplotForwarder,
  MockERC20,
} from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("AgentFactory", function () {
  let registry: AgentRegistry;
  let contentIndex: ContentIndex;
  let knowledgeBundle: KnowledgeBundle;
  let agentFactory: AgentFactory;
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
  const CID_1 = "QmContent1ForTestingFactory1234567890abcdefgh01";
  const CID_2 = "QmContent2ForTestingFactory1234567890abcdefgh02";
  const CID_3 = "QmContent3ForTestingFactory1234567890abcdefgh03";
  const CID_4 = "QmContent4ForTestingFactory1234567890abcdefgh04";
  const SOUL_CID = "QmSoulDocumentForTestingAgentFactoryContract00001";
  const SOUL_CID_2 = "QmSoulDocumentForTestingAgentFactoryContract00002";
  const COMMUNITY = "general";

  const PROXY_OPTS = {
    kind: "uups" as const,
    unsafeAllow: ["constructor", "state-variable-immutable"] as any[],
  };

  /** Helper: create ContributorWeight tuples for KnowledgeBundle calls */
  function weights(entries: Array<{ addr: string; bps: number }>) {
    return entries.map((e) => ({ contributor: e.addr, weightBps: e.bps }));
  }

  /** Helper: mint tokens, approve factory, then return amount */
  async function fundAndApprove(
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

    // Register agents A, B, C, D in the registry
    await registry.connect(agentA).register(DID_CID);
    await registry.connect(agentB).register(DID_CID);
    await registry.connect(agentC).register(DID_CID);
    await registry.connect(agentD).register(DID_CID);

    // Publish content CIDs so they exist in ContentIndex
    await contentIndex.connect(agentA).publishPost(CID_1, COMMUNITY);
    await contentIndex.connect(agentA).publishPost(CID_2, COMMUNITY);
    await contentIndex.connect(agentB).publishPost(CID_3, COMMUNITY);

    // Create a knowledge bundle (bundleId = 0)
    const contribs = weights([
      { addr: agentA.address, bps: 6000 },
      { addr: agentB.address, bps: 4000 },
    ]);
    await knowledgeBundle
      .connect(agentA)
      .createBundle("Test Bundle", "", [CID_1, CID_2], contribs);
  });

  // ============================================================
  //                     INITIALIZATION
  // ============================================================

  describe("Initialization", function () {
    it("should set the owner correctly", async function () {
      expect(await agentFactory.owner()).to.equal(owner.address);
    });

    it("should set the agentRegistry correctly", async function () {
      expect(await agentFactory.agentRegistry()).to.equal(
        await registry.getAddress()
      );
    });

    it("should set the knowledgeBundleContract correctly", async function () {
      expect(await agentFactory.knowledgeBundleContract()).to.equal(
        await knowledgeBundle.getAddress()
      );
    });

    it("should set the treasury correctly", async function () {
      expect(await agentFactory.treasury()).to.equal(treasurySigner.address);
    });

    it("should set the creditPool correctly", async function () {
      expect(await agentFactory.creditPool()).to.equal(
        creditPoolSigner.address
      );
    });

    it("should not be paused initially", async function () {
      expect(await agentFactory.paused()).to.be.false;
    });

    it("should start with zero deployments", async function () {
      expect(await agentFactory.getDeploymentCount()).to.equal(0);
    });
  });

  // ============================================================
  //                 DEPLOY AGENT — FREE MODE
  // ============================================================

  describe("deployAgent (free mode)", function () {
    it("should deploy an agent with valid data", async function () {
      const tx = await agentFactory
        .connect(agentA)
        .deployAgent(0, agentC.address, SOUL_CID, 0);
      const receipt = await tx.wait();
      expect(receipt).to.not.be.null;

      const deployment = await agentFactory.getDeployment(0);
      expect(deployment.creator).to.equal(agentA.address);
      expect(deployment.agentAddress).to.equal(agentC.address);
      expect(deployment.bundleId).to.equal(0);
      expect(deployment.soulCid).to.equal(SOUL_CID);
      expect(deployment.deploymentFee).to.equal(0);
      expect(deployment.parentAgent).to.equal(ethers.ZeroAddress);
    });

    it("should emit AgentDeployed event", async function () {
      await expect(
        agentFactory
          .connect(agentA)
          .deployAgent(0, agentC.address, SOUL_CID, 0)
      )
        .to.emit(agentFactory, "AgentDeployed")
        .withArgs(
          0,
          agentA.address,
          agentC.address,
          0,
          SOUL_CID,
          0,
          (v: any) => v > 0
        );
    });

    it("should increment deployment ID", async function () {
      await agentFactory
        .connect(agentA)
        .deployAgent(0, agentC.address, SOUL_CID, 0);
      await agentFactory
        .connect(agentA)
        .deployAgent(0, agentD.address, SOUL_CID_2, 0);

      expect(await agentFactory.getDeploymentCount()).to.equal(2);
      const d0 = await agentFactory.getDeployment(0);
      const d1 = await agentFactory.getDeployment(1);
      expect(d0.agentAddress).to.equal(agentC.address);
      expect(d1.agentAddress).to.equal(agentD.address);
    });

    it("should update creator mapping", async function () {
      await agentFactory
        .connect(agentA)
        .deployAgent(0, agentC.address, SOUL_CID, 0);
      const deployments = await agentFactory.getDeploymentsByCreator(
        agentA.address
      );
      expect(deployments.length).to.equal(1);
      expect(deployments[0]).to.equal(0);
    });

    it("should update bundle mapping", async function () {
      await agentFactory
        .connect(agentA)
        .deployAgent(0, agentC.address, SOUL_CID, 0);
      const deployments = await agentFactory.getDeploymentsByBundle(0);
      expect(deployments.length).to.equal(1);
      expect(deployments[0]).to.equal(0);
    });

    it("should revert for non-registered agent address", async function () {
      await expect(
        agentFactory
          .connect(agentA)
          .deployAgent(0, nonAgent.address, SOUL_CID, 0)
      ).to.be.revertedWithCustomError(agentFactory, "NotRegisteredAgent");
    });

    it("should revert for inactive bundle", async function () {
      // Deactivate the bundle
      await knowledgeBundle.connect(agentA).deactivateBundle(0);

      await expect(
        agentFactory
          .connect(agentA)
          .deployAgent(0, agentC.address, SOUL_CID, 0)
      ).to.be.revertedWithCustomError(agentFactory, "BundleNotActive");
    });

    it("should revert for empty soulCid", async function () {
      await expect(
        agentFactory.connect(agentA).deployAgent(0, agentC.address, "", 0)
      ).to.be.revertedWithCustomError(agentFactory, "EmptySoulCid");
    });

    it("should revert for zero agent address", async function () {
      await expect(
        agentFactory
          .connect(agentA)
          .deployAgent(0, ethers.ZeroAddress, SOUL_CID, 0)
      ).to.be.revertedWithCustomError(agentFactory, "ZeroAddress");
    });

    it("should revert if agent already deployed", async function () {
      await agentFactory
        .connect(agentA)
        .deployAgent(0, agentC.address, SOUL_CID, 0);

      await expect(
        agentFactory
          .connect(agentA)
          .deployAgent(0, agentC.address, SOUL_CID_2, 0)
      ).to.be.revertedWithCustomError(agentFactory, "AgentAlreadyDeployed");
    });

    it("should revert when paused", async function () {
      await agentFactory.connect(owner).pause();

      await expect(
        agentFactory
          .connect(agentA)
          .deployAgent(0, agentC.address, SOUL_CID, 0)
      ).to.be.revertedWithCustomError(agentFactory, "EnforcedPause");
    });
  });

  // ============================================================
  //               DEPLOY AGENT — TOKEN MODE
  // ============================================================

  describe("deployAgent (token mode)", function () {
    const DEPLOY_FEE = ethers.parseEther("100");

    beforeEach(async function () {
      // Enable token mode
      await agentFactory
        .connect(owner)
        .setPaymentToken(await mockToken.getAddress());
      // Set fee shares: 5000 contributor, 2000 treasury, 2000 credit, 1000 curator
      await agentFactory
        .connect(owner)
        .setFeeShares(5000, 2000, 2000, 1000);
    });

    it("should transfer fee from deployer and distribute", async function () {
      await fundAndApprove(agentA, DEPLOY_FEE);

      const treasuryBefore = await mockToken.balanceOf(
        treasurySigner.address
      );
      const creditBefore = await mockToken.balanceOf(
        creditPoolSigner.address
      );

      await agentFactory
        .connect(agentA)
        .deployAgent(0, agentC.address, SOUL_CID, DEPLOY_FEE);

      // Treasury should receive 20%
      const treasuryAfter = await mockToken.balanceOf(
        treasurySigner.address
      );
      expect(treasuryAfter - treasuryBefore).to.equal(
        ethers.parseEther("20")
      );

      // Credit pool should receive 20%
      const creditAfter = await mockToken.balanceOf(
        creditPoolSigner.address
      );
      expect(creditAfter - creditBefore).to.equal(ethers.parseEther("20"));
    });

    it("should distribute contributor share by weight", async function () {
      await fundAndApprove(agentA, DEPLOY_FEE);

      const agentABefore = await mockToken.balanceOf(agentA.address);
      const agentBBefore = await mockToken.balanceOf(agentB.address);

      await agentFactory
        .connect(agentA)
        .deployAgent(0, agentC.address, SOUL_CID, DEPLOY_FEE);

      // Contributor share = 50 tokens total. agentA has 6000/10000 = 30, agentB has 4000/10000 = 20
      // agentA is also the bundle creator (curator) so gets curator share = 10 tokens
      const agentAAfter = await mockToken.balanceOf(agentA.address);
      const agentBAfter = await mockToken.balanceOf(agentB.address);

      // agentA paid 100 but got back 30 as contributor + 10 as curator = 40
      expect(agentAAfter - agentABefore + DEPLOY_FEE).to.equal(
        ethers.parseEther("40")
      );
      expect(agentBAfter - agentBBefore).to.equal(ethers.parseEther("20"));
    });

    it("should send curator share to bundle creator", async function () {
      await fundAndApprove(agentB, DEPLOY_FEE);

      // agentA is the bundle creator (curator)
      const agentABefore = await mockToken.balanceOf(agentA.address);

      await agentFactory
        .connect(agentB)
        .deployAgent(0, agentC.address, SOUL_CID, DEPLOY_FEE);

      const agentAAfter = await mockToken.balanceOf(agentA.address);
      // agentA receives contributor share: 50 * 6000/10000 = 30 tokens
      // Plus curator share: 10 tokens (as bundle creator)
      expect(agentAAfter - agentABefore).to.equal(ethers.parseEther("40"));

      // Verify the payout amounts are recorded correctly
      const d = await agentFactory.getDeployment(0);
      expect(d.curatorPayout).to.equal(ethers.parseEther("10"));
    });

    it("should emit FeeDistributed event", async function () {
      await fundAndApprove(agentA, DEPLOY_FEE);

      await expect(
        agentFactory
          .connect(agentA)
          .deployAgent(0, agentC.address, SOUL_CID, DEPLOY_FEE)
      )
        .to.emit(agentFactory, "FeeDistributed")
        .withArgs(
          0,
          ethers.parseEther("50"), // contributor
          ethers.parseEther("20"), // treasury
          ethers.parseEther("20"), // credit
          ethers.parseEther("10") // curator
        );
    });

    it("should emit ContributorPaid events", async function () {
      await fundAndApprove(agentA, DEPLOY_FEE);

      const tx = agentFactory
        .connect(agentA)
        .deployAgent(0, agentC.address, SOUL_CID, DEPLOY_FEE);

      await expect(tx)
        .to.emit(agentFactory, "ContributorPaid")
        .withArgs(0, agentA.address, ethers.parseEther("30"));
      await expect(tx)
        .to.emit(agentFactory, "ContributorPaid")
        .withArgs(0, agentB.address, ethers.parseEther("20"));
    });

    it("should store payout amounts in deployment info", async function () {
      await fundAndApprove(agentA, DEPLOY_FEE);

      await agentFactory
        .connect(agentA)
        .deployAgent(0, agentC.address, SOUL_CID, DEPLOY_FEE);

      const d = await agentFactory.getDeployment(0);
      expect(d.contributorPayout).to.equal(ethers.parseEther("50"));
      expect(d.treasuryPayout).to.equal(ethers.parseEther("20"));
      expect(d.creditPayout).to.equal(ethers.parseEther("20"));
      expect(d.curatorPayout).to.equal(ethers.parseEther("10"));
    });

    it("should revert on insufficient approval", async function () {
      // Mint but don't approve enough
      await mockToken.mint(agentA.address, DEPLOY_FEE);
      await mockToken
        .connect(agentA)
        .approve(await agentFactory.getAddress(), ethers.parseEther("10"));

      await expect(
        agentFactory
          .connect(agentA)
          .deployAgent(0, agentC.address, SOUL_CID, DEPLOY_FEE)
      ).to.be.reverted;
    });

    it("should handle fee=0 in token mode (no transfer)", async function () {
      // No need to fund or approve — fee is 0
      await agentFactory
        .connect(agentA)
        .deployAgent(0, agentC.address, SOUL_CID, 0);

      const d = await agentFactory.getDeployment(0);
      expect(d.deploymentFee).to.equal(0);
      expect(d.contributorPayout).to.equal(0);
      expect(d.treasuryPayout).to.equal(0);
    });

    it("should handle single contributor bundle", async function () {
      // Create a single-contributor bundle (bundleId = 1)
      const singleContribs = weights([{ addr: agentA.address, bps: 10000 }]);
      await knowledgeBundle
        .connect(agentA)
        .createBundle("Solo Bundle", "", [CID_1], singleContribs);

      await fundAndApprove(agentB, DEPLOY_FEE);

      await agentFactory
        .connect(agentB)
        .deployAgent(1, agentC.address, SOUL_CID, DEPLOY_FEE);

      // agentA gets full contributor share (50 tokens) + curator (10 tokens)
      const d = await agentFactory.getDeployment(0);
      expect(d.contributorPayout).to.equal(ethers.parseEther("50"));
    });
  });

  // ============================================================
  //                      SPAWN AGENT
  // ============================================================

  describe("spawnAgent", function () {
    it("should spawn a child agent from a parent", async function () {
      await agentFactory
        .connect(agentA)
        .spawnAgent(0, agentC.address, SOUL_CID, 0);

      const d = await agentFactory.getDeployment(0);
      expect(d.creator).to.equal(agentA.address);
      expect(d.agentAddress).to.equal(agentC.address);
      expect(d.parentAgent).to.equal(agentA.address);
    });

    it("should emit AgentSpawned event", async function () {
      await expect(
        agentFactory
          .connect(agentA)
          .spawnAgent(0, agentC.address, SOUL_CID, 0)
      )
        .to.emit(agentFactory, "AgentSpawned")
        .withArgs(
          0,
          agentA.address,
          agentC.address,
          0,
          SOUL_CID,
          (v: any) => v > 0
        );
    });

    it("should record parent-child mapping", async function () {
      await agentFactory
        .connect(agentA)
        .spawnAgent(0, agentC.address, SOUL_CID, 0);

      const children = await agentFactory.getSpawnChildren(agentA.address);
      expect(children.length).to.equal(1);
      expect(children[0]).to.equal(agentC.address);

      const parent = await agentFactory.getSpawnParent(agentC.address);
      expect(parent).to.equal(agentA.address);
    });

    it("should handle multi-level spawns (A spawns C, C spawns D)", async function () {
      await agentFactory
        .connect(agentA)
        .spawnAgent(0, agentC.address, SOUL_CID, 0);
      await agentFactory
        .connect(agentC)
        .spawnAgent(0, agentD.address, SOUL_CID_2, 0);

      // A -> C
      const childrenA = await agentFactory.getSpawnChildren(agentA.address);
      expect(childrenA.length).to.equal(1);
      expect(childrenA[0]).to.equal(agentC.address);

      // C -> D
      const childrenC = await agentFactory.getSpawnChildren(agentC.address);
      expect(childrenC.length).to.equal(1);
      expect(childrenC[0]).to.equal(agentD.address);

      // Verify parent chain: D -> C -> A
      expect(await agentFactory.getSpawnParent(agentD.address)).to.equal(
        agentC.address
      );
      expect(await agentFactory.getSpawnParent(agentC.address)).to.equal(
        agentA.address
      );
    });

    it("should handle multiple children from same parent", async function () {
      await agentFactory
        .connect(agentA)
        .spawnAgent(0, agentC.address, SOUL_CID, 0);
      await agentFactory
        .connect(agentA)
        .spawnAgent(0, agentD.address, SOUL_CID_2, 0);

      const children = await agentFactory.getSpawnChildren(agentA.address);
      expect(children.length).to.equal(2);
      expect(children[0]).to.equal(agentC.address);
      expect(children[1]).to.equal(agentD.address);
    });

    it("should distribute fees in spawn with token mode", async function () {
      const SPAWN_FEE = ethers.parseEther("50");
      await agentFactory
        .connect(owner)
        .setPaymentToken(await mockToken.getAddress());
      await agentFactory
        .connect(owner)
        .setFeeShares(5000, 2000, 2000, 1000);

      await fundAndApprove(agentA, SPAWN_FEE);

      await agentFactory
        .connect(agentA)
        .spawnAgent(0, agentC.address, SOUL_CID, SPAWN_FEE);

      const d = await agentFactory.getDeployment(0);
      expect(d.contributorPayout).to.equal(ethers.parseEther("25"));
      expect(d.treasuryPayout).to.equal(ethers.parseEther("10"));
      expect(d.creditPayout).to.equal(ethers.parseEther("10"));
      expect(d.curatorPayout).to.equal(ethers.parseEther("5"));
    });

    it("should revert if parent is not a registered agent", async function () {
      await expect(
        agentFactory
          .connect(nonAgent)
          .spawnAgent(0, agentC.address, SOUL_CID, 0)
      ).to.be.revertedWithCustomError(agentFactory, "NotRegisteredAgent");
    });

    it("should revert if child is not a registered agent", async function () {
      await expect(
        agentFactory
          .connect(agentA)
          .spawnAgent(0, nonAgent.address, SOUL_CID, 0)
      ).to.be.revertedWithCustomError(agentFactory, "NotRegisteredAgent");
    });

    it("should revert for empty soulCid", async function () {
      await expect(
        agentFactory.connect(agentA).spawnAgent(0, agentC.address, "", 0)
      ).to.be.revertedWithCustomError(agentFactory, "EmptySoulCid");
    });

    it("should revert if child already deployed", async function () {
      await agentFactory
        .connect(agentA)
        .spawnAgent(0, agentC.address, SOUL_CID, 0);

      await expect(
        agentFactory
          .connect(agentA)
          .spawnAgent(0, agentC.address, SOUL_CID_2, 0)
      ).to.be.revertedWithCustomError(agentFactory, "AgentAlreadyDeployed");
    });
  });

  // ============================================================
  //                      UPDATE SOUL
  // ============================================================

  describe("updateSoul", function () {
    beforeEach(async function () {
      await agentFactory
        .connect(agentA)
        .deployAgent(0, agentC.address, SOUL_CID, 0);
    });

    it("should update the soul CID", async function () {
      await agentFactory.connect(agentC).updateSoul(0, SOUL_CID_2);

      const d = await agentFactory.getDeployment(0);
      expect(d.soulCid).to.equal(SOUL_CID_2);
    });

    it("should emit SoulUpdated with old and new CIDs", async function () {
      await expect(
        agentFactory.connect(agentC).updateSoul(0, SOUL_CID_2)
      )
        .to.emit(agentFactory, "SoulUpdated")
        .withArgs(0, agentC.address, SOUL_CID, SOUL_CID_2);
    });

    it("should revert if caller is not the deployed agent", async function () {
      await expect(
        agentFactory.connect(agentA).updateSoul(0, SOUL_CID_2)
      ).to.be.revertedWithCustomError(agentFactory, "NotDeployedAgent");
    });

    it("should revert for non-existent deployment", async function () {
      await expect(
        agentFactory.connect(agentC).updateSoul(999, SOUL_CID_2)
      ).to.be.revertedWithCustomError(agentFactory, "DeploymentNotFound");
    });

    it("should revert for empty CID", async function () {
      await expect(
        agentFactory.connect(agentC).updateSoul(0, "")
      ).to.be.revertedWithCustomError(agentFactory, "EmptySoulCid");
    });
  });

  // ============================================================
  //                     VIEW FUNCTIONS
  // ============================================================

  describe("View Functions", function () {
    beforeEach(async function () {
      // Deploy two agents
      await agentFactory
        .connect(agentA)
        .deployAgent(0, agentC.address, SOUL_CID, 0);
      await agentFactory
        .connect(agentB)
        .deployAgent(0, agentD.address, SOUL_CID_2, 0);
    });

    it("getDeployment should return correct data", async function () {
      const d = await agentFactory.getDeployment(0);
      expect(d.creator).to.equal(agentA.address);
      expect(d.agentAddress).to.equal(agentC.address);
      expect(d.bundleId).to.equal(0);
      expect(d.soulCid).to.equal(SOUL_CID);
      expect(d.parentAgent).to.equal(ethers.ZeroAddress);
      expect(d.createdAt).to.be.greaterThan(0);
    });

    it("getDeploymentsByCreator should return all deployments by a creator", async function () {
      const deployments = await agentFactory.getDeploymentsByCreator(
        agentA.address
      );
      expect(deployments.length).to.equal(1);
      expect(deployments[0]).to.equal(0);
    });

    it("getDeploymentsByBundle should return all deployments for a bundle", async function () {
      const deployments = await agentFactory.getDeploymentsByBundle(0);
      expect(deployments.length).to.equal(2);
      expect(deployments[0]).to.equal(0);
      expect(deployments[1]).to.equal(1);
    });

    it("getAgentDeploymentId should return the deployment ID for an agent", async function () {
      expect(
        await agentFactory.getAgentDeploymentId(agentC.address)
      ).to.equal(0);
      expect(
        await agentFactory.getAgentDeploymentId(agentD.address)
      ).to.equal(1);
    });

    it("getSoulCid should return the soul CID for an agent", async function () {
      expect(await agentFactory.getSoulCid(agentC.address)).to.equal(
        SOUL_CID
      );
      expect(await agentFactory.getSoulCid(agentD.address)).to.equal(
        SOUL_CID_2
      );
    });

    it("getDeploymentCount should return correct count", async function () {
      expect(await agentFactory.getDeploymentCount()).to.equal(2);
    });

    it("getDeployment should revert for non-existent ID", async function () {
      await expect(
        agentFactory.getDeployment(999)
      ).to.be.revertedWithCustomError(agentFactory, "DeploymentNotFound");
    });

    it("getSoulCid should revert for undeployed agent", async function () {
      await expect(
        agentFactory.getSoulCid(nonAgent.address)
      ).to.be.revertedWithCustomError(agentFactory, "DeploymentNotFound");
    });
  });

  // ============================================================
  //                    ADMIN FUNCTIONS
  // ============================================================

  describe("Admin Functions", function () {
    it("should set valid fee shares summing to 10000", async function () {
      await agentFactory
        .connect(owner)
        .setFeeShares(5000, 2500, 1500, 1000);

      expect(await agentFactory.contributorShareBps()).to.equal(5000);
      expect(await agentFactory.treasuryShareBps()).to.equal(2500);
      expect(await agentFactory.creditShareBps()).to.equal(1500);
      expect(await agentFactory.curatorShareBps()).to.equal(1000);
    });

    it("should allow all-zero fee shares", async function () {
      await agentFactory.connect(owner).setFeeShares(0, 0, 0, 0);

      expect(await agentFactory.contributorShareBps()).to.equal(0);
      expect(await agentFactory.treasuryShareBps()).to.equal(0);
      expect(await agentFactory.creditShareBps()).to.equal(0);
      expect(await agentFactory.curatorShareBps()).to.equal(0);
    });

    it("should emit FeeSharesUpdated event", async function () {
      await expect(
        agentFactory.connect(owner).setFeeShares(5000, 2000, 2000, 1000)
      )
        .to.emit(agentFactory, "FeeSharesUpdated")
        .withArgs(5000, 2000, 2000, 1000);
    });

    it("should revert for invalid fee shares (sum != 10000 and != 0)", async function () {
      await expect(
        agentFactory.connect(owner).setFeeShares(5000, 2000, 2000, 500)
      ).to.be.revertedWithCustomError(agentFactory, "InvalidFeeShares");
    });

    it("should set payment token", async function () {
      const tokenAddr = await mockToken.getAddress();
      await agentFactory.connect(owner).setPaymentToken(tokenAddr);
      expect(await agentFactory.paymentToken()).to.equal(tokenAddr);
    });

    it("should set treasury", async function () {
      const newTreasury = ethers.Wallet.createRandom().address;
      await agentFactory.connect(owner).setTreasury(newTreasury);
      expect(await agentFactory.treasury()).to.equal(newTreasury);
    });

    it("should revert setTreasury with zero address", async function () {
      await expect(
        agentFactory.connect(owner).setTreasury(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(agentFactory, "ZeroAddress");
    });

    it("should set credit pool", async function () {
      const newPool = ethers.Wallet.createRandom().address;
      await agentFactory.connect(owner).setCreditPool(newPool);
      expect(await agentFactory.creditPool()).to.equal(newPool);
    });

    it("should revert setCreditPool with zero address", async function () {
      await expect(
        agentFactory.connect(owner).setCreditPool(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(agentFactory, "ZeroAddress");
    });

    it("should allow owner to pause and unpause", async function () {
      await agentFactory.connect(owner).pause();
      expect(await agentFactory.paused()).to.be.true;

      await agentFactory.connect(owner).unpause();
      expect(await agentFactory.paused()).to.be.false;
    });

    it("should revert admin calls from non-owner", async function () {
      await expect(
        agentFactory.connect(agentA).setFeeShares(5000, 2000, 2000, 1000)
      ).to.be.revertedWithCustomError(
        agentFactory,
        "OwnableUnauthorizedAccount"
      );

      await expect(
        agentFactory
          .connect(agentA)
          .setPaymentToken(await mockToken.getAddress())
      ).to.be.revertedWithCustomError(
        agentFactory,
        "OwnableUnauthorizedAccount"
      );

      await expect(
        agentFactory.connect(agentA).setTreasury(agentA.address)
      ).to.be.revertedWithCustomError(
        agentFactory,
        "OwnableUnauthorizedAccount"
      );

      await expect(
        agentFactory.connect(agentA).setCreditPool(agentA.address)
      ).to.be.revertedWithCustomError(
        agentFactory,
        "OwnableUnauthorizedAccount"
      );

      await expect(
        agentFactory.connect(agentA).pause()
      ).to.be.revertedWithCustomError(
        agentFactory,
        "OwnableUnauthorizedAccount"
      );

      await expect(
        agentFactory.connect(agentA).unpause()
      ).to.be.revertedWithCustomError(
        agentFactory,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  // ============================================================
  //                      EDGE CASES
  // ============================================================

  describe("Edge Cases", function () {
    it("paused should reject writes but not reads", async function () {
      // Deploy first, then pause
      await agentFactory
        .connect(agentA)
        .deployAgent(0, agentC.address, SOUL_CID, 0);

      await agentFactory.connect(owner).pause();

      // Reads should still work
      const d = await agentFactory.getDeployment(0);
      expect(d.agentAddress).to.equal(agentC.address);
      expect(await agentFactory.getDeploymentCount()).to.equal(1);
      expect(await agentFactory.getSoulCid(agentC.address)).to.equal(
        SOUL_CID
      );

      // Writes should revert
      await expect(
        agentFactory
          .connect(agentB)
          .deployAgent(0, agentD.address, SOUL_CID_2, 0)
      ).to.be.revertedWithCustomError(agentFactory, "EnforcedPause");

      await expect(
        agentFactory
          .connect(agentA)
          .spawnAgent(0, agentD.address, SOUL_CID_2, 0)
      ).to.be.revertedWithCustomError(agentFactory, "EnforcedPause");

      await expect(
        agentFactory.connect(agentC).updateSoul(0, SOUL_CID_2)
      ).to.be.revertedWithCustomError(agentFactory, "EnforcedPause");
    });

    it("should report the trusted forwarder (ERC-2771)", async function () {
      expect(
        await agentFactory.isTrustedForwarder(await forwarder.getAddress())
      ).to.be.true;
    });

    it("should not report random address as trusted forwarder", async function () {
      expect(
        await agentFactory.isTrustedForwarder(
          ethers.Wallet.createRandom().address
        )
      ).to.be.false;
    });

    it("should handle zero fee shares in token mode (all to curator as remainder)", async function () {
      const DEPLOY_FEE = ethers.parseEther("100");
      await agentFactory
        .connect(owner)
        .setPaymentToken(await mockToken.getAddress());
      // All shares zero — curator gets the entire remainder
      await agentFactory.connect(owner).setFeeShares(0, 0, 0, 0);

      await fundAndApprove(agentA, DEPLOY_FEE);

      await agentFactory
        .connect(agentA)
        .deployAgent(0, agentC.address, SOUL_CID, DEPLOY_FEE);

      const d = await agentFactory.getDeployment(0);
      // With all shares at 0, contributor/treasury/credit = 0; curator = remainder = 100
      expect(d.contributorPayout).to.equal(0);
      expect(d.treasuryPayout).to.equal(0);
      expect(d.creditPayout).to.equal(0);
      expect(d.curatorPayout).to.equal(DEPLOY_FEE);
    });

    it("should handle deployAgent with non-existent bundle ID", async function () {
      await expect(
        agentFactory
          .connect(agentA)
          .deployAgent(999, agentC.address, SOUL_CID, 0)
      ).to.be.revertedWithCustomError(agentFactory, "BundleNotActive");
    });
  });

  // ============================================================
  //                      FEE MATH
  // ============================================================

  describe("Fee Math", function () {
    const FEE = ethers.parseEther("1000");

    beforeEach(async function () {
      await agentFactory
        .connect(owner)
        .setPaymentToken(await mockToken.getAddress());
    });

    it("should precisely distribute with 3 contributors (5000/3000/2000)", async function () {
      // Create a 3-contributor bundle (bundleId = 1)
      // CID_3 already published by agentB in beforeEach, use CID_4
      await contentIndex.connect(agentC).publishPost(CID_4, COMMUNITY);
      const contribs = weights([
        { addr: agentA.address, bps: 5000 },
        { addr: agentB.address, bps: 3000 },
        { addr: agentC.address, bps: 2000 },
      ]);
      await knowledgeBundle
        .connect(agentA)
        .createBundle("3-Way Bundle", "", [CID_1], contribs);

      // Set shares: 6000 contributor, 2000 treasury, 1000 credit, 1000 curator
      await agentFactory
        .connect(owner)
        .setFeeShares(6000, 2000, 1000, 1000);

      await fundAndApprove(agentB, FEE);

      const aBefore = await mockToken.balanceOf(agentA.address);
      const bBefore = await mockToken.balanceOf(agentB.address);
      const cBefore = await mockToken.balanceOf(agentC.address);

      await agentFactory
        .connect(agentB)
        .deployAgent(1, agentD.address, SOUL_CID, FEE);

      // Contributor total = 600 tokens
      // agentA: 600 * 5000/10000 = 300
      // agentB: 600 * 3000/10000 = 180
      // agentC: 600 * 2000/10000 = 120
      const aAfter = await mockToken.balanceOf(agentA.address);
      const bAfter = await mockToken.balanceOf(agentB.address);
      const cAfter = await mockToken.balanceOf(agentC.address);

      // agentA receives contributor share (300) + curator share (100) as bundle creator
      expect(aAfter - aBefore).to.equal(ethers.parseEther("400"));
      // agentB paid 1000, got 180 back as contributor
      expect(bAfter - bBefore + FEE).to.equal(ethers.parseEther("180"));
      expect(cAfter - cBefore).to.equal(ethers.parseEther("120"));

      // Verify recorded payout info
      const d = await agentFactory.getDeployment(0);
      expect(d.contributorPayout).to.equal(ethers.parseEther("600"));
      expect(d.treasuryPayout).to.equal(ethers.parseEther("200"));
      expect(d.creditPayout).to.equal(ethers.parseEther("100"));
      expect(d.curatorPayout).to.equal(ethers.parseEther("100"));
    });

    it("should give curator the remainder (dust handling)", async function () {
      // Use a fee that creates rounding: 3333 with shares 3333/3333/3333/1
      // This won't work since must sum to 10000. Use 3334/3333/3333/0 but that sums to 10000.
      // Let's test with a fee of 3 tokens and shares 5000/2000/2000/1000
      const SMALL_FEE = 3n; // 3 wei to maximize rounding effects
      await agentFactory
        .connect(owner)
        .setFeeShares(5000, 2000, 2000, 1000);

      await fundAndApprove(agentA, SMALL_FEE);

      await agentFactory
        .connect(agentA)
        .deployAgent(0, agentC.address, SOUL_CID, SMALL_FEE);

      const d = await agentFactory.getDeployment(0);
      // 3 * 5000/10000 = 1 (floor)
      // 3 * 2000/10000 = 0 (floor)
      // 3 * 2000/10000 = 0 (floor)
      // curator = 3 - 1 - 0 - 0 = 2 (gets the dust)
      expect(d.contributorPayout).to.equal(1);
      expect(d.treasuryPayout).to.equal(0);
      expect(d.creditPayout).to.equal(0);
      expect(d.curatorPayout).to.equal(2);

      // Total distributed must equal the fee
      const total =
        d.contributorPayout +
        d.treasuryPayout +
        d.creditPayout +
        d.curatorPayout;
      expect(total).to.equal(SMALL_FEE);
    });

    it("should handle rounding with odd numbers", async function () {
      const ODD_FEE = ethers.parseEther("33");
      // 7000/1500/1000/500 = 10000
      await agentFactory
        .connect(owner)
        .setFeeShares(7000, 1500, 1000, 500);

      await fundAndApprove(agentA, ODD_FEE);

      await agentFactory
        .connect(agentA)
        .deployAgent(0, agentC.address, SOUL_CID, ODD_FEE);

      const d = await agentFactory.getDeployment(0);
      // 33e18 * 7000/10000 = 23.1e18
      // 33e18 * 1500/10000 = 4.95e18
      // 33e18 * 1000/10000 = 3.3e18
      // curator = 33e18 - 23.1e18 - 4.95e18 - 3.3e18 = 1.65e18
      expect(d.contributorPayout).to.equal(ethers.parseEther("23.1"));
      expect(d.treasuryPayout).to.equal(ethers.parseEther("4.95"));
      expect(d.creditPayout).to.equal(ethers.parseEther("3.3"));
      expect(d.curatorPayout).to.equal(ethers.parseEther("1.65"));

      // Verify total equals fee
      const total =
        d.contributorPayout +
        d.treasuryPayout +
        d.creditPayout +
        d.curatorPayout;
      expect(total).to.equal(ODD_FEE);
    });

    it("should handle maximum split (all to contributors)", async function () {
      await agentFactory
        .connect(owner)
        .setFeeShares(10000, 0, 0, 0);

      await fundAndApprove(agentA, FEE);

      await agentFactory
        .connect(agentA)
        .deployAgent(0, agentC.address, SOUL_CID, FEE);

      const d = await agentFactory.getDeployment(0);
      expect(d.contributorPayout).to.equal(FEE);
      expect(d.treasuryPayout).to.equal(0);
      expect(d.creditPayout).to.equal(0);
      expect(d.curatorPayout).to.equal(0);
    });
  });
});
