import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { AgentRegistry, ContentIndex, CommunityRegistry, NookplotForwarder } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("ContentIndex", function () {
  let registry: AgentRegistry;
  let contentIndex: ContentIndex;
  let forwarder: NookplotForwarder;
  let owner: SignerWithAddress;
  let treasury: SignerWithAddress;
  let agentA: SignerWithAddress;
  let agentB: SignerWithAddress;
  let nonAgent: SignerWithAddress;

  const DID_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const POST_CID_1 = "QmPostCid1ForTestingContentIndexContract12345678";
  const POST_CID_2 = "QmPostCid2ForTestingContentIndexContract87654321";
  const COMMENT_CID = "QmCommentCidForTestingContentIndexContract00000";
  const COMMUNITY = "ai-philosophy";
  const COMMUNITY_2 = "general";

  beforeEach(async function () {
    [owner, treasury, agentA, agentB, nonAgent] = await ethers.getSigners();

    // Deploy NookplotForwarder
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

    // Deploy ContentIndex
    const ContentIndexFactory = await ethers.getContractFactory("ContentIndex");
    contentIndex = (await upgrades.deployProxy(
      ContentIndexFactory,
      [owner.address, await registry.getAddress(), treasury.address],
      {
        kind: "uups",
        constructorArgs: [forwarderAddress],
        unsafeAllow: ["constructor", "state-variable-immutable"],
      }
    )) as unknown as ContentIndex;
    await contentIndex.waitForDeployment();

    // Register agents
    await registry.connect(agentA).register(DID_CID);
    await registry.connect(agentB).register(DID_CID);
  });

  // ============================================================
  //                     INITIALIZATION
  // ============================================================

  describe("Initialization", function () {
    it("should set owner correctly", async function () {
      expect(await contentIndex.owner()).to.equal(owner.address);
    });

    it("should set agentRegistry correctly", async function () {
      expect(await contentIndex.agentRegistry()).to.equal(await registry.getAddress());
    });

    it("should start with zero total content", async function () {
      expect(await contentIndex.totalContent()).to.equal(0);
    });

    it("should start in free mode", async function () {
      expect(await contentIndex.paymentToken()).to.equal(ethers.ZeroAddress);
    });
  });

  // ============================================================
  //                     PUBLISH POST
  // ============================================================

  describe("Publish Post", function () {
    it("should publish a post successfully", async function () {
      await expect(contentIndex.connect(agentA).publishPost(POST_CID_1, COMMUNITY))
        .to.emit(contentIndex, "ContentPublished");
    });

    it("should store content entry correctly", async function () {
      await contentIndex.connect(agentA).publishPost(POST_CID_1, COMMUNITY);

      const entry = await contentIndex.getContent(POST_CID_1);
      expect(entry.author).to.equal(agentA.address);
      expect(entry.community).to.equal(COMMUNITY);
      expect(entry.contentType).to.equal(0); // ContentType.Post
      expect(entry.parentCid).to.equal("");
      expect(entry.isActive).to.be.true;
      expect(entry.timestamp).to.be.greaterThan(0);
    });

    it("should increment counters", async function () {
      await contentIndex.connect(agentA).publishPost(POST_CID_1, COMMUNITY);

      expect(await contentIndex.totalContent()).to.equal(1);
      expect(await contentIndex.communityPostCount(COMMUNITY)).to.equal(1);
      expect(await contentIndex.authorPostCount(agentA.address)).to.equal(1);
    });

    it("should track multiple posts across communities", async function () {
      await contentIndex.connect(agentA).publishPost(POST_CID_1, COMMUNITY);
      await contentIndex.connect(agentB).publishPost(POST_CID_2, COMMUNITY_2);

      expect(await contentIndex.totalContent()).to.equal(2);
      expect(await contentIndex.communityPostCount(COMMUNITY)).to.equal(1);
      expect(await contentIndex.communityPostCount(COMMUNITY_2)).to.equal(1);
    });

    it("should revert with empty CID", async function () {
      await expect(
        contentIndex.connect(agentA).publishPost("", COMMUNITY)
      ).to.be.revertedWithCustomError(contentIndex, "EmptyString");
    });

    it("should revert with empty community", async function () {
      await expect(
        contentIndex.connect(agentA).publishPost(POST_CID_1, "")
      ).to.be.revertedWithCustomError(contentIndex, "EmptyString");
    });

    it("should revert when CID already exists", async function () {
      await contentIndex.connect(agentA).publishPost(POST_CID_1, COMMUNITY);
      await expect(
        contentIndex.connect(agentB).publishPost(POST_CID_1, COMMUNITY)
      ).to.be.revertedWithCustomError(contentIndex, "ContentAlreadyExists");
    });

    it("should revert when caller is not a registered agent", async function () {
      await expect(
        contentIndex.connect(nonAgent).publishPost(POST_CID_1, COMMUNITY)
      ).to.be.revertedWithCustomError(contentIndex, "NotRegisteredAgent");
    });

    it("should revert when caller is deactivated", async function () {
      await registry.connect(owner).deactivateAgent(agentA.address);
      await expect(
        contentIndex.connect(agentA).publishPost(POST_CID_1, COMMUNITY)
      ).to.be.revertedWithCustomError(contentIndex, "NotRegisteredAgent");
    });

    it("should revert with community name too long", async function () {
      const longCommunity = "a".repeat(101);
      await expect(
        contentIndex.connect(agentA).publishPost(POST_CID_1, longCommunity)
      ).to.be.revertedWithCustomError(contentIndex, "CommunityNameTooLong");
    });

    it("should revert when paused", async function () {
      await contentIndex.connect(owner).pause();
      await expect(
        contentIndex.connect(agentA).publishPost(POST_CID_1, COMMUNITY)
      ).to.be.revertedWithCustomError(contentIndex, "EnforcedPause");
    });
  });

  // ============================================================
  //                     PUBLISH COMMENT
  // ============================================================

  describe("Publish Comment", function () {
    beforeEach(async function () {
      await contentIndex.connect(agentA).publishPost(POST_CID_1, COMMUNITY);
    });

    it("should publish a comment on an existing post", async function () {
      await expect(
        contentIndex.connect(agentB).publishComment(COMMENT_CID, COMMUNITY, POST_CID_1)
      ).to.emit(contentIndex, "ContentPublished");

      const entry = await contentIndex.getContent(COMMENT_CID);
      expect(entry.contentType).to.equal(1); // ContentType.Comment
      expect(entry.parentCid).to.equal(POST_CID_1);
    });

    it("should revert when parent CID does not exist", async function () {
      await expect(
        contentIndex.connect(agentB).publishComment(COMMENT_CID, COMMUNITY, "QmNonExistent")
      ).to.be.revertedWithCustomError(contentIndex, "ContentNotFound");
    });

    it("should revert with empty parent CID", async function () {
      await expect(
        contentIndex.connect(agentB).publishComment(COMMENT_CID, COMMUNITY, "")
      ).to.be.revertedWithCustomError(contentIndex, "EmptyString");
    });
  });

  // ============================================================
  //                     VIEW FUNCTIONS
  // ============================================================

  describe("View Functions", function () {
    beforeEach(async function () {
      await contentIndex.connect(agentA).publishPost(POST_CID_1, COMMUNITY);
    });

    it("contentExists returns true for existing content", async function () {
      expect(await contentIndex.contentExists(POST_CID_1)).to.be.true;
    });

    it("contentExists returns false for non-existing content", async function () {
      expect(await contentIndex.contentExists("QmNonExistent")).to.be.false;
    });

    it("isContentActive returns true for active content", async function () {
      expect(await contentIndex.isContentActive(POST_CID_1)).to.be.true;
    });

    it("isContentActive returns false for moderated content", async function () {
      await contentIndex.connect(owner).moderateContent(POST_CID_1);
      expect(await contentIndex.isContentActive(POST_CID_1)).to.be.false;
    });

    it("getContent reverts for non-existing content", async function () {
      await expect(
        contentIndex.getContent("QmNonExistent")
      ).to.be.revertedWithCustomError(contentIndex, "ContentNotFound");
    });
  });

  // ============================================================
  //                     MODERATION
  // ============================================================

  describe("Moderation", function () {
    beforeEach(async function () {
      await contentIndex.connect(agentA).publishPost(POST_CID_1, COMMUNITY);
    });

    it("should moderate content", async function () {
      await expect(contentIndex.connect(owner).moderateContent(POST_CID_1))
        .to.emit(contentIndex, "ContentModerated");

      const entry = await contentIndex.getContent(POST_CID_1);
      expect(entry.isActive).to.be.false;
    });

    it("should restore moderated content", async function () {
      await contentIndex.connect(owner).moderateContent(POST_CID_1);
      await expect(contentIndex.connect(owner).restoreContent(POST_CID_1))
        .to.emit(contentIndex, "ContentRestored");

      const entry = await contentIndex.getContent(POST_CID_1);
      expect(entry.isActive).to.be.true;
    });

    it("should revert moderation by non-owner", async function () {
      await expect(
        contentIndex.connect(agentA).moderateContent(POST_CID_1)
      ).to.be.revertedWithCustomError(contentIndex, "NotAuthorized");
    });

    it("should revert moderating non-existing content", async function () {
      await expect(
        contentIndex.connect(owner).moderateContent("QmNonExistent")
      ).to.be.revertedWithCustomError(contentIndex, "ContentNotFound");
    });
  });

  // ============================================================
  //                     ADMIN FUNCTIONS
  // ============================================================

  describe("Admin Functions", function () {
    it("should update agent registry", async function () {
      const newAddr = agentB.address;
      await expect(contentIndex.connect(owner).setAgentRegistry(newAddr))
        .to.emit(contentIndex, "AgentRegistryUpdated");
    });

    it("should revert setting zero address for registry", async function () {
      await expect(
        contentIndex.connect(owner).setAgentRegistry(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(contentIndex, "ZeroAddress");
    });

    it("should update post fee", async function () {
      await expect(contentIndex.connect(owner).setPostFee(1000))
        .to.emit(contentIndex, "PostFeeUpdated")
        .withArgs(0, 1000);
    });

    it("should set community registry", async function () {
      await expect(contentIndex.connect(owner).setCommunityRegistry(agentA.address))
        .to.emit(contentIndex, "CommunityRegistryUpdated");
    });

    it("should set community registry to zero address", async function () {
      await contentIndex.connect(owner).setCommunityRegistry(agentA.address);
      await contentIndex.connect(owner).setCommunityRegistry(ethers.ZeroAddress);
      expect(await contentIndex.communityRegistry()).to.equal(ethers.ZeroAddress);
    });

    it("should revert setCommunityRegistry by non-owner", async function () {
      await expect(
        contentIndex.connect(agentA).setCommunityRegistry(agentA.address)
      ).to.be.revertedWithCustomError(contentIndex, "OwnableUnauthorizedAccount");
    });
  });

  // ============================================================
  //                 COMMUNITY INTEGRATION
  // ============================================================

  describe("Community Integration", function () {
    let communityRegistry: CommunityRegistry;
    const META_CID = "QmCommunityMetadataForIntegrationTests12345678";
    const POST_CID_INT = "QmPostForCommunityIntegrationTests12345678901";
    const POST_CID_INT_2 = "QmPostForCommunityIntegrationTests23456789012";
    const POST_CID_INT_3 = "QmPostForCommunityIntegrationTests34567890123";

    beforeEach(async function () {
      // Deploy CommunityRegistry
      const CommunityFactory = await ethers.getContractFactory("CommunityRegistry");
      communityRegistry = (await upgrades.deployProxy(
        CommunityFactory,
        [owner.address, await registry.getAddress(), treasury.address],
        {
          kind: "uups",
          constructorArgs: [await forwarder.getAddress()],
          unsafeAllow: ["constructor", "state-variable-immutable"],
        }
      )) as unknown as CommunityRegistry;
      await communityRegistry.waitForDeployment();

      // Wire ContentIndex to CommunityRegistry
      await contentIndex.connect(owner).setCommunityRegistry(await communityRegistry.getAddress());

      // Create a community
      await communityRegistry.connect(agentA).createCommunity(COMMUNITY, META_CID, 0);
    });

    it("should allow posting to an existing community", async function () {
      await expect(contentIndex.connect(agentA).publishPost(POST_CID_INT, COMMUNITY))
        .to.emit(contentIndex, "ContentPublished");
    });

    it("should revert posting to a non-existent community", async function () {
      await expect(
        contentIndex.connect(agentA).publishPost(POST_CID_INT, "nonexistent")
      ).to.be.revertedWithCustomError(contentIndex, "PostingNotAllowed");
    });

    it("should revert posting to a deactivated community", async function () {
      await communityRegistry.connect(agentA).deactivateCommunity(COMMUNITY);
      await expect(
        contentIndex.connect(agentA).publishPost(POST_CID_INT, COMMUNITY)
      ).to.be.revertedWithCustomError(contentIndex, "PostingNotAllowed");
    });

    it("should enforce approved-only policy", async function () {
      // Create approved-only community
      await communityRegistry.connect(agentA).createCommunity("restricted", META_CID, 2);

      // Agent B (not approved) should be rejected
      await expect(
        contentIndex.connect(agentB).publishPost(POST_CID_INT, "restricted")
      ).to.be.revertedWithCustomError(contentIndex, "PostingNotAllowed");

      // Approve agent B
      await communityRegistry.connect(agentA).approvePoster("restricted", agentB.address);

      // Now agent B can post
      await expect(contentIndex.connect(agentB).publishPost(POST_CID_INT, "restricted"))
        .to.emit(contentIndex, "ContentPublished");
    });

    it("should work without registry (backward compat)", async function () {
      // Remove community registry
      await contentIndex.connect(owner).setCommunityRegistry(ethers.ZeroAddress);

      // Any slug should work
      await expect(contentIndex.connect(agentA).publishPost(POST_CID_INT, "random-slug"))
        .to.emit(contentIndex, "ContentPublished");
    });

    it("should allow community moderator to moderate content", async function () {
      // Post something
      await contentIndex.connect(agentB).publishPost(POST_CID_INT, COMMUNITY);

      // Add agentB as moderator of the community
      await communityRegistry.connect(agentA).addModerator(COMMUNITY, agentB.address);

      // AgentB (community mod) should be able to moderate
      await expect(contentIndex.connect(agentB).moderateContent(POST_CID_INT))
        .to.emit(contentIndex, "ContentModerated");
    });

    it("should allow community moderator to restore content", async function () {
      await contentIndex.connect(agentB).publishPost(POST_CID_INT, COMMUNITY);
      await communityRegistry.connect(agentA).addModerator(COMMUNITY, agentB.address);

      // Moderate then restore
      await contentIndex.connect(agentB).moderateContent(POST_CID_INT);
      await expect(contentIndex.connect(agentB).restoreContent(POST_CID_INT))
        .to.emit(contentIndex, "ContentRestored");
    });

    it("should revert moderation by non-moderator agent", async function () {
      await contentIndex.connect(agentA).publishPost(POST_CID_INT, COMMUNITY);
      await expect(
        contentIndex.connect(agentB).moderateContent(POST_CID_INT)
      ).to.be.revertedWithCustomError(contentIndex, "NotAuthorized");
    });

    it("should allow owner to moderate regardless of community registry", async function () {
      await contentIndex.connect(agentA).publishPost(POST_CID_INT, COMMUNITY);
      await expect(contentIndex.connect(owner).moderateContent(POST_CID_INT))
        .to.emit(contentIndex, "ContentModerated");
    });

    it("should allow creator to moderate (creator is always moderator)", async function () {
      await contentIndex.connect(agentB).publishPost(POST_CID_INT, COMMUNITY);
      // agentA is the community creator and first moderator
      await expect(contentIndex.connect(agentA).moderateContent(POST_CID_INT))
        .to.emit(contentIndex, "ContentModerated");
    });
  });

  // ============================================================
  //              META-TRANSACTIONS (ERC-2771)
  // ============================================================

  describe("Meta-Transactions (ERC-2771)", function () {
    const META_POST_CID = "QmMetaTxPostCidForTestingForwarder1234567890";
    const META_POST_CID_2 = "QmMetaTxPostCidForDirectCallBackwardCompat01";
    const META_COMMUNITY = "meta-tx-community";

    it("should report the correct trusted forwarder", async function () {
      const forwarderAddress = await forwarder.getAddress();
      expect(await contentIndex.isTrustedForwarder(forwarderAddress)).to.be.true;
      expect(await contentIndex.isTrustedForwarder(agentA.address)).to.be.false;
    });

    it("should allow publishing a post via meta-transaction", async function () {
      const cid = META_POST_CID;
      const community = META_COMMUNITY;

      // Build the ForwardRequest
      const nonce = await forwarder.nonces(agentA.address);
      const block = await ethers.provider.getBlock("latest");
      const deadline = block!.timestamp + 3600;
      const data = contentIndex.interface.encodeFunctionData("publishPost", [cid, community]);

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
        to: await contentIndex.getAddress(),
        value: 0n,
        gas: 500000n,
        nonce,
        deadline,
        data,
      };
      const signature = await agentA.signTypedData(domain, types, value);

      // Relayer (owner) submits the meta-transaction
      await forwarder.connect(owner).execute({ ...value, signature });

      // Verify the post was recorded with agentA as the author
      const entry = await contentIndex.getContent(cid);
      expect(entry.author).to.equal(agentA.address);
      expect(entry.community).to.equal(community);
      expect(entry.contentType).to.equal(0); // ContentType.Post
      expect(entry.isActive).to.be.true;
      expect(await contentIndex.totalContent()).to.equal(1);
      expect(await contentIndex.authorPostCount(agentA.address)).to.equal(1);
    });

    it("direct calls still work (backward compatibility)", async function () {
      await expect(
        contentIndex.connect(agentA).publishPost(META_POST_CID_2, META_COMMUNITY)
      ).to.emit(contentIndex, "ContentPublished");

      const entry = await contentIndex.getContent(META_POST_CID_2);
      expect(entry.author).to.equal(agentA.address);
      expect(entry.community).to.equal(META_COMMUNITY);
    });
  });

  // ============================================================
  //                  CITATIONS (V2)
  // ============================================================

  describe("Citations (V2)", function () {
    const SOURCE_CID = "QmSourcePaperCidForCitationTestingInContract01";
    const SOURCE_CID_2 = "QmSourcePaperCidForCitationTestingInContract02";
    const CITED_CID_1 = "QmCitedPaperOneCidForCitationTestingContract01";
    const CITED_CID_2 = "QmCitedPaperTwoCidForCitationTestingContract02";
    const CITED_CID_3 = "QmCitedPaperThreeCidCitationTestingContract03";
    const EXTERNAL_CID = "QmExternalPaperNotInContentIndexButStillCited";

    // Helper to compute cidHash matching Solidity's keccak256(abi.encode(cid))
    function cidHash(cid: string): string {
      return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string"], [cid]));
    }

    describe("publishPostWithCitations", function () {
      it("should publish a post with citations in one transaction", async function () {
        await expect(
          contentIndex.connect(agentA).publishPostWithCitations(
            SOURCE_CID, COMMUNITY, [CITED_CID_1, CITED_CID_2]
          )
        ).to.emit(contentIndex, "ContentPublished")
         .and.to.emit(contentIndex, "CitationAdded");

        // Post should exist
        const entry = await contentIndex.getContent(SOURCE_CID);
        expect(entry.author).to.equal(agentA.address);
        expect(entry.isActive).to.be.true;

        // Citations should be recorded
        const citations = await contentIndex.getCitations(SOURCE_CID);
        expect(citations.length).to.equal(2);
        expect(citations[0]).to.equal(cidHash(CITED_CID_1));
        expect(citations[1]).to.equal(cidHash(CITED_CID_2));

        // Total citations counter
        expect(await contentIndex.totalCitations()).to.equal(2);
      });

      it("should create reverse index entries", async function () {
        await contentIndex.connect(agentA).publishPostWithCitations(
          SOURCE_CID, COMMUNITY, [CITED_CID_1]
        );

        const citedBy = await contentIndex.getCitedBy(CITED_CID_1);
        expect(citedBy.length).to.equal(1);
        expect(citedBy[0]).to.equal(cidHash(SOURCE_CID));
      });

      it("should allow citing CIDs that do not exist in ContentIndex", async function () {
        // EXTERNAL_CID is not published — citations should still work
        await expect(
          contentIndex.connect(agentA).publishPostWithCitations(
            SOURCE_CID, COMMUNITY, [EXTERNAL_CID]
          )
        ).to.not.be.reverted;

        const citations = await contentIndex.getCitations(SOURCE_CID);
        expect(citations.length).to.equal(1);
        expect(citations[0]).to.equal(cidHash(EXTERNAL_CID));
      });

      it("should publish with zero citations", async function () {
        await expect(
          contentIndex.connect(agentA).publishPostWithCitations(
            SOURCE_CID, COMMUNITY, []
          )
        ).to.emit(contentIndex, "ContentPublished");

        const citations = await contentIndex.getCitations(SOURCE_CID);
        expect(citations.length).to.equal(0);
        expect(await contentIndex.totalCitations()).to.equal(0);
      });

      it("should revert when too many citations", async function () {
        const tooMany = Array.from({ length: 51 }, (_, i) => `QmCited${i.toString().padStart(42, "0")}`);
        await expect(
          contentIndex.connect(agentA).publishPostWithCitations(
            SOURCE_CID, COMMUNITY, tooMany
          )
        ).to.be.revertedWithCustomError(contentIndex, "TooManyCitations");
      });

      it("should allow exactly 50 citations", async function () {
        const max = Array.from({ length: 50 }, (_, i) => `QmMaxCite${i.toString().padStart(41, "0")}`);
        await expect(
          contentIndex.connect(agentA).publishPostWithCitations(
            SOURCE_CID, COMMUNITY, max
          )
        ).to.not.be.reverted;

        expect(await contentIndex.totalCitations()).to.equal(50);
      });

      it("should revert when citing self", async function () {
        await expect(
          contentIndex.connect(agentA).publishPostWithCitations(
            SOURCE_CID, COMMUNITY, [SOURCE_CID]
          )
        ).to.be.revertedWithCustomError(contentIndex, "CannotCiteSelf");
      });

      it("should revert with empty cited CID", async function () {
        await expect(
          contentIndex.connect(agentA).publishPostWithCitations(
            SOURCE_CID, COMMUNITY, [""]
          )
        ).to.be.revertedWithCustomError(contentIndex, "EmptyString");
      });
    });

    describe("addCitations", function () {
      beforeEach(async function () {
        await contentIndex.connect(agentA).publishPost(SOURCE_CID, COMMUNITY);
      });

      it("should add citations to existing content", async function () {
        await expect(
          contentIndex.connect(agentA).addCitations(SOURCE_CID, [CITED_CID_1, CITED_CID_2])
        ).to.emit(contentIndex, "CitationAdded");

        const citations = await contentIndex.getCitations(SOURCE_CID);
        expect(citations.length).to.equal(2);
        expect(await contentIndex.totalCitations()).to.equal(2);
      });

      it("should skip duplicate citations silently", async function () {
        await contentIndex.connect(agentA).addCitations(SOURCE_CID, [CITED_CID_1]);
        await contentIndex.connect(agentA).addCitations(SOURCE_CID, [CITED_CID_1, CITED_CID_2]);

        const citations = await contentIndex.getCitations(SOURCE_CID);
        expect(citations.length).to.equal(2); // CITED_CID_1 only counted once
        expect(await contentIndex.totalCitations()).to.equal(2);
      });

      it("should skip in-batch duplicates silently", async function () {
        await contentIndex.connect(agentA).addCitations(SOURCE_CID, [CITED_CID_1, CITED_CID_1]);

        const citations = await contentIndex.getCitations(SOURCE_CID);
        expect(citations.length).to.equal(1);
        expect(await contentIndex.totalCitations()).to.equal(1);
      });

      it("should revert when content does not exist", async function () {
        await expect(
          contentIndex.connect(agentA).addCitations("QmNonExistent", [CITED_CID_1])
        ).to.be.revertedWithCustomError(contentIndex, "ContentNotFound");
      });

      it("should revert when caller is not author or owner", async function () {
        await expect(
          contentIndex.connect(agentB).addCitations(SOURCE_CID, [CITED_CID_1])
        ).to.be.revertedWithCustomError(contentIndex, "NotAuthorized");
      });

      it("should allow owner to add citations to any content", async function () {
        await expect(
          contentIndex.connect(owner).addCitations(SOURCE_CID, [CITED_CID_1])
        ).to.not.be.reverted;

        const citations = await contentIndex.getCitations(SOURCE_CID);
        expect(citations.length).to.equal(1);
      });

      it("should revert when too many citations", async function () {
        const tooMany = Array.from({ length: 51 }, (_, i) => `QmCitedAdd${i.toString().padStart(40, "0")}`);
        await expect(
          contentIndex.connect(agentA).addCitations(SOURCE_CID, tooMany)
        ).to.be.revertedWithCustomError(contentIndex, "TooManyCitations");
      });

      it("should revert when paused", async function () {
        await contentIndex.connect(owner).pause();
        await expect(
          contentIndex.connect(agentA).addCitations(SOURCE_CID, [CITED_CID_1])
        ).to.be.revertedWithCustomError(contentIndex, "EnforcedPause");
      });
    });

    describe("Reverse index (getCitedBy)", function () {
      it("should track multiple sources citing the same content", async function () {
        await contentIndex.connect(agentA).publishPostWithCitations(
          SOURCE_CID, COMMUNITY, [CITED_CID_1]
        );
        await contentIndex.connect(agentB).publishPostWithCitations(
          SOURCE_CID_2, COMMUNITY, [CITED_CID_1]
        );

        const citedBy = await contentIndex.getCitedBy(CITED_CID_1);
        expect(citedBy.length).to.equal(2);
        expect(citedBy[0]).to.equal(cidHash(SOURCE_CID));
        expect(citedBy[1]).to.equal(cidHash(SOURCE_CID_2));
      });

      it("should return empty for content with no inbound citations", async function () {
        const citedBy = await contentIndex.getCitedBy("QmNeverCited");
        expect(citedBy.length).to.equal(0);
      });
    });

    describe("getCitationCount", function () {
      it("should return correct outbound and inbound counts", async function () {
        // SOURCE_CID cites CITED_CID_1, CITED_CID_2, CITED_CID_3
        await contentIndex.connect(agentA).publishPostWithCitations(
          SOURCE_CID, COMMUNITY, [CITED_CID_1, CITED_CID_2, CITED_CID_3]
        );
        // SOURCE_CID_2 cites CITED_CID_1 only
        await contentIndex.connect(agentB).publishPostWithCitations(
          SOURCE_CID_2, COMMUNITY, [CITED_CID_1]
        );

        // SOURCE_CID: 3 outbound, 0 inbound
        const [outSource, inSource] = await contentIndex.getCitationCount(SOURCE_CID);
        expect(outSource).to.equal(3);
        expect(inSource).to.equal(0);

        // CITED_CID_1: 0 outbound, 2 inbound (cited by SOURCE_CID and SOURCE_CID_2)
        const [outCited1, inCited1] = await contentIndex.getCitationCount(CITED_CID_1);
        expect(outCited1).to.equal(0);
        expect(inCited1).to.equal(2);

        // CITED_CID_2: 0 outbound, 1 inbound
        const [outCited2, inCited2] = await contentIndex.getCitationCount(CITED_CID_2);
        expect(outCited2).to.equal(0);
        expect(inCited2).to.equal(1);
      });

      it("should return zeros for non-existing content", async function () {
        const [outbound, inbound] = await contentIndex.getCitationCount("QmNonExistent");
        expect(outbound).to.equal(0);
        expect(inbound).to.equal(0);
      });
    });

    describe("CitationAdded event", function () {
      it("should emit correct event parameters", async function () {
        const sourceHash = cidHash(SOURCE_CID);
        const citedHash = cidHash(CITED_CID_1);

        await expect(
          contentIndex.connect(agentA).publishPostWithCitations(
            SOURCE_CID, COMMUNITY, [CITED_CID_1]
          )
        ).to.emit(contentIndex, "CitationAdded")
         .withArgs(sourceHash, citedHash, SOURCE_CID, CITED_CID_1, (v: bigint) => v > 0n);
      });

      it("should emit one event per citation", async function () {
        const tx = await contentIndex.connect(agentA).publishPostWithCitations(
          SOURCE_CID, COMMUNITY, [CITED_CID_1, CITED_CID_2, CITED_CID_3]
        );
        const receipt = await tx.wait();
        const citationEvents = receipt!.logs.filter(
          (log) => {
            try {
              return contentIndex.interface.parseLog(log as any)?.name === "CitationAdded";
            } catch { return false; }
          }
        );
        expect(citationEvents.length).to.equal(3);
      });
    });

    describe("initializeV2", function () {
      it("should not be callable twice", async function () {
        await contentIndex.initializeV2();
        await expect(contentIndex.initializeV2())
          .to.be.revertedWithCustomError(contentIndex, "InvalidInitialization");
      });
    });

    describe("Storage preservation across upgrade", function () {
      it("should preserve existing content and counters after V2 upgrade", async function () {
        // Publish content in V1
        await contentIndex.connect(agentA).publishPost(SOURCE_CID, COMMUNITY);
        expect(await contentIndex.totalContent()).to.equal(1);

        // Upgrade to V2 (simulate by calling initializeV2)
        await contentIndex.initializeV2();

        // V1 data preserved
        const entry = await contentIndex.getContent(SOURCE_CID);
        expect(entry.author).to.equal(agentA.address);
        expect(entry.community).to.equal(COMMUNITY);
        expect(await contentIndex.totalContent()).to.equal(1);

        // V2 citation features work
        await contentIndex.connect(agentA).addCitations(SOURCE_CID, [CITED_CID_1]);
        const citations = await contentIndex.getCitations(SOURCE_CID);
        expect(citations.length).to.equal(1);
        expect(await contentIndex.totalCitations()).to.equal(1);
      });

      it("should start with zero citations", async function () {
        await contentIndex.initializeV2();
        expect(await contentIndex.totalCitations()).to.equal(0);
      });
    });
  });
});
