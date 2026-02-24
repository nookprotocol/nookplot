import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import {
  CliqueRegistry,
  AgentFactory,
  AgentRegistry,
  ContentIndex,
  KnowledgeBundle,
  NookplotForwarder,
  MockERC20,
} from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("CliqueRegistry", function () {
  let registry: AgentRegistry;
  let contentIndex: ContentIndex;
  let knowledgeBundle: KnowledgeBundle;
  let agentFactory: AgentFactory;
  let cliqueRegistry: CliqueRegistry;
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
  const CID_1 = "QmContent1ForTestingCliques1234567890abcdefgh01";
  const CID_2 = "QmContent2ForTestingCliques1234567890abcdefgh02";
  const CID_3 = "QmContent3ForTestingCliques1234567890abcdefgh03";
  const SOUL_CID = "QmSoulDocumentForTestingCliqueRegistryContrct0001";
  const COMMUNITY = "general";
  const DESC_CID = "QmDescriptionCidForTestingCliqueRegistry00000001";

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

    // Deploy CliqueRegistry
    const CliqueRegistryFactory =
      await ethers.getContractFactory("CliqueRegistry");
    cliqueRegistry = (await upgrades.deployProxy(
      CliqueRegistryFactory,
      [
        owner.address,
        await registry.getAddress(),
        await agentFactory.getAddress(),
      ],
      { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
    )) as unknown as CliqueRegistry;
    await cliqueRegistry.waitForDeployment();

    // Set cliqueRegistry on AgentFactory so collectiveSpawn can call deployAgentFor
    await agentFactory.connect(owner).setCliqueRegistry(await cliqueRegistry.getAddress());

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
      expect(await cliqueRegistry.owner()).to.equal(owner.address);
    });

    it("should set the agentRegistry correctly", async function () {
      expect(await cliqueRegistry.agentRegistry()).to.equal(
        await registry.getAddress()
      );
    });

    it("should set the agentFactory correctly", async function () {
      expect(await cliqueRegistry.agentFactory()).to.equal(
        await agentFactory.getAddress()
      );
    });

    it("should set default minMembers to 2", async function () {
      expect(await cliqueRegistry.minMembers()).to.equal(2);
    });

    it("should set default maxMembers to 10", async function () {
      expect(await cliqueRegistry.maxMembers()).to.equal(10);
    });

    it("should not be paused initially", async function () {
      expect(await cliqueRegistry.paused()).to.be.false;
    });

    it("should start with zero cliques", async function () {
      expect(await cliqueRegistry.getCliqueCount()).to.equal(0);
    });
  });

  // ============================================================
  //                     PROPOSE CLIQUE
  // ============================================================

  describe("Propose Clique", function () {
    it("should propose a 2-member clique", async function () {
      const tx = await cliqueRegistry
        .connect(agentA)
        .proposeClique("Alpha Clique", DESC_CID, [
          agentA.address,
          agentB.address,
        ]);

      const clique = await cliqueRegistry.getClique(0);
      expect(clique.name).to.equal("Alpha Clique");
      expect(clique.descriptionCid).to.equal(DESC_CID);
      expect(clique.proposer).to.equal(agentA.address);
      expect(clique.memberCount).to.equal(2);
      expect(clique.approvedCount).to.equal(1); // proposer auto-approves
      expect(clique.status).to.equal(0); // Proposed
    });

    it("should propose a 3-member clique", async function () {
      await cliqueRegistry
        .connect(agentA)
        .proposeClique("Triple Clique", DESC_CID, [
          agentA.address,
          agentB.address,
          agentC.address,
        ]);

      const clique = await cliqueRegistry.getClique(0);
      expect(clique.memberCount).to.equal(3);
      expect(clique.approvedCount).to.equal(1);
    });

    it("should emit CliqueProposed event", async function () {
      await expect(
        cliqueRegistry
          .connect(agentA)
          .proposeClique("Alpha Clique", DESC_CID, [
            agentA.address,
            agentB.address,
          ])
      )
        .to.emit(cliqueRegistry, "CliqueProposed")
        .withArgs(
          0,
          agentA.address,
          "Alpha Clique",
          2,
          (v: any) => v > 0
        );
    });

    it("should auto-approve the proposer", async function () {
      await cliqueRegistry
        .connect(agentA)
        .proposeClique("Alpha Clique", DESC_CID, [
          agentA.address,
          agentB.address,
        ]);

      expect(
        await cliqueRegistry.getMemberStatus(0, agentA.address)
      ).to.equal(2); // Approved
      expect(
        await cliqueRegistry.getMemberStatus(0, agentB.address)
      ).to.equal(1); // Proposed
    });

    it("should store members correctly", async function () {
      await cliqueRegistry
        .connect(agentA)
        .proposeClique("Alpha Clique", DESC_CID, [
          agentA.address,
          agentB.address,
          agentC.address,
        ]);

      const members = await cliqueRegistry.getMembers(0);
      expect(members).to.have.lengthOf(3);
      expect(members[0]).to.equal(agentA.address);
      expect(members[1]).to.equal(agentB.address);
      expect(members[2]).to.equal(agentC.address);
    });

    it("should update agentCliques reverse lookup", async function () {
      await cliqueRegistry
        .connect(agentA)
        .proposeClique("Alpha Clique", DESC_CID, [
          agentA.address,
          agentB.address,
        ]);

      const aCliques = await cliqueRegistry.getAgentCliques(agentA.address);
      expect(aCliques).to.have.lengthOf(1);
      expect(aCliques[0]).to.equal(0);

      const bCliques = await cliqueRegistry.getAgentCliques(agentB.address);
      expect(bCliques).to.have.lengthOf(1);
      expect(bCliques[0]).to.equal(0);
    });

    it("should increment cliqueId", async function () {
      await cliqueRegistry
        .connect(agentA)
        .proposeClique("First", DESC_CID, [agentA.address, agentB.address]);
      await cliqueRegistry
        .connect(agentC)
        .proposeClique("Second", DESC_CID, [agentC.address, agentD.address]);

      expect(await cliqueRegistry.getCliqueCount()).to.equal(2);
      expect((await cliqueRegistry.getClique(0)).name).to.equal("First");
      expect((await cliqueRegistry.getClique(1)).name).to.equal("Second");
    });

    it("should revert with empty name", async function () {
      await expect(
        cliqueRegistry
          .connect(agentA)
          .proposeClique("", DESC_CID, [agentA.address, agentB.address])
      ).to.be.revertedWithCustomError(cliqueRegistry, "EmptyName");
    });

    it("should revert with too few members", async function () {
      await expect(
        cliqueRegistry
          .connect(agentA)
          .proposeClique("Solo", DESC_CID, [agentA.address])
      ).to.be.revertedWithCustomError(cliqueRegistry, "TooFewMembers");
    });

    it("should revert if proposer is not in members list", async function () {
      await expect(
        cliqueRegistry
          .connect(agentA)
          .proposeClique("No Self", DESC_CID, [agentB.address, agentC.address])
      ).to.be.revertedWithCustomError(cliqueRegistry, "ProposerMustBeMember");
    });

    it("should revert with duplicate members", async function () {
      await expect(
        cliqueRegistry
          .connect(agentA)
          .proposeClique("Dupe", DESC_CID, [agentA.address, agentA.address])
      ).to.be.revertedWithCustomError(cliqueRegistry, "DuplicateMember");
    });

    it("should revert for non-registered agent in members", async function () {
      await expect(
        cliqueRegistry
          .connect(agentA)
          .proposeClique("Bad Member", DESC_CID, [
            agentA.address,
            nonAgent.address,
          ])
      ).to.be.revertedWithCustomError(cliqueRegistry, "NotRegisteredAgent");
    });

    it("should revert for non-registered proposer", async function () {
      await expect(
        cliqueRegistry
          .connect(nonAgent)
          .proposeClique("Unregistered", DESC_CID, [
            nonAgent.address,
            agentA.address,
          ])
      ).to.be.revertedWithCustomError(cliqueRegistry, "NotRegisteredAgent");
    });
  });

  // ============================================================
  //                   APPROVE MEMBERSHIP
  // ============================================================

  describe("Approve Membership", function () {
    beforeEach(async function () {
      await cliqueRegistry
        .connect(agentA)
        .proposeClique("Alpha Clique", DESC_CID, [
          agentA.address,
          agentB.address,
          agentC.address,
        ]);
    });

    it("should approve membership for a proposed member", async function () {
      await cliqueRegistry.connect(agentB).approveMembership(0);
      expect(
        await cliqueRegistry.getMemberStatus(0, agentB.address)
      ).to.equal(2); // Approved
    });

    it("should increment approvedCount", async function () {
      await cliqueRegistry.connect(agentB).approveMembership(0);
      const clique = await cliqueRegistry.getClique(0);
      expect(clique.approvedCount).to.equal(2);
    });

    it("should emit MembershipApproved event", async function () {
      await expect(cliqueRegistry.connect(agentB).approveMembership(0))
        .to.emit(cliqueRegistry, "MembershipApproved")
        .withArgs(0, agentB.address, (v: any) => v > 0);
    });

    it("should activate clique when all members approve", async function () {
      await cliqueRegistry.connect(agentB).approveMembership(0);
      await cliqueRegistry.connect(agentC).approveMembership(0);

      const clique = await cliqueRegistry.getClique(0);
      expect(clique.status).to.equal(1); // Active
      expect(clique.activatedAt).to.be.gt(0);
    });

    it("should emit CliqueActivated when all approve", async function () {
      await cliqueRegistry.connect(agentB).approveMembership(0);
      await expect(cliqueRegistry.connect(agentC).approveMembership(0))
        .to.emit(cliqueRegistry, "CliqueActivated")
        .withArgs(0, (v: any) => v > 0);
    });

    it("should revert if already approved", async function () {
      await cliqueRegistry.connect(agentB).approveMembership(0);
      await expect(
        cliqueRegistry.connect(agentB).approveMembership(0)
      ).to.be.revertedWithCustomError(cliqueRegistry, "AlreadyApproved");
    });

    it("should revert for proposer (auto-approved)", async function () {
      await expect(
        cliqueRegistry.connect(agentA).approveMembership(0)
      ).to.be.revertedWithCustomError(cliqueRegistry, "AlreadyApproved");
    });

    it("should revert for non-member", async function () {
      await expect(
        cliqueRegistry.connect(agentD).approveMembership(0)
      ).to.be.revertedWithCustomError(cliqueRegistry, "NotCliqueMember");
    });

    it("should revert for non-existent clique", async function () {
      await expect(
        cliqueRegistry.connect(agentB).approveMembership(999)
      ).to.be.revertedWithCustomError(cliqueRegistry, "CliqueNotFound");
    });

    it("should set isCliqueMember to true after approval", async function () {
      await cliqueRegistry.connect(agentB).approveMembership(0);
      expect(await cliqueRegistry.isCliqueMember(0, agentB.address)).to.be
        .true;
    });

    it("should auto-activate a 2-member clique when second approves", async function () {
      // Create a 2-member clique
      await cliqueRegistry
        .connect(agentD)
        .proposeClique("Duo", DESC_CID, [agentD.address, agentE.address]);

      // Only one approval needed (proposer auto-approved)
      await expect(cliqueRegistry.connect(agentE).approveMembership(1))
        .to.emit(cliqueRegistry, "CliqueActivated")
        .withArgs(1, (v: any) => v > 0);

      const clique = await cliqueRegistry.getClique(1);
      expect(clique.status).to.equal(1); // Active
    });
  });

  // ============================================================
  //                   REJECT MEMBERSHIP
  // ============================================================

  describe("Reject Membership", function () {
    beforeEach(async function () {
      await cliqueRegistry
        .connect(agentA)
        .proposeClique("Alpha Clique", DESC_CID, [
          agentA.address,
          agentB.address,
          agentC.address,
        ]);
    });

    it("should reject membership", async function () {
      await cliqueRegistry.connect(agentB).rejectMembership(0);
      expect(
        await cliqueRegistry.getMemberStatus(0, agentB.address)
      ).to.equal(3); // Rejected
    });

    it("should emit MembershipRejected event", async function () {
      await expect(cliqueRegistry.connect(agentB).rejectMembership(0))
        .to.emit(cliqueRegistry, "MembershipRejected")
        .withArgs(0, agentB.address, (v: any) => v > 0);
    });

    it("should keep clique in Proposed status after rejection", async function () {
      await cliqueRegistry.connect(agentB).rejectMembership(0);
      const clique = await cliqueRegistry.getClique(0);
      expect(clique.status).to.equal(0); // Still Proposed
    });

    it("should revert for non-member", async function () {
      await expect(
        cliqueRegistry.connect(agentD).rejectMembership(0)
      ).to.be.revertedWithCustomError(cliqueRegistry, "NotCliqueMember");
    });

    it("should revert if already approved (proposer)", async function () {
      await expect(
        cliqueRegistry.connect(agentA).rejectMembership(0)
      ).to.be.revertedWithCustomError(cliqueRegistry, "MemberNotProposed");
    });
  });

  // ============================================================
  //                     LEAVE CLIQUE
  // ============================================================

  describe("Leave Clique", function () {
    beforeEach(async function () {
      // Create and activate a 3-member clique
      await cliqueRegistry
        .connect(agentA)
        .proposeClique("Active Clique", DESC_CID, [
          agentA.address,
          agentB.address,
          agentC.address,
        ]);
      await cliqueRegistry.connect(agentB).approveMembership(0);
      await cliqueRegistry.connect(agentC).approveMembership(0);
    });

    it("should allow a member to leave", async function () {
      await cliqueRegistry.connect(agentC).leaveClique(0);
      expect(
        await cliqueRegistry.getMemberStatus(0, agentC.address)
      ).to.equal(4); // Left
    });

    it("should decrement approvedCount", async function () {
      await cliqueRegistry.connect(agentC).leaveClique(0);
      const clique = await cliqueRegistry.getClique(0);
      expect(clique.approvedCount).to.equal(2);
    });

    it("should emit MemberLeft event", async function () {
      await expect(cliqueRegistry.connect(agentC).leaveClique(0))
        .to.emit(cliqueRegistry, "MemberLeft")
        .withArgs(0, agentC.address, (v: any) => v > 0);
    });

    it("should auto-dissolve if below minMembers", async function () {
      await cliqueRegistry.connect(agentC).leaveClique(0);
      await cliqueRegistry.connect(agentB).leaveClique(0);
      // Now only 1 approved member — below minMembers (2)
      const clique = await cliqueRegistry.getClique(0);
      expect(clique.status).to.equal(2); // Dissolved
    });

    it("should emit CliqueDissolved on auto-dissolve", async function () {
      await cliqueRegistry.connect(agentC).leaveClique(0);
      await expect(cliqueRegistry.connect(agentB).leaveClique(0))
        .to.emit(cliqueRegistry, "CliqueDissolved")
        .withArgs(0, (v: any) => v > 0);
    });

    it("should revert for non-active clique", async function () {
      // Create a proposed clique (not activated)
      await cliqueRegistry
        .connect(agentD)
        .proposeClique("Pending", DESC_CID, [agentD.address, agentE.address]);

      await expect(
        cliqueRegistry.connect(agentD).leaveClique(1)
      ).to.be.revertedWithCustomError(cliqueRegistry, "CliqueNotActive");
    });

    it("should revert for non-member", async function () {
      await expect(
        cliqueRegistry.connect(agentD).leaveClique(0)
      ).to.be.revertedWithCustomError(cliqueRegistry, "NotCliqueMember");
    });

    it("should update isCliqueMember to false after leaving", async function () {
      await cliqueRegistry.connect(agentC).leaveClique(0);
      expect(await cliqueRegistry.isCliqueMember(0, agentC.address)).to.be
        .false;
    });
  });

  // ============================================================
  //                    DISSOLVE CLIQUE
  // ============================================================

  describe("Dissolve Clique", function () {
    beforeEach(async function () {
      await cliqueRegistry
        .connect(agentA)
        .proposeClique("Alpha Clique", DESC_CID, [
          agentA.address,
          agentB.address,
        ]);
    });

    it("should allow owner to dissolve a proposed clique", async function () {
      await cliqueRegistry.connect(owner).dissolveClique(0);
      const clique = await cliqueRegistry.getClique(0);
      expect(clique.status).to.equal(2); // Dissolved
    });

    it("should allow owner to dissolve an active clique", async function () {
      await cliqueRegistry.connect(agentB).approveMembership(0);
      await cliqueRegistry.connect(owner).dissolveClique(0);
      const clique = await cliqueRegistry.getClique(0);
      expect(clique.status).to.equal(2); // Dissolved
    });

    it("should emit CliqueDissolved event", async function () {
      await expect(cliqueRegistry.connect(owner).dissolveClique(0))
        .to.emit(cliqueRegistry, "CliqueDissolved")
        .withArgs(0, (v: any) => v > 0);
    });

    it("should revert for non-owner", async function () {
      await expect(
        cliqueRegistry.connect(agentA).dissolveClique(0)
      ).to.be.revertedWithCustomError(
        cliqueRegistry,
        "OwnableUnauthorizedAccount"
      );
    });

    it("should revert for already dissolved clique", async function () {
      await cliqueRegistry.connect(owner).dissolveClique(0);
      await expect(
        cliqueRegistry.connect(owner).dissolveClique(0)
      ).to.be.revertedWithCustomError(
        cliqueRegistry,
        "CliqueAlreadyDissolved"
      );
    });
  });

  // ============================================================
  //                   COLLECTIVE SPAWN
  // ============================================================

  describe("Collective Spawn", function () {
    beforeEach(async function () {
      // Create and activate a 3-member clique
      await cliqueRegistry
        .connect(agentA)
        .proposeClique("Spawn Clique", DESC_CID, [
          agentA.address,
          agentB.address,
          agentC.address,
        ]);
      await cliqueRegistry.connect(agentB).approveMembership(0);
      await cliqueRegistry.connect(agentC).approveMembership(0);

      // Register the child agent (agentD is already registered above)
      // agentD is already registered in beforeEach
    });

    it("should spawn an agent through the factory (free mode)", async function () {
      // In free mode (no payment token set), we can spawn without fees
      const tx = await cliqueRegistry
        .connect(agentA)
        .collectiveSpawn(0, 0, agentD.address, SOUL_CID, 0);

      await expect(tx)
        .to.emit(cliqueRegistry, "CollectiveSpawn")
        .withArgs(0, 0, agentD.address, 0, (v: any) => v > 0);
    });

    it("should create deployment in AgentFactory", async function () {
      await cliqueRegistry
        .connect(agentA)
        .collectiveSpawn(0, 0, agentD.address, SOUL_CID, 0);

      const deployment = await agentFactory.getDeployment(0);
      expect(deployment.agentAddress).to.equal(agentD.address);
      expect(deployment.bundleId).to.equal(0);
      expect(deployment.soulCid).to.equal(SOUL_CID);
    });

    it("should revert for non-active clique", async function () {
      // Create a proposed (not activated) clique
      await cliqueRegistry
        .connect(agentD)
        .proposeClique("Pending", DESC_CID, [agentD.address, agentE.address]);

      await expect(
        cliqueRegistry
          .connect(agentD)
          .collectiveSpawn(1, 0, nonAgent.address, SOUL_CID, 0)
      ).to.be.revertedWithCustomError(cliqueRegistry, "CliqueNotActive");
    });

    it("should revert for non-member", async function () {
      await expect(
        cliqueRegistry
          .connect(agentD)
          .collectiveSpawn(0, 0, agentE.address, SOUL_CID, 0)
      ).to.be.revertedWithCustomError(cliqueRegistry, "NotCliqueMember");
    });

    it("should revert for dissolved clique", async function () {
      await cliqueRegistry.connect(owner).dissolveClique(0);
      await expect(
        cliqueRegistry
          .connect(agentA)
          .collectiveSpawn(0, 0, agentD.address, SOUL_CID, 0)
      ).to.be.revertedWithCustomError(cliqueRegistry, "CliqueNotActive");
    });
  });

  // ============================================================
  //                      EDGE CASES
  // ============================================================

  describe("Edge Cases", function () {
    it("should allow an agent to be in multiple cliques", async function () {
      await cliqueRegistry
        .connect(agentA)
        .proposeClique("Clique 1", DESC_CID, [
          agentA.address,
          agentB.address,
        ]);
      await cliqueRegistry
        .connect(agentA)
        .proposeClique("Clique 2", DESC_CID, [
          agentA.address,
          agentC.address,
        ]);

      const cliques = await cliqueRegistry.getAgentCliques(agentA.address);
      expect(cliques).to.have.lengthOf(2);
      expect(cliques[0]).to.equal(0);
      expect(cliques[1]).to.equal(1);
    });

    it("should track getCliqueCount across multiple proposals", async function () {
      await cliqueRegistry
        .connect(agentA)
        .proposeClique("A", DESC_CID, [agentA.address, agentB.address]);
      await cliqueRegistry
        .connect(agentC)
        .proposeClique("B", DESC_CID, [agentC.address, agentD.address]);
      await cliqueRegistry
        .connect(agentE)
        .proposeClique("C", DESC_CID, [agentE.address, agentA.address]);

      expect(await cliqueRegistry.getCliqueCount()).to.equal(3);
    });

    it("should return CliqueNotFound for invalid cliqueId", async function () {
      await expect(
        cliqueRegistry.getClique(99)
      ).to.be.revertedWithCustomError(cliqueRegistry, "CliqueNotFound");
    });

    it("should return None status for non-member", async function () {
      await cliqueRegistry
        .connect(agentA)
        .proposeClique("A", DESC_CID, [agentA.address, agentB.address]);

      expect(
        await cliqueRegistry.getMemberStatus(0, agentD.address)
      ).to.equal(0); // None
    });

    it("should return empty array for agent with no cliques", async function () {
      const cliques = await cliqueRegistry.getAgentCliques(nonAgent.address);
      expect(cliques).to.have.lengthOf(0);
    });
  });

  // ============================================================
  //                    PAUSE / UNPAUSE
  // ============================================================

  describe("Pause / Unpause", function () {
    it("should block proposeClique when paused", async function () {
      await cliqueRegistry.connect(owner).pause();
      await expect(
        cliqueRegistry
          .connect(agentA)
          .proposeClique("Paused", DESC_CID, [agentA.address, agentB.address])
      ).to.be.revertedWithCustomError(cliqueRegistry, "EnforcedPause");
    });

    it("should block approveMembership when paused", async function () {
      await cliqueRegistry
        .connect(agentA)
        .proposeClique("A", DESC_CID, [agentA.address, agentB.address]);
      await cliqueRegistry.connect(owner).pause();
      await expect(
        cliqueRegistry.connect(agentB).approveMembership(0)
      ).to.be.revertedWithCustomError(cliqueRegistry, "EnforcedPause");
    });

    it("should resume after unpause", async function () {
      await cliqueRegistry.connect(owner).pause();
      await cliqueRegistry.connect(owner).unpause();
      await expect(
        cliqueRegistry
          .connect(agentA)
          .proposeClique("Resumed", DESC_CID, [agentA.address, agentB.address])
      ).to.not.be.reverted;
    });
  });

  // ============================================================
  //                    ADMIN FUNCTIONS
  // ============================================================

  describe("Admin Functions", function () {
    it("should update minMembers", async function () {
      await cliqueRegistry.connect(owner).setMinMembers(3);
      expect(await cliqueRegistry.minMembers()).to.equal(3);
    });

    it("should emit MinMembersUpdated event", async function () {
      await expect(cliqueRegistry.connect(owner).setMinMembers(3))
        .to.emit(cliqueRegistry, "MinMembersUpdated")
        .withArgs(2, 3);
    });

    it("should update maxMembers", async function () {
      await cliqueRegistry.connect(owner).setMaxMembers(20);
      expect(await cliqueRegistry.maxMembers()).to.equal(20);
    });

    it("should emit MaxMembersUpdated event", async function () {
      await expect(cliqueRegistry.connect(owner).setMaxMembers(20))
        .to.emit(cliqueRegistry, "MaxMembersUpdated")
        .withArgs(10, 20);
    });

    it("should allow owner to set agentFactory", async function () {
      await cliqueRegistry
        .connect(owner)
        .setAgentFactory(agentB.address);
      expect(await cliqueRegistry.agentFactory()).to.equal(agentB.address);
    });

    it("should revert setAgentFactory with zero address", async function () {
      await expect(
        cliqueRegistry
          .connect(owner)
          .setAgentFactory(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(cliqueRegistry, "ZeroAddress");
    });

    it("should revert non-owner admin calls", async function () {
      await expect(
        cliqueRegistry.connect(agentA).setMinMembers(3)
      ).to.be.revertedWithCustomError(
        cliqueRegistry,
        "OwnableUnauthorizedAccount"
      );
      await expect(
        cliqueRegistry.connect(agentA).setMaxMembers(20)
      ).to.be.revertedWithCustomError(
        cliqueRegistry,
        "OwnableUnauthorizedAccount"
      );
      await expect(
        cliqueRegistry.connect(agentA).pause()
      ).to.be.revertedWithCustomError(
        cliqueRegistry,
        "OwnableUnauthorizedAccount"
      );
    });
  });
});
