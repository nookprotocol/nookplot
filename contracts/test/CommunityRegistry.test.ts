import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { AgentRegistry, CommunityRegistry, MockERC20, NookplotForwarder } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("CommunityRegistry", function () {
  let registry: AgentRegistry;
  let communityRegistry: CommunityRegistry;
  let forwarder: NookplotForwarder;
  let token: MockERC20;
  let owner: SignerWithAddress;
  let treasury: SignerWithAddress;
  let agentA: SignerWithAddress;
  let agentB: SignerWithAddress;
  let agentC: SignerWithAddress;
  let nonAgent: SignerWithAddress;

  const DID_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const META_CID = "QmCommunityMetadataCidForTesting12345678901234";
  const META_CID_2 = "QmUpdatedCommunityMetadataCid678901234567890123";
  const SLUG = "ai-philosophy";
  const SLUG_2 = "code-review";

  beforeEach(async function () {
    [owner, treasury, agentA, agentB, agentC, nonAgent] = await ethers.getSigners();

    // Deploy NookplotForwarder first
    const ForwarderFactory = await ethers.getContractFactory("NookplotForwarder");
    forwarder = (await ForwarderFactory.deploy()) as unknown as NookplotForwarder;
    await forwarder.waitForDeployment();
    const forwarderAddress = await forwarder.getAddress();

    // Deploy AgentRegistry
    const RegistryFactory = await ethers.getContractFactory("AgentRegistry");
    registry = (await upgrades.deployProxy(
      RegistryFactory,
      [owner.address, treasury.address],
      {
        kind: "uups",
        constructorArgs: [forwarderAddress],
        unsafeAllow: ["constructor", "state-variable-immutable"],
      }
    )) as unknown as AgentRegistry;
    await registry.waitForDeployment();

    // Deploy CommunityRegistry
    const CommunityFactory = await ethers.getContractFactory("CommunityRegistry");
    communityRegistry = (await upgrades.deployProxy(
      CommunityFactory,
      [owner.address, await registry.getAddress(), treasury.address],
      {
        kind: "uups",
        constructorArgs: [forwarderAddress],
        unsafeAllow: ["constructor", "state-variable-immutable"],
      }
    )) as unknown as CommunityRegistry;
    await communityRegistry.waitForDeployment();

    // Register agents A, B, C
    await registry.connect(agentA).register(DID_CID);
    await registry.connect(agentB).register(DID_CID);
    await registry.connect(agentC).register(DID_CID);
  });

  // ============================================================
  //                     INITIALIZATION
  // ============================================================

  describe("Initialization", function () {
    it("should set the owner correctly", async function () {
      expect(await communityRegistry.owner()).to.equal(owner.address);
    });

    it("should set the agentRegistry correctly", async function () {
      expect(await communityRegistry.agentRegistry()).to.equal(await registry.getAddress());
    });

    it("should set the treasury correctly", async function () {
      expect(await communityRegistry.treasury()).to.equal(treasury.address);
    });

    it("should start with zero communities", async function () {
      expect(await communityRegistry.totalCommunities()).to.equal(0);
    });

    it("should start in free mode", async function () {
      expect(await communityRegistry.paymentToken()).to.equal(ethers.ZeroAddress);
    });

    it("should start with zero creation fee", async function () {
      expect(await communityRegistry.creationFee()).to.equal(0);
    });

    it("should not be paused initially", async function () {
      expect(await communityRegistry.paused()).to.be.false;
    });

    it("should revert if initialized with zero owner", async function () {
      const Factory = await ethers.getContractFactory("CommunityRegistry");
      await expect(
        upgrades.deployProxy(Factory, [ethers.ZeroAddress, await registry.getAddress(), treasury.address], {
          kind: "uups",
          constructorArgs: [await forwarder.getAddress()],
          unsafeAllow: ["constructor", "state-variable-immutable"],
        })
      ).to.be.revertedWithCustomError(communityRegistry, "ZeroAddress");
    });

    it("should revert if initialized with zero agentRegistry", async function () {
      const Factory = await ethers.getContractFactory("CommunityRegistry");
      await expect(
        upgrades.deployProxy(Factory, [owner.address, ethers.ZeroAddress, treasury.address], {
          kind: "uups",
          constructorArgs: [await forwarder.getAddress()],
          unsafeAllow: ["constructor", "state-variable-immutable"],
        })
      ).to.be.revertedWithCustomError(communityRegistry, "ZeroAddress");
    });

    it("should revert if initialized with zero treasury", async function () {
      const Factory = await ethers.getContractFactory("CommunityRegistry");
      await expect(
        upgrades.deployProxy(Factory, [owner.address, await registry.getAddress(), ethers.ZeroAddress], {
          kind: "uups",
          constructorArgs: [await forwarder.getAddress()],
          unsafeAllow: ["constructor", "state-variable-immutable"],
        })
      ).to.be.revertedWithCustomError(communityRegistry, "ZeroAddress");
    });
  });

  // ============================================================
  //                   COMMUNITY CREATION
  // ============================================================

  describe("Community Creation", function () {
    it("should create a community successfully", async function () {
      const tx = await communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 0);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      await expect(tx)
        .to.emit(communityRegistry, "CommunityCreated");
    });

    it("should emit ModeratorAdded for creator", async function () {
      await expect(communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 0))
        .to.emit(communityRegistry, "ModeratorAdded");
    });

    it("should store community data correctly", async function () {
      await communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 0);
      const info = await communityRegistry.getCommunity(SLUG);
      expect(info.creator).to.equal(agentA.address);
      expect(info.metadataCid).to.equal(META_CID);
      expect(info.postingPolicy).to.equal(0);
      expect(info.isActive).to.be.true;
      expect(info.moderatorCount).to.equal(1);
    });

    it("should increment totalCommunities", async function () {
      await communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 0);
      expect(await communityRegistry.totalCommunities()).to.equal(1);

      await communityRegistry.connect(agentB).createCommunity(SLUG_2, META_CID, 0);
      expect(await communityRegistry.totalCommunities()).to.equal(2);
    });

    it("should set creator as moderator", async function () {
      await communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 0);
      expect(await communityRegistry.isModerator(SLUG, agentA.address)).to.be.true;
    });

    it("should create with registered-only policy", async function () {
      await communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 1);
      const info = await communityRegistry.getCommunity(SLUG);
      expect(info.postingPolicy).to.equal(1);
    });

    it("should create with approved-only policy", async function () {
      await communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 2);
      const info = await communityRegistry.getCommunity(SLUG);
      expect(info.postingPolicy).to.equal(2);
    });

    it("should revert with duplicate slug", async function () {
      await communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 0);
      await expect(
        communityRegistry.connect(agentB).createCommunity(SLUG, META_CID, 0)
      ).to.be.revertedWithCustomError(communityRegistry, "CommunityAlreadyExists");
    });

    it("should revert with empty metadata CID", async function () {
      await expect(
        communityRegistry.connect(agentA).createCommunity(SLUG, "", 0)
      ).to.be.revertedWithCustomError(communityRegistry, "EmptyString");
    });

    it("should revert with invalid posting policy", async function () {
      await expect(
        communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 3)
      ).to.be.revertedWithCustomError(communityRegistry, "InvalidPostingPolicy");
    });

    it("should revert when caller is not a registered agent", async function () {
      await expect(
        communityRegistry.connect(nonAgent).createCommunity(SLUG, META_CID, 0)
      ).to.be.revertedWithCustomError(communityRegistry, "NotRegisteredAgent");
    });

    it("should revert when paused", async function () {
      await communityRegistry.connect(owner).pause();
      await expect(
        communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 0)
      ).to.be.revertedWithCustomError(communityRegistry, "EnforcedPause");
    });
  });

  // ============================================================
  //                    SLUG VALIDATION
  // ============================================================

  describe("Slug Validation", function () {
    it("should accept valid slugs", async function () {
      await communityRegistry.connect(agentA).createCommunity("my-community", META_CID, 0);
      expect(await communityRegistry.communityExists("my-community")).to.be.true;
    });

    it("should accept slugs with numbers", async function () {
      await communityRegistry.connect(agentA).createCommunity("AI-2025", META_CID, 0);
      expect(await communityRegistry.communityExists("AI-2025")).to.be.true;
    });

    it("should accept single character slugs", async function () {
      await communityRegistry.connect(agentA).createCommunity("x", META_CID, 0);
      expect(await communityRegistry.communityExists("x")).to.be.true;
    });

    it("should reject empty slug", async function () {
      await expect(
        communityRegistry.connect(agentA).createCommunity("", META_CID, 0)
      ).to.be.revertedWithCustomError(communityRegistry, "InvalidSlug");
    });

    it("should reject slug with spaces", async function () {
      await expect(
        communityRegistry.connect(agentA).createCommunity("my community", META_CID, 0)
      ).to.be.revertedWithCustomError(communityRegistry, "InvalidSlug");
    });

    it("should reject slug with underscores", async function () {
      await expect(
        communityRegistry.connect(agentA).createCommunity("my_community", META_CID, 0)
      ).to.be.revertedWithCustomError(communityRegistry, "InvalidSlug");
    });

    it("should reject slug with special characters", async function () {
      await expect(
        communityRegistry.connect(agentA).createCommunity("my@community!", META_CID, 0)
      ).to.be.revertedWithCustomError(communityRegistry, "InvalidSlug");
    });

    it("should reject slug exceeding max length", async function () {
      const longSlug = "a".repeat(101);
      await expect(
        communityRegistry.connect(agentA).createCommunity(longSlug, META_CID, 0)
      ).to.be.revertedWithCustomError(communityRegistry, "InvalidSlug");
    });

    it("should accept slug at max length", async function () {
      const maxSlug = "a".repeat(100);
      await communityRegistry.connect(agentA).createCommunity(maxSlug, META_CID, 0);
      expect(await communityRegistry.communityExists(maxSlug)).to.be.true;
    });
  });

  // ============================================================
  //                    METADATA UPDATES
  // ============================================================

  describe("Metadata Updates", function () {
    beforeEach(async function () {
      await communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 0);
    });

    it("should update metadata by creator", async function () {
      await expect(communityRegistry.connect(agentA).updateMetadata(SLUG, META_CID_2))
        .to.emit(communityRegistry, "CommunityMetadataUpdated");

      const info = await communityRegistry.getCommunity(SLUG);
      expect(info.metadataCid).to.equal(META_CID_2);
    });

    it("should update metadata by moderator", async function () {
      await communityRegistry.connect(agentA).addModerator(SLUG, agentB.address);
      await communityRegistry.connect(agentB).updateMetadata(SLUG, META_CID_2);

      const info = await communityRegistry.getCommunity(SLUG);
      expect(info.metadataCid).to.equal(META_CID_2);
    });

    it("should update the updatedAt timestamp", async function () {
      const before = (await communityRegistry.getCommunity(SLUG)).updatedAt;
      await communityRegistry.connect(agentA).updateMetadata(SLUG, META_CID_2);
      const after = (await communityRegistry.getCommunity(SLUG)).updatedAt;
      expect(after).to.be.gte(before);
    });

    it("should revert update by non-moderator", async function () {
      await expect(
        communityRegistry.connect(agentB).updateMetadata(SLUG, META_CID_2)
      ).to.be.revertedWithCustomError(communityRegistry, "NotModerator");
    });

    it("should revert with empty metadata CID", async function () {
      await expect(
        communityRegistry.connect(agentA).updateMetadata(SLUG, "")
      ).to.be.revertedWithCustomError(communityRegistry, "EmptyString");
    });

    it("should revert for non-existing community", async function () {
      await expect(
        communityRegistry.connect(agentA).updateMetadata("nonexistent", META_CID_2)
      ).to.be.revertedWithCustomError(communityRegistry, "CommunityNotFound");
    });

    it("should revert for deactivated community", async function () {
      await communityRegistry.connect(agentA).deactivateCommunity(SLUG);
      await expect(
        communityRegistry.connect(agentA).updateMetadata(SLUG, META_CID_2)
      ).to.be.revertedWithCustomError(communityRegistry, "CommunityNotActive");
    });
  });

  // ============================================================
  //                   POSTING POLICY
  // ============================================================

  describe("Posting Policy", function () {
    beforeEach(async function () {
      await communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 0);
    });

    it("should change posting policy", async function () {
      await expect(communityRegistry.connect(agentA).setPostingPolicy(SLUG, 2))
        .to.emit(communityRegistry, "CommunityPostingPolicyChanged");

      const info = await communityRegistry.getCommunity(SLUG);
      expect(info.postingPolicy).to.equal(2);
    });

    it("should emit old and new policy values", async function () {
      await expect(communityRegistry.connect(agentA).setPostingPolicy(SLUG, 1))
        .to.emit(communityRegistry, "CommunityPostingPolicyChanged");
    });

    it("should only allow creator to change policy", async function () {
      await communityRegistry.connect(agentA).addModerator(SLUG, agentB.address);
      await expect(
        communityRegistry.connect(agentB).setPostingPolicy(SLUG, 1)
      ).to.be.revertedWithCustomError(communityRegistry, "NotCreator");
    });

    it("should revert with invalid policy value", async function () {
      await expect(
        communityRegistry.connect(agentA).setPostingPolicy(SLUG, 3)
      ).to.be.revertedWithCustomError(communityRegistry, "InvalidPostingPolicy");
    });
  });

  // ============================================================
  //                 MODERATOR MANAGEMENT
  // ============================================================

  describe("Moderator Management", function () {
    beforeEach(async function () {
      await communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 0);
    });

    it("should add a moderator", async function () {
      await expect(communityRegistry.connect(agentA).addModerator(SLUG, agentB.address))
        .to.emit(communityRegistry, "ModeratorAdded");

      expect(await communityRegistry.isModerator(SLUG, agentB.address)).to.be.true;
    });

    it("should increment moderator count", async function () {
      await communityRegistry.connect(agentA).addModerator(SLUG, agentB.address);
      const info = await communityRegistry.getCommunity(SLUG);
      expect(info.moderatorCount).to.equal(2);
    });

    it("should remove a moderator", async function () {
      await communityRegistry.connect(agentA).addModerator(SLUG, agentB.address);
      await expect(communityRegistry.connect(agentA).removeModerator(SLUG, agentB.address))
        .to.emit(communityRegistry, "ModeratorRemoved");

      expect(await communityRegistry.isModerator(SLUG, agentB.address)).to.be.false;
    });

    it("should decrement moderator count on removal", async function () {
      await communityRegistry.connect(agentA).addModerator(SLUG, agentB.address);
      await communityRegistry.connect(agentA).removeModerator(SLUG, agentB.address);
      const info = await communityRegistry.getCommunity(SLUG);
      expect(info.moderatorCount).to.equal(1);
    });

    it("should revert adding moderator by non-creator", async function () {
      await communityRegistry.connect(agentA).addModerator(SLUG, agentB.address);
      await expect(
        communityRegistry.connect(agentB).addModerator(SLUG, agentC.address)
      ).to.be.revertedWithCustomError(communityRegistry, "NotCreator");
    });

    it("should revert adding already-existing moderator", async function () {
      await communityRegistry.connect(agentA).addModerator(SLUG, agentB.address);
      await expect(
        communityRegistry.connect(agentA).addModerator(SLUG, agentB.address)
      ).to.be.revertedWithCustomError(communityRegistry, "AlreadyModerator");
    });

    it("should revert removing non-moderator", async function () {
      await expect(
        communityRegistry.connect(agentA).removeModerator(SLUG, agentB.address)
      ).to.be.revertedWithCustomError(communityRegistry, "NotAModerator");
    });

    it("should revert creator removing themselves", async function () {
      await expect(
        communityRegistry.connect(agentA).removeModerator(SLUG, agentA.address)
      ).to.be.revertedWithCustomError(communityRegistry, "CannotRemoveSelf");
    });

    it("should revert adding moderator with zero address", async function () {
      await expect(
        communityRegistry.connect(agentA).addModerator(SLUG, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(communityRegistry, "ZeroAddress");
    });

    it("should revert adding non-registered agent as moderator", async function () {
      await expect(
        communityRegistry.connect(agentA).addModerator(SLUG, nonAgent.address)
      ).to.be.revertedWithCustomError(communityRegistry, "NotRegisteredAgent");
    });

    it("should enforce max moderator cap", async function () {
      // Register 19 more agents and add as moderators (agent A is already mod #1)
      const signers = await ethers.getSigners();
      for (let i = 6; i < 25; i++) {
        await registry.connect(signers[i]).register(DID_CID);
        await communityRegistry.connect(agentA).addModerator(SLUG, signers[i].address);
      }
      // Now at 20 moderators (agentA + 19 new). Adding one more should fail.
      const extra = signers[25];
      await registry.connect(extra).register(DID_CID);
      await expect(
        communityRegistry.connect(agentA).addModerator(SLUG, extra.address)
      ).to.be.revertedWithCustomError(communityRegistry, "TooManyModerators");
    });
  });

  // ============================================================
  //                    POSTER APPROVAL
  // ============================================================

  describe("Poster Approval", function () {
    beforeEach(async function () {
      await communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 2); // approved-only
    });

    it("should approve a poster by creator", async function () {
      await expect(communityRegistry.connect(agentA).approvePoster(SLUG, agentB.address))
        .to.emit(communityRegistry, "PosterApproved");

      expect(await communityRegistry.isApprovedPoster(SLUG, agentB.address)).to.be.true;
    });

    it("should approve a poster by moderator", async function () {
      await communityRegistry.connect(agentA).addModerator(SLUG, agentB.address);
      await communityRegistry.connect(agentB).approvePoster(SLUG, agentC.address);
      expect(await communityRegistry.isApprovedPoster(SLUG, agentC.address)).to.be.true;
    });

    it("should revoke a poster", async function () {
      await communityRegistry.connect(agentA).approvePoster(SLUG, agentB.address);
      await expect(communityRegistry.connect(agentA).revokePoster(SLUG, agentB.address))
        .to.emit(communityRegistry, "PosterRevoked");

      expect(await communityRegistry.isApprovedPoster(SLUG, agentB.address)).to.be.false;
    });

    it("should revert approving already approved poster", async function () {
      await communityRegistry.connect(agentA).approvePoster(SLUG, agentB.address);
      await expect(
        communityRegistry.connect(agentA).approvePoster(SLUG, agentB.address)
      ).to.be.revertedWithCustomError(communityRegistry, "AlreadyApproved");
    });

    it("should revert revoking non-approved poster", async function () {
      await expect(
        communityRegistry.connect(agentA).revokePoster(SLUG, agentB.address)
      ).to.be.revertedWithCustomError(communityRegistry, "NotApproved");
    });

    it("should revert approval by non-moderator", async function () {
      await expect(
        communityRegistry.connect(agentB).approvePoster(SLUG, agentC.address)
      ).to.be.revertedWithCustomError(communityRegistry, "NotModerator");
    });

    it("should revert approving zero address", async function () {
      await expect(
        communityRegistry.connect(agentA).approvePoster(SLUG, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(communityRegistry, "ZeroAddress");
    });
  });

  // ============================================================
  //                     canPost LOGIC
  // ============================================================

  describe("canPost Logic", function () {
    it("should allow any registered agent for open communities", async function () {
      await communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 0);
      expect(await communityRegistry.canPost(SLUG, agentB.address)).to.be.true;
    });

    it("should allow any registered agent for registered-only communities", async function () {
      await communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 1);
      expect(await communityRegistry.canPost(SLUG, agentB.address)).to.be.true;
    });

    it("should deny non-approved agent for approved-only communities", async function () {
      await communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 2);
      expect(await communityRegistry.canPost(SLUG, agentB.address)).to.be.false;
    });

    it("should allow approved agent for approved-only communities", async function () {
      await communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 2);
      await communityRegistry.connect(agentA).approvePoster(SLUG, agentB.address);
      expect(await communityRegistry.canPost(SLUG, agentB.address)).to.be.true;
    });

    it("should allow moderator to post in approved-only communities", async function () {
      await communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 2);
      await communityRegistry.connect(agentA).addModerator(SLUG, agentB.address);
      expect(await communityRegistry.canPost(SLUG, agentB.address)).to.be.true;
    });

    it("should allow creator to post in approved-only communities", async function () {
      await communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 2);
      expect(await communityRegistry.canPost(SLUG, agentA.address)).to.be.true;
    });

    it("should return false for non-existent community", async function () {
      expect(await communityRegistry.canPost("nonexistent", agentA.address)).to.be.false;
    });

    it("should return false for deactivated community", async function () {
      await communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 0);
      await communityRegistry.connect(agentA).deactivateCommunity(SLUG);
      expect(await communityRegistry.canPost(SLUG, agentB.address)).to.be.false;
    });
  });

  // ============================================================
  //                   DEACTIVATION / REACTIVATION
  // ============================================================

  describe("Deactivation / Reactivation", function () {
    beforeEach(async function () {
      await communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 0);
    });

    it("should deactivate a community by creator", async function () {
      await expect(communityRegistry.connect(agentA).deactivateCommunity(SLUG))
        .to.emit(communityRegistry, "CommunityDeactivated");

      expect(await communityRegistry.isCommunityActive(SLUG)).to.be.false;
    });

    it("should revert deactivation by non-creator", async function () {
      await expect(
        communityRegistry.connect(agentB).deactivateCommunity(SLUG)
      ).to.be.revertedWithCustomError(communityRegistry, "NotCreator");
    });

    it("should force-deactivate by admin", async function () {
      await expect(communityRegistry.connect(owner).forceDeactivate(SLUG))
        .to.emit(communityRegistry, "CommunityDeactivated");

      expect(await communityRegistry.isCommunityActive(SLUG)).to.be.false;
    });

    it("should force-reactivate by admin", async function () {
      await communityRegistry.connect(agentA).deactivateCommunity(SLUG);
      await expect(communityRegistry.connect(owner).forceReactivate(SLUG))
        .to.emit(communityRegistry, "CommunityReactivated");

      expect(await communityRegistry.isCommunityActive(SLUG)).to.be.true;
    });

    it("should revert force-deactivate by non-admin", async function () {
      await expect(
        communityRegistry.connect(agentA).forceDeactivate(SLUG)
      ).to.be.revertedWithCustomError(communityRegistry, "OwnableUnauthorizedAccount");
    });

    it("should revert force-reactivate by non-admin", async function () {
      await expect(
        communityRegistry.connect(agentA).forceReactivate(SLUG)
      ).to.be.revertedWithCustomError(communityRegistry, "OwnableUnauthorizedAccount");
    });

    it("should revert deactivating non-existent community", async function () {
      await expect(
        communityRegistry.connect(agentA).deactivateCommunity("nonexistent")
      ).to.be.revertedWithCustomError(communityRegistry, "CommunityNotFound");
    });
  });

  // ============================================================
  //                  OWNERSHIP TRANSFER
  // ============================================================

  describe("Ownership Transfer", function () {
    beforeEach(async function () {
      await communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 0);
    });

    it("should transfer ownership", async function () {
      await expect(communityRegistry.connect(agentA).transferCommunityOwnership(SLUG, agentB.address))
        .to.emit(communityRegistry, "CommunityOwnershipTransferred");

      const info = await communityRegistry.getCommunity(SLUG);
      expect(info.creator).to.equal(agentB.address);
    });

    it("should add new creator as moderator", async function () {
      await communityRegistry.connect(agentA).transferCommunityOwnership(SLUG, agentB.address);
      expect(await communityRegistry.isModerator(SLUG, agentB.address)).to.be.true;
    });

    it("should not duplicate moderator if already a moderator", async function () {
      await communityRegistry.connect(agentA).addModerator(SLUG, agentB.address);
      const before = (await communityRegistry.getCommunity(SLUG)).moderatorCount;
      await communityRegistry.connect(agentA).transferCommunityOwnership(SLUG, agentB.address);
      const after = (await communityRegistry.getCommunity(SLUG)).moderatorCount;
      expect(after).to.equal(before);
    });

    it("should revert transfer by non-creator", async function () {
      await expect(
        communityRegistry.connect(agentB).transferCommunityOwnership(SLUG, agentC.address)
      ).to.be.revertedWithCustomError(communityRegistry, "NotCreator");
    });

    it("should revert transfer to zero address", async function () {
      await expect(
        communityRegistry.connect(agentA).transferCommunityOwnership(SLUG, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(communityRegistry, "ZeroAddress");
    });

    it("should revert transfer to non-registered agent", async function () {
      await expect(
        communityRegistry.connect(agentA).transferCommunityOwnership(SLUG, nonAgent.address)
      ).to.be.revertedWithCustomError(communityRegistry, "NotRegisteredAgent");
    });
  });

  // ============================================================
  //                      VIEW FUNCTIONS
  // ============================================================

  describe("View Functions", function () {
    it("communityExists returns true for existing community", async function () {
      await communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 0);
      expect(await communityRegistry.communityExists(SLUG)).to.be.true;
    });

    it("communityExists returns false for non-existing community", async function () {
      expect(await communityRegistry.communityExists("nonexistent")).to.be.false;
    });

    it("isCommunityActive returns true for active community", async function () {
      await communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 0);
      expect(await communityRegistry.isCommunityActive(SLUG)).to.be.true;
    });

    it("isCommunityActive returns false for deactivated community", async function () {
      await communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 0);
      await communityRegistry.connect(agentA).deactivateCommunity(SLUG);
      expect(await communityRegistry.isCommunityActive(SLUG)).to.be.false;
    });

    it("isCommunityActive returns false for non-existing community", async function () {
      expect(await communityRegistry.isCommunityActive("nonexistent")).to.be.false;
    });

    it("getCommunity reverts for non-existing community", async function () {
      await expect(
        communityRegistry.getCommunity("nonexistent")
      ).to.be.revertedWithCustomError(communityRegistry, "CommunityNotFound");
    });

    it("isModerator returns false for non-moderator", async function () {
      await communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 0);
      expect(await communityRegistry.isModerator(SLUG, agentB.address)).to.be.false;
    });

    it("isApprovedPoster returns false for non-approved poster", async function () {
      await communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 2);
      expect(await communityRegistry.isApprovedPoster(SLUG, agentB.address)).to.be.false;
    });
  });

  // ============================================================
  //                      TOKEN MODE
  // ============================================================

  describe("Token Mode", function () {
    beforeEach(async function () {
      const TokenFactory = await ethers.getContractFactory("MockERC20");
      token = (await TokenFactory.deploy("NookplotToken", "NOOK")) as unknown as MockERC20;
      await token.waitForDeployment();
    });

    it("should charge creation fee when token is set", async function () {
      const fee = ethers.parseEther("10");
      await communityRegistry.connect(owner).setPaymentToken(await token.getAddress());
      await communityRegistry.connect(owner).setCreationFee(fee);

      // Mint tokens to agentA and approve
      await token.mint(agentA.address, ethers.parseEther("100"));
      await token.connect(agentA).approve(await communityRegistry.getAddress(), fee);

      await communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 0);

      // Treasury should have received the fee
      expect(await token.balanceOf(treasury.address)).to.equal(fee);
    });

    it("should revert creation without token approval", async function () {
      const fee = ethers.parseEther("10");
      await communityRegistry.connect(owner).setPaymentToken(await token.getAddress());
      await communityRegistry.connect(owner).setCreationFee(fee);

      await token.mint(agentA.address, ethers.parseEther("100"));
      // No approval

      await expect(
        communityRegistry.connect(agentA).createCommunity(SLUG, META_CID, 0)
      ).to.be.reverted;
    });
  });

  // ============================================================
  //                    ADMIN FUNCTIONS
  // ============================================================

  describe("Admin Functions", function () {
    it("should set payment token", async function () {
      const TokenFactory = await ethers.getContractFactory("MockERC20");
      const token = await TokenFactory.deploy("NookplotToken", "NOOK");
      await communityRegistry.connect(owner).setPaymentToken(await token.getAddress());
      expect(await communityRegistry.paymentToken()).to.equal(await token.getAddress());
    });

    it("should set creation fee", async function () {
      const fee = ethers.parseEther("5");
      await communityRegistry.connect(owner).setCreationFee(fee);
      expect(await communityRegistry.creationFee()).to.equal(fee);
    });

    it("should set treasury", async function () {
      await communityRegistry.connect(owner).setTreasury(agentA.address);
      expect(await communityRegistry.treasury()).to.equal(agentA.address);
    });

    it("should revert setting zero address for treasury", async function () {
      await expect(
        communityRegistry.connect(owner).setTreasury(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(communityRegistry, "ZeroAddress");
    });

    it("should set agent registry", async function () {
      await communityRegistry.connect(owner).setAgentRegistry(agentA.address);
      expect(await communityRegistry.agentRegistry()).to.equal(agentA.address);
    });

    it("should revert setting zero address for agent registry", async function () {
      await expect(
        communityRegistry.connect(owner).setAgentRegistry(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(communityRegistry, "ZeroAddress");
    });

    it("should pause and unpause", async function () {
      await communityRegistry.connect(owner).pause();
      expect(await communityRegistry.paused()).to.be.true;

      await communityRegistry.connect(owner).unpause();
      expect(await communityRegistry.paused()).to.be.false;
    });

    it("should revert admin calls from non-owner", async function () {
      await expect(
        communityRegistry.connect(agentA).setPaymentToken(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(communityRegistry, "OwnableUnauthorizedAccount");

      await expect(
        communityRegistry.connect(agentA).setCreationFee(0)
      ).to.be.revertedWithCustomError(communityRegistry, "OwnableUnauthorizedAccount");

      await expect(
        communityRegistry.connect(agentA).setTreasury(agentA.address)
      ).to.be.revertedWithCustomError(communityRegistry, "OwnableUnauthorizedAccount");

      await expect(
        communityRegistry.connect(agentA).pause()
      ).to.be.revertedWithCustomError(communityRegistry, "OwnableUnauthorizedAccount");
    });
  });

  // ============================================================
  //              META-TRANSACTIONS (ERC-2771)
  // ============================================================

  describe("Meta-Transactions (ERC-2771)", function () {
    let relayer: SignerWithAddress;

    beforeEach(async function () {
      const signers = await ethers.getSigners();
      // Use a signer not already assigned as a relayer
      relayer = signers[6];
    });

    it("should report the correct trusted forwarder", async function () {
      const forwarderAddress = await forwarder.getAddress();
      expect(await communityRegistry.isTrustedForwarder(forwarderAddress)).to.be.true;
      // A random address should not be trusted
      expect(await communityRegistry.isTrustedForwarder(relayer.address)).to.be.false;
    });

    it("should allow community creation via meta-transaction", async function () {
      const metaSlug = "meta-test";
      const metadataCid = META_CID;

      // agentA is already registered in the outer beforeEach

      // Build the ForwardRequest
      const nonce = await forwarder.nonces(agentA.address);
      const block = await ethers.provider.getBlock("latest");
      const deadline = block!.timestamp + 3600;
      const data = communityRegistry.interface.encodeFunctionData("createCommunity", [metaSlug, metadataCid, 0]);

      const domain = {
        name: "NookplotForwarder",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await forwarder.getAddress(),
      };
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
      const value = {
        from: agentA.address,
        to: await communityRegistry.getAddress(),
        value: 0n,
        gas: 500000n,
        nonce,
        deadline,
        data,
      };
      const signature = await agentA.signTypedData(domain, types, value);

      // Relayer submits the meta-transaction
      await forwarder.connect(relayer).execute({ ...value, signature });

      // Verify community was created with agentA as creator
      expect(await communityRegistry.communityExists(metaSlug)).to.be.true;
      const info = await communityRegistry.getCommunity(metaSlug);
      expect(info.creator).to.equal(agentA.address);
      expect(info.metadataCid).to.equal(metadataCid);
      expect(info.isActive).to.be.true;
      expect(info.moderatorCount).to.equal(1);
      expect(await communityRegistry.isModerator(metaSlug, agentA.address)).to.be.true;
    });

    it("direct calls still work (backward compatibility)", async function () {
      const directSlug = "direct-call";

      await communityRegistry.connect(agentA).createCommunity(directSlug, META_CID, 0);

      expect(await communityRegistry.communityExists(directSlug)).to.be.true;
      const info = await communityRegistry.getCommunity(directSlug);
      expect(info.creator).to.equal(agentA.address);
      expect(info.isActive).to.be.true;
    });
  });
});
