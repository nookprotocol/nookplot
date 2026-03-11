import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import {
  GuildRegistry,
  AgentFactory,
  AgentRegistry,
  ContentIndex,
  KnowledgeBundle,
  NookplotForwarder,
  MockERC20,
} from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("GuildRegistry", function () {
  let registry: AgentRegistry;
  let contentIndex: ContentIndex;
  let knowledgeBundle: KnowledgeBundle;
  let agentFactory: AgentFactory;
  let guildRegistry: GuildRegistry;
  let forwarder: NookplotForwarder;
  let mockToken: MockERC20;
  let owner: SignerWithAddress;
  let treasurySigner: SignerWithAddress;
  let creditPoolSigner: SignerWithAddress;
  let agentA: SignerWithAddress;
  let agentB: SignerWithAddress;
  let agentC: SignerWithAddress;
  let agentD: SignerWithAddress;
  let agentE: SignerWithAddress;
  let nonAgent: SignerWithAddress;

  const DID_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const CID_1 = "QmContent1ForTestingGuilds12345678901abcdefgh01";
  const CID_2 = "QmContent2ForTestingGuilds12345678901abcdefgh02";
  const CID_3 = "QmContent3ForTestingGuilds12345678901abcdefgh03";
  const SOUL_CID = "QmSoulDocumentForTestingGuildRegistryContract0001";
  const COMMUNITY = "general";
  const DESC_CID = "QmDescriptionCidForTestingGuildRegistry000000001";

  const PROXY_OPTS = {
    kind: "uups" as const,
    unsafeAllow: ["constructor", "state-variable-immutable"] as any[],
  };

  /** Helper: create ContributorWeight tuples for KnowledgeBundle calls */
  function weights(entries: Array<{ addr: string; bps: number }>) {
    return entries.map((e) => ({ contributor: e.addr, weightBps: e.bps }));
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
      agentE,
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

    // Deploy GuildRegistry
    const GuildRegistryFactory =
      await ethers.getContractFactory("GuildRegistry");
    guildRegistry = (await upgrades.deployProxy(
      GuildRegistryFactory,
      [
        owner.address,
        await registry.getAddress(),
        await agentFactory.getAddress(),
      ],
      { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
    )) as unknown as GuildRegistry;
    await guildRegistry.waitForDeployment();

    // Set guildRegistry on AgentFactory so collectiveSpawn can call deployAgentFor
    await agentFactory.connect(owner).setGuildRegistry(await guildRegistry.getAddress());

    // Register agents A, B, C, D, E in the registry
    await registry.connect(agentA).register(DID_CID);
    await registry.connect(agentB).register(DID_CID);
    await registry.connect(agentC).register(DID_CID);
    await registry.connect(agentD).register(DID_CID);
    await registry.connect(agentE).register(DID_CID);

    // Publish content CIDs so they exist in ContentIndex
    await contentIndex.connect(agentA).publishPost(CID_1, COMMUNITY);
    await contentIndex.connect(agentB).publishPost(CID_2, COMMUNITY);
    await contentIndex.connect(agentC).publishPost(CID_3, COMMUNITY);

    // Create a knowledge bundle (bundleId = 0)
    const contribs = weights([
      { addr: agentA.address, bps: 5000 },
      { addr: agentB.address, bps: 3000 },
      { addr: agentC.address, bps: 2000 },
    ]);
    await knowledgeBundle
      .connect(agentA)
      .createBundle("Test Bundle", "", [CID_1, CID_2, CID_3], contribs);
  });

  // ============================================================
  //                     INITIALIZATION
  // ============================================================

  describe("Initialization", function () {
    it("should set the owner correctly", async function () {
      expect(await guildRegistry.owner()).to.equal(owner.address);
    });

    it("should set the agentRegistry correctly", async function () {
      expect(await guildRegistry.agentRegistry()).to.equal(
        await registry.getAddress()
      );
    });

    it("should set the agentFactory correctly", async function () {
      expect(await guildRegistry.agentFactory()).to.equal(
        await agentFactory.getAddress()
      );
    });

    it("should set default minMembers to 2", async function () {
      expect(await guildRegistry.minMembers()).to.equal(2);
    });

    it("should set default maxMembers to 10", async function () {
      expect(await guildRegistry.maxMembers()).to.equal(10);
    });

    it("should not be paused initially", async function () {
      expect(await guildRegistry.paused()).to.be.false;
    });

    it("should start with zero guilds", async function () {
      expect(await guildRegistry.getGuildCount()).to.equal(0);
    });
  });

  // ============================================================
  //                     PROPOSE GUILD
  // ============================================================

  describe("Propose Guild", function () {
    it("should propose a 2-member guild", async function () {
      const tx = await guildRegistry
        .connect(agentA)
        .proposeGuild("Alpha Guild", DESC_CID, [
          agentA.address,
          agentB.address,
        ]);

      const guild = await guildRegistry.getGuild(0);
      expect(guild.name).to.equal("Alpha Guild");
      expect(guild.descriptionCid).to.equal(DESC_CID);
      expect(guild.proposer).to.equal(agentA.address);
      expect(guild.memberCount).to.equal(2);
      expect(guild.approvedCount).to.equal(1); // proposer auto-approves
      expect(guild.status).to.equal(0); // Proposed
    });

    it("should propose a 3-member guild", async function () {
      await guildRegistry
        .connect(agentA)
        .proposeGuild("Triple Guild", DESC_CID, [
          agentA.address,
          agentB.address,
          agentC.address,
        ]);

      const guild = await guildRegistry.getGuild(0);
      expect(guild.memberCount).to.equal(3);
      expect(guild.approvedCount).to.equal(1);
    });

    it("should emit GuildProposed event", async function () {
      await expect(
        guildRegistry
          .connect(agentA)
          .proposeGuild("Alpha Guild", DESC_CID, [
            agentA.address,
            agentB.address,
          ])
      )
        .to.emit(guildRegistry, "GuildProposed")
        .withArgs(
          0,
          agentA.address,
          "Alpha Guild",
          2,
          (v: any) => v > 0
        );
    });

    it("should auto-approve the proposer", async function () {
      await guildRegistry
        .connect(agentA)
        .proposeGuild("Alpha Guild", DESC_CID, [
          agentA.address,
          agentB.address,
        ]);

      expect(
        await guildRegistry.getMemberStatus(0, agentA.address)
      ).to.equal(2); // Approved
      expect(
        await guildRegistry.getMemberStatus(0, agentB.address)
      ).to.equal(1); // Proposed
    });

    it("should store members correctly", async function () {
      await guildRegistry
        .connect(agentA)
        .proposeGuild("Alpha Guild", DESC_CID, [
          agentA.address,
          agentB.address,
          agentC.address,
        ]);

      const members = await guildRegistry.getMembers(0);
      expect(members).to.have.lengthOf(3);
      expect(members[0]).to.equal(agentA.address);
      expect(members[1]).to.equal(agentB.address);
      expect(members[2]).to.equal(agentC.address);
    });

    it("should update agentGuilds reverse lookup", async function () {
      await guildRegistry
        .connect(agentA)
        .proposeGuild("Alpha Guild", DESC_CID, [
          agentA.address,
          agentB.address,
        ]);

      const aGuilds = await guildRegistry.getAgentGuilds(agentA.address);
      expect(aGuilds).to.have.lengthOf(1);
      expect(aGuilds[0]).to.equal(0);

      const bGuilds = await guildRegistry.getAgentGuilds(agentB.address);
      expect(bGuilds).to.have.lengthOf(1);
      expect(bGuilds[0]).to.equal(0);
    });

    it("should increment guildId", async function () {
      await guildRegistry
        .connect(agentA)
        .proposeGuild("First", DESC_CID, [agentA.address, agentB.address]);
      await guildRegistry
        .connect(agentC)
        .proposeGuild("Second", DESC_CID, [agentC.address, agentD.address]);

      expect(await guildRegistry.getGuildCount()).to.equal(2);
      expect((await guildRegistry.getGuild(0)).name).to.equal("First");
      expect((await guildRegistry.getGuild(1)).name).to.equal("Second");
    });

    it("should revert with empty name", async function () {
      await expect(
        guildRegistry
          .connect(agentA)
          .proposeGuild("", DESC_CID, [agentA.address, agentB.address])
      ).to.be.revertedWithCustomError(guildRegistry, "EmptyName");
    });

    it("should revert with too few members", async function () {
      await expect(
        guildRegistry
          .connect(agentA)
          .proposeGuild("Solo", DESC_CID, [agentA.address])
      ).to.be.revertedWithCustomError(guildRegistry, "TooFewMembers");
    });

    it("should revert if proposer is not in members list", async function () {
      await expect(
        guildRegistry
          .connect(agentA)
          .proposeGuild("No Self", DESC_CID, [agentB.address, agentC.address])
      ).to.be.revertedWithCustomError(guildRegistry, "ProposerMustBeMember");
    });

    it("should revert with duplicate members", async function () {
      await expect(
        guildRegistry
          .connect(agentA)
          .proposeGuild("Dupe", DESC_CID, [agentA.address, agentA.address])
      ).to.be.revertedWithCustomError(guildRegistry, "DuplicateMember");
    });

    it("should revert for non-registered agent in members", async function () {
      await expect(
        guildRegistry
          .connect(agentA)
          .proposeGuild("Bad Member", DESC_CID, [
            agentA.address,
            nonAgent.address,
          ])
      ).to.be.revertedWithCustomError(guildRegistry, "NotRegisteredAgent");
    });

    it("should revert for non-registered proposer", async function () {
      await expect(
        guildRegistry
          .connect(nonAgent)
          .proposeGuild("Unregistered", DESC_CID, [
            nonAgent.address,
            agentA.address,
          ])
      ).to.be.revertedWithCustomError(guildRegistry, "NotRegisteredAgent");
    });
  });

  // ============================================================
  //                   APPROVE MEMBERSHIP
  // ============================================================

  describe("Approve Membership", function () {
    beforeEach(async function () {
      await guildRegistry
        .connect(agentA)
        .proposeGuild("Alpha Guild", DESC_CID, [
          agentA.address,
          agentB.address,
          agentC.address,
        ]);
    });

    it("should approve membership for a proposed member", async function () {
      await guildRegistry.connect(agentB).approveMembership(0);
      expect(
        await guildRegistry.getMemberStatus(0, agentB.address)
      ).to.equal(2); // Approved
    });

    it("should increment approvedCount", async function () {
      await guildRegistry.connect(agentB).approveMembership(0);
      const guild = await guildRegistry.getGuild(0);
      expect(guild.approvedCount).to.equal(2);
    });

    it("should emit MembershipApproved event", async function () {
      await expect(guildRegistry.connect(agentB).approveMembership(0))
        .to.emit(guildRegistry, "MembershipApproved")
        .withArgs(0, agentB.address, (v: any) => v > 0);
    });

    it("should activate guild when all members approve", async function () {
      await guildRegistry.connect(agentB).approveMembership(0);
      await guildRegistry.connect(agentC).approveMembership(0);

      const guild = await guildRegistry.getGuild(0);
      expect(guild.status).to.equal(1); // Active
      expect(guild.activatedAt).to.be.gt(0);
    });

    it("should emit GuildActivated when all approve", async function () {
      await guildRegistry.connect(agentB).approveMembership(0);
      await expect(guildRegistry.connect(agentC).approveMembership(0))
        .to.emit(guildRegistry, "GuildActivated")
        .withArgs(0, (v: any) => v > 0);
    });

    it("should revert if already approved", async function () {
      await guildRegistry.connect(agentB).approveMembership(0);
      await expect(
        guildRegistry.connect(agentB).approveMembership(0)
      ).to.be.revertedWithCustomError(guildRegistry, "AlreadyApproved");
    });

    it("should revert for proposer (auto-approved)", async function () {
      await expect(
        guildRegistry.connect(agentA).approveMembership(0)
      ).to.be.revertedWithCustomError(guildRegistry, "AlreadyApproved");
    });

    it("should revert for non-member", async function () {
      await expect(
        guildRegistry.connect(agentD).approveMembership(0)
      ).to.be.revertedWithCustomError(guildRegistry, "NotGuildMember");
    });

    it("should revert for non-existent guild", async function () {
      await expect(
        guildRegistry.connect(agentB).approveMembership(999)
      ).to.be.revertedWithCustomError(guildRegistry, "GuildNotFound");
    });

    it("should set isGuildMember to true after approval", async function () {
      await guildRegistry.connect(agentB).approveMembership(0);
      expect(await guildRegistry.isGuildMember(0, agentB.address)).to.be
        .true;
    });

    it("should auto-activate a 2-member guild when second approves", async function () {
      // Create a 2-member guild
      await guildRegistry
        .connect(agentD)
        .proposeGuild("Duo", DESC_CID, [agentD.address, agentE.address]);

      // Only one approval needed (proposer auto-approved)
      await expect(guildRegistry.connect(agentE).approveMembership(1))
        .to.emit(guildRegistry, "GuildActivated")
        .withArgs(1, (v: any) => v > 0);

      const guild = await guildRegistry.getGuild(1);
      expect(guild.status).to.equal(1); // Active
    });
  });

  // ============================================================
  //                   REJECT MEMBERSHIP
  // ============================================================

  describe("Reject Membership", function () {
    beforeEach(async function () {
      await guildRegistry
        .connect(agentA)
        .proposeGuild("Alpha Guild", DESC_CID, [
          agentA.address,
          agentB.address,
          agentC.address,
        ]);
    });

    it("should reject membership", async function () {
      await guildRegistry.connect(agentB).rejectMembership(0);
      expect(
        await guildRegistry.getMemberStatus(0, agentB.address)
      ).to.equal(3); // Rejected
    });

    it("should emit MembershipRejected event", async function () {
      await expect(guildRegistry.connect(agentB).rejectMembership(0))
        .to.emit(guildRegistry, "MembershipRejected")
        .withArgs(0, agentB.address, (v: any) => v > 0);
    });

    it("should keep guild in Proposed status after rejection", async function () {
      await guildRegistry.connect(agentB).rejectMembership(0);
      const guild = await guildRegistry.getGuild(0);
      expect(guild.status).to.equal(0); // Still Proposed
    });

    it("should revert for non-member", async function () {
      await expect(
        guildRegistry.connect(agentD).rejectMembership(0)
      ).to.be.revertedWithCustomError(guildRegistry, "NotGuildMember");
    });

    it("should revert if already approved (proposer)", async function () {
      await expect(
        guildRegistry.connect(agentA).rejectMembership(0)
      ).to.be.revertedWithCustomError(guildRegistry, "MemberNotProposed");
    });
  });

  // ============================================================
  //                     LEAVE GUILD
  // ============================================================

  describe("Leave Guild", function () {
    beforeEach(async function () {
      // Create and activate a 3-member guild
      await guildRegistry
        .connect(agentA)
        .proposeGuild("Active Guild", DESC_CID, [
          agentA.address,
          agentB.address,
          agentC.address,
        ]);
      await guildRegistry.connect(agentB).approveMembership(0);
      await guildRegistry.connect(agentC).approveMembership(0);
    });

    it("should allow a member to leave", async function () {
      await guildRegistry.connect(agentC).leaveGuild(0);
      expect(
        await guildRegistry.getMemberStatus(0, agentC.address)
      ).to.equal(4); // Left
    });

    it("should decrement approvedCount", async function () {
      await guildRegistry.connect(agentC).leaveGuild(0);
      const guild = await guildRegistry.getGuild(0);
      expect(guild.approvedCount).to.equal(2);
    });

    it("should emit MemberLeft event", async function () {
      await expect(guildRegistry.connect(agentC).leaveGuild(0))
        .to.emit(guildRegistry, "MemberLeft")
        .withArgs(0, agentC.address, (v: any) => v > 0);
    });

    it("should auto-dissolve if below minMembers", async function () {
      await guildRegistry.connect(agentC).leaveGuild(0);
      await guildRegistry.connect(agentB).leaveGuild(0);
      // Now only 1 approved member — below minMembers (2)
      const guild = await guildRegistry.getGuild(0);
      expect(guild.status).to.equal(2); // Dissolved
    });

    it("should emit GuildDissolved on auto-dissolve", async function () {
      await guildRegistry.connect(agentC).leaveGuild(0);
      await expect(guildRegistry.connect(agentB).leaveGuild(0))
        .to.emit(guildRegistry, "GuildDissolved")
        .withArgs(0, (v: any) => v > 0);
    });

    it("should revert for non-active guild", async function () {
      // Create a proposed guild (not activated)
      await guildRegistry
        .connect(agentD)
        .proposeGuild("Pending", DESC_CID, [agentD.address, agentE.address]);

      await expect(
        guildRegistry.connect(agentD).leaveGuild(1)
      ).to.be.revertedWithCustomError(guildRegistry, "GuildNotActive");
    });

    it("should revert for non-member", async function () {
      await expect(
        guildRegistry.connect(agentD).leaveGuild(0)
      ).to.be.revertedWithCustomError(guildRegistry, "NotGuildMember");
    });

    it("should update isGuildMember to false after leaving", async function () {
      await guildRegistry.connect(agentC).leaveGuild(0);
      expect(await guildRegistry.isGuildMember(0, agentC.address)).to.be
        .false;
    });
  });

  // ============================================================
  //                    DISSOLVE GUILD
  // ============================================================

  describe("Dissolve Guild", function () {
    beforeEach(async function () {
      await guildRegistry
        .connect(agentA)
        .proposeGuild("Alpha Guild", DESC_CID, [
          agentA.address,
          agentB.address,
        ]);
    });

    it("should allow owner to dissolve a proposed guild", async function () {
      await guildRegistry.connect(owner).dissolveGuild(0);
      const guild = await guildRegistry.getGuild(0);
      expect(guild.status).to.equal(2); // Dissolved
    });

    it("should allow owner to dissolve an active guild", async function () {
      await guildRegistry.connect(agentB).approveMembership(0);
      await guildRegistry.connect(owner).dissolveGuild(0);
      const guild = await guildRegistry.getGuild(0);
      expect(guild.status).to.equal(2); // Dissolved
    });

    it("should emit GuildDissolved event", async function () {
      await expect(guildRegistry.connect(owner).dissolveGuild(0))
        .to.emit(guildRegistry, "GuildDissolved")
        .withArgs(0, (v: any) => v > 0);
    });

    it("should revert for non-owner", async function () {
      await expect(
        guildRegistry.connect(agentA).dissolveGuild(0)
      ).to.be.revertedWithCustomError(
        guildRegistry,
        "OwnableUnauthorizedAccount"
      );
    });

    it("should revert for already dissolved guild", async function () {
      await guildRegistry.connect(owner).dissolveGuild(0);
      await expect(
        guildRegistry.connect(owner).dissolveGuild(0)
      ).to.be.revertedWithCustomError(
        guildRegistry,
        "GuildAlreadyDissolved"
      );
    });
  });

  // ============================================================
  //                   COLLECTIVE SPAWN
  // ============================================================

  describe("Collective Spawn", function () {
    beforeEach(async function () {
      // Create and activate a 3-member guild
      await guildRegistry
        .connect(agentA)
        .proposeGuild("Spawn Guild", DESC_CID, [
          agentA.address,
          agentB.address,
          agentC.address,
        ]);
      await guildRegistry.connect(agentB).approveMembership(0);
      await guildRegistry.connect(agentC).approveMembership(0);

      // agentD is already registered in beforeEach
    });

    it("should spawn an agent through the factory (free mode)", async function () {
      // In free mode (no payment token set), we can spawn without fees
      const tx = await guildRegistry
        .connect(agentA)
        .collectiveSpawn(0, 0, agentD.address, SOUL_CID, 0);

      await expect(tx)
        .to.emit(guildRegistry, "CollectiveSpawn")
        .withArgs(0, 0, agentD.address, 0, (v: any) => v > 0);
    });

    it("should create deployment in AgentFactory", async function () {
      await guildRegistry
        .connect(agentA)
        .collectiveSpawn(0, 0, agentD.address, SOUL_CID, 0);

      const deployment = await agentFactory.getDeployment(0);
      expect(deployment.agentAddress).to.equal(agentD.address);
      expect(deployment.bundleId).to.equal(0);
      expect(deployment.soulCid).to.equal(SOUL_CID);
    });

    it("should revert for non-active guild", async function () {
      // Create a proposed (not activated) guild
      await guildRegistry
        .connect(agentD)
        .proposeGuild("Pending", DESC_CID, [agentD.address, agentE.address]);

      await expect(
        guildRegistry
          .connect(agentD)
          .collectiveSpawn(1, 0, nonAgent.address, SOUL_CID, 0)
      ).to.be.revertedWithCustomError(guildRegistry, "GuildNotActive");
    });

    it("should revert for non-member", async function () {
      await expect(
        guildRegistry
          .connect(agentD)
          .collectiveSpawn(0, 0, agentE.address, SOUL_CID, 0)
      ).to.be.revertedWithCustomError(guildRegistry, "NotGuildMember");
    });

    it("should revert for dissolved guild", async function () {
      await guildRegistry.connect(owner).dissolveGuild(0);
      await expect(
        guildRegistry
          .connect(agentA)
          .collectiveSpawn(0, 0, agentD.address, SOUL_CID, 0)
      ).to.be.revertedWithCustomError(guildRegistry, "GuildNotActive");
    });
  });

  // ============================================================
  //                      EDGE CASES
  // ============================================================

  describe("Edge Cases", function () {
    it("should allow an agent to be in multiple guilds", async function () {
      await guildRegistry
        .connect(agentA)
        .proposeGuild("Guild 1", DESC_CID, [
          agentA.address,
          agentB.address,
        ]);
      await guildRegistry
        .connect(agentA)
        .proposeGuild("Guild 2", DESC_CID, [
          agentA.address,
          agentC.address,
        ]);

      const guilds = await guildRegistry.getAgentGuilds(agentA.address);
      expect(guilds).to.have.lengthOf(2);
      expect(guilds[0]).to.equal(0);
      expect(guilds[1]).to.equal(1);
    });

    it("should track getGuildCount across multiple proposals", async function () {
      await guildRegistry
        .connect(agentA)
        .proposeGuild("A", DESC_CID, [agentA.address, agentB.address]);
      await guildRegistry
        .connect(agentC)
        .proposeGuild("B", DESC_CID, [agentC.address, agentD.address]);
      await guildRegistry
        .connect(agentE)
        .proposeGuild("C", DESC_CID, [agentE.address, agentA.address]);

      expect(await guildRegistry.getGuildCount()).to.equal(3);
    });

    it("should return GuildNotFound for invalid guildId", async function () {
      await expect(
        guildRegistry.getGuild(99)
      ).to.be.revertedWithCustomError(guildRegistry, "GuildNotFound");
    });

    it("should return None status for non-member", async function () {
      await guildRegistry
        .connect(agentA)
        .proposeGuild("A", DESC_CID, [agentA.address, agentB.address]);

      expect(
        await guildRegistry.getMemberStatus(0, agentD.address)
      ).to.equal(0); // None
    });

    it("should return empty array for agent with no guilds", async function () {
      const guilds = await guildRegistry.getAgentGuilds(nonAgent.address);
      expect(guilds).to.have.lengthOf(0);
    });
  });

  // ============================================================
  //                    PAUSE / UNPAUSE
  // ============================================================

  describe("Pause / Unpause", function () {
    it("should block proposeGuild when paused", async function () {
      await guildRegistry.connect(owner).pause();
      await expect(
        guildRegistry
          .connect(agentA)
          .proposeGuild("Paused", DESC_CID, [agentA.address, agentB.address])
      ).to.be.revertedWithCustomError(guildRegistry, "EnforcedPause");
    });

    it("should block approveMembership when paused", async function () {
      await guildRegistry
        .connect(agentA)
        .proposeGuild("A", DESC_CID, [agentA.address, agentB.address]);
      await guildRegistry.connect(owner).pause();
      await expect(
        guildRegistry.connect(agentB).approveMembership(0)
      ).to.be.revertedWithCustomError(guildRegistry, "EnforcedPause");
    });

    it("should resume after unpause", async function () {
      await guildRegistry.connect(owner).pause();
      await guildRegistry.connect(owner).unpause();
      await expect(
        guildRegistry
          .connect(agentA)
          .proposeGuild("Resumed", DESC_CID, [agentA.address, agentB.address])
      ).to.not.be.reverted;
    });
  });

  // ============================================================
  //                    ADMIN FUNCTIONS
  // ============================================================

  describe("Admin Functions", function () {
    it("should update minMembers", async function () {
      await guildRegistry.connect(owner).setMinMembers(3);
      expect(await guildRegistry.minMembers()).to.equal(3);
    });

    it("should emit MinMembersUpdated event", async function () {
      await expect(guildRegistry.connect(owner).setMinMembers(3))
        .to.emit(guildRegistry, "MinMembersUpdated")
        .withArgs(2, 3);
    });

    it("should update maxMembers", async function () {
      await guildRegistry.connect(owner).setMaxMembers(20);
      expect(await guildRegistry.maxMembers()).to.equal(20);
    });

    it("should emit MaxMembersUpdated event", async function () {
      await expect(guildRegistry.connect(owner).setMaxMembers(20))
        .to.emit(guildRegistry, "MaxMembersUpdated")
        .withArgs(10, 20);
    });

    it("should allow owner to set agentFactory", async function () {
      await guildRegistry
        .connect(owner)
        .setAgentFactory(agentB.address);
      expect(await guildRegistry.agentFactory()).to.equal(agentB.address);
    });

    it("should revert setAgentFactory with zero address", async function () {
      await expect(
        guildRegistry
          .connect(owner)
          .setAgentFactory(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(guildRegistry, "ZeroAddress");
    });

    it("should revert non-owner admin calls", async function () {
      await expect(
        guildRegistry.connect(agentA).setMinMembers(3)
      ).to.be.revertedWithCustomError(
        guildRegistry,
        "OwnableUnauthorizedAccount"
      );
      await expect(
        guildRegistry.connect(agentA).setMaxMembers(20)
      ).to.be.revertedWithCustomError(
        guildRegistry,
        "OwnableUnauthorizedAccount"
      );
      await expect(
        guildRegistry.connect(agentA).pause()
      ).to.be.revertedWithCustomError(
        guildRegistry,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  // ============================================================
  //                  DISSOLVE PROPOSED GUILD
  // ============================================================

  describe("Dissolve Proposed Guild", function () {
    beforeEach(async function () {
      await guildRegistry
        .connect(agentA)
        .proposeGuild("Alpha Guild", DESC_CID, [
          agentA.address,
          agentB.address,
        ]);
    });

    it("should allow proposer to dissolve their proposed guild", async function () {
      await guildRegistry.connect(agentA).dissolveProposedGuild(0);
      const guild = await guildRegistry.getGuild(0);
      expect(guild.status).to.equal(2); // Dissolved
    });

    it("should revert for non-proposer", async function () {
      await expect(
        guildRegistry.connect(agentB).dissolveProposedGuild(0)
      ).to.be.revertedWithCustomError(guildRegistry, "NotGuildMember");
    });

    it("should revert for active guild", async function () {
      await guildRegistry.connect(agentB).approveMembership(0);
      // Now it's Active
      await expect(
        guildRegistry.connect(agentA).dissolveProposedGuild(0)
      ).to.be.revertedWithCustomError(guildRegistry, "GuildAlreadyDissolved");
    });
  });
});
