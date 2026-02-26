import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import {
  AgentRegistry,
  BountyContract,
  MockERC20,
  NookplotForwarder,
} from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("BountyContract", function () {
  let registry: AgentRegistry;
  let bountyContract: BountyContract;
  let token: MockERC20;
  let forwarder: NookplotForwarder;
  let owner: SignerWithAddress;
  let treasury: SignerWithAddress;
  let agentA: SignerWithAddress;
  let agentB: SignerWithAddress;
  let agentC: SignerWithAddress;
  let nonAgent: SignerWithAddress;

  const DID_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const METADATA_CID = "QmBountyCidForTestingBountyContract1234567890ab";
  const METADATA_CID_2 = "QmBountyCidForTestingBountyContract2345678901bc";
  const SUBMISSION_CID = "QmSubmissionCidForTestBountyWork123456789012345";
  const COMMUNITY = "general";

  /** @returns a deadline 1 day from the latest block timestamp (unix seconds) */
  async function futureDeadline(): Promise<number> {
    const block = await ethers.provider.getBlock("latest");
    return block!.timestamp + 86400;
  }

  beforeEach(async function () {
    [owner, treasury, agentA, agentB, agentC, nonAgent] =
      await ethers.getSigners();

    // Deploy NookplotForwarder (standalone, not proxied)
    const ForwarderFactory =
      await ethers.getContractFactory("NookplotForwarder");
    forwarder =
      (await ForwarderFactory.deploy()) as unknown as NookplotForwarder;
    await forwarder.waitForDeployment();
    const forwarderAddress = await forwarder.getAddress();

    // Deploy AgentRegistry via UUPS proxy
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

    // Deploy BountyContract via UUPS proxy
    const BountyFactory = await ethers.getContractFactory("BountyContract");
    bountyContract = (await upgrades.deployProxy(
      BountyFactory,
      [owner.address, await registry.getAddress(), treasury.address],
      {
        kind: "uups",
        constructorArgs: [forwarderAddress],
        unsafeAllow: ["constructor", "state-variable-immutable"],
      }
    )) as unknown as BountyContract;
    await bountyContract.waitForDeployment();

    // Register agents
    await registry.connect(agentA).register(DID_CID);
    await registry.connect(agentB).register(DID_CID);
    await registry.connect(agentC).register(DID_CID);
  });

  // ============================================================
  //                     INITIALIZATION
  // ============================================================

  describe("Initialization", function () {
    it("should set the owner correctly", async function () {
      expect(await bountyContract.owner()).to.equal(owner.address);
    });

    it("should set the agentRegistry correctly", async function () {
      expect(await bountyContract.agentRegistry()).to.equal(
        await registry.getAddress()
      );
    });

    it("should set the treasury correctly", async function () {
      expect(await bountyContract.treasury()).to.equal(treasury.address);
    });

    it("should not be paused initially", async function () {
      expect(await bountyContract.paused()).to.be.false;
    });

    it("should start with zero bounties", async function () {
      expect(await bountyContract.totalBounties()).to.equal(0);
    });

    it("should start in free mode (no payment token)", async function () {
      expect(await bountyContract.paymentToken()).to.equal(ethers.ZeroAddress);
    });

    it("should start with zero platform fee", async function () {
      expect(await bountyContract.platformFeeBps()).to.equal(0);
    });

    it("should revert if initialized with zero owner", async function () {
      const forwarderAddress = await forwarder.getAddress();
      const Factory = await ethers.getContractFactory("BountyContract");
      await expect(
        upgrades.deployProxy(
          Factory,
          [ethers.ZeroAddress, await registry.getAddress(), treasury.address],
          {
            kind: "uups",
            constructorArgs: [forwarderAddress],
            unsafeAllow: ["constructor", "state-variable-immutable"],
          }
        )
      ).to.be.revertedWithCustomError(bountyContract, "ZeroAddress");
    });

    it("should revert if initialized with zero agentRegistry", async function () {
      const forwarderAddress = await forwarder.getAddress();
      const Factory = await ethers.getContractFactory("BountyContract");
      await expect(
        upgrades.deployProxy(
          Factory,
          [owner.address, ethers.ZeroAddress, treasury.address],
          {
            kind: "uups",
            constructorArgs: [forwarderAddress],
            unsafeAllow: ["constructor", "state-variable-immutable"],
          }
        )
      ).to.be.revertedWithCustomError(bountyContract, "ZeroAddress");
    });

    it("should revert if initialized with zero treasury", async function () {
      const forwarderAddress = await forwarder.getAddress();
      const Factory = await ethers.getContractFactory("BountyContract");
      await expect(
        upgrades.deployProxy(
          Factory,
          [owner.address, await registry.getAddress(), ethers.ZeroAddress],
          {
            kind: "uups",
            constructorArgs: [forwarderAddress],
            unsafeAllow: ["constructor", "state-variable-immutable"],
          }
        )
      ).to.be.revertedWithCustomError(bountyContract, "ZeroAddress");
    });
  });

  // ============================================================
  //                     CREATE BOUNTY
  // ============================================================

  describe("Create Bounty", function () {
    it("should create an ETH escrow bounty", async function () {
      const ethAmount = ethers.parseEther("1");
      const deadline = await futureDeadline();

      const tx = await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, deadline, 0, {
          value: ethAmount,
        });
      await tx.wait();

      const bounty = await bountyContract.getBounty(0);
      expect(bounty.creator).to.equal(agentA.address);
      expect(bounty.metadataCid).to.equal(METADATA_CID);
      expect(bounty.community).to.equal(COMMUNITY);
      expect(bounty.rewardAmount).to.equal(ethAmount);
      expect(bounty.escrowType).to.equal(1); // EscrowType.ETH
      expect(bounty.status).to.equal(0); // BountyStatus.Open
      expect(bounty.claimer).to.equal(ethers.ZeroAddress);
      expect(bounty.deadline).to.equal(deadline);
      expect(bounty.createdAt).to.be.greaterThan(0);
    });

    it("should hold ETH in the contract", async function () {
      const ethAmount = ethers.parseEther("2");
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, {
          value: ethAmount,
        });

      const contractBalance = await ethers.provider.getBalance(
        await bountyContract.getAddress()
      );
      expect(contractBalance).to.equal(ethAmount);
    });

    it("should create a reputation-only bounty (no ETH)", async function () {
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0);

      const bounty = await bountyContract.getBounty(0);
      expect(bounty.rewardAmount).to.equal(0);
      expect(bounty.escrowType).to.equal(0); // EscrowType.None
    });

    it("should create a token escrow bounty", async function () {
      // Deploy MockERC20 and set as payment token
      const MockFactory = await ethers.getContractFactory("MockERC20");
      token = (await MockFactory.deploy(
        "Mock Token",
        "MOCK"
      )) as unknown as MockERC20;
      await token.waitForDeployment();

      await bountyContract
        .connect(owner)
        .setPaymentToken(await token.getAddress());

      // Mint and approve
      const tokenAmount = ethers.parseEther("100");
      await token.mint(agentA.address, ethers.parseEther("1000"));
      await token
        .connect(agentA)
        .approve(await bountyContract.getAddress(), tokenAmount);

      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), tokenAmount);

      const bounty = await bountyContract.getBounty(0);
      expect(bounty.rewardAmount).to.equal(tokenAmount);
      expect(bounty.escrowType).to.equal(2); // EscrowType.Token

      // Verify tokens transferred to contract
      const contractBalance = await token.balanceOf(
        await bountyContract.getAddress()
      );
      expect(contractBalance).to.equal(tokenAmount);
    });

    it("should emit BountyCreated event", async function () {
      const ethAmount = ethers.parseEther("1");
      const deadline = await futureDeadline();

      await expect(
        bountyContract
          .connect(agentA)
          .createBounty(METADATA_CID, COMMUNITY, deadline, 0, {
            value: ethAmount,
          })
      )
        .to.emit(bountyContract, "BountyCreated")
        .withArgs(0, agentA.address, METADATA_CID, COMMUNITY, ethAmount, 1, deadline);
    });

    it("should increment totalBounties", async function () {
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0);
      await bountyContract
        .connect(agentB)
        .createBounty(METADATA_CID_2, COMMUNITY, await futureDeadline(), 0);

      expect(await bountyContract.totalBounties()).to.equal(2);
    });

    it("should revert with empty metadata CID", async function () {
      await expect(
        bountyContract
          .connect(agentA)
          .createBounty("", COMMUNITY, await futureDeadline(), 0)
      ).to.be.revertedWithCustomError(bountyContract, "EmptyString");
    });

    it("should revert with empty community", async function () {
      await expect(
        bountyContract
          .connect(agentA)
          .createBounty(METADATA_CID, "", await futureDeadline(), 0)
      ).to.be.revertedWithCustomError(bountyContract, "EmptyString");
    });

    it("should revert when deadline is in the past", async function () {
      const block = await ethers.provider.getBlock("latest");
      const pastDeadline = block!.timestamp - 86400;
      await expect(
        bountyContract
          .connect(agentA)
          .createBounty(METADATA_CID, COMMUNITY, pastDeadline, 0)
      ).to.be.revertedWithCustomError(bountyContract, "DeadlineNotInFuture");
    });

    it("should revert when caller is not a registered agent", async function () {
      await expect(
        bountyContract
          .connect(nonAgent)
          .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0)
      ).to.be.revertedWithCustomError(bountyContract, "NotRegisteredAgent");
    });
  });

  // ============================================================
  //                     CLAIM BOUNTY
  // ============================================================

  describe("Claim Bounty", function () {
    beforeEach(async function () {
      // Create a bounty from agentA
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, {
          value: ethers.parseEther("1"),
        });
    });

    it("should allow a registered agent to claim an Open bounty", async function () {
      await expect(bountyContract.connect(agentB).claimBounty(0))
        .to.emit(bountyContract, "BountyClaimed")
        .withArgs(0, agentB.address);
    });

    it("should update bounty state on claim", async function () {
      await bountyContract.connect(agentB).claimBounty(0);

      const bounty = await bountyContract.getBounty(0);
      expect(bounty.claimer).to.equal(agentB.address);
      expect(bounty.status).to.equal(1); // BountyStatus.Claimed
      expect(bounty.claimedAt).to.be.greaterThan(0);
    });

    it("should revert when bounty is not Open", async function () {
      await bountyContract.connect(agentB).claimBounty(0);
      // Now bounty is Claimed, agentC tries to claim
      await expect(
        bountyContract.connect(agentC).claimBounty(0)
      ).to.be.revertedWithCustomError(bountyContract, "InvalidStatus");
    });

    it("should revert when creator claims their own bounty", async function () {
      await expect(
        bountyContract.connect(agentA).claimBounty(0)
      ).to.be.revertedWithCustomError(bountyContract, "CannotClaimOwnBounty");
    });

    it("should revert when caller is not a registered agent", async function () {
      await expect(
        bountyContract.connect(nonAgent).claimBounty(0)
      ).to.be.revertedWithCustomError(bountyContract, "NotRegisteredAgent");
    });

    it("should revert when bounty does not exist", async function () {
      await expect(
        bountyContract.connect(agentB).claimBounty(999)
      ).to.be.revertedWithCustomError(bountyContract, "BountyNotFound");
    });
  });

  // ============================================================
  //                     UNCLAIM BOUNTY
  // ============================================================

  describe("Unclaim Bounty", function () {
    beforeEach(async function () {
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, {
          value: ethers.parseEther("1"),
        });
      await bountyContract.connect(agentB).claimBounty(0);
    });

    it("should allow claimer to unclaim", async function () {
      await expect(bountyContract.connect(agentB).unclaimBounty(0))
        .to.emit(bountyContract, "BountyUnclaimed")
        .withArgs(0, agentB.address);
    });

    it("should reset bounty state back to Open", async function () {
      await bountyContract.connect(agentB).unclaimBounty(0);

      const bounty = await bountyContract.getBounty(0);
      expect(bounty.status).to.equal(0); // BountyStatus.Open
      expect(bounty.claimer).to.equal(ethers.ZeroAddress);
      expect(bounty.claimedAt).to.equal(0);
    });

    it("should revert when bounty is not Claimed", async function () {
      await bountyContract.connect(agentB).unclaimBounty(0);
      // Now it's Open again
      await expect(
        bountyContract.connect(agentB).unclaimBounty(0)
      ).to.be.revertedWithCustomError(bountyContract, "InvalidStatus");
    });

    it("should revert when caller is not the claimer", async function () {
      await expect(
        bountyContract.connect(agentC).unclaimBounty(0)
      ).to.be.revertedWithCustomError(bountyContract, "NotClaimer");
    });
  });

  // ============================================================
  //                     SUBMIT WORK
  // ============================================================

  describe("Submit Work", function () {
    beforeEach(async function () {
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, {
          value: ethers.parseEther("1"),
        });
      await bountyContract.connect(agentB).claimBounty(0);
    });

    it("should allow claimer to submit work", async function () {
      await expect(
        bountyContract.connect(agentB).submitWork(0, SUBMISSION_CID)
      )
        .to.emit(bountyContract, "WorkSubmitted")
        .withArgs(0, agentB.address, SUBMISSION_CID);
    });

    it("should update bounty state on submission", async function () {
      await bountyContract.connect(agentB).submitWork(0, SUBMISSION_CID);

      const bounty = await bountyContract.getBounty(0);
      expect(bounty.status).to.equal(2); // BountyStatus.Submitted
      expect(bounty.submissionCid).to.equal(SUBMISSION_CID);
      expect(bounty.submittedAt).to.be.greaterThan(0);
    });

    it("should revert when bounty is not Claimed", async function () {
      await bountyContract.connect(agentB).submitWork(0, SUBMISSION_CID);
      // Now it's Submitted, try submitting again
      await expect(
        bountyContract.connect(agentB).submitWork(0, SUBMISSION_CID)
      ).to.be.revertedWithCustomError(bountyContract, "InvalidStatus");
    });

    it("should revert when caller is not the claimer", async function () {
      await expect(
        bountyContract.connect(agentC).submitWork(0, SUBMISSION_CID)
      ).to.be.revertedWithCustomError(bountyContract, "NotClaimer");
    });

    it("should revert with empty submission CID", async function () {
      await expect(
        bountyContract.connect(agentB).submitWork(0, "")
      ).to.be.revertedWithCustomError(bountyContract, "EmptyString");
    });
  });

  // ============================================================
  //                     APPROVE WORK
  // ============================================================

  describe("Approve Work", function () {
    const ethAmount = ethers.parseEther("1");

    beforeEach(async function () {
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, {
          value: ethAmount,
        });
      await bountyContract.connect(agentB).claimBounty(0);
      await bountyContract.connect(agentB).submitWork(0, SUBMISSION_CID);
    });

    it("should allow creator to approve and release ETH escrow to worker", async function () {
      const balanceBefore = await ethers.provider.getBalance(agentB.address);

      await expect(bountyContract.connect(agentA).approveWork(0))
        .to.emit(bountyContract, "WorkApproved")
        .withArgs(0, agentB.address, ethAmount, 0, ethAmount);

      const balanceAfter = await ethers.provider.getBalance(agentB.address);
      expect(balanceAfter - balanceBefore).to.equal(ethAmount);
    });

    it("should set status to Approved", async function () {
      await bountyContract.connect(agentA).approveWork(0);

      const bounty = await bountyContract.getBounty(0);
      expect(bounty.status).to.equal(3); // BountyStatus.Approved
    });

    it("should approve reputation-only bounty with no escrow", async function () {
      // Create a reputation-only bounty
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID_2, COMMUNITY, await futureDeadline(), 0);
      // bountyId = 1
      await bountyContract.connect(agentB).claimBounty(1);
      await bountyContract.connect(agentB).submitWork(1, SUBMISSION_CID);

      await expect(bountyContract.connect(agentA).approveWork(1))
        .to.emit(bountyContract, "WorkApproved")
        .withArgs(1, agentB.address, 0, 0, 0);

      expect(await bountyContract.getBountyStatus(1)).to.equal(3); // Approved
    });

    it("should deduct platform fee on ETH escrow approval", async function () {
      // Set 2.5% fee (250 basis points)
      await bountyContract.connect(owner).setPlatformFeeBps(250);

      // Create a new bounty with ETH
      const bountyEth = ethers.parseEther("10");
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID_2, COMMUNITY, await futureDeadline(), 0, {
          value: bountyEth,
        });
      // bountyId = 1
      await bountyContract.connect(agentC).claimBounty(1);
      await bountyContract.connect(agentC).submitWork(1, SUBMISSION_CID);

      const workerBalanceBefore = await ethers.provider.getBalance(
        agentC.address
      );
      const treasuryBalanceBefore = await ethers.provider.getBalance(
        treasury.address
      );

      await bountyContract.connect(agentA).approveWork(1);

      const workerBalanceAfter = await ethers.provider.getBalance(
        agentC.address
      );
      const treasuryBalanceAfter = await ethers.provider.getBalance(
        treasury.address
      );

      // 2.5% of 10 ETH = 0.25 ETH fee, 9.75 ETH to worker
      const expectedFee = ethers.parseEther("0.25");
      const expectedPayout = ethers.parseEther("9.75");

      expect(workerBalanceAfter - workerBalanceBefore).to.equal(expectedPayout);
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(
        expectedFee
      );
    });

    it("should deduct platform fee on token escrow approval", async function () {
      // Deploy MockERC20
      const MockFactory = await ethers.getContractFactory("MockERC20");
      token = (await MockFactory.deploy(
        "Mock Token",
        "MOCK"
      )) as unknown as MockERC20;
      await token.waitForDeployment();
      await bountyContract
        .connect(owner)
        .setPaymentToken(await token.getAddress());
      await bountyContract.connect(owner).setPlatformFeeBps(500); // 5%

      const tokenAmount = ethers.parseEther("100");
      await token.mint(agentA.address, ethers.parseEther("1000"));
      await token
        .connect(agentA)
        .approve(await bountyContract.getAddress(), tokenAmount);

      // Create token bounty (bountyId = 1)
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID_2, COMMUNITY, await futureDeadline(), tokenAmount);
      await bountyContract.connect(agentC).claimBounty(1);
      await bountyContract.connect(agentC).submitWork(1, SUBMISSION_CID);

      await bountyContract.connect(agentA).approveWork(1);

      // 5% of 100 = 5 tokens fee, 95 tokens to worker
      expect(await token.balanceOf(agentC.address)).to.equal(
        ethers.parseEther("95")
      );
      expect(await token.balanceOf(treasury.address)).to.equal(
        ethers.parseEther("5")
      );
    });

    it("should revert when bounty is not Submitted", async function () {
      // Create and only claim (don't submit)
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID_2, COMMUNITY, await futureDeadline(), 0, {
          value: ethers.parseEther("1"),
        });
      await bountyContract.connect(agentB).claimBounty(1);

      await expect(
        bountyContract.connect(agentA).approveWork(1)
      ).to.be.revertedWithCustomError(bountyContract, "InvalidStatus");
    });

    it("should revert when caller is not the creator", async function () {
      await expect(
        bountyContract.connect(agentB).approveWork(0)
      ).to.be.revertedWithCustomError(bountyContract, "NotCreator");
    });

    it("should release full amount when no platform fee is set", async function () {
      // platformFeeBps is 0 by default
      const balanceBefore = await ethers.provider.getBalance(agentB.address);
      await bountyContract.connect(agentA).approveWork(0);
      const balanceAfter = await ethers.provider.getBalance(agentB.address);

      expect(balanceAfter - balanceBefore).to.equal(ethAmount);
    });
  });

  // ============================================================
  //                     DISPUTE WORK
  // ============================================================

  describe("Dispute Work", function () {
    beforeEach(async function () {
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, {
          value: ethers.parseEther("1"),
        });
      await bountyContract.connect(agentB).claimBounty(0);
      await bountyContract.connect(agentB).submitWork(0, SUBMISSION_CID);
    });

    it("should allow creator to dispute submitted work", async function () {
      await expect(bountyContract.connect(agentA).disputeWork(0))
        .to.emit(bountyContract, "BountyDisputed")
        .withArgs(0, agentA.address);

      expect(await bountyContract.getBountyStatus(0)).to.equal(4); // Disputed
    });

    it("should revert when bounty is not Submitted", async function () {
      await bountyContract.connect(agentA).disputeWork(0);
      // Now it's Disputed, try disputing again
      await expect(
        bountyContract.connect(agentA).disputeWork(0)
      ).to.be.revertedWithCustomError(bountyContract, "InvalidStatus");
    });

    it("should revert when caller is not the creator", async function () {
      await expect(
        bountyContract.connect(agentB).disputeWork(0)
      ).to.be.revertedWithCustomError(bountyContract, "NotCreator");
    });

    it("should revert when non-participant calls dispute", async function () {
      await expect(
        bountyContract.connect(agentC).disputeWork(0)
      ).to.be.revertedWithCustomError(bountyContract, "NotCreator");
    });
  });

  // ============================================================
  //                     RESOLVE DISPUTE
  // ============================================================

  describe("Resolve Dispute", function () {
    const ethAmount = ethers.parseEther("2");

    beforeEach(async function () {
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, {
          value: ethAmount,
        });
      await bountyContract.connect(agentB).claimBounty(0);
      await bountyContract.connect(agentB).submitWork(0, SUBMISSION_CID);
      await bountyContract.connect(agentA).disputeWork(0);
    });

    it("should release escrow to worker when resolved in their favor", async function () {
      const workerBalanceBefore = await ethers.provider.getBalance(
        agentB.address
      );

      await expect(bountyContract.connect(owner).resolveDispute(0, true))
        .to.emit(bountyContract, "DisputeResolved")
        .withArgs(0, true, owner.address);

      const workerBalanceAfter = await ethers.provider.getBalance(
        agentB.address
      );
      expect(workerBalanceAfter - workerBalanceBefore).to.equal(ethAmount);
      expect(await bountyContract.getBountyStatus(0)).to.equal(3); // Approved
    });

    it("should release escrow to worker with fee when resolved in their favor", async function () {
      await bountyContract.connect(owner).setPlatformFeeBps(500); // 5%

      const workerBalanceBefore = await ethers.provider.getBalance(
        agentB.address
      );
      const treasuryBalanceBefore = await ethers.provider.getBalance(
        treasury.address
      );

      await bountyContract.connect(owner).resolveDispute(0, true);

      const workerBalanceAfter = await ethers.provider.getBalance(
        agentB.address
      );
      const treasuryBalanceAfter = await ethers.provider.getBalance(
        treasury.address
      );

      // 5% of 2 ETH = 0.1 ETH fee, 1.9 ETH to worker
      expect(workerBalanceAfter - workerBalanceBefore).to.equal(
        ethers.parseEther("1.9")
      );
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(
        ethers.parseEther("0.1")
      );
    });

    it("should refund full escrow to creator when resolved against worker", async function () {
      const creatorBalanceBefore = await ethers.provider.getBalance(
        agentA.address
      );

      await bountyContract.connect(owner).resolveDispute(0, false);

      const creatorBalanceAfter = await ethers.provider.getBalance(
        agentA.address
      );
      // Full refund, no fee deducted
      expect(creatorBalanceAfter - creatorBalanceBefore).to.equal(ethAmount);
      expect(await bountyContract.getBountyStatus(0)).to.equal(5); // Cancelled
    });

    it("should revert when bounty is not Disputed", async function () {
      // Create a new bounty that is just Open
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID_2, COMMUNITY, await futureDeadline(), 0);

      await expect(
        bountyContract.connect(owner).resolveDispute(1, true)
      ).to.be.revertedWithCustomError(bountyContract, "InvalidStatus");
    });

    it("should revert when caller is not the owner", async function () {
      await expect(
        bountyContract.connect(agentA).resolveDispute(0, true)
      ).to.be.revertedWithCustomError(
        bountyContract,
        "OwnableUnauthorizedAccount"
      );
    });

    it("should revert when bounty does not exist", async function () {
      await expect(
        bountyContract.connect(owner).resolveDispute(999, true)
      ).to.be.revertedWithCustomError(bountyContract, "BountyNotFound");
    });
  });

  // ============================================================
  //                     CANCEL BOUNTY
  // ============================================================

  describe("Cancel Bounty", function () {
    it("should cancel and refund ETH escrow to creator", async function () {
      const ethAmount = ethers.parseEther("3");
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, {
          value: ethAmount,
        });

      const balanceBefore = await ethers.provider.getBalance(agentA.address);

      const tx = await bountyContract.connect(agentA).cancelBounty(0);
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;

      const balanceAfter = await ethers.provider.getBalance(agentA.address);
      expect(balanceAfter - balanceBefore + gasCost).to.equal(ethAmount);

      await expect(tx)
        .to.emit(bountyContract, "BountyCancelled")
        .withArgs(0, agentA.address, ethAmount);

      expect(await bountyContract.getBountyStatus(0)).to.equal(5); // Cancelled
    });

    it("should cancel a reputation-only bounty", async function () {
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0);

      await expect(bountyContract.connect(agentA).cancelBounty(0))
        .to.emit(bountyContract, "BountyCancelled")
        .withArgs(0, agentA.address, 0);

      expect(await bountyContract.getBountyStatus(0)).to.equal(5); // Cancelled
    });

    it("should cancel and refund token escrow to creator", async function () {
      const MockFactory = await ethers.getContractFactory("MockERC20");
      token = (await MockFactory.deploy(
        "Mock Token",
        "MOCK"
      )) as unknown as MockERC20;
      await token.waitForDeployment();
      await bountyContract
        .connect(owner)
        .setPaymentToken(await token.getAddress());

      const tokenAmount = ethers.parseEther("50");
      await token.mint(agentA.address, ethers.parseEther("1000"));
      await token
        .connect(agentA)
        .approve(await bountyContract.getAddress(), tokenAmount);

      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), tokenAmount);

      const tokensBefore = await token.balanceOf(agentA.address);
      await bountyContract.connect(agentA).cancelBounty(0);
      const tokensAfter = await token.balanceOf(agentA.address);

      expect(tokensAfter - tokensBefore).to.equal(tokenAmount);
    });

    it("should revert when bounty is not Open", async function () {
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, {
          value: ethers.parseEther("1"),
        });
      await bountyContract.connect(agentB).claimBounty(0);

      await expect(
        bountyContract.connect(agentA).cancelBounty(0)
      ).to.be.revertedWithCustomError(bountyContract, "InvalidStatus");
    });

    it("should revert when caller is not the creator", async function () {
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, {
          value: ethers.parseEther("1"),
        });

      await expect(
        bountyContract.connect(agentB).cancelBounty(0)
      ).to.be.revertedWithCustomError(bountyContract, "NotCreator");
    });
  });

  // ============================================================
  //                     EXPIRE BOUNTY
  // ============================================================

  describe("Expire Bounty", function () {
    it("should expire an Open bounty past deadline", async function () {
      const ethAmount = ethers.parseEther("1");
      const latestBlock = await ethers.provider.getBlock("latest");
      const shortDeadline = latestBlock!.timestamp + 60; // 60 seconds from now

      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, shortDeadline, 0, {
          value: ethAmount,
        });

      // Fast-forward past deadline
      await ethers.provider.send("evm_increaseTime", [120]); // 2 minutes
      await ethers.provider.send("evm_mine", []);

      const creatorBalanceBefore = await ethers.provider.getBalance(
        agentA.address
      );

      await expect(bountyContract.connect(agentC).expireBounty(0))
        .to.emit(bountyContract, "BountyExpired")
        .withArgs(0, agentC.address, ethAmount);

      const creatorBalanceAfter = await ethers.provider.getBalance(
        agentA.address
      );
      expect(creatorBalanceAfter - creatorBalanceBefore).to.equal(ethAmount);
      expect(await bountyContract.getBountyStatus(0)).to.equal(6); // Expired
    });

    it("should expire a Claimed bounty past deadline", async function () {
      const ethAmount = ethers.parseEther("1");
      const latestBlock = await ethers.provider.getBlock("latest");
      const shortDeadline = latestBlock!.timestamp + 60;

      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, shortDeadline, 0, {
          value: ethAmount,
        });
      await bountyContract.connect(agentB).claimBounty(0);

      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);

      await bountyContract.connect(agentC).expireBounty(0);
      expect(await bountyContract.getBountyStatus(0)).to.equal(6); // Expired
    });

    it("should allow anyone to call expire", async function () {
      const latestBlock = await ethers.provider.getBlock("latest");
      const shortDeadline = latestBlock!.timestamp + 60;
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, shortDeadline, 0);

      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);

      // nonAgent (not registered) can still expire bounties
      await expect(bountyContract.connect(nonAgent).expireBounty(0))
        .to.emit(bountyContract, "BountyExpired");
    });

    it("should revert when deadline has not passed", async function () {
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0);

      await expect(
        bountyContract.connect(agentB).expireBounty(0)
      ).to.be.revertedWithCustomError(bountyContract, "NotExpired");
    });

    it("should revert when bounty is Submitted", async function () {
      const latestBlock = await ethers.provider.getBlock("latest");
      const shortDeadline = latestBlock!.timestamp + 60;
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, shortDeadline, 0, {
          value: ethers.parseEther("1"),
        });
      await bountyContract.connect(agentB).claimBounty(0);
      await bountyContract.connect(agentB).submitWork(0, SUBMISSION_CID);

      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        bountyContract.connect(agentC).expireBounty(0)
      ).to.be.revertedWithCustomError(bountyContract, "InvalidStatus");
    });

    it("should revert when bounty is already Approved", async function () {
      const latestBlock = await ethers.provider.getBlock("latest");
      const shortDeadline = latestBlock!.timestamp + 60;
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, shortDeadline, 0, {
          value: ethers.parseEther("1"),
        });
      await bountyContract.connect(agentB).claimBounty(0);
      await bountyContract.connect(agentB).submitWork(0, SUBMISSION_CID);
      await bountyContract.connect(agentA).approveWork(0);

      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        bountyContract.connect(agentC).expireBounty(0)
      ).to.be.revertedWithCustomError(bountyContract, "InvalidStatus");
    });

    it("should refund ETH escrow on expiry", async function () {
      const ethAmount = ethers.parseEther("5");
      const latestBlock = await ethers.provider.getBlock("latest");
      const shortDeadline = latestBlock!.timestamp + 60;

      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, shortDeadline, 0, {
          value: ethAmount,
        });

      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);

      const balanceBefore = await ethers.provider.getBalance(agentA.address);
      await bountyContract.connect(agentC).expireBounty(0);
      const balanceAfter = await ethers.provider.getBalance(agentA.address);

      expect(balanceAfter - balanceBefore).to.equal(ethAmount);
    });
  });

  // ============================================================
  //                     ADMIN FUNCTIONS
  // ============================================================

  describe("Admin Functions", function () {
    it("should set platform fee basis points", async function () {
      await expect(bountyContract.connect(owner).setPlatformFeeBps(500))
        .to.emit(bountyContract, "PlatformFeeUpdated")
        .withArgs(0, 500);

      expect(await bountyContract.platformFeeBps()).to.equal(500);
    });

    it("should revert when fee exceeds max (1000)", async function () {
      await expect(
        bountyContract.connect(owner).setPlatformFeeBps(1001)
      ).to.be.revertedWithCustomError(bountyContract, "FeeTooHigh");
    });

    it("should set treasury address", async function () {
      await expect(bountyContract.connect(owner).setTreasury(agentC.address))
        .to.emit(bountyContract, "TreasuryUpdated")
        .withArgs(treasury.address, agentC.address);

      expect(await bountyContract.treasury()).to.equal(agentC.address);
    });

    it("should revert setting treasury to zero address", async function () {
      await expect(
        bountyContract.connect(owner).setTreasury(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(bountyContract, "ZeroAddress");
    });

    it("should set payment token", async function () {
      const tokenAddr = "0x0000000000000000000000000000000000000001";
      await expect(bountyContract.connect(owner).setPaymentToken(tokenAddr))
        .to.emit(bountyContract, "PaymentTokenUpdated")
        .withArgs(ethers.ZeroAddress, tokenAddr);
    });

    it("should set agent registry", async function () {
      await bountyContract
        .connect(owner)
        .setAgentRegistry(agentC.address);
      expect(await bountyContract.agentRegistry()).to.equal(agentC.address);
    });

    it("should revert setting agent registry to zero address", async function () {
      await expect(
        bountyContract.connect(owner).setAgentRegistry(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(bountyContract, "ZeroAddress");
    });

    it("should revert admin calls from non-owner", async function () {
      await expect(
        bountyContract.connect(agentA).setPlatformFeeBps(100)
      ).to.be.revertedWithCustomError(
        bountyContract,
        "OwnableUnauthorizedAccount"
      );

      await expect(
        bountyContract.connect(agentA).setTreasury(agentA.address)
      ).to.be.revertedWithCustomError(
        bountyContract,
        "OwnableUnauthorizedAccount"
      );

      await expect(
        bountyContract.connect(agentA).setPaymentToken(agentA.address)
      ).to.be.revertedWithCustomError(
        bountyContract,
        "OwnableUnauthorizedAccount"
      );

      await expect(
        bountyContract.connect(agentA).setAgentRegistry(agentA.address)
      ).to.be.revertedWithCustomError(
        bountyContract,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  // ============================================================
  //                     PAUSABLE
  // ============================================================

  describe("Pausable", function () {
    it("should revert createBounty when paused", async function () {
      await bountyContract.connect(owner).pause();

      await expect(
        bountyContract
          .connect(agentA)
          .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0)
      ).to.be.revertedWithCustomError(bountyContract, "EnforcedPause");
    });

    it("should revert claimBounty when paused", async function () {
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, {
          value: ethers.parseEther("1"),
        });

      await bountyContract.connect(owner).pause();

      await expect(
        bountyContract.connect(agentB).claimBounty(0)
      ).to.be.revertedWithCustomError(bountyContract, "EnforcedPause");
    });

    it("should allow operations after unpause", async function () {
      await bountyContract.connect(owner).pause();
      await bountyContract.connect(owner).unpause();

      await expect(
        bountyContract
          .connect(agentA)
          .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0)
      ).to.emit(bountyContract, "BountyCreated");
    });
  });

  // ============================================================
  //                     UUPS UPGRADE AUTH
  // ============================================================

  describe("UUPS Upgrade Auth", function () {
    it("should revert upgrade from non-owner", async function () {
      const BountyFactory = await ethers.getContractFactory("BountyContract");
      await expect(
        upgrades.upgradeProxy(await bountyContract.getAddress(), BountyFactory.connect(agentA), {
          constructorArgs: [await forwarder.getAddress()],
          unsafeAllow: ["constructor", "state-variable-immutable"],
        })
      ).to.be.revertedWithCustomError(
        bountyContract,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  // ============================================================
  //              META-TRANSACTIONS (ERC-2771)
  // ============================================================

  describe("Meta-Transactions (ERC-2771)", function () {
    it("should report the correct trusted forwarder", async function () {
      const forwarderAddress = await forwarder.getAddress();
      expect(await bountyContract.trustedForwarder()).to.equal(
        forwarderAddress
      );
      expect(
        await bountyContract.isTrustedForwarder(forwarderAddress)
      ).to.be.true;
      expect(await bountyContract.isTrustedForwarder(agentA.address)).to.be
        .false;
    });

    it("should allow claiming a bounty via meta-transaction", async function () {
      // Create bounty directly
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, {
          value: ethers.parseEther("1"),
        });

      // agentB signs a ForwardRequest to claim the bounty
      const contractAddress = await bountyContract.getAddress();
      const data = bountyContract.interface.encodeFunctionData("claimBounty", [
        0,
      ]);
      const nonce = await forwarder.nonces(agentB.address);
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
        from: agentB.address,
        to: contractAddress,
        value: 0n,
        gas: 500000n,
        nonce: nonce,
        deadline: deadline,
        data: data,
      };

      const signature = await agentB.signTypedData(domain, types, request);
      const tx = await forwarder
        .connect(agentC)
        .execute({ ...request, signature });
      await tx.wait();

      // Verify the bounty was claimed by agentB (not agentC who relayed)
      const bounty = await bountyContract.getBounty(0);
      expect(bounty.claimer).to.equal(agentB.address);
      expect(bounty.status).to.equal(1); // BountyStatus.Claimed
    });

    it("direct calls still work (backward compatibility)", async function () {
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, {
          value: ethers.parseEther("1"),
        });

      await bountyContract.connect(agentB).claimBounty(0);

      const bounty = await bountyContract.getBounty(0);
      expect(bounty.claimer).to.equal(agentB.address);
      expect(bounty.status).to.equal(1); // BountyStatus.Claimed
    });
  });

  // ============================================================
  //                     VIEW FUNCTIONS
  // ============================================================

  describe("View Functions", function () {
    it("getBounty should revert for non-existent bounty", async function () {
      await expect(
        bountyContract.getBounty(0)
      ).to.be.revertedWithCustomError(bountyContract, "BountyNotFound");
    });

    it("getBountyStatus should revert for non-existent bounty", async function () {
      await expect(
        bountyContract.getBountyStatus(0)
      ).to.be.revertedWithCustomError(bountyContract, "BountyNotFound");
    });

    it("totalBounties should track all created bounties", async function () {
      expect(await bountyContract.totalBounties()).to.equal(0);

      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0);
      expect(await bountyContract.totalBounties()).to.equal(1);

      await bountyContract
        .connect(agentB)
        .createBounty(METADATA_CID_2, COMMUNITY, await futureDeadline(), 0);
      expect(await bountyContract.totalBounties()).to.equal(2);
    });
  });
});
