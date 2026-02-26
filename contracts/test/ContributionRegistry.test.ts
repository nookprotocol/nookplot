import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { AgentRegistry, ContributionRegistry, NookplotForwarder } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("ContributionRegistry", function () {
  let registry: AgentRegistry;
  let contributionRegistry: ContributionRegistry;
  let forwarder: NookplotForwarder;
  let owner: SignerWithAddress;
  let treasury: SignerWithAddress;
  let agentA: SignerWithAddress;
  let agentB: SignerWithAddress;
  let nonAgent: SignerWithAddress;

  const DID_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const BREAKDOWN_CID = "QmBreakdownCidForTestingContributionRegistry1234";
  const BREAKDOWN_CID_2 = "QmBreakdownCidForTestingContributionRegistry5678";
  const TAGS = "TypeScript,Solidity,React";

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

    // Deploy ContributionRegistry
    const ContributionRegistryFactory = await ethers.getContractFactory("ContributionRegistry");
    contributionRegistry = (await upgrades.deployProxy(
      ContributionRegistryFactory,
      [owner.address, await registry.getAddress()],
      {
        kind: "uups",
        constructorArgs: [forwarderAddress],
        unsafeAllow: ["constructor", "state-variable-immutable"],
      }
    )) as unknown as ContributionRegistry;
    await contributionRegistry.waitForDeployment();

    // Register agents
    await registry.connect(agentA).register(DID_CID);
    await registry.connect(agentB).register(DID_CID);
  });

  // ============================================================
  //                     INITIALIZATION
  // ============================================================

  describe("Initialization", function () {
    it("should set the owner correctly", async function () {
      expect(await contributionRegistry.owner()).to.equal(owner.address);
    });

    it("should set the agentRegistry correctly", async function () {
      expect(await contributionRegistry.agentRegistry()).to.equal(await registry.getAddress());
    });

    it("should not be paused initially", async function () {
      expect(await contributionRegistry.paused()).to.be.false;
    });

    it("should revert if initialized with zero owner", async function () {
      const forwarderAddress = await forwarder.getAddress();
      const Factory = await ethers.getContractFactory("ContributionRegistry");
      await expect(
        upgrades.deployProxy(Factory, [ethers.ZeroAddress, await registry.getAddress()], {
          kind: "uups",
          constructorArgs: [forwarderAddress],
          unsafeAllow: ["constructor", "state-variable-immutable"],
        })
      ).to.be.revertedWithCustomError(contributionRegistry, "ZeroAddress");
    });

    it("should revert if initialized with zero agentRegistry", async function () {
      const forwarderAddress = await forwarder.getAddress();
      const Factory = await ethers.getContractFactory("ContributionRegistry");
      await expect(
        upgrades.deployProxy(Factory, [owner.address, ethers.ZeroAddress], {
          kind: "uups",
          constructorArgs: [forwarderAddress],
          unsafeAllow: ["constructor", "state-variable-immutable"],
        })
      ).to.be.revertedWithCustomError(contributionRegistry, "ZeroAddress");
    });
  });

  // ============================================================
  //                  SET CONTRIBUTION SCORE
  // ============================================================

  describe("setContributionScore", function () {
    it("should set a contribution score and emit event", async function () {
      const tx = await contributionRegistry.connect(owner).setContributionScore(agentA.address, 7500, BREAKDOWN_CID);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      await expect(tx)
        .to.emit(contributionRegistry, "ContributionScoreUpdated")
        .withArgs(agentA.address, 7500, BREAKDOWN_CID, block!.timestamp);
    });

    it("should store score, breakdown CID, and lastUpdated", async function () {
      await contributionRegistry.connect(owner).setContributionScore(agentA.address, 5000, BREAKDOWN_CID);

      expect(await contributionRegistry.getContributionScore(agentA.address)).to.equal(5000);
      expect(await contributionRegistry.getBreakdownCid(agentA.address)).to.equal(BREAKDOWN_CID);
      expect(await contributionRegistry.getLastUpdated(agentA.address)).to.be.greaterThan(0);
    });

    it("should allow setting score to zero", async function () {
      await contributionRegistry.connect(owner).setContributionScore(agentA.address, 5000, BREAKDOWN_CID);
      await contributionRegistry.connect(owner).setContributionScore(agentA.address, 0, BREAKDOWN_CID_2);
      expect(await contributionRegistry.getContributionScore(agentA.address)).to.equal(0);
    });

    it("should allow setting score to MAX_SCORE (10000)", async function () {
      await contributionRegistry.connect(owner).setContributionScore(agentA.address, 10000, BREAKDOWN_CID);
      expect(await contributionRegistry.getContributionScore(agentA.address)).to.equal(10000);
    });

    it("should overwrite a previous score", async function () {
      await contributionRegistry.connect(owner).setContributionScore(agentA.address, 3000, BREAKDOWN_CID);
      await contributionRegistry.connect(owner).setContributionScore(agentA.address, 8000, BREAKDOWN_CID_2);

      expect(await contributionRegistry.getContributionScore(agentA.address)).to.equal(8000);
      expect(await contributionRegistry.getBreakdownCid(agentA.address)).to.equal(BREAKDOWN_CID_2);
    });

    it("should revert when called by non-owner", async function () {
      await expect(
        contributionRegistry.connect(agentA).setContributionScore(agentA.address, 5000, BREAKDOWN_CID)
      ).to.be.revertedWithCustomError(contributionRegistry, "OwnableUnauthorizedAccount");
    });

    it("should revert when score exceeds MAX_SCORE", async function () {
      await expect(
        contributionRegistry.connect(owner).setContributionScore(agentA.address, 10001, BREAKDOWN_CID)
      ).to.be.revertedWithCustomError(contributionRegistry, "ScoreTooHigh");
    });

    it("should revert when agent is not registered", async function () {
      await expect(
        contributionRegistry.connect(owner).setContributionScore(nonAgent.address, 5000, BREAKDOWN_CID)
      ).to.be.revertedWithCustomError(contributionRegistry, "NotRegisteredAgent");
    });

    it("should revert when breakdownCid is empty", async function () {
      await expect(
        contributionRegistry.connect(owner).setContributionScore(agentA.address, 5000, "")
      ).to.be.revertedWithCustomError(contributionRegistry, "EmptyCid");
    });

    it("should revert when agent address is zero", async function () {
      await expect(
        contributionRegistry.connect(owner).setContributionScore(ethers.ZeroAddress, 5000, BREAKDOWN_CID)
      ).to.be.revertedWithCustomError(contributionRegistry, "ZeroAddress");
    });
  });

  // ============================================================
  //                    SET EXPERTISE TAGS
  // ============================================================

  describe("setExpertiseTags", function () {
    it("should set expertise tags and emit event", async function () {
      const tx = await contributionRegistry.connect(owner).setExpertiseTags(agentA.address, TAGS);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      await expect(tx)
        .to.emit(contributionRegistry, "ExpertiseTagsUpdated")
        .withArgs(agentA.address, TAGS, block!.timestamp);
    });

    it("should store expertise tags and update lastUpdated", async function () {
      await contributionRegistry.connect(owner).setExpertiseTags(agentA.address, TAGS);

      expect(await contributionRegistry.getExpertiseTags(agentA.address)).to.equal(TAGS);
      expect(await contributionRegistry.getLastUpdated(agentA.address)).to.be.greaterThan(0);
    });

    it("should allow setting empty tags (clearing tags)", async function () {
      await contributionRegistry.connect(owner).setExpertiseTags(agentA.address, TAGS);
      await contributionRegistry.connect(owner).setExpertiseTags(agentA.address, "");
      expect(await contributionRegistry.getExpertiseTags(agentA.address)).to.equal("");
    });

    it("should revert when called by non-owner", async function () {
      await expect(
        contributionRegistry.connect(agentA).setExpertiseTags(agentA.address, TAGS)
      ).to.be.revertedWithCustomError(contributionRegistry, "OwnableUnauthorizedAccount");
    });

    it("should revert when tags exceed MAX_TAGS_LENGTH (500 chars)", async function () {
      const longTags = "a".repeat(501);
      await expect(
        contributionRegistry.connect(owner).setExpertiseTags(agentA.address, longTags)
      ).to.be.revertedWithCustomError(contributionRegistry, "TagsTooLong");
    });

    it("should allow tags at exactly MAX_TAGS_LENGTH (500 chars)", async function () {
      const maxTags = "a".repeat(500);
      await contributionRegistry.connect(owner).setExpertiseTags(agentA.address, maxTags);
      expect(await contributionRegistry.getExpertiseTags(agentA.address)).to.equal(maxTags);
    });

    it("should revert when agent address is zero", async function () {
      await expect(
        contributionRegistry.connect(owner).setExpertiseTags(ethers.ZeroAddress, TAGS)
      ).to.be.revertedWithCustomError(contributionRegistry, "ZeroAddress");
    });

    it("should revert when agent is not registered", async function () {
      await expect(
        contributionRegistry.connect(owner).setExpertiseTags(nonAgent.address, TAGS)
      ).to.be.revertedWithCustomError(contributionRegistry, "NotRegisteredAgent");
    });
  });

  // ============================================================
  //                    BATCH SET SCORES
  // ============================================================

  describe("batchSetScores", function () {
    it("should batch set scores for multiple agents", async function () {
      const tx = await contributionRegistry.connect(owner).batchSetScores(
        [agentA.address, agentB.address],
        [7500, 3000],
        [BREAKDOWN_CID, BREAKDOWN_CID_2]
      );

      await expect(tx)
        .to.emit(contributionRegistry, "ContributionScoreUpdated")
        .withArgs(agentA.address, 7500, BREAKDOWN_CID, await getBlockTimestamp(tx));

      await expect(tx)
        .to.emit(contributionRegistry, "ContributionScoreUpdated")
        .withArgs(agentB.address, 3000, BREAKDOWN_CID_2, await getBlockTimestamp(tx));

      expect(await contributionRegistry.getContributionScore(agentA.address)).to.equal(7500);
      expect(await contributionRegistry.getContributionScore(agentB.address)).to.equal(3000);
    });

    it("should handle batch of size 1", async function () {
      await contributionRegistry.connect(owner).batchSetScores(
        [agentA.address],
        [9999],
        [BREAKDOWN_CID]
      );
      expect(await contributionRegistry.getContributionScore(agentA.address)).to.equal(9999);
    });

    it("should revert when array lengths do not match", async function () {
      await expect(
        contributionRegistry.connect(owner).batchSetScores(
          [agentA.address, agentB.address],
          [5000],
          [BREAKDOWN_CID, BREAKDOWN_CID_2]
        )
      ).to.be.revertedWithCustomError(contributionRegistry, "ArrayLengthMismatch");
    });

    it("should revert when CID array length does not match", async function () {
      await expect(
        contributionRegistry.connect(owner).batchSetScores(
          [agentA.address, agentB.address],
          [5000, 6000],
          [BREAKDOWN_CID]
        )
      ).to.be.revertedWithCustomError(contributionRegistry, "ArrayLengthMismatch");
    });

    it("should revert when batch exceeds MAX_BATCH_SIZE (50)", async function () {
      const agents: string[] = [];
      const scores: number[] = [];
      const cids: string[] = [];
      // Generate 51 entries — only agentA and agentB are registered,
      // but BatchTooLarge should revert before agent validation
      for (let i = 0; i < 51; i++) {
        agents.push(agentA.address);
        scores.push(1000);
        cids.push(BREAKDOWN_CID);
      }
      await expect(
        contributionRegistry.connect(owner).batchSetScores(agents, scores, cids)
      ).to.be.revertedWithCustomError(contributionRegistry, "BatchTooLarge");
    });

    it("should revert when any individual score exceeds MAX_SCORE", async function () {
      await expect(
        contributionRegistry.connect(owner).batchSetScores(
          [agentA.address, agentB.address],
          [5000, 10001],
          [BREAKDOWN_CID, BREAKDOWN_CID_2]
        )
      ).to.be.revertedWithCustomError(contributionRegistry, "ScoreTooHigh");
    });

    it("should revert when any individual CID is empty", async function () {
      await expect(
        contributionRegistry.connect(owner).batchSetScores(
          [agentA.address, agentB.address],
          [5000, 6000],
          [BREAKDOWN_CID, ""]
        )
      ).to.be.revertedWithCustomError(contributionRegistry, "EmptyCid");
    });

    it("should revert when any individual address is zero", async function () {
      await expect(
        contributionRegistry.connect(owner).batchSetScores(
          [agentA.address, ethers.ZeroAddress],
          [5000, 6000],
          [BREAKDOWN_CID, BREAKDOWN_CID_2]
        )
      ).to.be.revertedWithCustomError(contributionRegistry, "ZeroAddress");
    });

    it("should revert when called by non-owner", async function () {
      await expect(
        contributionRegistry.connect(agentA).batchSetScores(
          [agentA.address],
          [5000],
          [BREAKDOWN_CID]
        )
      ).to.be.revertedWithCustomError(contributionRegistry, "OwnableUnauthorizedAccount");
    });
  });

  // ============================================================
  //                     VIEW FUNCTIONS
  // ============================================================

  describe("View Functions", function () {
    it("should return 0 for unset agent score", async function () {
      expect(await contributionRegistry.getContributionScore(agentA.address)).to.equal(0);
    });

    it("should return empty string for unset agent tags", async function () {
      expect(await contributionRegistry.getExpertiseTags(agentA.address)).to.equal("");
    });

    it("should return empty string for unset agent breakdown CID", async function () {
      expect(await contributionRegistry.getBreakdownCid(agentA.address)).to.equal("");
    });

    it("should return 0 for unset agent lastUpdated", async function () {
      expect(await contributionRegistry.getLastUpdated(agentA.address)).to.equal(0);
    });
  });

  // ============================================================
  //                     PAUSABLE
  // ============================================================

  describe("Pausable", function () {
    it("should pause and unpause", async function () {
      await contributionRegistry.connect(owner).pause();
      expect(await contributionRegistry.paused()).to.be.true;

      await contributionRegistry.connect(owner).unpause();
      expect(await contributionRegistry.paused()).to.be.false;
    });

    it("should revert setContributionScore when paused", async function () {
      await contributionRegistry.connect(owner).pause();
      await expect(
        contributionRegistry.connect(owner).setContributionScore(agentA.address, 5000, BREAKDOWN_CID)
      ).to.be.revertedWithCustomError(contributionRegistry, "EnforcedPause");
    });

    it("should revert setExpertiseTags when paused", async function () {
      await contributionRegistry.connect(owner).pause();
      await expect(
        contributionRegistry.connect(owner).setExpertiseTags(agentA.address, TAGS)
      ).to.be.revertedWithCustomError(contributionRegistry, "EnforcedPause");
    });

    it("should revert batchSetScores when paused", async function () {
      await contributionRegistry.connect(owner).pause();
      await expect(
        contributionRegistry.connect(owner).batchSetScores([agentA.address], [5000], [BREAKDOWN_CID])
      ).to.be.revertedWithCustomError(contributionRegistry, "EnforcedPause");
    });

    it("should revert pause from non-owner", async function () {
      await expect(
        contributionRegistry.connect(agentA).pause()
      ).to.be.revertedWithCustomError(contributionRegistry, "OwnableUnauthorizedAccount");
    });

    it("should revert unpause from non-owner", async function () {
      await contributionRegistry.connect(owner).pause();
      await expect(
        contributionRegistry.connect(agentA).unpause()
      ).to.be.revertedWithCustomError(contributionRegistry, "OwnableUnauthorizedAccount");
    });
  });

  // ============================================================
  //                     ADMIN FUNCTIONS
  // ============================================================

  describe("Admin Functions", function () {
    it("should allow owner to update agentRegistry", async function () {
      const newRegistryAddress = agentB.address; // use any non-zero address
      await contributionRegistry.connect(owner).setAgentRegistry(newRegistryAddress);
      expect(await contributionRegistry.agentRegistry()).to.equal(newRegistryAddress);
    });

    it("should revert setAgentRegistry with zero address", async function () {
      await expect(
        contributionRegistry.connect(owner).setAgentRegistry(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(contributionRegistry, "ZeroAddress");
    });

    it("should revert setAgentRegistry from non-owner", async function () {
      await expect(
        contributionRegistry.connect(agentA).setAgentRegistry(agentB.address)
      ).to.be.revertedWithCustomError(contributionRegistry, "OwnableUnauthorizedAccount");
    });
  });

  // ============================================================
  //                     UUPS UPGRADE
  // ============================================================

  describe("UUPS Upgrade", function () {
    it("should revert upgrade by non-owner", async function () {
      const Factory = await ethers.getContractFactory("ContributionRegistry", agentA);
      await expect(
        upgrades.upgradeProxy(await contributionRegistry.getAddress(), Factory, {
          constructorArgs: [await forwarder.getAddress()],
          unsafeAllow: ["constructor", "state-variable-immutable"],
        })
      ).to.be.revertedWithCustomError(contributionRegistry, "OwnableUnauthorizedAccount");
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
      relayer = signers[5];
    });

    it("should report the correct trusted forwarder", async function () {
      const forwarderAddress = await forwarder.getAddress();
      expect(await contributionRegistry.isTrustedForwarder(forwarderAddress)).to.be.true;
      // A random address should not be trusted
      expect(await contributionRegistry.isTrustedForwarder(relayer.address)).to.be.false;
    });

    it("should support meta-transactions via forwarder", async function () {
      // Build ForwardRequest
      const contractAddress = await contributionRegistry.getAddress();
      const data = contributionRegistry.interface.encodeFunctionData("setContributionScore", [agentA.address, 5000, BREAKDOWN_CID]);
      const nonce = await forwarder.nonces(owner.address);
      const block = await ethers.provider.getBlock("latest");
      const deadline = block!.timestamp + 3600;

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

      const request = {
        from: owner.address,
        to: contractAddress,
        value: 0n,
        gas: 500000n,
        nonce: nonce,
        deadline: deadline,
        data: data,
      };

      const signature = await owner.signTypedData(domain, types, request);

      // Submit via relayer (agentB acts as relayer)
      const tx = await forwarder.connect(agentB).execute({ ...request, signature });
      await tx.wait();

      expect(await contributionRegistry.getContributionScore(agentA.address)).to.equal(5000);
    });
  });

  // ============================================================
  //                     HELPERS
  // ============================================================

  async function getBlockTimestamp(tx: any): Promise<number> {
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt!.blockNumber);
    return block!.timestamp;
  }
});
