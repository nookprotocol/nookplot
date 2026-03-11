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
  let guardian: SignerWithAddress;

  const DID_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const METADATA_CID = "QmBountyCidForTestingBountyContract1234567890ab";
  const METADATA_CID_2 = "QmBountyCidForTestingBountyContract2345678901bc";
  const SUBMISSION_CID = "QmSubmissionCidForTestBountyWork123456789012345";
  const COMMUNITY = "general";

  // DEFAULT_ADMIN_ROLE = bytes32(0)
  const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
  const GUARDIAN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GUARDIAN_ROLE"));

  /** @returns a deadline 1 day from the latest block timestamp (unix seconds) */
  async function futureDeadline(): Promise<number> {
    const block = await ethers.provider.getBlock("latest");
    return block!.timestamp + 86400;
  }

  beforeEach(async function () {
    [owner, treasury, agentA, agentB, agentC, nonAgent, guardian] =
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

    // Run V2, V3, V4 reinitializers
    await bountyContract.initializeV2(ethers.ZeroAddress, ethers.ZeroAddress);
    await bountyContract.initializeV3();
    await bountyContract.initializeV4(owner.address, guardian.address);

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
      expect(await bountyContract.owner()).to.equal(ethers.ZeroAddress);
    });

    it("should grant DEFAULT_ADMIN_ROLE to admin", async function () {
      expect(await bountyContract.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;
    });

    it("should grant GUARDIAN_ROLE to guardian", async function () {
      expect(await bountyContract.hasRole(GUARDIAN_ROLE, guardian.address)).to.be.true;
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

    it("should set submissionGracePeriod to 14 days via initializeV3", async function () {
      expect(await bountyContract.submissionGracePeriod()).to.equal(14 * 86400);
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
        .createBounty(METADATA_CID, COMMUNITY, deadline, 0, ethers.ZeroAddress, {
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
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress, {
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
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress);

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
      await bountyContract.connect(owner).setAllowedToken(await token.getAddress(), true);

      // Mint and approve
      const tokenAmount = ethers.parseEther("100");
      await token.mint(agentA.address, ethers.parseEther("1000"));
      await token
        .connect(agentA)
        .approve(await bountyContract.getAddress(), tokenAmount);

      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), tokenAmount, await token.getAddress());

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
          .createBounty(METADATA_CID, COMMUNITY, deadline, 0, ethers.ZeroAddress, {
            value: ethAmount,
          })
      )
        .to.emit(bountyContract, "BountyCreated")
        .withArgs(0, agentA.address, METADATA_CID, COMMUNITY, ethAmount, 1, deadline, ethers.ZeroAddress);
    });

    it("should increment totalBounties", async function () {
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress);
      await bountyContract
        .connect(agentB)
        .createBounty(METADATA_CID_2, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress);

      expect(await bountyContract.totalBounties()).to.equal(2);
    });

    it("should revert with empty metadata CID", async function () {
      await expect(
        bountyContract
          .connect(agentA)
          .createBounty("", COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(bountyContract, "EmptyString");
    });

    it("should revert with empty community", async function () {
      await expect(
        bountyContract
          .connect(agentA)
          .createBounty(METADATA_CID, "", await futureDeadline(), 0, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(bountyContract, "EmptyString");
    });

    it("should revert when deadline is in the past", async function () {
      const block = await ethers.provider.getBlock("latest");
      const pastDeadline = block!.timestamp - 86400;
      await expect(
        bountyContract
          .connect(agentA)
          .createBounty(METADATA_CID, COMMUNITY, pastDeadline, 0, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(bountyContract, "DeadlineNotInFuture");
    });

    it("should revert when caller is not a registered agent", async function () {
      await expect(
        bountyContract
          .connect(nonAgent)
          .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress)
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
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress, {
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
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress, {
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
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress, {
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
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress, {
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
        .createBounty(METADATA_CID_2, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress);
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
        .createBounty(METADATA_CID_2, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress, {
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
      await bountyContract.connect(owner).setAllowedToken(await token.getAddress(), true);
      await bountyContract.connect(owner).setPlatformFeeBps(500); // 5%

      const tokenAmount = ethers.parseEther("100");
      await token.mint(agentA.address, ethers.parseEther("1000"));
      await token
        .connect(agentA)
        .approve(await bountyContract.getAddress(), tokenAmount);

      // Create token bounty (bountyId = 1)
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID_2, COMMUNITY, await futureDeadline(), tokenAmount, await token.getAddress());
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
        .createBounty(METADATA_CID_2, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress, {
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
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress, {
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
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress, {
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
        .createBounty(METADATA_CID_2, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress);

      await expect(
        bountyContract.connect(owner).resolveDispute(1, true)
      ).to.be.revertedWithCustomError(bountyContract, "InvalidStatus");
    });

    it("should revert when caller is not admin", async function () {
      await expect(
        bountyContract.connect(agentA).resolveDispute(0, true)
      ).to.be.revertedWithCustomError(
        bountyContract,
        "AccessControlUnauthorizedAccount"
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
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress, {
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
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress);

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
      await bountyContract.connect(owner).setAllowedToken(await token.getAddress(), true);

      const tokenAmount = ethers.parseEther("50");
      await token.mint(agentA.address, ethers.parseEther("1000"));
      await token
        .connect(agentA)
        .approve(await bountyContract.getAddress(), tokenAmount);

      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), tokenAmount, await token.getAddress());

      const tokensBefore = await token.balanceOf(agentA.address);
      await bountyContract.connect(agentA).cancelBounty(0);
      const tokensAfter = await token.balanceOf(agentA.address);

      expect(tokensAfter - tokensBefore).to.equal(tokenAmount);
    });

    it("should revert when bounty is not Open", async function () {
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress, {
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
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress, {
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
        .createBounty(METADATA_CID, COMMUNITY, shortDeadline, 0, ethers.ZeroAddress, {
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
        .createBounty(METADATA_CID, COMMUNITY, shortDeadline, 0, ethers.ZeroAddress, {
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
        .createBounty(METADATA_CID, COMMUNITY, shortDeadline, 0, ethers.ZeroAddress);

      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);

      // nonAgent (not registered) can still expire bounties
      await expect(bountyContract.connect(nonAgent).expireBounty(0))
        .to.emit(bountyContract, "BountyExpired");
    });

    it("should revert when deadline has not passed", async function () {
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress);

      await expect(
        bountyContract.connect(agentB).expireBounty(0)
      ).to.be.revertedWithCustomError(bountyContract, "NotExpired");
    });

    it("should revert when bounty is Submitted", async function () {
      const latestBlock = await ethers.provider.getBlock("latest");
      const shortDeadline = latestBlock!.timestamp + 60;
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, shortDeadline, 0, ethers.ZeroAddress, {
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
        .createBounty(METADATA_CID, COMMUNITY, shortDeadline, 0, ethers.ZeroAddress, {
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
        .createBounty(METADATA_CID, COMMUNITY, shortDeadline, 0, ethers.ZeroAddress, {
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

    it("should revert admin calls from non-admin", async function () {
      await expect(
        bountyContract.connect(agentA).setPlatformFeeBps(100)
      ).to.be.revertedWithCustomError(
        bountyContract,
        "AccessControlUnauthorizedAccount"
      );

      await expect(
        bountyContract.connect(agentA).setTreasury(agentA.address)
      ).to.be.revertedWithCustomError(
        bountyContract,
        "AccessControlUnauthorizedAccount"
      );

      await expect(
        bountyContract.connect(agentA).setPaymentToken(agentA.address)
      ).to.be.revertedWithCustomError(
        bountyContract,
        "AccessControlUnauthorizedAccount"
      );

      await expect(
        bountyContract.connect(agentA).setAgentRegistry(agentA.address)
      ).to.be.revertedWithCustomError(
        bountyContract,
        "AccessControlUnauthorizedAccount"
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
          .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(bountyContract, "EnforcedPause");
    });

    it("should revert claimBounty when paused", async function () {
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress, {
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
          .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress)
      ).to.emit(bountyContract, "BountyCreated");
    });
  });

  // ============================================================
  //                     UUPS UPGRADE AUTH
  // ============================================================

  describe("UUPS Upgrade Auth", function () {
    it("should revert upgrade from non-admin", async function () {
      const BountyFactory = await ethers.getContractFactory("BountyContract");
      await expect(
        upgrades.upgradeProxy(await bountyContract.getAddress(), BountyFactory.connect(agentA), {
          constructorArgs: [await forwarder.getAddress()],
          unsafeAllow: ["constructor", "state-variable-immutable"],
        })
      ).to.be.revertedWithCustomError(
        bountyContract,
        "AccessControlUnauthorizedAccount"
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
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress, {
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
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress, {
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
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress);
      expect(await bountyContract.totalBounties()).to.equal(1);

      await bountyContract
        .connect(agentB)
        .createBounty(METADATA_CID_2, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress);
      expect(await bountyContract.totalBounties()).to.equal(2);
    });
  });

  // ============================================================
  //                    V3: ownerForceResolve
  // ============================================================

  describe("V3: ownerForceResolve", function () {
    /** Helper: create ETH bounty -> claim -> submit -> return bountyId */
    async function createClaimSubmit(
      creator: SignerWithAddress,
      worker: SignerWithAddress,
      ethAmount: bigint,
    ): Promise<number> {
      const dl = await futureDeadline();
      await bountyContract
        .connect(creator)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress, { value: ethAmount });
      const bountyId = Number(await bountyContract.totalBounties()) - 1;
      await bountyContract.connect(worker).claimBounty(bountyId);
      await bountyContract.connect(worker).submitWork(bountyId, SUBMISSION_CID);
      return bountyId;
    }

    it("should force-resolve Submitted bounty -> release to worker (ETH)", async function () {
      await bountyContract.connect(owner).setPlatformFeeBps(250);
      const bountyId = await createClaimSubmit(agentA, agentB, ethers.parseEther("1"));

      const workerBefore = await ethers.provider.getBalance(agentB.address);
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);

      await expect(bountyContract.connect(owner).ownerForceResolve(bountyId, true))
        .to.emit(bountyContract, "ForceResolved")
        .withArgs(bountyId, true, owner.address);

      const workerAfter = await ethers.provider.getBalance(agentB.address);
      const treasuryAfter = await ethers.provider.getBalance(treasury.address);

      // 2.5% fee on 1 ETH = 0.025 ETH
      expect(treasuryAfter - treasuryBefore).to.equal(ethers.parseEther("0.025"));
      expect(workerAfter - workerBefore).to.equal(ethers.parseEther("0.975"));

      const bounty = await bountyContract.getBounty(bountyId);
      expect(bounty.status).to.equal(3); // Approved
    });

    it("should force-resolve Submitted bounty -> refund to creator", async function () {
      const bountyId = await createClaimSubmit(agentA, agentB, ethers.parseEther("1"));

      const creatorBefore = await ethers.provider.getBalance(agentA.address);

      await bountyContract.connect(owner).ownerForceResolve(bountyId, false);

      const creatorAfter = await ethers.provider.getBalance(agentA.address);
      expect(creatorAfter - creatorBefore).to.equal(ethers.parseEther("1")); // full refund, no fee

      const bounty = await bountyContract.getBounty(bountyId);
      expect(bounty.status).to.equal(5); // Cancelled
    });

    it("should force-resolve Disputed bounty -> release to worker", async function () {
      await bountyContract.connect(owner).setPlatformFeeBps(500);
      const bountyId = await createClaimSubmit(agentA, agentB, ethers.parseEther("2"));
      await bountyContract.connect(agentA).disputeWork(bountyId);

      const workerBefore = await ethers.provider.getBalance(agentB.address);

      await bountyContract.connect(owner).ownerForceResolve(bountyId, true);

      const workerAfter = await ethers.provider.getBalance(agentB.address);
      // 5% of 2 ETH = 0.1, worker gets 1.9
      expect(workerAfter - workerBefore).to.equal(ethers.parseEther("1.9"));
    });

    it("should force-resolve Disputed bounty -> refund to creator", async function () {
      const bountyId = await createClaimSubmit(agentA, agentB, ethers.parseEther("1"));
      await bountyContract.connect(agentA).disputeWork(bountyId);

      const creatorBefore = await ethers.provider.getBalance(agentA.address);

      await bountyContract.connect(owner).ownerForceResolve(bountyId, false);

      const creatorAfter = await ethers.provider.getBalance(agentA.address);
      expect(creatorAfter - creatorBefore).to.equal(ethers.parseEther("1"));
    });

    it("should revert if not admin", async function () {
      const bountyId = await createClaimSubmit(agentA, agentB, ethers.parseEther("1"));

      await expect(
        bountyContract.connect(agentA).ownerForceResolve(bountyId, true),
      ).to.be.revertedWithCustomError(bountyContract, "AccessControlUnauthorizedAccount");
    });

    it("should revert if status is Open", async function () {
      const dl = await futureDeadline();
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress, { value: ethers.parseEther("1") });

      await expect(
        bountyContract.connect(owner).ownerForceResolve(0, true),
      ).to.be.revertedWithCustomError(bountyContract, "InvalidStatus");
    });

    it("should revert if status is Claimed", async function () {
      const dl = await futureDeadline();
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress, { value: ethers.parseEther("1") });
      await bountyContract.connect(agentB).claimBounty(0);

      await expect(
        bountyContract.connect(owner).ownerForceResolve(0, true),
      ).to.be.revertedWithCustomError(bountyContract, "InvalidStatus");
    });

    it("should revert if status is Approved", async function () {
      const bountyId = await createClaimSubmit(agentA, agentB, ethers.parseEther("1"));
      await bountyContract.connect(agentA).approveWork(bountyId);

      await expect(
        bountyContract.connect(owner).ownerForceResolve(bountyId, true),
      ).to.be.revertedWithCustomError(bountyContract, "InvalidStatus");
    });

    it("should revert if status is Cancelled", async function () {
      const dl = await futureDeadline();
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress, { value: ethers.parseEther("1") });
      await bountyContract.connect(agentA).cancelBounty(0);

      await expect(
        bountyContract.connect(owner).ownerForceResolve(0, true),
      ).to.be.revertedWithCustomError(bountyContract, "InvalidStatus");
    });

    it("should force-resolve with token escrow", async function () {
      // Set up token
      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const mockToken = (await MockERC20Factory.deploy("Mock", "MCK")) as unknown as MockERC20;
      await mockToken.waitForDeployment();
      const tokenAddr = await mockToken.getAddress();

      await bountyContract.connect(owner).setAllowedToken(tokenAddr, true);
      await bountyContract.connect(owner).setPlatformFeeBps(250);

      const amount = ethers.parseEther("10");
      await mockToken.mint(agentA.address, amount);
      await mockToken.connect(agentA).approve(await bountyContract.getAddress(), amount);

      const dl = await futureDeadline();
      await bountyContract.connect(agentA).createBounty(METADATA_CID, COMMUNITY, dl, amount, tokenAddr);
      const bountyId = Number(await bountyContract.totalBounties()) - 1;

      await bountyContract.connect(agentB).claimBounty(bountyId);
      await bountyContract.connect(agentB).submitWork(bountyId, SUBMISSION_CID);

      await bountyContract.connect(owner).ownerForceResolve(bountyId, true);

      // Worker gets 97.5% = 9.75 tokens, treasury gets 0.25
      expect(await mockToken.balanceOf(agentB.address)).to.equal(ethers.parseEther("9.75"));
      expect(await mockToken.balanceOf(treasury.address)).to.equal(ethers.parseEther("0.25"));
    });
  });

  // ============================================================
  //                    V3: expireSubmitted
  // ============================================================

  describe("V3: expireSubmitted", function () {
    /** Helper: create ETH bounty -> claim -> submit -> return bountyId */
    async function createClaimSubmit(
      creator: SignerWithAddress,
      worker: SignerWithAddress,
      ethAmount: bigint,
    ): Promise<number> {
      const dl = await futureDeadline();
      await bountyContract
        .connect(creator)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress, { value: ethAmount });
      const bountyId = Number(await bountyContract.totalBounties()) - 1;
      await bountyContract.connect(worker).claimBounty(bountyId);
      await bountyContract.connect(worker).submitWork(bountyId, SUBMISSION_CID);
      return bountyId;
    }

    it("should expire Submitted bounty after deadline + grace period -> worker paid", async function () {
      await bountyContract.connect(owner).setPlatformFeeBps(250);
      // Set grace period to 14 days
      await bountyContract.connect(owner).setSubmissionGracePeriod(14 * 86400);

      const bountyId = await createClaimSubmit(agentA, agentB, ethers.parseEther("1"));

      // Advance time past deadline + 14 days grace
      await ethers.provider.send("evm_increaseTime", [86400 + 14 * 86400 + 1]);
      await ethers.provider.send("evm_mine", []);

      const workerBefore = await ethers.provider.getBalance(agentB.address);
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);

      await expect(bountyContract.connect(agentC).expireSubmitted(bountyId))
        .to.emit(bountyContract, "SubmissionExpired")
        .withArgs(bountyId, agentB.address, ethers.parseEther("1"));

      const workerAfter = await ethers.provider.getBalance(agentB.address);
      const treasuryAfter = await ethers.provider.getBalance(treasury.address);

      expect(treasuryAfter - treasuryBefore).to.equal(ethers.parseEther("0.025"));
      expect(workerAfter - workerBefore).to.equal(ethers.parseEther("0.975"));

      const bounty = await bountyContract.getBounty(bountyId);
      expect(bounty.status).to.equal(3); // Approved
    });

    it("should revert if grace period not elapsed", async function () {
      await bountyContract.connect(owner).setSubmissionGracePeriod(14 * 86400);
      const bountyId = await createClaimSubmit(agentA, agentB, ethers.parseEther("1"));

      // Only advance past deadline, not past grace period
      await ethers.provider.send("evm_increaseTime", [86400 + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        bountyContract.connect(agentC).expireSubmitted(bountyId),
      ).to.be.revertedWithCustomError(bountyContract, "NotExpired");
    });

    it("should revert if status is not Submitted", async function () {
      const dl = await futureDeadline();
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress, { value: ethers.parseEther("1") });

      await ethers.provider.send("evm_increaseTime", [86400 + 14 * 86400 + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        bountyContract.connect(agentC).expireSubmitted(0),
      ).to.be.revertedWithCustomError(bountyContract, "InvalidStatus");
    });

    it("should allow anyone to call (not just owner/creator)", async function () {
      await bountyContract.connect(owner).setPlatformFeeBps(0);
      await bountyContract.connect(owner).setSubmissionGracePeriod(0); // zero grace

      const bountyId = await createClaimSubmit(agentA, agentB, ethers.parseEther("1"));

      await ethers.provider.send("evm_increaseTime", [86400 + 1]);
      await ethers.provider.send("evm_mine", []);

      // agentC is neither creator nor claimer
      await expect(bountyContract.connect(agentC).expireSubmitted(bountyId)).to.not.be.reverted;
    });

    it("should work with token escrow", async function () {
      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const mockToken = (await MockERC20Factory.deploy("Mock", "MCK")) as unknown as MockERC20;
      await mockToken.waitForDeployment();
      const tokenAddr = await mockToken.getAddress();

      await bountyContract.connect(owner).setAllowedToken(tokenAddr, true);
      await bountyContract.connect(owner).setPlatformFeeBps(500);
      await bountyContract.connect(owner).setSubmissionGracePeriod(14 * 86400);

      const amount = ethers.parseEther("10");
      await mockToken.mint(agentA.address, amount);
      await mockToken.connect(agentA).approve(await bountyContract.getAddress(), amount);

      const dl = await futureDeadline();
      await bountyContract.connect(agentA).createBounty(METADATA_CID, COMMUNITY, dl, amount, tokenAddr);
      const bountyId = Number(await bountyContract.totalBounties()) - 1;

      await bountyContract.connect(agentB).claimBounty(bountyId);
      await bountyContract.connect(agentB).submitWork(bountyId, SUBMISSION_CID);

      await ethers.provider.send("evm_increaseTime", [86400 + 14 * 86400 + 1]);
      await ethers.provider.send("evm_mine", []);

      await bountyContract.connect(agentC).expireSubmitted(bountyId);

      // 5% fee: worker gets 9.5, treasury gets 0.5
      expect(await mockToken.balanceOf(agentB.address)).to.equal(ethers.parseEther("9.5"));
      expect(await mockToken.balanceOf(treasury.address)).to.equal(ethers.parseEther("0.5"));
    });
  });

  // ============================================================
  //               V3: creationFeeBps (fee lock-in)
  // ============================================================

  describe("V3: creationFeeBps (fee lock-in)", function () {
    /** Helper: create ETH bounty -> claim -> submit -> return bountyId */
    async function createClaimSubmit(
      creator: SignerWithAddress,
      worker: SignerWithAddress,
      ethAmount: bigint,
    ): Promise<number> {
      const dl = await futureDeadline();
      await bountyContract
        .connect(creator)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress, { value: ethAmount });
      const bountyId = Number(await bountyContract.totalBounties()) - 1;
      await bountyContract.connect(worker).claimBounty(bountyId);
      await bountyContract.connect(worker).submitWork(bountyId, SUBMISSION_CID);
      return bountyId;
    }

    it("should store fee at creation time", async function () {
      await bountyContract.connect(owner).setPlatformFeeBps(250);
      const dl = await futureDeadline();
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress, { value: ethers.parseEther("1") });

      const bounty = await bountyContract.getBounty(0);
      expect(bounty.creationFeeBps).to.equal(250);
    });

    it("should NOT be affected by fee change after creation", async function () {
      await bountyContract.connect(owner).setPlatformFeeBps(250); // 2.5%
      const bountyId = await createClaimSubmit(agentA, agentB, ethers.parseEther("1"));

      // Change fee to 10% after creation
      await bountyContract.connect(owner).setPlatformFeeBps(1000);

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      await bountyContract.connect(agentA).approveWork(bountyId);
      const treasuryAfter = await ethers.provider.getBalance(treasury.address);

      // Should use locked 2.5%, NOT new 10%
      expect(treasuryAfter - treasuryBefore).to.equal(ethers.parseEther("0.025"));
    });

    it("should apply locked fee to resolveDispute", async function () {
      await bountyContract.connect(owner).setPlatformFeeBps(250);
      const bountyId = await createClaimSubmit(agentA, agentB, ethers.parseEther("1"));
      await bountyContract.connect(agentA).disputeWork(bountyId);

      // Change fee
      await bountyContract.connect(owner).setPlatformFeeBps(1000);

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      await bountyContract.connect(owner).resolveDispute(bountyId, true);
      const treasuryAfter = await ethers.provider.getBalance(treasury.address);

      // Should use locked 2.5%
      expect(treasuryAfter - treasuryBefore).to.equal(ethers.parseEther("0.025"));
    });

    it("should apply locked fee to ownerForceResolve", async function () {
      await bountyContract.connect(owner).setPlatformFeeBps(500);
      const bountyId = await createClaimSubmit(agentA, agentB, ethers.parseEther("1"));

      // Change fee
      await bountyContract.connect(owner).setPlatformFeeBps(0);

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      await bountyContract.connect(owner).ownerForceResolve(bountyId, true);
      const treasuryAfter = await ethers.provider.getBalance(treasury.address);

      // Should use locked 5%, not current 0%
      expect(treasuryAfter - treasuryBefore).to.equal(ethers.parseEther("0.05"));
    });

    it("should apply locked fee to expireSubmitted", async function () {
      await bountyContract.connect(owner).setPlatformFeeBps(250);
      await bountyContract.connect(owner).setSubmissionGracePeriod(0);
      const bountyId = await createClaimSubmit(agentA, agentB, ethers.parseEther("1"));

      // Change fee
      await bountyContract.connect(owner).setPlatformFeeBps(1000);

      await ethers.provider.send("evm_increaseTime", [86400 + 1]);
      await ethers.provider.send("evm_mine", []);

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      await bountyContract.connect(agentC).expireSubmitted(bountyId);
      const treasuryAfter = await ethers.provider.getBalance(treasury.address);

      // Should use locked 2.5%
      expect(treasuryAfter - treasuryBefore).to.equal(ethers.parseEther("0.025"));
    });

    it("pre-V3 bounties (creationFeeBps == 0) should fall back to global fee", async function () {
      // Simulate pre-V3 bounty: create with fee=0 (so creationFeeBps is stored as 0)
      await bountyContract.connect(owner).setPlatformFeeBps(0);
      const bountyId = await createClaimSubmit(agentA, agentB, ethers.parseEther("1"));

      // Now set global fee -- pre-V3 bounties should use this fallback
      await bountyContract.connect(owner).setPlatformFeeBps(500);

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      await bountyContract.connect(agentA).approveWork(bountyId);
      const treasuryAfter = await ethers.provider.getBalance(treasury.address);

      // creationFeeBps==0 -> falls back to global 500 bps (5%)
      expect(treasuryAfter - treasuryBefore).to.equal(ethers.parseEther("0.05"));
    });
  });

  // ============================================================
  //               V3: submissionGracePeriod
  // ============================================================

  describe("V3: submissionGracePeriod", function () {
    it("should default to 14 days after initializeV3", async function () {
      // initializeV3 is called in beforeEach, so it should be 14 days
      expect(await bountyContract.submissionGracePeriod()).to.equal(14 * 86400);
    });

    it("admin can set grace period", async function () {
      await bountyContract.connect(owner).setSubmissionGracePeriod(14 * 86400);
      expect(await bountyContract.submissionGracePeriod()).to.equal(14 * 86400);
    });

    it("admin can change grace period and expireSubmitted respects it", async function () {
      await bountyContract.connect(owner).setPlatformFeeBps(0);

      const dl = await futureDeadline();
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress, { value: ethers.parseEther("1") });
      await bountyContract.connect(agentB).claimBounty(0);
      await bountyContract.connect(agentB).submitWork(0, SUBMISSION_CID);

      // Set 7-day grace
      await bountyContract.connect(owner).setSubmissionGracePeriod(7 * 86400);

      // Advance past deadline + 7 days
      await ethers.provider.send("evm_increaseTime", [86400 + 7 * 86400 + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(bountyContract.connect(agentC).expireSubmitted(0)).to.not.be.reverted;
    });

    it("non-admin cannot set grace period", async function () {
      await expect(
        bountyContract.connect(agentA).setSubmissionGracePeriod(86400),
      ).to.be.revertedWithCustomError(bountyContract, "AccessControlUnauthorizedAccount");
    });
  });

  // ============================================================
  //                   V4: AccessControl
  // ============================================================

  describe("V4: AccessControl", function () {
    it("admin can call all admin functions", async function () {
      // setPlatformFeeBps
      await expect(bountyContract.connect(owner).setPlatformFeeBps(100)).to.not.be.reverted;

      // setTreasury
      await expect(bountyContract.connect(owner).setTreasury(agentC.address)).to.not.be.reverted;

      // setPaymentToken
      await expect(bountyContract.connect(owner).setPaymentToken(ethers.ZeroAddress)).to.not.be.reverted;

      // setAgentRegistry
      await expect(bountyContract.connect(owner).setAgentRegistry(agentC.address)).to.not.be.reverted;

      // setSubmissionGracePeriod
      await expect(bountyContract.connect(owner).setSubmissionGracePeriod(7 * 86400)).to.not.be.reverted;

      // setAllowedToken
      await expect(bountyContract.connect(owner).setAllowedToken(agentC.address, true)).to.not.be.reverted;
    });

    it("non-admin reverts with AccessControlUnauthorizedAccount on all admin functions", async function () {
      await expect(
        bountyContract.connect(agentA).setPlatformFeeBps(100)
      ).to.be.revertedWithCustomError(bountyContract, "AccessControlUnauthorizedAccount")
        .withArgs(agentA.address, DEFAULT_ADMIN_ROLE);

      await expect(
        bountyContract.connect(agentA).setTreasury(agentA.address)
      ).to.be.revertedWithCustomError(bountyContract, "AccessControlUnauthorizedAccount")
        .withArgs(agentA.address, DEFAULT_ADMIN_ROLE);

      await expect(
        bountyContract.connect(agentA).setPaymentToken(agentA.address)
      ).to.be.revertedWithCustomError(bountyContract, "AccessControlUnauthorizedAccount")
        .withArgs(agentA.address, DEFAULT_ADMIN_ROLE);

      await expect(
        bountyContract.connect(agentA).setAgentRegistry(agentA.address)
      ).to.be.revertedWithCustomError(bountyContract, "AccessControlUnauthorizedAccount")
        .withArgs(agentA.address, DEFAULT_ADMIN_ROLE);

      await expect(
        bountyContract.connect(agentA).setSubmissionGracePeriod(86400)
      ).to.be.revertedWithCustomError(bountyContract, "AccessControlUnauthorizedAccount")
        .withArgs(agentA.address, DEFAULT_ADMIN_ROLE);

      await expect(
        bountyContract.connect(agentA).setAllowedToken(agentA.address, true)
      ).to.be.revertedWithCustomError(bountyContract, "AccessControlUnauthorizedAccount")
        .withArgs(agentA.address, DEFAULT_ADMIN_ROLE);

      await expect(
        bountyContract.connect(agentA).unpause()
      ).to.be.revertedWithCustomError(bountyContract, "AccessControlUnauthorizedAccount")
        .withArgs(agentA.address, DEFAULT_ADMIN_ROLE);
    });

    it("guardian can pause", async function () {
      await expect(bountyContract.connect(guardian).pause()).to.not.be.reverted;
      expect(await bountyContract.paused()).to.be.true;
    });

    it("guardian cannot unpause", async function () {
      await bountyContract.connect(guardian).pause();

      await expect(
        bountyContract.connect(guardian).unpause()
      ).to.be.revertedWithCustomError(bountyContract, "AccessControlUnauthorizedAccount")
        .withArgs(guardian.address, DEFAULT_ADMIN_ROLE);
    });

    it("admin can pause and unpause", async function () {
      await bountyContract.connect(owner).pause();
      expect(await bountyContract.paused()).to.be.true;

      await bountyContract.connect(owner).unpause();
      expect(await bountyContract.paused()).to.be.false;
    });

    it("non-guardian non-admin cannot pause", async function () {
      await expect(
        bountyContract.connect(agentA).pause()
      ).to.be.revertedWithCustomError(bountyContract, "AccessControlUnauthorizedAccount")
        .withArgs(agentA.address, GUARDIAN_ROLE);
    });

    it("emergencyWithdraw works for admin (ERC-20)", async function () {
      // Deploy MockERC20 and send tokens to the bounty contract
      const MockFactory = await ethers.getContractFactory("MockERC20");
      const mockToken = (await MockFactory.deploy("Mock", "MCK")) as unknown as MockERC20;
      await mockToken.waitForDeployment();
      const tokenAddr = await mockToken.getAddress();

      const amount = ethers.parseEther("10");
      await mockToken.mint(await bountyContract.getAddress(), amount);

      const recipientBefore = await mockToken.balanceOf(treasury.address);

      await expect(
        bountyContract.connect(owner).emergencyWithdraw(tokenAddr, treasury.address, amount)
      ).to.emit(bountyContract, "EmergencyWithdraw")
        .withArgs(tokenAddr, treasury.address, amount);

      const recipientAfter = await mockToken.balanceOf(treasury.address);
      expect(recipientAfter - recipientBefore).to.equal(amount);
    });

    it("emergencyWithdraw reverts for non-admin", async function () {
      const MockFactory = await ethers.getContractFactory("MockERC20");
      const mockToken = (await MockFactory.deploy("Mock", "MCK")) as unknown as MockERC20;
      await mockToken.waitForDeployment();

      await expect(
        bountyContract.connect(agentA).emergencyWithdraw(await mockToken.getAddress(), agentA.address, 1)
      ).to.be.revertedWithCustomError(bountyContract, "AccessControlUnauthorizedAccount")
        .withArgs(agentA.address, DEFAULT_ADMIN_ROLE);
    });

    it("emergencyWithdraw reverts with ZeroAddress recipient", async function () {
      const MockFactory = await ethers.getContractFactory("MockERC20");
      const mockToken = (await MockFactory.deploy("Mock", "MCK")) as unknown as MockERC20;
      await mockToken.waitForDeployment();

      await expect(
        bountyContract.connect(owner).emergencyWithdraw(await mockToken.getAddress(), ethers.ZeroAddress, 1)
      ).to.be.revertedWithCustomError(bountyContract, "ZeroAddress");
    });

    it("emergencyWithdraw reverts with ZeroAmount", async function () {
      const MockFactory = await ethers.getContractFactory("MockERC20");
      const mockToken = (await MockFactory.deploy("Mock", "MCK")) as unknown as MockERC20;
      await mockToken.waitForDeployment();

      await expect(
        bountyContract.connect(owner).emergencyWithdraw(await mockToken.getAddress(), treasury.address, 0)
      ).to.be.revertedWithCustomError(bountyContract, "ZeroAmount");
    });

    it("rescueETH works for admin", async function () {
      // Send ETH to the contract via a bounty, then cancel to leave ETH behind
      // Or just send directly via a fallback — but the contract might not have receive()
      // Instead, create and cancel a bounty to get ETH in, then use rescueETH on the remainder
      // Actually, the simplest is to just fund via createBounty and then use rescueETH
      const ethAmount = ethers.parseEther("1");
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress, {
          value: ethAmount,
        });

      const recipientBefore = await ethers.provider.getBalance(treasury.address);

      await expect(
        bountyContract.connect(owner).rescueETH(treasury.address, ethAmount)
      ).to.emit(bountyContract, "EmergencyETHWithdraw")
        .withArgs(treasury.address, ethAmount);

      const recipientAfter = await ethers.provider.getBalance(treasury.address);
      expect(recipientAfter - recipientBefore).to.equal(ethAmount);
    });

    it("rescueETH reverts for non-admin", async function () {
      await expect(
        bountyContract.connect(agentA).rescueETH(agentA.address, 1)
      ).to.be.revertedWithCustomError(bountyContract, "AccessControlUnauthorizedAccount")
        .withArgs(agentA.address, DEFAULT_ADMIN_ROLE);
    });

    it("rescueETH reverts with ZeroAddress recipient", async function () {
      await expect(
        bountyContract.connect(owner).rescueETH(ethers.ZeroAddress, 1)
      ).to.be.revertedWithCustomError(bountyContract, "ZeroAddress");
    });

    it("rescueETH reverts with ZeroAmount", async function () {
      await expect(
        bountyContract.connect(owner).rescueETH(treasury.address, 0)
      ).to.be.revertedWithCustomError(bountyContract, "ZeroAmount");
    });

    it("admin can grant and revoke roles", async function () {
      // Grant GUARDIAN_ROLE to agentA
      await bountyContract.connect(owner).grantRole(GUARDIAN_ROLE, agentA.address);
      expect(await bountyContract.hasRole(GUARDIAN_ROLE, agentA.address)).to.be.true;

      // agentA can now pause
      await bountyContract.connect(agentA).pause();
      expect(await bountyContract.paused()).to.be.true;
      await bountyContract.connect(owner).unpause();

      // Revoke GUARDIAN_ROLE from agentA
      await bountyContract.connect(owner).revokeRole(GUARDIAN_ROLE, agentA.address);
      expect(await bountyContract.hasRole(GUARDIAN_ROLE, agentA.address)).to.be.false;

      // agentA can no longer pause
      await expect(
        bountyContract.connect(agentA).pause()
      ).to.be.revertedWithCustomError(bountyContract, "AccessControlUnauthorizedAccount")
        .withArgs(agentA.address, GUARDIAN_ROLE);
    });

    it("non-admin cannot grant roles", async function () {
      await expect(
        bountyContract.connect(agentA).grantRole(GUARDIAN_ROLE, agentB.address)
      ).to.be.revertedWithCustomError(bountyContract, "AccessControlUnauthorizedAccount")
        .withArgs(agentA.address, DEFAULT_ADMIN_ROLE);
    });

    it("non-admin cannot revoke roles", async function () {
      await expect(
        bountyContract.connect(agentA).revokeRole(GUARDIAN_ROLE, guardian.address)
      ).to.be.revertedWithCustomError(bountyContract, "AccessControlUnauthorizedAccount")
        .withArgs(agentA.address, DEFAULT_ADMIN_ROLE);
    });

    it("initializeV4 reverts with zero admin address", async function () {
      // Deploy a fresh proxy without V4 initialized
      const forwarderAddress = await forwarder.getAddress();
      const BountyFactory = await ethers.getContractFactory("BountyContract");
      const fresh = (await upgrades.deployProxy(
        BountyFactory,
        [owner.address, await registry.getAddress(), treasury.address],
        {
          kind: "uups",
          constructorArgs: [forwarderAddress],
          unsafeAllow: ["constructor", "state-variable-immutable"],
        }
      )) as unknown as BountyContract;
      await fresh.waitForDeployment();
      await fresh.initializeV2(ethers.ZeroAddress, ethers.ZeroAddress);
      await fresh.initializeV3();

      await expect(
        fresh.initializeV4(ethers.ZeroAddress, guardian.address)
      ).to.be.revertedWithCustomError(fresh, "ZeroAddress");
    });

    it("initializeV4 works with zero guardian (optional)", async function () {
      // Deploy a fresh proxy without V4 initialized
      const forwarderAddress = await forwarder.getAddress();
      const BountyFactory = await ethers.getContractFactory("BountyContract");
      const fresh = (await upgrades.deployProxy(
        BountyFactory,
        [owner.address, await registry.getAddress(), treasury.address],
        {
          kind: "uups",
          constructorArgs: [forwarderAddress],
          unsafeAllow: ["constructor", "state-variable-immutable"],
        }
      )) as unknown as BountyContract;
      await fresh.waitForDeployment();
      await fresh.initializeV2(ethers.ZeroAddress, ethers.ZeroAddress);
      await fresh.initializeV3();

      // Should not revert when guardian is zero (it just skips granting)
      await expect(
        fresh.initializeV4(owner.address, ethers.ZeroAddress)
      ).to.not.be.reverted;

      expect(await fresh.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;
      // No guardian role granted to zero address
      expect(await fresh.hasRole(GUARDIAN_ROLE, ethers.ZeroAddress)).to.be.false;
    });

    it("initializeV4 zeros out Ownable ownership", async function () {
      expect(await bountyContract.owner()).to.equal(ethers.ZeroAddress);
    });

    it("guardian cannot call admin-only functions", async function () {
      await expect(
        bountyContract.connect(guardian).setPlatformFeeBps(100)
      ).to.be.revertedWithCustomError(bountyContract, "AccessControlUnauthorizedAccount")
        .withArgs(guardian.address, DEFAULT_ADMIN_ROLE);

      await expect(
        bountyContract.connect(guardian).setTreasury(agentA.address)
      ).to.be.revertedWithCustomError(bountyContract, "AccessControlUnauthorizedAccount")
        .withArgs(guardian.address, DEFAULT_ADMIN_ROLE);

      await expect(
        bountyContract.connect(guardian).emergencyWithdraw(agentA.address, agentA.address, 1)
      ).to.be.revertedWithCustomError(bountyContract, "AccessControlUnauthorizedAccount")
        .withArgs(guardian.address, DEFAULT_ADMIN_ROLE);

      await expect(
        bountyContract.connect(guardian).rescueETH(agentA.address, 1)
      ).to.be.revertedWithCustomError(bountyContract, "AccessControlUnauthorizedAccount")
        .withArgs(guardian.address, DEFAULT_ADMIN_ROLE);
    });

    it("resolveDispute requires DEFAULT_ADMIN_ROLE", async function () {
      // Create disputed bounty
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress, {
          value: ethers.parseEther("1"),
        });
      await bountyContract.connect(agentB).claimBounty(0);
      await bountyContract.connect(agentB).submitWork(0, SUBMISSION_CID);
      await bountyContract.connect(agentA).disputeWork(0);

      // Guardian cannot resolve
      await expect(
        bountyContract.connect(guardian).resolveDispute(0, true)
      ).to.be.revertedWithCustomError(bountyContract, "AccessControlUnauthorizedAccount")
        .withArgs(guardian.address, DEFAULT_ADMIN_ROLE);

      // Admin can resolve
      await expect(bountyContract.connect(owner).resolveDispute(0, true)).to.not.be.reverted;
    });

    it("ownerForceResolve requires DEFAULT_ADMIN_ROLE", async function () {
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress, {
          value: ethers.parseEther("1"),
        });
      await bountyContract.connect(agentB).claimBounty(0);
      await bountyContract.connect(agentB).submitWork(0, SUBMISSION_CID);

      // Guardian cannot force-resolve
      await expect(
        bountyContract.connect(guardian).ownerForceResolve(0, true)
      ).to.be.revertedWithCustomError(bountyContract, "AccessControlUnauthorizedAccount")
        .withArgs(guardian.address, DEFAULT_ADMIN_ROLE);

      // Admin can force-resolve
      await expect(bountyContract.connect(owner).ownerForceResolve(0, true)).to.not.be.reverted;
    });
  });

  // ============================================================
  //                  V5 — CREATOR-APPROVED CLAIMING
  // ============================================================

  describe("V5 — Creator-Approved Claiming", function () {
    /**
     * Helper: create a bounty BEFORE V5 upgrade (no approval required).
     * Returns the bountyId (0-based, first created in this test).
     */
    async function createPreV5Bounty(): Promise<number> {
      const dl = await futureDeadline();
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress);
      return Number(await bountyContract.totalBounties()) - 1;
    }

    it("approveClaimer sets the approved address", async function () {
      await bountyContract.initializeV5();
      const dl = await futureDeadline();
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress);
      const bountyId = 0;

      await bountyContract.connect(agentA).approveClaimer(bountyId, agentB.address);

      expect(await bountyContract.approvedClaimers(bountyId)).to.equal(agentB.address);
      expect(await bountyContract.getApprovedClaimer(bountyId)).to.equal(agentB.address);
    });

    it("approveClaimer reverts if not creator (NotCreator)", async function () {
      await bountyContract.initializeV5();
      const dl = await futureDeadline();
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress);

      await expect(
        bountyContract.connect(agentB).approveClaimer(0, agentB.address)
      ).to.be.revertedWithCustomError(bountyContract, "NotCreator");
    });

    it("approveClaimer reverts if bounty not Open (InvalidStatus)", async function () {
      await bountyContract.initializeV5();
      const dl = await futureDeadline();
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress);

      // Approve and claim to move to Claimed status
      await bountyContract.connect(agentA).approveClaimer(0, agentB.address);
      await bountyContract.connect(agentB).claimBounty(0);

      await expect(
        bountyContract.connect(agentA).approveClaimer(0, agentC.address)
      ).to.be.revertedWithCustomError(bountyContract, "InvalidStatus");
    });

    it("approveClaimer with address(0) revokes approval", async function () {
      await bountyContract.initializeV5();
      const dl = await futureDeadline();
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress);

      // Approve then revoke
      await bountyContract.connect(agentA).approveClaimer(0, agentB.address);
      expect(await bountyContract.getApprovedClaimer(0)).to.equal(agentB.address);

      await bountyContract.connect(agentA).approveClaimer(0, ethers.ZeroAddress);
      expect(await bountyContract.getApprovedClaimer(0)).to.equal(ethers.ZeroAddress);

      // Now agentB cannot claim
      await expect(
        bountyContract.connect(agentB).claimBounty(0)
      ).to.be.revertedWithCustomError(bountyContract, "NotApprovedClaimer");
    });

    it("approveClaimer overwrites previous approval", async function () {
      await bountyContract.initializeV5();
      const dl = await futureDeadline();
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress);

      await bountyContract.connect(agentA).approveClaimer(0, agentB.address);
      expect(await bountyContract.getApprovedClaimer(0)).to.equal(agentB.address);

      await bountyContract.connect(agentA).approveClaimer(0, agentC.address);
      expect(await bountyContract.getApprovedClaimer(0)).to.equal(agentC.address);

      // agentB can no longer claim
      await expect(
        bountyContract.connect(agentB).claimBounty(0)
      ).to.be.revertedWithCustomError(bountyContract, "NotApprovedClaimer");

      // agentC can claim
      await bountyContract.connect(agentC).claimBounty(0);
      const bounty = await bountyContract.getBounty(0);
      expect(bounty.claimer).to.equal(agentC.address);
    });

    it("claimBounty succeeds for pre-V5 bounties without approval (backward compat)", async function () {
      // Create bounty BEFORE V5 upgrade
      const preV5Id = await createPreV5Bounty();

      // Now upgrade to V5 — threshold will be set to nextBountyId (1)
      await bountyContract.initializeV5();
      expect(await bountyContract.approvedClaimerSinceId()).to.equal(1);
      expect(await bountyContract.v5Active()).to.equal(true);

      // Pre-V5 bounty (id=0) should be claimable by anyone without approval
      await bountyContract.connect(agentB).claimBounty(preV5Id);
      const bounty = await bountyContract.getBounty(preV5Id);
      expect(bounty.claimer).to.equal(agentB.address);
      expect(bounty.status).to.equal(1); // Claimed
    });

    it("v5Active defaults to false before initializeV5", async function () {
      expect(await bountyContract.v5Active()).to.equal(false);
    });

    it("claimBounty works without V5 initialization (v5Active = false)", async function () {
      // Without initializeV5, v5Active is false, enforcement is off
      const dl = await futureDeadline();
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress);

      await bountyContract.connect(agentB).claimBounty(0);
      const bounty = await bountyContract.getBounty(0);
      expect(bounty.claimer).to.equal(agentB.address);
    });

    it("claimBounty reverts for V5+ bounty with no approval (NotApprovedClaimer)", async function () {
      await bountyContract.initializeV5();
      const dl = await futureDeadline();
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress);

      // No approval set — should revert
      await expect(
        bountyContract.connect(agentB).claimBounty(0)
      ).to.be.revertedWithCustomError(bountyContract, "NotApprovedClaimer");
    });

    it("claimBounty reverts for V5+ bounty with wrong claimer (NotApprovedClaimer)", async function () {
      await bountyContract.initializeV5();
      const dl = await futureDeadline();
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress);

      // Approve agentB but agentC tries to claim
      await bountyContract.connect(agentA).approveClaimer(0, agentB.address);

      await expect(
        bountyContract.connect(agentC).claimBounty(0)
      ).to.be.revertedWithCustomError(bountyContract, "NotApprovedClaimer");
    });

    it("claimBounty succeeds for V5+ bounty when approved claimer calls (V7: auto-payout)", async function () {
      await bountyContract.initializeV5();
      const dl = await futureDeadline();
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress);

      await bountyContract.connect(agentA).approveClaimer(0, agentB.address);
      await bountyContract.connect(agentB).claimBounty(0);

      const bounty = await bountyContract.getBounty(0);
      expect(bounty.claimer).to.equal(agentB.address);
      expect(bounty.status).to.equal(3); // V7: Approved (auto-payout for pre-approved claimers)
    });

    it("ClaimerApproved event emitted correctly", async function () {
      await bountyContract.initializeV5();
      const dl = await futureDeadline();
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress);

      await expect(bountyContract.connect(agentA).approveClaimer(0, agentB.address))
        .to.emit(bountyContract, "ClaimerApproved")
        .withArgs(0, agentB.address);
    });

    it("initializeV5 cannot be called twice (reinitializer guard)", async function () {
      await bountyContract.initializeV5();

      await expect(bountyContract.initializeV5()).to.be.revertedWithCustomError(
        bountyContract,
        "InvalidInitialization"
      );
    });

    it("approveClaimer works through NookplotForwarder (meta-tx)", async function () {
      await bountyContract.initializeV5();
      const dl = await futureDeadline();
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress);

      // agentA signs a ForwardRequest to approve agentB as claimer
      const contractAddress = await bountyContract.getAddress();
      const data = bountyContract.interface.encodeFunctionData("approveClaimer", [
        0,
        agentB.address,
      ]);
      const nonce = await forwarder.nonces(agentA.address);
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
        from: agentA.address,
        to: contractAddress,
        value: 0n,
        gas: 500000n,
        nonce: nonce,
        deadline: deadline,
        data: data,
      };

      const signature = await agentA.signTypedData(domain, types, request);
      const tx = await forwarder
        .connect(agentC)
        .execute({ ...request, signature });
      await tx.wait();

      // Verify approval was set via meta-tx (agentA is the creator, not agentC)
      expect(await bountyContract.getApprovedClaimer(0)).to.equal(agentB.address);
    });

    it("paused contract blocks approveClaimer", async function () {
      await bountyContract.initializeV5();
      const dl = await futureDeadline();
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress);

      await bountyContract.connect(owner).pause();

      await expect(
        bountyContract.connect(agentA).approveClaimer(0, agentB.address)
      ).to.be.revertedWithCustomError(bountyContract, "EnforcedPause");
    });

    it("getApprovedClaimer reverts for non-existent bounty", async function () {
      await bountyContract.initializeV5();
      await expect(
        bountyContract.getApprovedClaimer(999)
      ).to.be.revertedWithCustomError(bountyContract, "BountyNotFound");
    });

    // --- Edge case tests (audit findings) ---

    it("approveClaimer reverts on non-existent bountyId (BountyNotFound)", async function () {
      await bountyContract.initializeV5();
      await expect(
        bountyContract.connect(agentA).approveClaimer(999, agentB.address)
      ).to.be.revertedWithCustomError(bountyContract, "BountyNotFound");
    });

    it("approveClaimer reverts on Cancelled bounty (InvalidStatus)", async function () {
      await bountyContract.initializeV5();
      const dl = await futureDeadline();
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress);

      // Cancel the bounty
      await bountyContract.connect(agentA).cancelBounty(0);

      await expect(
        bountyContract.connect(agentA).approveClaimer(0, agentB.address)
      ).to.be.revertedWithCustomError(bountyContract, "InvalidStatus");
    });

    it("approveClaimer reverts on Expired bounty (InvalidStatus)", async function () {
      await bountyContract.initializeV5();
      const block = await ethers.provider.getBlock("latest");
      const shortDeadline = block!.timestamp + 60; // 60 seconds
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, shortDeadline, 0, ethers.ZeroAddress);

      // Fast-forward past the deadline
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);

      // Expire the bounty
      await bountyContract.connect(agentA).expireBounty(0);

      await expect(
        bountyContract.connect(agentA).approveClaimer(0, agentB.address)
      ).to.be.revertedWithCustomError(bountyContract, "InvalidStatus");
    });

    it("approveClaimer reverts when creator approves themselves (CannotClaimOwnBounty)", async function () {
      await bountyContract.initializeV5();
      const dl = await futureDeadline();
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress);

      await expect(
        bountyContract.connect(agentA).approveClaimer(0, agentA.address)
      ).to.be.revertedWithCustomError(bountyContract, "CannotClaimOwnBounty");
    });

    it("revoke then claim — revoked agent cannot claim (NotApprovedClaimer)", async function () {
      await bountyContract.initializeV5();
      const dl = await futureDeadline();
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress);

      // Approve agentB, then revoke
      await bountyContract.connect(agentA).approveClaimer(0, agentB.address);
      await bountyContract.connect(agentA).approveClaimer(0, ethers.ZeroAddress);

      // agentB tries to claim — should revert
      await expect(
        bountyContract.connect(agentB).claimBounty(0)
      ).to.be.revertedWithCustomError(bountyContract, "NotApprovedClaimer");
    });

    it("re-approve after revocation — new agent can claim", async function () {
      await bountyContract.initializeV5();
      const dl = await futureDeadline();
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress);

      // Approve agentB, revoke, then approve agentC
      await bountyContract.connect(agentA).approveClaimer(0, agentB.address);
      await bountyContract.connect(agentA).approveClaimer(0, ethers.ZeroAddress);
      await bountyContract.connect(agentA).approveClaimer(0, agentC.address);

      // agentB cannot claim
      await expect(
        bountyContract.connect(agentB).claimBounty(0)
      ).to.be.revertedWithCustomError(bountyContract, "NotApprovedClaimer");

      // agentC can claim
      await bountyContract.connect(agentC).claimBounty(0);
      const bounty = await bountyContract.getBounty(0);
      expect(bounty.claimer).to.equal(agentC.address);
      expect(bounty.status).to.equal(3); // V7: Approved (auto-payout for pre-approved claimers)
    });

    it("V7: pre-approved claim goes directly to Approved — unclaim not possible", async function () {
      await bountyContract.initializeV5();
      const dl = await futureDeadline();
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress);

      // Approve agentB, claim → V7 auto-payout → status = Approved
      await bountyContract.connect(agentA).approveClaimer(0, agentB.address);
      await bountyContract.connect(agentB).claimBounty(0);

      const bounty = await bountyContract.getBounty(0);
      expect(bounty.status).to.equal(3); // Approved (V7 auto-payout)
      expect(bounty.claimer).to.equal(agentB.address);

      // Cannot unclaim an Approved bounty
      await expect(
        bountyContract.connect(agentB).unclaimBounty(0)
      ).to.be.revertedWithCustomError(bountyContract, "InvalidStatus");
    });

    it("boundary: bountyId == approvedClaimerSinceId requires approval", async function () {
      // Create one bounty before V5 upgrade to set nextBountyId = 1
      const preV5Id = await createPreV5Bounty();

      // Initialize V5 — threshold = nextBountyId = 1
      await bountyContract.initializeV5();
      expect(await bountyContract.approvedClaimerSinceId()).to.equal(1);

      // Create bounty at id=1 (== approvedClaimerSinceId)
      const dl = await futureDeadline();
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress);
      const bountyAtThreshold = Number(await bountyContract.totalBounties()) - 1;
      expect(bountyAtThreshold).to.equal(1);

      // This bounty should require approval (1 >= 1 = true)
      await expect(
        bountyContract.connect(agentB).claimBounty(bountyAtThreshold)
      ).to.be.revertedWithCustomError(bountyContract, "NotApprovedClaimer");

      // Pre-V5 bounty (id=0) should NOT require approval
      await bountyContract.connect(agentB).claimBounty(preV5Id);
      const oldBounty = await bountyContract.getBounty(preV5Id);
      expect(oldBounty.claimer).to.equal(agentB.address);

      // Approve and claim the threshold bounty
      await bountyContract.connect(agentA).approveClaimer(bountyAtThreshold, agentC.address);
      await bountyContract.connect(agentC).claimBounty(bountyAtThreshold);
      const thresholdBounty = await bountyContract.getBounty(bountyAtThreshold);
      expect(thresholdBounty.claimer).to.equal(agentC.address);
    });
  });

  // ============================================================
  //              V7 — AUTO-PAYOUT FOR PRE-APPROVED CLAIMS
  // ============================================================

  describe("V7 — Auto-payout on claim for pre-approved claimers", function () {
    let v7Token: MockERC20;
    const tokenAmount = ethers.parseEther("100");

    beforeEach(async function () {
      const MockFactory = await ethers.getContractFactory("MockERC20");
      v7Token = (await MockFactory.deploy("TestToken", "TT")) as unknown as MockERC20;
      await v7Token.waitForDeployment();

      // Whitelist the token
      await bountyContract.setAllowedToken(await v7Token.getAddress(), true);

      // Initialize V5 for approved claimer enforcement
      await bountyContract.initializeV5();
    });

    it("pre-approved claim with token escrow auto-pays the claimer", async function () {
      // Mint and approve tokens for bounty creator
      await v7Token.mint(agentA.address, tokenAmount);
      await v7Token.connect(agentA).approve(await bountyContract.getAddress(), tokenAmount);

      // Create token bounty
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), tokenAmount, await v7Token.getAddress());

      // Approve claimer and claim
      await bountyContract.connect(agentA).approveClaimer(0, agentB.address);

      const balBefore = await v7Token.balanceOf(agentB.address);
      await bountyContract.connect(agentB).claimBounty(0);
      const balAfter = await v7Token.balanceOf(agentB.address);

      // Claimer received tokens (minus fee)
      expect(balAfter - balBefore).to.be.greaterThan(0);

      // Bounty status is Approved (skipped Claimed → Submitted → Approved)
      const bounty = await bountyContract.getBounty(0);
      expect(bounty.status).to.equal(3); // Approved
      expect(bounty.claimer).to.equal(agentB.address);
    });

    it("pre-approved claim emits both BountyClaimed and WorkApproved", async function () {
      await v7Token.mint(agentA.address, tokenAmount);
      await v7Token.connect(agentA).approve(await bountyContract.getAddress(), tokenAmount);

      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), tokenAmount, await v7Token.getAddress());

      await bountyContract.connect(agentA).approveClaimer(0, agentB.address);

      await expect(bountyContract.connect(agentB).claimBounty(0))
        .to.emit(bountyContract, "BountyClaimed")
        .withArgs(0, agentB.address)
        .and.to.emit(bountyContract, "WorkApproved");
    });

    it("pre-approved claim on reputation-only bounty goes to Approved without transfer", async function () {
      // Create reputation-only bounty (no escrow)
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress);

      await bountyContract.connect(agentA).approveClaimer(0, agentB.address);
      await bountyContract.connect(agentB).claimBounty(0);

      const bounty = await bountyContract.getBounty(0);
      expect(bounty.status).to.equal(3); // Approved
    });

    it("non-approved claim (pre-V5 bounty) still goes to Claimed", async function () {
      // Create a bounty BEFORE V5 init — need a fresh fixture
      // Use the fact that approvedClaimerSinceId was set at V5 init
      // Pre-V5 bounties (id < approvedClaimerSinceId) follow old flow
      const thresholdId = await bountyContract.approvedClaimerSinceId();

      // If there's a pre-V5 bounty, it should still go to Claimed
      // Create a new bounty (post-V5) but without approval to verify revert
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress);

      // Without approval, claim should revert
      await expect(
        bountyContract.connect(agentB).claimBounty(Number(thresholdId))
      ).to.be.revertedWithCustomError(bountyContract, "NotApprovedClaimer");
    });

    it("approveWork reverts after V7 auto-payout (no double-payout)", async function () {
      await bountyContract.connect(agentA).createBounty(
        METADATA_CID, COMMUNITY, await futureDeadline(), 0, ethers.ZeroAddress,
        { value: ethers.parseEther("1") },
      );
      const bountyId = (await bountyContract.totalBounties()) - 1n;
      await bountyContract.connect(agentA).approveClaimer(bountyId, agentB.address);
      await bountyContract.connect(agentB).claimBounty(bountyId);

      // Status is Approved (3) after auto-payout — approveWork requires Submitted (2)
      const bounty = await bountyContract.getBounty(bountyId);
      expect(bounty.status).to.equal(3);

      await expect(
        bountyContract.connect(agentA).approveWork(bountyId)
      ).to.be.revertedWithCustomError(bountyContract, "InvalidStatus");
    });
  });

  // ============================================================
  //                     V6 SECURITY FIXES
  // ============================================================

  describe("V6 — ETH rejected with token escrow", function () {
    let v6Token: MockERC20;

    beforeEach(async function () {
      const MockFactory = await ethers.getContractFactory("MockERC20");
      v6Token = (await MockFactory.deploy("Mock Token", "MOCK")) as unknown as MockERC20;
      await v6Token.waitForDeployment();
      await bountyContract.connect(owner).setAllowedToken(await v6Token.getAddress(), true);
    });

    it("should revert when ETH is sent with token escrow", async function () {
      const deadline = await futureDeadline();
      const amount = ethers.parseUnits("100", 18);
      await v6Token.mint(agentA.address, amount);
      await v6Token.connect(agentA).approve(await bountyContract.getAddress(), amount);

      await expect(
        bountyContract.connect(agentA).createBounty(
          METADATA_CID,
          COMMUNITY,
          deadline,
          amount,
          await v6Token.getAddress(),
          { value: ethers.parseEther("0.1") },
        )
      ).to.be.revertedWith("ETH not accepted with token escrow");
    });

    it("should still accept ETH-only escrow", async function () {
      const deadline = await futureDeadline();
      await bountyContract.connect(agentA).createBounty(
        METADATA_CID,
        COMMUNITY,
        deadline,
        0,
        ethers.ZeroAddress,
        { value: ethers.parseEther("0.1") },
      );
      const bounty = await bountyContract.getBounty(0);
      expect(bounty.rewardAmount).to.equal(ethers.parseEther("0.1"));
    });

    it("should still accept token-only escrow", async function () {
      const deadline = await futureDeadline();
      const amount = ethers.parseUnits("50", 18);
      await v6Token.mint(agentA.address, amount);
      await v6Token.connect(agentA).approve(await bountyContract.getAddress(), amount);

      await bountyContract.connect(agentA).createBounty(
        METADATA_CID,
        COMMUNITY,
        deadline,
        amount,
        await v6Token.getAddress(),
      );
      const bounty = await bountyContract.getBounty(0);
      expect(bounty.rewardAmount).to.equal(amount);
    });
  });

  describe("V6 — submission grace period bounds", function () {
    it("should reject grace period > 365 days", async function () {
      await expect(
        bountyContract.setSubmissionGracePeriod(366 * 86400)
      ).to.be.revertedWith("Period too long");
    });

    it("should accept grace period of 365 days", async function () {
      await bountyContract.setSubmissionGracePeriod(365 * 86400);
      expect(await bountyContract.submissionGracePeriod()).to.equal(365 * 86400);
    });

    it("should accept grace period of 0", async function () {
      await bountyContract.setSubmissionGracePeriod(0);
      expect(await bountyContract.submissionGracePeriod()).to.equal(0);
    });
  });

  describe("V6 — initializeV6", function () {
    it("should succeed on first call", async function () {
      await bountyContract.initializeV6();
    });

    it("should revert on second call (reinitializer guard)", async function () {
      await bountyContract.initializeV6();
      await expect(bountyContract.initializeV6()).to.be.revertedWithCustomError(
        bountyContract, "InvalidInitialization"
      );
    });
  });
});
