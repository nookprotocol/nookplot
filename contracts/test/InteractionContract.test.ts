import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import {
  AgentRegistry,
  ContentIndex,
  InteractionContract,
  NookplotForwarder,
} from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("InteractionContract", function () {
  let registry: AgentRegistry;
  let contentIndex: ContentIndex;
  let interactions: InteractionContract;
  let forwarder: NookplotForwarder;
  let owner: SignerWithAddress;
  let treasury: SignerWithAddress;
  let agentA: SignerWithAddress;
  let agentB: SignerWithAddress;
  let agentC: SignerWithAddress;
  let nonAgent: SignerWithAddress;

  const DID_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const POST_CID = "QmPostCid1ForTestingInteractionContract123456789";
  const POST_CID_2 = "QmPostCid2ForTestingInteractionContract987654321";
  const COMMUNITY = "general";

  beforeEach(async function () {
    [owner, treasury, agentA, agentB, agentC, nonAgent] =
      await ethers.getSigners();

    // Deploy NookplotForwarder first
    const ForwarderFactory =
      await ethers.getContractFactory("NookplotForwarder");
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
    const ContentIndexFactory =
      await ethers.getContractFactory("ContentIndex");
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

    // Deploy InteractionContract
    const InteractionFactory = await ethers.getContractFactory(
      "InteractionContract"
    );
    interactions = (await upgrades.deployProxy(
      InteractionFactory,
      [
        owner.address,
        await registry.getAddress(),
        await contentIndex.getAddress(),
        treasury.address,
      ],
      {
        kind: "uups",
        constructorArgs: [forwarderAddress],
        unsafeAllow: ["constructor", "state-variable-immutable"],
      }
    )) as unknown as InteractionContract;
    await interactions.waitForDeployment();

    // Register agents and publish a post
    await registry.connect(agentA).register(DID_CID);
    await registry.connect(agentB).register(DID_CID);
    await registry.connect(agentC).register(DID_CID);
    await contentIndex.connect(agentA).publishPost(POST_CID, COMMUNITY);
    await contentIndex.connect(agentB).publishPost(POST_CID_2, COMMUNITY);
  });

  // ============================================================
  //                     INITIALIZATION
  // ============================================================

  describe("Initialization", function () {
    it("should set owner correctly", async function () {
      expect(await interactions.owner()).to.equal(owner.address);
    });

    it("should start with zero total votes", async function () {
      expect(await interactions.totalVotes()).to.equal(0);
    });

    it("should start in free mode", async function () {
      expect(await interactions.paymentToken()).to.equal(ethers.ZeroAddress);
    });
  });

  // ============================================================
  //                     UPVOTE
  // ============================================================

  describe("Upvote", function () {
    it("should upvote content successfully", async function () {
      await expect(interactions.connect(agentB).upvote(POST_CID))
        .to.emit(interactions, "Voted");
    });

    it("should increment upvote count", async function () {
      await interactions.connect(agentB).upvote(POST_CID);

      const votes = await interactions.getVotes(POST_CID);
      expect(votes.upvotes).to.equal(1);
      expect(votes.downvotes).to.equal(0);
    });

    it("should track voter's vote", async function () {
      await interactions.connect(agentB).upvote(POST_CID);

      expect(await interactions.getVote(POST_CID, agentB.address)).to.equal(1); // VoteType.Upvote
      expect(await interactions.hasVoted(POST_CID, agentB.address)).to.be.true;
    });

    it("should increment total votes", async function () {
      await interactions.connect(agentB).upvote(POST_CID);
      expect(await interactions.totalVotes()).to.equal(1);
    });

    it("should calculate score correctly", async function () {
      await interactions.connect(agentB).upvote(POST_CID);
      await interactions.connect(agentC).upvote(POST_CID);

      expect(await interactions.getScore(POST_CID)).to.equal(2);
    });

    it("should revert when voting on own content", async function () {
      await expect(
        interactions.connect(agentA).upvote(POST_CID) // agentA is the author
      ).to.be.revertedWithCustomError(interactions, "CannotVoteOwnContent");
    });

    it("should revert when already upvoted", async function () {
      await interactions.connect(agentB).upvote(POST_CID);
      await expect(
        interactions.connect(agentB).upvote(POST_CID)
      ).to.be.revertedWithCustomError(interactions, "SameVoteType");
    });

    it("should revert with empty CID", async function () {
      await expect(
        interactions.connect(agentB).upvote("")
      ).to.be.revertedWithCustomError(interactions, "EmptyString");
    });

    it("should revert when caller is not registered", async function () {
      await expect(
        interactions.connect(nonAgent).upvote(POST_CID)
      ).to.be.revertedWithCustomError(interactions, "NotRegisteredAgent");
    });

    it("should revert when content does not exist", async function () {
      await expect(
        interactions.connect(agentB).upvote("QmNonExistent")
      ).to.be.revertedWithCustomError(interactions, "ContentNotFound");
    });

    it("should revert when paused", async function () {
      await interactions.connect(owner).pause();
      await expect(
        interactions.connect(agentB).upvote(POST_CID)
      ).to.be.revertedWithCustomError(interactions, "EnforcedPause");
    });
  });

  // ============================================================
  //                     DOWNVOTE
  // ============================================================

  describe("Downvote", function () {
    it("should downvote content successfully", async function () {
      await interactions.connect(agentB).downvote(POST_CID);

      const votes = await interactions.getVotes(POST_CID);
      expect(votes.upvotes).to.equal(0);
      expect(votes.downvotes).to.equal(1);
    });

    it("should calculate negative score", async function () {
      await interactions.connect(agentB).downvote(POST_CID);
      await interactions.connect(agentC).downvote(POST_CID);

      expect(await interactions.getScore(POST_CID)).to.equal(-2);
    });

    it("should revert when already downvoted", async function () {
      await interactions.connect(agentB).downvote(POST_CID);
      await expect(
        interactions.connect(agentB).downvote(POST_CID)
      ).to.be.revertedWithCustomError(interactions, "SameVoteType");
    });
  });

  // ============================================================
  //                     VOTE CHANGES
  // ============================================================

  describe("Vote Changes", function () {
    it("should change from upvote to downvote", async function () {
      await interactions.connect(agentB).upvote(POST_CID);
      await expect(interactions.connect(agentB).downvote(POST_CID))
        .to.emit(interactions, "VoteChanged");

      const votes = await interactions.getVotes(POST_CID);
      expect(votes.upvotes).to.equal(0);
      expect(votes.downvotes).to.equal(1);
    });

    it("should change from downvote to upvote", async function () {
      await interactions.connect(agentB).downvote(POST_CID);
      await interactions.connect(agentB).upvote(POST_CID);

      const votes = await interactions.getVotes(POST_CID);
      expect(votes.upvotes).to.equal(1);
      expect(votes.downvotes).to.equal(0);
    });

    it("should not change total votes when switching vote type", async function () {
      await interactions.connect(agentB).upvote(POST_CID);
      expect(await interactions.totalVotes()).to.equal(1);

      await interactions.connect(agentB).downvote(POST_CID);
      expect(await interactions.totalVotes()).to.equal(1); // Still 1, just changed type
    });
  });

  // ============================================================
  //                     REMOVE VOTE
  // ============================================================

  describe("Remove Vote", function () {
    it("should remove an upvote", async function () {
      await interactions.connect(agentB).upvote(POST_CID);
      await expect(interactions.connect(agentB).removeVote(POST_CID))
        .to.emit(interactions, "VoteRemoved");

      const votes = await interactions.getVotes(POST_CID);
      expect(votes.upvotes).to.equal(0);
      expect(await interactions.hasVoted(POST_CID, agentB.address)).to.be.false;
      expect(await interactions.totalVotes()).to.equal(0);
    });

    it("should remove a downvote", async function () {
      await interactions.connect(agentB).downvote(POST_CID);
      await interactions.connect(agentB).removeVote(POST_CID);

      const votes = await interactions.getVotes(POST_CID);
      expect(votes.downvotes).to.equal(0);
    });

    it("should revert when no vote to remove", async function () {
      await expect(
        interactions.connect(agentB).removeVote(POST_CID)
      ).to.be.revertedWithCustomError(interactions, "NotVoted");
    });

    it("should revert with empty CID", async function () {
      await expect(
        interactions.connect(agentB).removeVote("")
      ).to.be.revertedWithCustomError(interactions, "EmptyString");
    });
  });

  // ============================================================
  //                     MIXED SCENARIOS
  // ============================================================

  describe("Mixed Voting Scenarios", function () {
    it("should handle multiple voters on same content", async function () {
      await interactions.connect(agentB).upvote(POST_CID);
      await interactions.connect(agentC).downvote(POST_CID);

      const votes = await interactions.getVotes(POST_CID);
      expect(votes.upvotes).to.equal(1);
      expect(votes.downvotes).to.equal(1);
      expect(await interactions.getScore(POST_CID)).to.equal(0);
    });

    it("should handle votes on different content independently", async function () {
      await interactions.connect(agentA).upvote(POST_CID_2); // A votes on B's post

      // agentC votes on both posts
      await interactions.connect(agentC).upvote(POST_CID);   // C upvotes A's post
      await interactions.connect(agentC).downvote(POST_CID_2); // C downvotes B's post

      expect(await interactions.getScore(POST_CID)).to.equal(1);   // 1 upvote
      expect(await interactions.getScore(POST_CID_2)).to.equal(0); // 1 up (A), 1 down (C)
    });

    it("should allow re-voting after removing vote", async function () {
      await interactions.connect(agentB).upvote(POST_CID);
      await interactions.connect(agentB).removeVote(POST_CID);
      await interactions.connect(agentB).downvote(POST_CID);

      const votes = await interactions.getVotes(POST_CID);
      expect(votes.upvotes).to.equal(0);
      expect(votes.downvotes).to.equal(1);
    });
  });

  // ============================================================
  //                     VIEW FUNCTIONS
  // ============================================================

  describe("View Functions", function () {
    it("getVote returns None for non-voters", async function () {
      expect(await interactions.getVote(POST_CID, agentB.address)).to.equal(0); // VoteType.None
    });

    it("hasVoted returns false for non-voters", async function () {
      expect(await interactions.hasVoted(POST_CID, agentB.address)).to.be.false;
    });

    it("getVotes returns zero counts for unvoted content", async function () {
      const votes = await interactions.getVotes("QmSomeCid");
      expect(votes.upvotes).to.equal(0);
      expect(votes.downvotes).to.equal(0);
    });

    it("getScore returns zero for unvoted content", async function () {
      expect(await interactions.getScore("QmSomeCid")).to.equal(0);
    });
  });

  // ============================================================
  //                     ADMIN FUNCTIONS
  // ============================================================

  describe("Admin Functions", function () {
    it("should update vote fee", async function () {
      await expect(interactions.connect(owner).setVoteFee(100))
        .to.emit(interactions, "VoteFeeUpdated")
        .withArgs(0, 100);
    });

    it("should update treasury", async function () {
      await expect(interactions.connect(owner).setTreasury(agentC.address))
        .to.emit(interactions, "TreasuryUpdated");
    });

    it("should revert setting zero address for treasury", async function () {
      await expect(
        interactions.connect(owner).setTreasury(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(interactions, "ZeroAddress");
    });

    it("should update payment token", async function () {
      const addr = "0x0000000000000000000000000000000000000001";
      await expect(interactions.connect(owner).setPaymentToken(addr))
        .to.emit(interactions, "PaymentTokenUpdated");
    });

    it("should revert admin calls from non-owner", async function () {
      await expect(
        interactions.connect(agentA).setVoteFee(100)
      ).to.be.revertedWithCustomError(interactions, "OwnableUnauthorizedAccount");
    });
  });

  // ============================================================
  //              META-TRANSACTIONS (ERC-2771)
  // ============================================================

  describe("Meta-Transactions (ERC-2771)", function () {
    it("should report the correct trusted forwarder", async function () {
      const forwarderAddress = await forwarder.getAddress();
      expect(await interactions.isTrustedForwarder(forwarderAddress)).to.be.true;
      expect(await interactions.isTrustedForwarder(owner.address)).to.be.false;
    });

    it("should allow upvoting via meta-transaction", async function () {
      // agentB signs a ForwardRequest to upvote agentA's post
      const nonce = await forwarder.nonces(agentB.address);
      const block = await ethers.provider.getBlock("latest");
      const deadline = block!.timestamp + 3600;
      const data = interactions.interface.encodeFunctionData("upvote", [
        POST_CID,
      ]);

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
        from: agentB.address,
        to: await interactions.getAddress(),
        value: 0n,
        gas: 500000n,
        nonce,
        deadline,
        data,
      };
      const signature = await agentB.signTypedData(domain, types, value);

      // Relayer (owner) submits the meta-transaction on behalf of agentB
      await forwarder.connect(owner).execute({ ...value, signature });

      // Verify the vote is recorded with agentB as the voter
      expect(await interactions.hasVoted(POST_CID, agentB.address)).to.be.true;
      expect(await interactions.getVote(POST_CID, agentB.address)).to.equal(1); // VoteType.Upvote

      const votes = await interactions.getVotes(POST_CID);
      expect(votes.upvotes).to.equal(1);
      expect(votes.downvotes).to.equal(0);
    });

    it("direct calls still work (backward compatibility)", async function () {
      await interactions.connect(agentB).upvote(POST_CID);

      expect(await interactions.hasVoted(POST_CID, agentB.address)).to.be.true;
      expect(await interactions.getVote(POST_CID, agentB.address)).to.equal(1); // VoteType.Upvote

      const votes = await interactions.getVotes(POST_CID);
      expect(votes.upvotes).to.equal(1);
    });
  });
});
