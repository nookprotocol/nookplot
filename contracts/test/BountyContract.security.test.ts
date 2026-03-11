import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import {
  AgentRegistry,
  BountyContract,
  NookplotForwarder,
  ReentrancyAttacker,
  RevertingReceiver,
} from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * BountyContract — Security Tests
 *
 * Covers: fee manipulation mid-escrow, treasury manipulation, reverting
 * treasury, rounding/precision, max fee, reentrancy, paused contract,
 * fee accumulation, fee toggle, and double-operation guards.
 */
describe("BountyContract — Security", function () {
  let registry: AgentRegistry;
  let bountyContract: BountyContract;
  let forwarder: NookplotForwarder;
  let owner: SignerWithAddress;
  let treasury: SignerWithAddress;
  let agentA: SignerWithAddress;
  let agentB: SignerWithAddress;
  let agentC: SignerWithAddress;
  let extra: SignerWithAddress;

  const DID_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const METADATA_CID = "QmBountyCidForTestingBountyContract1234567890ab";
  const SUBMISSION_CID = "QmSubmissionCidForTestBountyWork123456789012345";
  const COMMUNITY = "general";

  async function futureDeadline(): Promise<number> {
    const block = await ethers.provider.getBlock("latest");
    return block!.timestamp + 86400;
  }

  /** Helper: create ETH bounty → claim → submit → return bountyId */
  async function createClaimSubmit(
    creator: SignerWithAddress,
    worker: SignerWithAddress,
    ethAmount: bigint
  ): Promise<number> {
    const dl = await futureDeadline();
    const tx = await bountyContract
      .connect(creator)
      .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress, { value: ethAmount });
    const receipt = await tx.wait();
    // bountyId = nextBountyId - 1 at time of creation
    const bountyId = Number(await bountyContract.totalBounties()) - 1;

    await bountyContract.connect(worker).claimBounty(bountyId);
    await bountyContract.connect(worker).submitWork(bountyId, SUBMISSION_CID);
    return bountyId;
  }

  beforeEach(async function () {
    [owner, treasury, agentA, agentB, agentC, extra] =
      await ethers.getSigners();

    const ForwarderFactory =
      await ethers.getContractFactory("NookplotForwarder");
    forwarder =
      (await ForwarderFactory.deploy()) as unknown as NookplotForwarder;
    await forwarder.waitForDeployment();
    const forwarderAddress = await forwarder.getAddress();

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
    await bountyContract.initializeV2(ethers.ZeroAddress, ethers.ZeroAddress);
    await bountyContract.initializeV3();
    await bountyContract.initializeV4(owner.address, owner.address);

    // Register agents
    await registry.connect(agentA).register(DID_CID);
    await registry.connect(agentB).register(DID_CID);
    await registry.connect(agentC).register(DID_CID);
  });

  // ============================================================
  //           FEE LOCK-IN (V3) — fee locked at creation time
  // ============================================================
  describe("Fee Lock-In (V3)", function () {
    it("should apply fee rate locked at creation time, NOT current rate at approval", async function () {
      // Create bounty with 0% fee → creationFeeBps == 0 → falls back to global
      const bountyId = await createClaimSubmit(
        agentA,
        agentB,
        ethers.parseEther("1")
      );

      // Change fee to 5% (500 bps) after bounty created
      await bountyContract.connect(owner).setPlatformFeeBps(500);

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      await bountyContract.connect(agentA).approveWork(bountyId);
      const treasuryAfter = await ethers.provider.getBalance(treasury.address);

      // creationFeeBps == 0 → falls back to global 500 bps → 5% of 1 ETH = 0.05 ETH
      // (pre-V3 backward compat: 0 means "use global")
      expect(treasuryAfter - treasuryBefore).to.equal(
        ethers.parseEther("0.05")
      );
    });

    it("should NOT apply changed fee to bounty created with non-zero fee", async function () {
      // Create bounty with 2.5% fee
      await bountyContract.connect(owner).setPlatformFeeBps(250);
      const bountyId = await createClaimSubmit(
        agentA,
        agentB,
        ethers.parseEther("1")
      );

      // Change fee to 10% — should NOT affect this bounty
      await bountyContract.connect(owner).setPlatformFeeBps(1000);

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      await bountyContract.connect(agentA).approveWork(bountyId);
      const treasuryAfter = await ethers.provider.getBalance(treasury.address);

      // Locked at 2.5%, NOT 10%
      expect(treasuryAfter - treasuryBefore).to.equal(
        ethers.parseEther("0.025")
      );
    });

    it("should lock fee at dispute resolution time too", async function () {
      // Create bounty with 2.5% fee
      await bountyContract.connect(owner).setPlatformFeeBps(250);
      const bountyId = await createClaimSubmit(
        agentA,
        agentB,
        ethers.parseEther("1")
      );

      // Dispute
      await bountyContract.connect(agentA).disputeWork(bountyId);

      // Change fee to 10%
      await bountyContract.connect(owner).setPlatformFeeBps(1000);

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      // Resolve in favor of worker
      await bountyContract.connect(owner).resolveDispute(bountyId, true);
      const treasuryAfter = await ethers.provider.getBalance(treasury.address);

      // Locked at 2.5%, NOT 10%
      expect(treasuryAfter - treasuryBefore).to.equal(
        ethers.parseEther("0.025")
      );
    });
  });

  // ============================================================
  //           TREASURY CHANGE MID-ESCROW (1)
  // ============================================================
  describe("Treasury Change Mid-Escrow", function () {
    it("should send fees to new treasury when changed between creation and approval", async function () {
      await bountyContract.connect(owner).setPlatformFeeBps(500); // 5%
      const bountyId = await createClaimSubmit(
        agentA,
        agentB,
        ethers.parseEther("2")
      );

      // Change treasury to agentC
      await bountyContract.connect(owner).setTreasury(agentC.address);

      const oldTreasuryBefore = await ethers.provider.getBalance(
        treasury.address
      );
      const newTreasuryBefore = await ethers.provider.getBalance(
        agentC.address
      );

      await bountyContract.connect(agentA).approveWork(bountyId);

      const oldTreasuryAfter = await ethers.provider.getBalance(
        treasury.address
      );
      const newTreasuryAfter = await ethers.provider.getBalance(
        agentC.address
      );

      // Old treasury unchanged
      expect(oldTreasuryAfter).to.equal(oldTreasuryBefore);
      // New treasury received 5% of 2 ETH = 0.1 ETH
      expect(newTreasuryAfter - newTreasuryBefore).to.equal(
        ethers.parseEther("0.1")
      );
    });
  });

  // ============================================================
  //           REVERTING TREASURY (2)
  // ============================================================
  describe("Reverting Treasury", function () {
    it("should revert approveWork when treasury refuses ETH", async function () {
      const RevertingFactory =
        await ethers.getContractFactory("RevertingReceiver");
      const revertingReceiver =
        (await RevertingFactory.deploy()) as unknown as RevertingReceiver;
      await revertingReceiver.waitForDeployment();

      await bountyContract.connect(owner).setPlatformFeeBps(500);
      await bountyContract
        .connect(owner)
        .setTreasury(await revertingReceiver.getAddress());

      const bountyId = await createClaimSubmit(
        agentA,
        agentB,
        ethers.parseEther("1")
      );

      await expect(
        bountyContract.connect(agentA).approveWork(bountyId)
      ).to.be.revertedWithCustomError(bountyContract, "EthTransferFailed");
    });

    it("should NOT lock escrow when treasury reverts but fee is zero", async function () {
      const RevertingFactory =
        await ethers.getContractFactory("RevertingReceiver");
      const revertingReceiver =
        (await RevertingFactory.deploy()) as unknown as RevertingReceiver;
      await revertingReceiver.waitForDeployment();

      // Fee = 0, so treasury.call is skipped
      await bountyContract
        .connect(owner)
        .setTreasury(await revertingReceiver.getAddress());

      const bountyId = await createClaimSubmit(
        agentA,
        agentB,
        ethers.parseEther("1")
      );

      const workerBefore = await ethers.provider.getBalance(agentB.address);
      await bountyContract.connect(agentA).approveWork(bountyId);
      const workerAfter = await ethers.provider.getBalance(agentB.address);

      // Worker gets full 1 ETH (fee=0 → no treasury call)
      expect(workerAfter - workerBefore).to.equal(ethers.parseEther("1"));
    });
  });

  // ============================================================
  //           ROUNDING / PRECISION (3)
  // ============================================================
  describe("Rounding / Precision", function () {
    it("should handle 1 wei amount (fee rounds to 0)", async function () {
      await bountyContract.connect(owner).setPlatformFeeBps(500); // 5%
      const bountyId = await createClaimSubmit(agentA, agentB, 1n);

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      const workerBefore = await ethers.provider.getBalance(agentB.address);

      await bountyContract.connect(agentA).approveWork(bountyId);

      const treasuryAfter = await ethers.provider.getBalance(treasury.address);
      const workerAfter = await ethers.provider.getBalance(agentB.address);

      // 1 * 500 / 10000 = 0 (integer division)
      expect(treasuryAfter - treasuryBefore).to.equal(0n);
      // Worker gets the full 1 wei
      expect(workerAfter - workerBefore).to.equal(1n);
    });

    it("should handle 99 wei with 10% fee", async function () {
      await bountyContract.connect(owner).setPlatformFeeBps(1000); // 10%
      const bountyId = await createClaimSubmit(agentA, agentB, 99n);

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      const workerBefore = await ethers.provider.getBalance(agentB.address);

      await bountyContract.connect(agentA).approveWork(bountyId);

      const treasuryAfter = await ethers.provider.getBalance(treasury.address);
      const workerAfter = await ethers.provider.getBalance(agentB.address);

      // 99 * 1000 / 10000 = 9 fee, 90 payout
      expect(treasuryAfter - treasuryBefore).to.equal(9n);
      expect(workerAfter - workerBefore).to.equal(90n);
    });

    it("should handle exact fee calculation (no rounding)", async function () {
      await bountyContract.connect(owner).setPlatformFeeBps(250); // 2.5%
      const bountyId = await createClaimSubmit(agentA, agentB, 10000n);

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      const workerBefore = await ethers.provider.getBalance(agentB.address);

      await bountyContract.connect(agentA).approveWork(bountyId);

      const treasuryAfter = await ethers.provider.getBalance(treasury.address);
      const workerAfter = await ethers.provider.getBalance(agentB.address);

      // 10000 * 250 / 10000 = 250 fee, 9750 payout
      expect(treasuryAfter - treasuryBefore).to.equal(250n);
      expect(workerAfter - workerBefore).to.equal(9750n);
    });
  });

  // ============================================================
  //           MAX FEE (1)
  // ============================================================
  describe("Max Fee", function () {
    it("should correctly apply max fee of 1000 bps (10%)", async function () {
      await bountyContract.connect(owner).setPlatformFeeBps(1000);
      const bountyId = await createClaimSubmit(
        agentA,
        agentB,
        ethers.parseEther("10")
      );

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      const workerBefore = await ethers.provider.getBalance(agentB.address);

      await bountyContract.connect(agentA).approveWork(bountyId);

      const treasuryAfter = await ethers.provider.getBalance(treasury.address);
      const workerAfter = await ethers.provider.getBalance(agentB.address);

      // 10% of 10 ETH = 1 ETH fee, 9 ETH payout
      expect(treasuryAfter - treasuryBefore).to.equal(
        ethers.parseEther("1")
      );
      expect(workerAfter - workerBefore).to.equal(ethers.parseEther("9"));
    });
  });

  // ============================================================
  //           REENTRANCY (2)
  // ============================================================
  describe("Reentrancy", function () {
    it("should block reentrancy when treasury re-enters approveWork", async function () {
      const AttackerFactory =
        await ethers.getContractFactory("ReentrancyAttacker");
      const attacker =
        (await AttackerFactory.deploy(
          await bountyContract.getAddress()
        )) as unknown as ReentrancyAttacker;
      await attacker.waitForDeployment();

      // Set attacker as treasury
      await bountyContract.connect(owner).setPlatformFeeBps(500);
      await bountyContract
        .connect(owner)
        .setTreasury(await attacker.getAddress());

      const bountyId = await createClaimSubmit(
        agentA,
        agentB,
        ethers.parseEther("1")
      );

      // Prepare attack: re-enter approveWork with a different bountyId
      // (need a second bounty for the attacker to try)
      const bountyId2 = await createClaimSubmit(
        agentA,
        agentC,
        ethers.parseEther("1")
      );

      // Encode approveWork(bountyId2) as the re-entry calldata
      const attackCalldata = bountyContract.interface.encodeFunctionData(
        "approveWork",
        [bountyId2]
      );
      await attacker.setAttackData(attackCalldata);

      // approveWork sends ETH to treasury (attacker), attacker tries re-entry
      // The re-entry call should fail silently (attacker catches it)
      // but the original approveWork should succeed
      await bountyContract.connect(agentA).approveWork(bountyId);

      // Attacker attempted but did not succeed
      expect(await attacker.attackAttempted()).to.be.true;
      expect(await attacker.attackSucceeded()).to.be.false;
    });

    it("should block reentrancy when worker contract re-enters during payout", async function () {
      const AttackerFactory =
        await ethers.getContractFactory("ReentrancyAttacker");
      const attacker =
        (await AttackerFactory.deploy(
          await bountyContract.getAddress()
        )) as unknown as ReentrancyAttacker;
      await attacker.waitForDeployment();
      const attackerAddr = await attacker.getAddress();

      // Register attacker as agent (via execute) — disambiguate overload
      const registerData = registry.interface.encodeFunctionData(
        "register(string)",
        [DID_CID]
      );
      await attacker.execute(await registry.getAddress(), registerData);

      // Create bounty, have attacker claim and submit via execute
      await bountyContract.connect(owner).setPlatformFeeBps(500);
      const dl = await futureDeadline();
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress, {
          value: ethers.parseEther("1"),
        });
      const bountyId = 0;

      // Attacker claims
      const claimData = bountyContract.interface.encodeFunctionData(
        "claimBounty",
        [bountyId]
      );
      await attacker.execute(await bountyContract.getAddress(), claimData);

      // Attacker submits
      const submitData = bountyContract.interface.encodeFunctionData(
        "submitWork",
        [bountyId, SUBMISSION_CID]
      );
      await attacker.execute(await bountyContract.getAddress(), submitData);

      // Set attacker to try re-entering approveWork when it receives payout
      const attackCalldata = bountyContract.interface.encodeFunctionData(
        "approveWork",
        [bountyId]
      );
      await attacker.setAttackData(attackCalldata);

      // Approve — payout goes to attacker, attacker tries re-entry
      await bountyContract.connect(agentA).approveWork(bountyId);

      expect(await attacker.attackAttempted()).to.be.true;
      expect(await attacker.attackSucceeded()).to.be.false;
    });
  });

  // ============================================================
  //           PAUSED CONTRACT (2)
  // ============================================================
  describe("Paused Contract", function () {
    it("should revert approveWork when paused", async function () {
      const bountyId = await createClaimSubmit(
        agentA,
        agentB,
        ethers.parseEther("1")
      );

      await bountyContract.connect(owner).pause();

      await expect(
        bountyContract.connect(agentA).approveWork(bountyId)
      ).to.be.revertedWithCustomError(bountyContract, "EnforcedPause");
    });

    it("should revert disputeWork when paused", async function () {
      const bountyId = await createClaimSubmit(
        agentA,
        agentB,
        ethers.parseEther("1")
      );

      await bountyContract.connect(owner).pause();

      await expect(
        bountyContract.connect(agentA).disputeWork(bountyId)
      ).to.be.revertedWithCustomError(bountyContract, "EnforcedPause");
    });
  });

  // ============================================================
  //           FEE ACCUMULATION (1)
  // ============================================================
  describe("Fee Accumulation", function () {
    it("should accumulate fees correctly across multiple approvals", async function () {
      await bountyContract.connect(owner).setPlatformFeeBps(500); // 5%

      const bountyId1 = await createClaimSubmit(
        agentA,
        agentB,
        ethers.parseEther("1")
      );
      const bountyId2 = await createClaimSubmit(
        agentA,
        agentC,
        ethers.parseEther("2")
      );
      const bountyId3 = await createClaimSubmit(
        agentC,
        agentB,
        ethers.parseEther("3")
      );

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);

      await bountyContract.connect(agentA).approveWork(bountyId1);
      await bountyContract.connect(agentA).approveWork(bountyId2);
      await bountyContract.connect(agentC).approveWork(bountyId3);

      const treasuryAfter = await ethers.provider.getBalance(treasury.address);

      // 5% of (1 + 2 + 3) = 5% of 6 ETH = 0.3 ETH
      expect(treasuryAfter - treasuryBefore).to.equal(
        ethers.parseEther("0.3")
      );
    });
  });

  // ============================================================
  //           FEE TOGGLE (1)
  // ============================================================
  describe("Fee Toggle", function () {
    it("should allow setting fee back to 0", async function () {
      // First bounty with 5% fee
      await bountyContract.connect(owner).setPlatformFeeBps(500);
      const bountyId1 = await createClaimSubmit(
        agentA,
        agentB,
        ethers.parseEther("1")
      );

      const treasuryBefore1 = await ethers.provider.getBalance(
        treasury.address
      );
      await bountyContract.connect(agentA).approveWork(bountyId1);
      const treasuryAfter1 = await ethers.provider.getBalance(treasury.address);
      expect(treasuryAfter1 - treasuryBefore1).to.equal(
        ethers.parseEther("0.05")
      );

      // Set fee back to 0
      await bountyContract.connect(owner).setPlatformFeeBps(0);

      // Second bounty with 0% fee
      const bountyId2 = await createClaimSubmit(
        agentA,
        agentC,
        ethers.parseEther("1")
      );

      const treasuryBefore2 = await ethers.provider.getBalance(
        treasury.address
      );
      await bountyContract.connect(agentA).approveWork(bountyId2);
      const treasuryAfter2 = await ethers.provider.getBalance(treasury.address);

      // No fee taken
      expect(treasuryAfter2 - treasuryBefore2).to.equal(0n);
    });
  });

  // ============================================================
  //           DOUBLE OPERATIONS (2)
  // ============================================================
  describe("Double Operations", function () {
    it("should prevent double-approve", async function () {
      await bountyContract.connect(owner).setPlatformFeeBps(250);
      const bountyId = await createClaimSubmit(
        agentA,
        agentB,
        ethers.parseEther("1")
      );

      await bountyContract.connect(agentA).approveWork(bountyId);

      // Second approve should fail — status is now Approved, not Submitted
      await expect(
        bountyContract.connect(agentA).approveWork(bountyId)
      ).to.be.revertedWithCustomError(bountyContract, "InvalidStatus");
    });

    it("should prevent double-cancel", async function () {
      const dl = await futureDeadline();
      await bountyContract
        .connect(agentA)
        .createBounty(METADATA_CID, COMMUNITY, dl, 0, ethers.ZeroAddress, {
          value: ethers.parseEther("1"),
        });
      const bountyId = Number(await bountyContract.totalBounties()) - 1;

      await bountyContract.connect(agentA).cancelBounty(bountyId);

      // Second cancel should fail — status is now Cancelled, not Open
      await expect(
        bountyContract.connect(agentA).cancelBounty(bountyId)
      ).to.be.revertedWithCustomError(bountyContract, "InvalidStatus");
    });
  });
});
