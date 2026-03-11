import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import {
  AgentRegistry,
  ServiceMarketplace,
  NookplotForwarder,
  ReentrancyAttacker,
  RevertingReceiver,
} from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * ServiceMarketplace — Security Tests
 *
 * Covers: fee manipulation mid-escrow, treasury manipulation, reverting
 * treasury, rounding/precision, max fee, reentrancy, paused contract,
 * fee accumulation, fee toggle, and double-operation guards.
 */
describe("ServiceMarketplace — Security", function () {
  let registry: AgentRegistry;
  let marketplace: ServiceMarketplace;
  let forwarder: NookplotForwarder;
  let owner: SignerWithAddress;
  let treasury: SignerWithAddress;
  let provider: SignerWithAddress;
  let buyer: SignerWithAddress;
  let agentC: SignerWithAddress;
  let extra: SignerWithAddress;

  const DID_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const METADATA_CID = "QmServiceMetadataCidForTesting1234567890abcde";
  const TERMS_CID = "QmTermsDocumentCidForServiceAgreement1234567890";
  const DELIVERY_CID = "QmDeliveryCidForCompletedServiceWork123456789012";
  const REASON_CID = "QmDisputeReasonCidForServiceAgreement123456789012";
  const CATEGORY = "research";

  async function futureDeadline(): Promise<number> {
    const block = await ethers.provider.getBlock("latest");
    return block!.timestamp + 86400;
  }

  /** Helper: list service → create agreement → deliver → return agreementId */
  async function listCreateDeliver(
    providerSigner: SignerWithAddress,
    buyerSigner: SignerWithAddress,
    ethAmount: bigint
  ): Promise<number> {
    // List service
    await marketplace
      .connect(providerSigner)
      .listService(METADATA_CID, CATEGORY, 0, 0); // PricingModel.PerTask = 0
    const listingId = Number(await marketplace.totalListings()) - 1;

    // Create agreement with ETH escrow
    const dl = await futureDeadline();
    await marketplace
      .connect(buyerSigner)
      .createAgreement(listingId, TERMS_CID, dl, 0, ethers.ZeroAddress, { value: ethAmount });
    const agreementId = Number(await marketplace.totalAgreements()) - 1;

    // Deliver work
    await marketplace
      .connect(providerSigner)
      .deliverWork(agreementId, DELIVERY_CID);

    return agreementId;
  }

  beforeEach(async function () {
    [owner, treasury, provider, buyer, agentC, extra] =
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

    const MarketplaceFactory =
      await ethers.getContractFactory("ServiceMarketplace");
    marketplace = (await upgrades.deployProxy(
      MarketplaceFactory,
      [owner.address, await registry.getAddress(), treasury.address],
      {
        kind: "uups",
        constructorArgs: [forwarderAddress],
        unsafeAllow: ["constructor", "state-variable-immutable"],
      }
    )) as unknown as ServiceMarketplace;
    await marketplace.waitForDeployment();
    await marketplace.initializeV2(ethers.ZeroAddress, ethers.ZeroAddress);
    await marketplace.initializeV3(owner.address, owner.address);

    // Register agents
    await registry.connect(provider).register(DID_CID);
    await registry.connect(buyer).register(DID_CID);
    await registry.connect(agentC).register(DID_CID);
  });

  // ============================================================
  //           FEE SNAPSHOT (V3) — fee locked at creation time
  // ============================================================
  describe("Fee Snapshot (V3)", function () {
    it("should fall back to global rate when feeBps == 0 (pre-V3 backward compat)", async function () {
      // Create agreement with 0% fee → feeBps == 0 → falls back to global
      const agreementId = await listCreateDeliver(
        provider,
        buyer,
        ethers.parseEther("1")
      );

      // Change fee to 5% after agreement created
      await marketplace.connect(owner).setPlatformFeeBps(500);

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      await marketplace.connect(buyer).settleAgreement(agreementId);
      const treasuryAfter = await ethers.provider.getBalance(treasury.address);

      // feeBps == 0 → falls back to global 500 bps → 5% of 1 ETH = 0.05 ETH
      expect(treasuryAfter - treasuryBefore).to.equal(
        ethers.parseEther("0.05")
      );
    });

    it("should NOT apply changed fee to agreement created with non-zero fee", async function () {
      // Create agreement with 2.5% fee
      await marketplace.connect(owner).setPlatformFeeBps(250);

      // List → create → deliver
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, 0);
      const listingId = Number(await marketplace.totalListings()) - 1;
      const dl = await futureDeadline();
      await marketplace
        .connect(buyer)
        .createAgreement(listingId, TERMS_CID, dl, 0, ethers.ZeroAddress, {
          value: ethers.parseEther("1"),
        });
      const agreementId = Number(await marketplace.totalAgreements()) - 1;
      await marketplace
        .connect(provider)
        .deliverWork(agreementId, DELIVERY_CID);

      // Change fee to 10% — should NOT affect this agreement
      await marketplace.connect(owner).setPlatformFeeBps(1000);

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      await marketplace.connect(buyer).settleAgreement(agreementId);
      const treasuryAfter = await ethers.provider.getBalance(treasury.address);

      // Locked at 2.5%, NOT 10%
      expect(treasuryAfter - treasuryBefore).to.equal(
        ethers.parseEther("0.025")
      );
    });

    it("should lock fee at dispute resolution time too", async function () {
      // Create agreement with 2.5% fee
      await marketplace.connect(owner).setPlatformFeeBps(250);

      // List → create → deliver
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, 0);
      const listingId = Number(await marketplace.totalListings()) - 1;
      const dl = await futureDeadline();
      await marketplace
        .connect(buyer)
        .createAgreement(listingId, TERMS_CID, dl, 0, ethers.ZeroAddress, {
          value: ethers.parseEther("1"),
        });
      const agreementId = Number(await marketplace.totalAgreements()) - 1;
      await marketplace
        .connect(provider)
        .deliverWork(agreementId, DELIVERY_CID);

      // Dispute
      await marketplace
        .connect(buyer)
        .disputeAgreement(agreementId, REASON_CID);

      // Change fee to 10%
      await marketplace.connect(owner).setPlatformFeeBps(1000);

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      // Resolve in favor of provider
      await marketplace.connect(owner).resolveDispute(agreementId, true);
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
    it("should send fees to new treasury when changed between creation and settlement", async function () {
      await marketplace.connect(owner).setPlatformFeeBps(500); // 5%
      const agreementId = await listCreateDeliver(
        provider,
        buyer,
        ethers.parseEther("2")
      );

      // Change treasury to agentC
      await marketplace.connect(owner).setTreasury(agentC.address);

      const oldTreasuryBefore = await ethers.provider.getBalance(
        treasury.address
      );
      const newTreasuryBefore = await ethers.provider.getBalance(
        agentC.address
      );

      await marketplace.connect(buyer).settleAgreement(agreementId);

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
    it("should revert settleAgreement when treasury refuses ETH", async function () {
      const RevertingFactory =
        await ethers.getContractFactory("RevertingReceiver");
      const revertingReceiver =
        (await RevertingFactory.deploy()) as unknown as RevertingReceiver;
      await revertingReceiver.waitForDeployment();

      await marketplace.connect(owner).setPlatformFeeBps(500);
      await marketplace
        .connect(owner)
        .setTreasury(await revertingReceiver.getAddress());

      const agreementId = await listCreateDeliver(
        provider,
        buyer,
        ethers.parseEther("1")
      );

      await expect(
        marketplace.connect(buyer).settleAgreement(agreementId)
      ).to.be.revertedWithCustomError(marketplace, "EthTransferFailed");
    });

    it("should NOT lock escrow when treasury reverts but fee is zero", async function () {
      const RevertingFactory =
        await ethers.getContractFactory("RevertingReceiver");
      const revertingReceiver =
        (await RevertingFactory.deploy()) as unknown as RevertingReceiver;
      await revertingReceiver.waitForDeployment();

      // Fee = 0, so treasury.call is skipped
      await marketplace
        .connect(owner)
        .setTreasury(await revertingReceiver.getAddress());

      const agreementId = await listCreateDeliver(
        provider,
        buyer,
        ethers.parseEther("1")
      );

      const providerBefore = await ethers.provider.getBalance(provider.address);
      await marketplace.connect(buyer).settleAgreement(agreementId);
      const providerAfter = await ethers.provider.getBalance(provider.address);

      // Provider gets full 1 ETH (fee=0 → no treasury call)
      expect(providerAfter - providerBefore).to.equal(ethers.parseEther("1"));
    });
  });

  // ============================================================
  //           ROUNDING / PRECISION (2)
  // ============================================================
  describe("Rounding / Precision", function () {
    it("should handle 1 wei escrow (fee rounds to 0)", async function () {
      await marketplace.connect(owner).setPlatformFeeBps(500); // 5%
      const agreementId = await listCreateDeliver(provider, buyer, 1n);

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      const providerBefore = await ethers.provider.getBalance(provider.address);

      await marketplace.connect(buyer).settleAgreement(agreementId);

      const treasuryAfter = await ethers.provider.getBalance(treasury.address);
      const providerAfter = await ethers.provider.getBalance(provider.address);

      // 1 * 500 / 10000 = 0
      expect(treasuryAfter - treasuryBefore).to.equal(0n);
      expect(providerAfter - providerBefore).to.equal(1n);
    });

    it("should handle 99 wei with 10% fee", async function () {
      await marketplace.connect(owner).setPlatformFeeBps(1000); // 10%
      const agreementId = await listCreateDeliver(provider, buyer, 99n);

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      const providerBefore = await ethers.provider.getBalance(provider.address);

      await marketplace.connect(buyer).settleAgreement(agreementId);

      const treasuryAfter = await ethers.provider.getBalance(treasury.address);
      const providerAfter = await ethers.provider.getBalance(provider.address);

      // 99 * 1000 / 10000 = 9 fee, 90 payout
      expect(treasuryAfter - treasuryBefore).to.equal(9n);
      expect(providerAfter - providerBefore).to.equal(90n);
    });
  });

  // ============================================================
  //           MAX FEE (1)
  // ============================================================
  describe("Max Fee", function () {
    it("should correctly apply max fee of 1000 bps (10%)", async function () {
      await marketplace.connect(owner).setPlatformFeeBps(1000);
      const agreementId = await listCreateDeliver(
        provider,
        buyer,
        ethers.parseEther("10")
      );

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      const providerBefore = await ethers.provider.getBalance(provider.address);

      await marketplace.connect(buyer).settleAgreement(agreementId);

      const treasuryAfter = await ethers.provider.getBalance(treasury.address);
      const providerAfter = await ethers.provider.getBalance(provider.address);

      // 10% of 10 ETH = 1 ETH fee, 9 ETH payout
      expect(treasuryAfter - treasuryBefore).to.equal(
        ethers.parseEther("1")
      );
      expect(providerAfter - providerBefore).to.equal(
        ethers.parseEther("9")
      );
    });
  });

  // ============================================================
  //           REENTRANCY (2)
  // ============================================================
  describe("Reentrancy", function () {
    it("should block reentrancy when treasury re-enters settleAgreement", async function () {
      const AttackerFactory =
        await ethers.getContractFactory("ReentrancyAttacker");
      const attacker =
        (await AttackerFactory.deploy(
          await marketplace.getAddress()
        )) as unknown as ReentrancyAttacker;
      await attacker.waitForDeployment();

      // Set attacker as treasury
      await marketplace.connect(owner).setPlatformFeeBps(500);
      await marketplace
        .connect(owner)
        .setTreasury(await attacker.getAddress());

      const agreementId = await listCreateDeliver(
        provider,
        buyer,
        ethers.parseEther("1")
      );

      // Create a second agreement for re-entry target
      const agreementId2 = await listCreateDeliver(
        provider,
        buyer,
        ethers.parseEther("1")
      );

      // Encode settleAgreement(agreementId2) as re-entry calldata
      const attackCalldata = marketplace.interface.encodeFunctionData(
        "settleAgreement",
        [agreementId2]
      );
      await attacker.setAttackData(attackCalldata);

      // settleAgreement sends fee to treasury (attacker), attacker tries re-entry
      await marketplace.connect(buyer).settleAgreement(agreementId);

      expect(await attacker.attackAttempted()).to.be.true;
      expect(await attacker.attackSucceeded()).to.be.false;
    });

    it("should block reentrancy when provider contract re-enters during payout", async function () {
      const AttackerFactory =
        await ethers.getContractFactory("ReentrancyAttacker");
      const attacker =
        (await AttackerFactory.deploy(
          await marketplace.getAddress()
        )) as unknown as ReentrancyAttacker;
      await attacker.waitForDeployment();
      const attackerAddr = await attacker.getAddress();

      // Register attacker as agent — disambiguate overload
      const registerData = registry.interface.encodeFunctionData(
        "register(string)",
        [DID_CID]
      );
      await attacker.execute(await registry.getAddress(), registerData);

      // Attacker lists a service
      await marketplace.connect(owner).setPlatformFeeBps(500);
      const listServiceData = marketplace.interface.encodeFunctionData(
        "listService",
        [METADATA_CID, CATEGORY, 0, 0]
      );
      await attacker.execute(await marketplace.getAddress(), listServiceData);
      const listingId = Number(await marketplace.totalListings()) - 1;

      // Buyer creates agreement
      const dl = await futureDeadline();
      await marketplace
        .connect(buyer)
        .createAgreement(listingId, TERMS_CID, dl, 0, ethers.ZeroAddress, {
          value: ethers.parseEther("1"),
        });
      const agreementId = Number(await marketplace.totalAgreements()) - 1;

      // Attacker delivers
      const deliverData = marketplace.interface.encodeFunctionData(
        "deliverWork",
        [agreementId, DELIVERY_CID]
      );
      await attacker.execute(await marketplace.getAddress(), deliverData);

      // Set attacker to try re-entering settleAgreement when it receives payout
      const attackCalldata = marketplace.interface.encodeFunctionData(
        "settleAgreement",
        [agreementId]
      );
      await attacker.setAttackData(attackCalldata);

      // Settle — payout goes to attacker (provider), attacker tries re-entry
      await marketplace.connect(buyer).settleAgreement(agreementId);

      expect(await attacker.attackAttempted()).to.be.true;
      expect(await attacker.attackSucceeded()).to.be.false;
    });
  });

  // ============================================================
  //           PAUSED CONTRACT (3)
  // ============================================================
  describe("Paused Contract", function () {
    it("should revert settleAgreement when paused", async function () {
      const agreementId = await listCreateDeliver(
        provider,
        buyer,
        ethers.parseEther("1")
      );

      await marketplace.connect(owner).pause();

      await expect(
        marketplace.connect(buyer).settleAgreement(agreementId)
      ).to.be.revertedWithCustomError(marketplace, "EnforcedPause");
    });

    it("should revert deliverWork when paused", async function () {
      // List → create (but don't deliver yet)
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, 0);
      const listingId = Number(await marketplace.totalListings()) - 1;
      const dl = await futureDeadline();
      await marketplace
        .connect(buyer)
        .createAgreement(listingId, TERMS_CID, dl, 0, ethers.ZeroAddress, {
          value: ethers.parseEther("1"),
        });
      const agreementId = Number(await marketplace.totalAgreements()) - 1;

      await marketplace.connect(owner).pause();

      await expect(
        marketplace.connect(provider).deliverWork(agreementId, DELIVERY_CID)
      ).to.be.revertedWithCustomError(marketplace, "EnforcedPause");
    });

    it("should revert disputeAgreement when paused", async function () {
      const agreementId = await listCreateDeliver(
        provider,
        buyer,
        ethers.parseEther("1")
      );

      await marketplace.connect(owner).pause();

      await expect(
        marketplace
          .connect(buyer)
          .disputeAgreement(agreementId, REASON_CID)
      ).to.be.revertedWithCustomError(marketplace, "EnforcedPause");
    });
  });

  // ============================================================
  //           FEE ACCUMULATION (1)
  // ============================================================
  describe("Fee Accumulation", function () {
    it("should accumulate fees correctly across multiple settlements", async function () {
      await marketplace.connect(owner).setPlatformFeeBps(500); // 5%

      const agreementId1 = await listCreateDeliver(
        provider,
        buyer,
        ethers.parseEther("1")
      );
      const agreementId2 = await listCreateDeliver(
        provider,
        buyer,
        ethers.parseEther("2")
      );
      const agreementId3 = await listCreateDeliver(
        agentC,
        buyer,
        ethers.parseEther("3")
      );

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);

      await marketplace.connect(buyer).settleAgreement(agreementId1);
      await marketplace.connect(buyer).settleAgreement(agreementId2);
      await marketplace.connect(buyer).settleAgreement(agreementId3);

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
      // First agreement with 5% fee
      await marketplace.connect(owner).setPlatformFeeBps(500);
      const agreementId1 = await listCreateDeliver(
        provider,
        buyer,
        ethers.parseEther("1")
      );

      const treasuryBefore1 = await ethers.provider.getBalance(
        treasury.address
      );
      await marketplace.connect(buyer).settleAgreement(agreementId1);
      const treasuryAfter1 = await ethers.provider.getBalance(treasury.address);
      expect(treasuryAfter1 - treasuryBefore1).to.equal(
        ethers.parseEther("0.05")
      );

      // Set fee back to 0
      await marketplace.connect(owner).setPlatformFeeBps(0);

      // Second agreement with 0% fee
      const agreementId2 = await listCreateDeliver(
        agentC,
        buyer,
        ethers.parseEther("1")
      );

      const treasuryBefore2 = await ethers.provider.getBalance(
        treasury.address
      );
      await marketplace.connect(buyer).settleAgreement(agreementId2);
      const treasuryAfter2 = await ethers.provider.getBalance(treasury.address);

      // No fee taken
      expect(treasuryAfter2 - treasuryBefore2).to.equal(0n);
    });
  });

  // ============================================================
  //           EXPIRE DELIVERED (V4)
  // ============================================================
  describe("Expire Delivered (V4)", function () {
    it("should release escrow to provider after deadline + grace period", async function () {
      // Initialize V4 to set 14-day grace period
      await marketplace.initializeV4();

      const agreementId = await listCreateDeliver(
        provider,
        buyer,
        ethers.parseEther("1")
      );

      // Get the agreement deadline
      const agreement = await marketplace.getAgreement(agreementId);
      const deadline = Number(agreement.deadline);
      const gracePeriod = Number(await marketplace.deliveryGracePeriod());

      // Advance time past deadline + grace period
      await ethers.provider.send("evm_setNextBlockTimestamp", [
        deadline + gracePeriod + 1,
      ]);
      await ethers.provider.send("evm_mine", []);

      const providerBefore = await ethers.provider.getBalance(provider.address);

      await expect(
        marketplace.connect(agentC).expireDelivered(agreementId)
      ).to.emit(marketplace, "DeliveryExpired")
        .withArgs(agreementId, provider.address, ethers.parseEther("1"));

      const providerAfter = await ethers.provider.getBalance(provider.address);
      expect(providerAfter - providerBefore).to.equal(ethers.parseEther("1"));

      // Verify status is now Settled
      const after = await marketplace.getAgreement(agreementId);
      expect(after.status).to.equal(3); // Settled
    });

    it("should revert before deadline + grace period (NotExpired)", async function () {
      await marketplace.initializeV4();

      const agreementId = await listCreateDeliver(
        provider,
        buyer,
        ethers.parseEther("1")
      );

      // Try to expire immediately (before deadline + grace)
      await expect(
        marketplace.connect(agentC).expireDelivered(agreementId)
      ).to.be.revertedWithCustomError(marketplace, "NotExpired");
    });

    it("should revert for non-Delivered status (InvalidStatus)", async function () {
      await marketplace.initializeV4();

      // Create agreement but don't deliver
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, 0);
      const listingId = Number(await marketplace.totalListings()) - 1;
      const dl = await futureDeadline();
      await marketplace
        .connect(buyer)
        .createAgreement(listingId, TERMS_CID, dl, 0, ethers.ZeroAddress, {
          value: ethers.parseEther("1"),
        });
      const agreementId = Number(await marketplace.totalAgreements()) - 1;

      await expect(
        marketplace.connect(agentC).expireDelivered(agreementId)
      ).to.be.revertedWithCustomError(marketplace, "InvalidStatus");
    });

    it("setDeliveryGracePeriod is admin-only", async function () {
      await expect(
        marketplace.connect(buyer).setDeliveryGracePeriod(7 * 86400)
      ).to.be.revertedWithCustomError(
        marketplace,
        "AccessControlUnauthorizedAccount"
      );

      // Admin can set it
      await marketplace.connect(owner).setDeliveryGracePeriod(7 * 86400);
      expect(await marketplace.deliveryGracePeriod()).to.equal(7 * 86400);
    });

    it("initializeV4 sets grace period to 14 days", async function () {
      await marketplace.initializeV4();
      expect(await marketplace.deliveryGracePeriod()).to.equal(14 * 86400);
    });
  });

  // ============================================================
  //           DOUBLE OPERATIONS (2)
  // ============================================================
  describe("Double Operations", function () {
    it("should prevent double-settle", async function () {
      await marketplace.connect(owner).setPlatformFeeBps(250);
      const agreementId = await listCreateDeliver(
        provider,
        buyer,
        ethers.parseEther("1")
      );

      await marketplace.connect(buyer).settleAgreement(agreementId);

      // Second settle should fail — status is now Settled, not Delivered
      await expect(
        marketplace.connect(buyer).settleAgreement(agreementId)
      ).to.be.revertedWithCustomError(marketplace, "InvalidStatus");
    });

    it("should prevent double-cancel", async function () {
      // Create agreement (don't deliver — cancel from Agreed status)
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, 0);
      const listingId = Number(await marketplace.totalListings()) - 1;
      const dl = await futureDeadline();
      await marketplace
        .connect(buyer)
        .createAgreement(listingId, TERMS_CID, dl, 0, ethers.ZeroAddress, {
          value: ethers.parseEther("1"),
        });
      const agreementId = Number(await marketplace.totalAgreements()) - 1;

      await marketplace.connect(buyer).cancelAgreement(agreementId);

      // Second cancel should fail — status is now Cancelled, not Agreed
      await expect(
        marketplace.connect(buyer).cancelAgreement(agreementId)
      ).to.be.revertedWithCustomError(marketplace, "InvalidStatus");
    });
  });
});
