import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import {
  AgentRegistry,
  ContentIndex,
  KnowledgeBundle,
  NookplotForwarder,
} from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("KnowledgeBundle", function () {
  let registry: AgentRegistry;
  let contentIndex: ContentIndex;
  let knowledgeBundle: KnowledgeBundle;
  let forwarder: NookplotForwarder;
  let owner: SignerWithAddress;
  let treasury: SignerWithAddress;
  let agentA: SignerWithAddress;
  let agentB: SignerWithAddress;
  let nonAgent: SignerWithAddress;

  const DID_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const CID_1 = "QmContent1ForTestingBundles1234567890abcdefgh01";
  const CID_2 = "QmContent2ForTestingBundles1234567890abcdefgh02";
  const CID_3 = "QmContent3ForTestingBundles1234567890abcdefgh03";
  const DESC_CID = "QmDescriptionCidForTestingBundles1234567890abcd";
  const COMMUNITY = "general";

  const PROXY_OPTS = {
    kind: "uups" as const,
    unsafeAllow: ["constructor", "state-variable-immutable"] as any[],
  };

  /** Helper: create ContributorWeight tuples for contract calls */
  function weights(entries: Array<{ addr: string; bps: number }>) {
    return entries.map((e) => ({ contributor: e.addr, weightBps: e.bps }));
  }

  beforeEach(async function () {
    [owner, treasury, agentA, agentB, nonAgent] = await ethers.getSigners();

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
      [owner.address, treasury.address],
      { ...PROXY_OPTS, constructorArgs: [forwarderAddress] }
    )) as unknown as AgentRegistry;
    await registry.waitForDeployment();

    // Deploy ContentIndex
    const ContentIndexFactory =
      await ethers.getContractFactory("ContentIndex");
    contentIndex = (await upgrades.deployProxy(
      ContentIndexFactory,
      [owner.address, await registry.getAddress(), treasury.address],
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

    // Register agents
    await registry.connect(agentA).register(DID_CID);
    await registry.connect(agentB).register(DID_CID);

    // Publish content CIDs so they exist in ContentIndex
    await contentIndex.connect(agentA).publishPost(CID_1, COMMUNITY);
    await contentIndex.connect(agentA).publishPost(CID_2, COMMUNITY);
    await contentIndex.connect(agentB).publishPost(CID_3, COMMUNITY);
  });

  // ============================================================
  //                     INITIALIZATION
  // ============================================================

  describe("Initialization", function () {
    it("should set the owner correctly", async function () {
      expect(await knowledgeBundle.owner()).to.equal(owner.address);
    });

    it("should set the agentRegistry correctly", async function () {
      expect(await knowledgeBundle.agentRegistry()).to.equal(
        await registry.getAddress()
      );
    });

    it("should set the contentIndex correctly", async function () {
      expect(await knowledgeBundle.contentIndex()).to.equal(
        await contentIndex.getAddress()
      );
    });

    it("should not be paused initially", async function () {
      expect(await knowledgeBundle.paused()).to.be.false;
    });

    it("should start with zero bundles", async function () {
      expect(await knowledgeBundle.getBundleCount()).to.equal(0);
    });
  });

  // ============================================================
  //                     CREATE BUNDLE
  // ============================================================

  describe("createBundle", function () {
    it("should create a bundle with valid data", async function () {
      const contribs = weights([
        { addr: agentA.address, bps: 6000 },
        { addr: agentB.address, bps: 4000 },
      ]);

      const tx = await knowledgeBundle
        .connect(agentA)
        .createBundle("Test Bundle", DESC_CID, [CID_1, CID_2], contribs);

      const receipt = await tx.wait();
      expect(receipt).to.not.be.null;

      // Verify bundle data
      const bundle = await knowledgeBundle.getBundle(0);
      expect(bundle.creator).to.equal(agentA.address);
      expect(bundle.name).to.equal("Test Bundle");
      expect(bundle.descriptionCid).to.equal(DESC_CID);
      expect(bundle.contentCids.length).to.equal(2);
      expect(bundle.contentCids[0]).to.equal(CID_1);
      expect(bundle.contentCids[1]).to.equal(CID_2);
      expect(bundle.contributors.length).to.equal(2);
      expect(bundle.isActive).to.be.true;
    });

    it("should emit BundleCreated event", async function () {
      const contribs = weights([{ addr: agentA.address, bps: 10000 }]);

      await expect(
        knowledgeBundle
          .connect(agentA)
          .createBundle("My Bundle", "", [CID_1], contribs)
      )
        .to.emit(knowledgeBundle, "BundleCreated")
        .withArgs(0, agentA.address, "My Bundle", 1, (v: any) => v > 0);
    });

    it("should increment bundle ID", async function () {
      const contribs = weights([{ addr: agentA.address, bps: 10000 }]);

      await knowledgeBundle
        .connect(agentA)
        .createBundle("Bundle 0", "", [CID_1], contribs);
      await knowledgeBundle
        .connect(agentA)
        .createBundle("Bundle 1", "", [CID_2], contribs);

      expect(await knowledgeBundle.getBundleCount()).to.equal(2);
      expect((await knowledgeBundle.getBundle(0)).name).to.equal("Bundle 0");
      expect((await knowledgeBundle.getBundle(1)).name).to.equal("Bundle 1");
    });

    it("should revert for non-registered agent", async function () {
      const contribs = weights([{ addr: nonAgent.address, bps: 10000 }]);

      await expect(
        knowledgeBundle
          .connect(nonAgent)
          .createBundle("Bad Bundle", "", [CID_1], contribs)
      ).to.be.revertedWithCustomError(knowledgeBundle, "NotRegisteredAgent");
    });

    it("should revert for empty name", async function () {
      const contribs = weights([{ addr: agentA.address, bps: 10000 }]);

      await expect(
        knowledgeBundle
          .connect(agentA)
          .createBundle("", "", [CID_1], contribs)
      ).to.be.revertedWithCustomError(knowledgeBundle, "EmptyBundle");
    });

    it("should revert for empty CID array", async function () {
      const contribs = weights([{ addr: agentA.address, bps: 10000 }]);

      await expect(
        knowledgeBundle
          .connect(agentA)
          .createBundle("Bundle", "", [], contribs)
      ).to.be.revertedWithCustomError(knowledgeBundle, "EmptyBundle");
    });

    it("should revert for too many CIDs", async function () {
      const contribs = weights([{ addr: agentA.address, bps: 10000 }]);
      const tooManyCids = Array(51).fill(CID_1);

      await expect(
        knowledgeBundle
          .connect(agentA)
          .createBundle("Bundle", "", tooManyCids, contribs)
      ).to.be.revertedWithCustomError(knowledgeBundle, "TooManyCids");
    });

    it("should revert when CID does not exist in ContentIndex", async function () {
      const contribs = weights([{ addr: agentA.address, bps: 10000 }]);
      const fakeCid = "QmFakeCidThatDoesNotExistInContentIndex123456789";

      await expect(
        knowledgeBundle
          .connect(agentA)
          .createBundle("Bundle", "", [fakeCid], contribs)
      ).to.be.revertedWithCustomError(knowledgeBundle, "ContentNotFound");
    });

    it("should revert when weights don't sum to 10000", async function () {
      const badWeights = weights([
        { addr: agentA.address, bps: 5000 },
        { addr: agentB.address, bps: 3000 },
      ]);

      await expect(
        knowledgeBundle
          .connect(agentA)
          .createBundle("Bundle", "", [CID_1], badWeights)
      ).to.be.revertedWithCustomError(knowledgeBundle, "InvalidWeights");
    });

    it("should revert when contributors array is empty", async function () {
      await expect(
        knowledgeBundle
          .connect(agentA)
          .createBundle("Bundle", "", [CID_1], [])
      ).to.be.revertedWithCustomError(knowledgeBundle, "InvalidWeights");
    });
  });

  // ============================================================
  //                     ADD CONTENT
  // ============================================================

  describe("addContent", function () {
    beforeEach(async function () {
      const contribs = weights([{ addr: agentA.address, bps: 10000 }]);
      await knowledgeBundle
        .connect(agentA)
        .createBundle("Test Bundle", "", [CID_1], contribs);
    });

    it("should add CIDs to a bundle", async function () {
      await knowledgeBundle.connect(agentA).addContent(0, [CID_2, CID_3]);

      const content = await knowledgeBundle.getBundleContent(0);
      expect(content.length).to.equal(3);
      expect(content[1]).to.equal(CID_2);
      expect(content[2]).to.equal(CID_3);
    });

    it("should emit BundleContentAdded event", async function () {
      await expect(
        knowledgeBundle.connect(agentA).addContent(0, [CID_2])
      )
        .to.emit(knowledgeBundle, "BundleContentAdded")
        .withArgs(0, 1, 2);
    });

    it("should revert when not the creator", async function () {
      await expect(
        knowledgeBundle.connect(agentB).addContent(0, [CID_3])
      ).to.be.revertedWithCustomError(knowledgeBundle, "NotBundleCreator");
    });

    it("should revert when CID does not exist", async function () {
      const fakeCid = "QmFakeCidThatDoesNotExistInContentIndex123456789";

      await expect(
        knowledgeBundle.connect(agentA).addContent(0, [fakeCid])
      ).to.be.revertedWithCustomError(knowledgeBundle, "ContentNotFound");
    });

    it("should revert when exceeding 50 CID limit", async function () {
      const tooManyCids = Array(51).fill(CID_2);

      await expect(
        knowledgeBundle.connect(agentA).addContent(0, tooManyCids)
      ).to.be.revertedWithCustomError(knowledgeBundle, "TooManyCids");
    });

    it("should revert when bundle does not exist", async function () {
      await expect(
        knowledgeBundle.connect(agentA).addContent(999, [CID_2])
      ).to.be.revertedWithCustomError(knowledgeBundle, "BundleNotFound");
    });

    it("should revert when empty CID array", async function () {
      await expect(
        knowledgeBundle.connect(agentA).addContent(0, [])
      ).to.be.revertedWithCustomError(knowledgeBundle, "EmptyBundle");
    });
  });

  // ============================================================
  //                     REMOVE CONTENT
  // ============================================================

  describe("removeContent", function () {
    beforeEach(async function () {
      const contribs = weights([{ addr: agentA.address, bps: 10000 }]);
      await knowledgeBundle
        .connect(agentA)
        .createBundle("Test Bundle", "", [CID_1, CID_2, CID_3], contribs);
    });

    it("should remove CIDs from a bundle", async function () {
      await knowledgeBundle.connect(agentA).removeContent(0, [CID_2]);

      const content = await knowledgeBundle.getBundleContent(0);
      expect(content.length).to.equal(2);
      // CID_2 was removed, CID_3 swapped into its position
      expect(content[0]).to.equal(CID_1);
      expect(content[1]).to.equal(CID_3);
    });

    it("should emit BundleContentRemoved event", async function () {
      await expect(
        knowledgeBundle.connect(agentA).removeContent(0, [CID_1])
      )
        .to.emit(knowledgeBundle, "BundleContentRemoved")
        .withArgs(0, 1);
    });

    it("should revert when not the creator", async function () {
      await expect(
        knowledgeBundle.connect(agentB).removeContent(0, [CID_1])
      ).to.be.revertedWithCustomError(knowledgeBundle, "NotBundleCreator");
    });

    it("should handle removing non-existent CID gracefully", async function () {
      const fakeCid = "QmFakeCidThatDoesNotExistInBundle12345678901234";

      await expect(
        knowledgeBundle.connect(agentA).removeContent(0, [fakeCid])
      )
        .to.emit(knowledgeBundle, "BundleContentRemoved")
        .withArgs(0, 0);
    });
  });

  // ============================================================
  //                     SET CONTRIBUTOR WEIGHTS
  // ============================================================

  describe("setContributorWeights", function () {
    beforeEach(async function () {
      const contribs = weights([{ addr: agentA.address, bps: 10000 }]);
      await knowledgeBundle
        .connect(agentA)
        .createBundle("Test Bundle", "", [CID_1], contribs);
    });

    it("should update contributor weights", async function () {
      const newWeights = weights([
        { addr: agentA.address, bps: 7000 },
        { addr: agentB.address, bps: 3000 },
      ]);

      await knowledgeBundle.connect(agentA).setContributorWeights(0, newWeights);

      const contributors = await knowledgeBundle.getBundleContributors(0);
      expect(contributors.length).to.equal(2);
      expect(contributors[0].weightBps).to.equal(7000);
      expect(contributors[1].weightBps).to.equal(3000);
    });

    it("should emit ContributorWeightsSet and ContributorWeightSet events", async function () {
      const newWeights = weights([
        { addr: agentA.address, bps: 5000 },
        { addr: agentB.address, bps: 5000 },
      ]);

      const tx = knowledgeBundle
        .connect(agentA)
        .setContributorWeights(0, newWeights);

      await expect(tx)
        .to.emit(knowledgeBundle, "ContributorWeightsSet")
        .withArgs(0, 2);
      await expect(tx)
        .to.emit(knowledgeBundle, "ContributorWeightSet")
        .withArgs(0, agentA.address, 5000);
      await expect(tx)
        .to.emit(knowledgeBundle, "ContributorWeightSet")
        .withArgs(0, agentB.address, 5000);
    });

    it("should revert when not the creator", async function () {
      const newWeights = weights([{ addr: agentB.address, bps: 10000 }]);

      await expect(
        knowledgeBundle.connect(agentB).setContributorWeights(0, newWeights)
      ).to.be.revertedWithCustomError(knowledgeBundle, "NotBundleCreator");
    });

    it("should revert when weights don't sum to 10000", async function () {
      const badWeights = weights([{ addr: agentA.address, bps: 9999 }]);

      await expect(
        knowledgeBundle.connect(agentA).setContributorWeights(0, badWeights)
      ).to.be.revertedWithCustomError(knowledgeBundle, "InvalidWeights");
    });
  });

  // ============================================================
  //                     DEACTIVATE BUNDLE
  // ============================================================

  describe("deactivateBundle", function () {
    beforeEach(async function () {
      const contribs = weights([{ addr: agentA.address, bps: 10000 }]);
      await knowledgeBundle
        .connect(agentA)
        .createBundle("Test Bundle", "", [CID_1], contribs);
    });

    it("should deactivate bundle by creator", async function () {
      await knowledgeBundle.connect(agentA).deactivateBundle(0);
      expect(await knowledgeBundle.isBundleActive(0)).to.be.false;
    });

    it("should deactivate bundle by owner", async function () {
      await knowledgeBundle.connect(owner).deactivateBundle(0);
      expect(await knowledgeBundle.isBundleActive(0)).to.be.false;
    });

    it("should emit BundleDeactivated event", async function () {
      await expect(knowledgeBundle.connect(agentA).deactivateBundle(0))
        .to.emit(knowledgeBundle, "BundleDeactivated")
        .withArgs(0);
    });

    it("should revert when not creator or owner", async function () {
      await expect(
        knowledgeBundle.connect(agentB).deactivateBundle(0)
      ).to.be.revertedWithCustomError(knowledgeBundle, "NotBundleCreator");
    });

    it("should prevent modifications after deactivation", async function () {
      await knowledgeBundle.connect(agentA).deactivateBundle(0);

      await expect(
        knowledgeBundle.connect(agentA).addContent(0, [CID_2])
      ).to.be.revertedWithCustomError(knowledgeBundle, "BundleNotActive");
    });
  });

  // ============================================================
  //                     VIEW FUNCTIONS
  // ============================================================

  describe("View Functions", function () {
    beforeEach(async function () {
      const contribs = weights([
        { addr: agentA.address, bps: 6000 },
        { addr: agentB.address, bps: 4000 },
      ]);
      await knowledgeBundle
        .connect(agentA)
        .createBundle("Test Bundle", DESC_CID, [CID_1, CID_2], contribs);
    });

    it("getBundle should return correct data", async function () {
      const bundle = await knowledgeBundle.getBundle(0);
      expect(bundle.creator).to.equal(agentA.address);
      expect(bundle.name).to.equal("Test Bundle");
      expect(bundle.descriptionCid).to.equal(DESC_CID);
      expect(bundle.contentCids.length).to.equal(2);
      expect(bundle.isActive).to.be.true;
    });

    it("getBundleContent should return CID array", async function () {
      const content = await knowledgeBundle.getBundleContent(0);
      expect(content).to.deep.equal([CID_1, CID_2]);
    });

    it("getBundleContributors should return contributor array", async function () {
      const contributors = await knowledgeBundle.getBundleContributors(0);
      expect(contributors.length).to.equal(2);
      expect(contributors[0].contributor).to.equal(agentA.address);
      expect(contributors[0].weightBps).to.equal(6000);
    });

    it("getBundleCount should return correct count", async function () {
      expect(await knowledgeBundle.getBundleCount()).to.equal(1);
    });

    it("isBundleActive should return true for active bundle", async function () {
      expect(await knowledgeBundle.isBundleActive(0)).to.be.true;
    });

    it("should revert for non-existent bundle ID", async function () {
      await expect(
        knowledgeBundle.getBundle(999)
      ).to.be.revertedWithCustomError(knowledgeBundle, "BundleNotFound");
    });
  });

  // ============================================================
  //                     PAUSE / UNPAUSE
  // ============================================================

  describe("Pause/Unpause", function () {
    it("should block operations when paused", async function () {
      await knowledgeBundle.connect(owner).pause();

      const contribs = weights([{ addr: agentA.address, bps: 10000 }]);

      await expect(
        knowledgeBundle
          .connect(agentA)
          .createBundle("Bundle", "", [CID_1], contribs)
      ).to.be.revertedWithCustomError(knowledgeBundle, "EnforcedPause");
    });

    it("should allow operations after unpause", async function () {
      await knowledgeBundle.connect(owner).pause();
      await knowledgeBundle.connect(owner).unpause();

      const contribs = weights([{ addr: agentA.address, bps: 10000 }]);

      await expect(
        knowledgeBundle
          .connect(agentA)
          .createBundle("Bundle", "", [CID_1], contribs)
      ).to.not.be.reverted;
    });

    it("should only allow owner to pause", async function () {
      await expect(
        knowledgeBundle.connect(agentA).pause()
      ).to.be.revertedWithCustomError(
        knowledgeBundle,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  // ============================================================
  //                     META-TRANSACTION (ERC-2771)
  // ============================================================

  describe("ERC-2771 Support", function () {
    it("should report the trusted forwarder", async function () {
      expect(
        await knowledgeBundle.isTrustedForwarder(
          await forwarder.getAddress()
        )
      ).to.be.true;
    });
  });

  // ============================================================
  //                     ADMIN FUNCTIONS
  // ============================================================

  describe("Admin", function () {
    it("should allow owner to update agentRegistry", async function () {
      const newAddr = ethers.Wallet.createRandom().address;
      await knowledgeBundle.connect(owner).setAgentRegistry(newAddr);
      expect(await knowledgeBundle.agentRegistry()).to.equal(newAddr);
    });

    it("should allow owner to update contentIndex", async function () {
      const newAddr = ethers.Wallet.createRandom().address;
      await knowledgeBundle.connect(owner).setContentIndex(newAddr);
      expect(await knowledgeBundle.contentIndex()).to.equal(newAddr);
    });

    it("should revert setAgentRegistry with zero address", async function () {
      await expect(
        knowledgeBundle.connect(owner).setAgentRegistry(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(knowledgeBundle, "ZeroAddress");
    });

    it("should revert setContentIndex with zero address", async function () {
      await expect(
        knowledgeBundle.connect(owner).setContentIndex(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(knowledgeBundle, "ZeroAddress");
    });
  });
});
