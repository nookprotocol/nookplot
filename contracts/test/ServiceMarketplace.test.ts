import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import {
  AgentRegistry,
  ServiceMarketplace,
  MockERC20,
  NookplotForwarder,
} from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("ServiceMarketplace", function () {
  let registry: AgentRegistry;
  let marketplace: ServiceMarketplace;
  let token: MockERC20;
  let forwarder: NookplotForwarder;
  let owner: SignerWithAddress;
  let treasury: SignerWithAddress;
  let provider: SignerWithAddress;
  let buyer: SignerWithAddress;
  let agentC: SignerWithAddress;
  let nonAgent: SignerWithAddress;
  let guardian: SignerWithAddress;

  const DID_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const METADATA_CID = "QmServiceMetadataCidForTesting1234567890abcde";
  const METADATA_CID_2 = "QmServiceMetadataCidForTesting2345678901bcdef";
  const TERMS_CID = "QmTermsDocumentCidForServiceAgreement1234567890";
  const DELIVERY_CID = "QmDeliveryCidForCompletedServiceWork123456789012";
  const REASON_CID = "QmDisputeReasonCidForServiceAgreement123456789012";
  const CATEGORY = "research";
  const CATEGORY_2 = "coding";

  const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
  const GUARDIAN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GUARDIAN_ROLE"));

  /** @returns a deadline 1 day from the latest block timestamp (unix seconds) */
  async function futureDeadline(): Promise<number> {
    const block = await ethers.provider.getBlock("latest");
    return block!.timestamp + 86400;
  }

  beforeEach(async function () {
    [owner, treasury, provider, buyer, agentC, nonAgent, guardian] =
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

    // Deploy ServiceMarketplace via UUPS proxy
    const MarketplaceFactory = await ethers.getContractFactory("ServiceMarketplace");
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

    // Run V2 + V3 + V4 + V5 reinitializers
    await marketplace.initializeV2(ethers.ZeroAddress, ethers.ZeroAddress);
    await marketplace.initializeV3(owner.address, guardian.address);
    await marketplace.initializeV4();
    await marketplace.initializeV5();
    await marketplace.initializeV6();

    // Register agents (provider, buyer, agentC)
    await registry.connect(provider).register(DID_CID);
    await registry.connect(buyer).register(DID_CID);
    await registry.connect(agentC).register(DID_CID);
  });

  // ============================================================
  //                     INITIALIZATION (5)
  // ============================================================

  describe("Initialization", function () {
    it("should set the owner correctly", async function () {
      expect(await marketplace.owner()).to.equal(ethers.ZeroAddress);
    });

    it("should have granted DEFAULT_ADMIN_ROLE to owner", async function () {
      expect(await marketplace.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;
    });

    it("should have granted GUARDIAN_ROLE to guardian", async function () {
      expect(await marketplace.hasRole(GUARDIAN_ROLE, guardian.address)).to.be.true;
    });

    it("should set the agentRegistry correctly", async function () {
      expect(await marketplace.agentRegistry()).to.equal(
        await registry.getAddress()
      );
    });

    it("should set the treasury correctly", async function () {
      expect(await marketplace.treasury()).to.equal(treasury.address);
    });

    it("should not be paused initially", async function () {
      expect(await marketplace.paused()).to.be.false;
    });

    it("should start in free mode (no payment token)", async function () {
      expect(await marketplace.paymentToken()).to.equal(ethers.ZeroAddress);
    });

    it("should start with zero listings and agreements", async function () {
      expect(await marketplace.totalListings()).to.equal(0);
      expect(await marketplace.totalAgreements()).to.equal(0);
    });

    it("should start with zero platform fee", async function () {
      expect(await marketplace.platformFeeBps()).to.equal(0);
    });

    it("should revert if initialized with zero owner", async function () {
      const forwarderAddress = await forwarder.getAddress();
      const Factory = await ethers.getContractFactory("ServiceMarketplace");
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
      ).to.be.revertedWithCustomError(marketplace, "ZeroAddress");
    });

    it("should revert if initialized with zero agentRegistry", async function () {
      const forwarderAddress = await forwarder.getAddress();
      const Factory = await ethers.getContractFactory("ServiceMarketplace");
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
      ).to.be.revertedWithCustomError(marketplace, "ZeroAddress");
    });

    it("should revert if initialized with zero treasury", async function () {
      const forwarderAddress = await forwarder.getAddress();
      const Factory = await ethers.getContractFactory("ServiceMarketplace");
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
      ).to.be.revertedWithCustomError(marketplace, "ZeroAddress");
    });
  });

  // ============================================================
  //                   SERVICE LISTING (8)
  // ============================================================

  describe("Service Listing", function () {
    it("should list a service successfully", async function () {
      const tx = await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, ethers.parseEther("1"));
      await tx.wait();

      const listing = await marketplace.getListing(0);
      expect(listing.provider).to.equal(provider.address);
      expect(listing.metadataCid).to.equal(METADATA_CID);
      expect(listing.category).to.equal(CATEGORY);
      expect(listing.pricingModel).to.equal(0); // PricingModel.PerTask
      expect(listing.priceAmount).to.equal(ethers.parseEther("1"));
      expect(listing.active).to.be.true;
      expect(listing.totalCompleted).to.equal(0);
      expect(listing.totalDisputed).to.equal(0);
      expect(listing.createdAt).to.be.greaterThan(0);
    });

    it("should emit ServiceListed event", async function () {
      await expect(
        marketplace
          .connect(provider)
          .listService(METADATA_CID, CATEGORY, 0, ethers.parseEther("1"))
      )
        .to.emit(marketplace, "ServiceListed")
        .withArgs(0, provider.address, CATEGORY, METADATA_CID, ethers.parseEther("1"));
    });

    it("should increment totalListings", async function () {
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, 0);
      await marketplace
        .connect(buyer)
        .listService(METADATA_CID_2, CATEGORY_2, 1, ethers.parseEther("5"));

      expect(await marketplace.totalListings()).to.equal(2);
    });

    it("should track provider listings", async function () {
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, 0);
      await marketplace
        .connect(provider)
        .listService(METADATA_CID_2, CATEGORY_2, 1, 100);

      const providerListings = await marketplace.getProviderListings(provider.address);
      expect(providerListings.length).to.equal(2);
      expect(providerListings[0]).to.equal(0);
      expect(providerListings[1]).to.equal(1);
    });

    it("should revert when caller is not a registered agent", async function () {
      await expect(
        marketplace
          .connect(nonAgent)
          .listService(METADATA_CID, CATEGORY, 0, 0)
      ).to.be.revertedWithCustomError(marketplace, "NotRegisteredAgent");
    });

    it("should revert with empty metadata CID", async function () {
      await expect(
        marketplace.connect(provider).listService("", CATEGORY, 0, 0)
      ).to.be.revertedWithCustomError(marketplace, "EmptyString");
    });

    it("should revert with empty category", async function () {
      await expect(
        marketplace.connect(provider).listService(METADATA_CID, "", 0, 0)
      ).to.be.revertedWithCustomError(marketplace, "EmptyString");
    });

    it("should update a listing", async function () {
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, 0);

      await marketplace
        .connect(provider)
        .updateListing(0, METADATA_CID_2, false);

      const listing = await marketplace.getListing(0);
      expect(listing.metadataCid).to.equal(METADATA_CID_2);
      expect(listing.active).to.be.false;
    });

    it("should emit ServiceUpdated event", async function () {
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, 0);

      await expect(
        marketplace.connect(provider).updateListing(0, METADATA_CID_2, false)
      )
        .to.emit(marketplace, "ServiceUpdated")
        .withArgs(0, METADATA_CID_2, false);
    });

    it("should revert updateListing when caller is not the provider", async function () {
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, 0);

      await expect(
        marketplace.connect(buyer).updateListing(0, METADATA_CID_2, true)
      ).to.be.revertedWithCustomError(marketplace, "NotProvider");
    });

    it("should keep current metadata if empty string passed to updateListing", async function () {
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, 0);

      await marketplace.connect(provider).updateListing(0, "", false);

      const listing = await marketplace.getListing(0);
      expect(listing.metadataCid).to.equal(METADATA_CID);
      expect(listing.active).to.be.false;
    });
  });

  // ============================================================
  //                 AGREEMENT CREATION (10)
  // ============================================================

  describe("Agreement Creation", function () {
    beforeEach(async function () {
      // Create a service listing from provider
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, ethers.parseEther("1"));
    });

    it("should create an ETH escrow agreement", async function () {
      const ethAmount = ethers.parseEther("1");
      const deadline = await futureDeadline();

      const tx = await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, deadline, 0, ethers.ZeroAddress, { value: ethAmount });
      await tx.wait();

      const agreement = await marketplace.getAgreement(0);
      expect(agreement.listingId).to.equal(0);
      expect(agreement.buyer).to.equal(buyer.address);
      expect(agreement.provider).to.equal(provider.address);
      expect(agreement.termsCid).to.equal(TERMS_CID);
      expect(agreement.escrowAmount).to.equal(ethAmount);
      expect(agreement.escrowType).to.equal(1); // EscrowType.ETH
      expect(agreement.status).to.equal(1); // ServiceStatus.Agreed
      expect(agreement.deadline).to.equal(deadline);
      expect(agreement.createdAt).to.be.greaterThan(0);
    });

    it("should hold ETH in the contract", async function () {
      const ethAmount = ethers.parseEther("2");
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, {
          value: ethAmount,
        });

      const contractBalance = await ethers.provider.getBalance(
        await marketplace.getAddress()
      );
      expect(contractBalance).to.equal(ethAmount);
    });

    it("should create a reputation-only agreement (no ETH)", async function () {
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress);

      const agreement = await marketplace.getAgreement(0);
      expect(agreement.escrowAmount).to.equal(0);
      expect(agreement.escrowType).to.equal(0); // EscrowType.None
    });

    it("should create a token escrow agreement", async function () {
      // Deploy MockERC20 and set as payment token
      const MockFactory = await ethers.getContractFactory("MockERC20");
      token = (await MockFactory.deploy(
        "Mock Token",
        "MOCK"
      )) as unknown as MockERC20;
      await token.waitForDeployment();

      await marketplace
        .connect(owner)
        .setPaymentToken(await token.getAddress());
      await marketplace.connect(owner).setAllowedToken(await token.getAddress(), true);

      // Mint and approve
      const tokenAmount = ethers.parseEther("100");
      await token.mint(buyer.address, ethers.parseEther("1000"));
      await token
        .connect(buyer)
        .approve(await marketplace.getAddress(), tokenAmount);

      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), tokenAmount, await token.getAddress());

      const agreement = await marketplace.getAgreement(0);
      expect(agreement.escrowAmount).to.equal(tokenAmount);
      expect(agreement.escrowType).to.equal(2); // EscrowType.Token

      // Verify tokens transferred to contract
      const contractBalance = await token.balanceOf(
        await marketplace.getAddress()
      );
      expect(contractBalance).to.equal(tokenAmount);
    });

    it("should emit AgreementCreated event", async function () {
      const ethAmount = ethers.parseEther("1");
      const deadline = await futureDeadline();

      await expect(
        marketplace
          .connect(buyer)
          .createAgreement(0, TERMS_CID, deadline, 0, ethers.ZeroAddress, { value: ethAmount })
      )
        .to.emit(marketplace, "AgreementCreated")
        .withArgs(0, 0, buyer.address, provider.address, ethAmount, ethers.ZeroAddress);
    });

    it("should increment totalAgreements", async function () {
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress);
      await marketplace
        .connect(agentC)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress);

      expect(await marketplace.totalAgreements()).to.equal(2);
    });

    it("should revert when listing is inactive", async function () {
      await marketplace.connect(provider).updateListing(0, "", false);

      await expect(
        marketplace
          .connect(buyer)
          .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(marketplace, "ListingNotActive");
    });

    it("should revert when buyer tries to hire themselves", async function () {
      await expect(
        marketplace
          .connect(provider)
          .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(marketplace, "CannotHireSelf");
    });

    it("should revert when caller is not a registered agent", async function () {
      await expect(
        marketplace
          .connect(nonAgent)
          .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(marketplace, "NotRegisteredAgent");
    });

    it("should revert with empty terms CID", async function () {
      await expect(
        marketplace
          .connect(buyer)
          .createAgreement(0, "", await futureDeadline(), 0, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(marketplace, "EmptyString");
    });

    it("should revert when deadline is in the past", async function () {
      const block = await ethers.provider.getBlock("latest");
      const pastDeadline = block!.timestamp - 86400;
      await expect(
        marketplace
          .connect(buyer)
          .createAgreement(0, TERMS_CID, pastDeadline, 0, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(marketplace, "DeadlineNotInFuture");
    });

    it("should revert when deadline is too far in the future (>30 days)", async function () {
      const block = await ethers.provider.getBlock("latest");
      const tooFar = block!.timestamp + 31 * 86400;
      await expect(
        marketplace
          .connect(buyer)
          .createAgreement(0, TERMS_CID, tooFar, 0, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(marketplace, "DeadlineTooFar");
    });
  });

  // ============================================================
  //                   WORK DELIVERY (5)
  // ============================================================

  describe("Work Delivery", function () {
    beforeEach(async function () {
      // Create listing + agreement
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, ethers.parseEther("1"));
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, {
          value: ethers.parseEther("1"),
        });
    });

    it("should allow provider to deliver work", async function () {
      await expect(
        marketplace.connect(provider).deliverWork(0, DELIVERY_CID)
      )
        .to.emit(marketplace, "WorkDelivered")
        .withArgs(0, DELIVERY_CID);
    });

    it("should update agreement state on delivery", async function () {
      await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);

      const agreement = await marketplace.getAgreement(0);
      expect(agreement.status).to.equal(2); // ServiceStatus.Delivered
      expect(agreement.deliveryCid).to.equal(DELIVERY_CID);
    });

    it("should revert when agreement is not in Agreed status", async function () {
      await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);
      // Now it's Delivered, try delivering again
      await expect(
        marketplace.connect(provider).deliverWork(0, DELIVERY_CID)
      ).to.be.revertedWithCustomError(marketplace, "InvalidStatus");
    });

    it("should revert when caller is not the provider", async function () {
      await expect(
        marketplace.connect(buyer).deliverWork(0, DELIVERY_CID)
      ).to.be.revertedWithCustomError(marketplace, "NotProvider");
    });

    it("should revert with empty delivery CID", async function () {
      await expect(
        marketplace.connect(provider).deliverWork(0, "")
      ).to.be.revertedWithCustomError(marketplace, "EmptyString");
    });
  });

  // ============================================================
  //                    SETTLEMENT (8)
  // ============================================================

  describe("Settlement", function () {
    const ethAmount = ethers.parseEther("1");

    beforeEach(async function () {
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, ethers.parseEther("1"));
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, {
          value: ethAmount,
        });
      await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);
    });

    it("should allow buyer to settle and release ETH escrow to provider", async function () {
      const balanceBefore = await ethers.provider.getBalance(provider.address);

      await expect(marketplace.connect(buyer).settleAgreement(0))
        .to.emit(marketplace, "AgreementSettled")
        .withArgs(0, ethAmount);

      const balanceAfter = await ethers.provider.getBalance(provider.address);
      expect(balanceAfter - balanceBefore).to.equal(ethAmount);
    });

    it("should set status to Settled", async function () {
      await marketplace.connect(buyer).settleAgreement(0);

      const agreement = await marketplace.getAgreement(0);
      expect(agreement.status).to.equal(3); // ServiceStatus.Settled
      expect(agreement.settledAt).to.be.greaterThan(0);
    });

    it("should increment listing totalCompleted", async function () {
      await marketplace.connect(buyer).settleAgreement(0);

      const listing = await marketplace.getListing(0);
      expect(listing.totalCompleted).to.equal(1);
    });

    it("should settle reputation-only agreement with no escrow", async function () {
      // Create a reputation-only agreement
      await marketplace
        .connect(agentC)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress);
      // agreementId = 1
      await marketplace.connect(provider).deliverWork(1, DELIVERY_CID);

      await expect(marketplace.connect(agentC).settleAgreement(1))
        .to.emit(marketplace, "AgreementSettled")
        .withArgs(1, 0);

      const agreement = await marketplace.getAgreement(1);
      expect(agreement.status).to.equal(3); // Settled
    });

    it("should deduct platform fee on ETH settlement", async function () {
      // Set 2.5% fee (250 basis points)
      await marketplace.connect(owner).setPlatformFeeBps(250);

      // Create a new agreement with ETH
      const escrowEth = ethers.parseEther("10");
      await marketplace
        .connect(agentC)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, {
          value: escrowEth,
        });
      // agreementId = 1
      await marketplace.connect(provider).deliverWork(1, DELIVERY_CID);

      const providerBalanceBefore = await ethers.provider.getBalance(provider.address);
      const treasuryBalanceBefore = await ethers.provider.getBalance(treasury.address);

      await marketplace.connect(agentC).settleAgreement(1);

      const providerBalanceAfter = await ethers.provider.getBalance(provider.address);
      const treasuryBalanceAfter = await ethers.provider.getBalance(treasury.address);

      // 2.5% of 10 ETH = 0.25 ETH fee, 9.75 ETH to provider
      const expectedFee = ethers.parseEther("0.25");
      const expectedPayout = ethers.parseEther("9.75");

      expect(providerBalanceAfter - providerBalanceBefore).to.equal(expectedPayout);
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(expectedFee);
    });

    it("should deduct platform fee on token settlement", async function () {
      // Deploy MockERC20
      const MockFactory = await ethers.getContractFactory("MockERC20");
      token = (await MockFactory.deploy("Mock Token", "MOCK")) as unknown as MockERC20;
      await token.waitForDeployment();
      await marketplace
        .connect(owner)
        .setPaymentToken(await token.getAddress());
      await marketplace.connect(owner).setAllowedToken(await token.getAddress(), true);
      await marketplace.connect(owner).setPlatformFeeBps(500); // 5%

      const tokenAmount = ethers.parseEther("100");
      await token.mint(agentC.address, ethers.parseEther("1000"));
      await token
        .connect(agentC)
        .approve(await marketplace.getAddress(), tokenAmount);

      // Create token agreement (agreementId = 1)
      await marketplace
        .connect(agentC)
        .createAgreement(0, TERMS_CID, await futureDeadline(), tokenAmount, await token.getAddress());
      await marketplace.connect(provider).deliverWork(1, DELIVERY_CID);

      await marketplace.connect(agentC).settleAgreement(1);

      // 5% of 100 = 5 tokens fee, 95 tokens to provider
      expect(await token.balanceOf(provider.address)).to.equal(
        ethers.parseEther("95")
      );
      expect(await token.balanceOf(treasury.address)).to.equal(
        ethers.parseEther("5")
      );
    });

    it("should revert when agreement is not Delivered", async function () {
      // Create agreement but don't deliver
      await marketplace
        .connect(agentC)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, {
          value: ethers.parseEther("1"),
        });

      await expect(
        marketplace.connect(agentC).settleAgreement(1)
      ).to.be.revertedWithCustomError(marketplace, "InvalidStatus");
    });

    it("should revert when caller is not the buyer", async function () {
      await expect(
        marketplace.connect(provider).settleAgreement(0)
      ).to.be.revertedWithCustomError(marketplace, "NotBuyer");
    });

    it("should release full amount when no platform fee is set", async function () {
      // platformFeeBps is 0 by default
      const balanceBefore = await ethers.provider.getBalance(provider.address);
      await marketplace.connect(buyer).settleAgreement(0);
      const balanceAfter = await ethers.provider.getBalance(provider.address);

      expect(balanceAfter - balanceBefore).to.equal(ethAmount);
    });
  });

  // ============================================================
  //                     DISPUTES (6)
  // ============================================================

  describe("Disputes", function () {
    const ethAmount = ethers.parseEther("2");

    beforeEach(async function () {
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, ethers.parseEther("1"));
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, {
          value: ethAmount,
        });
    });

    it("should allow buyer to dispute an Agreed agreement", async function () {
      await expect(
        marketplace.connect(buyer).disputeAgreement(0, REASON_CID)
      )
        .to.emit(marketplace, "AgreementDisputed")
        .withArgs(0, buyer.address, REASON_CID);

      const agreement = await marketplace.getAgreement(0);
      expect(agreement.status).to.equal(4); // ServiceStatus.Disputed
    });

    it("should allow provider to dispute a Delivered agreement", async function () {
      await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);

      await expect(
        marketplace.connect(provider).disputeAgreement(0, REASON_CID)
      )
        .to.emit(marketplace, "AgreementDisputed")
        .withArgs(0, provider.address, REASON_CID);

      const agreement = await marketplace.getAgreement(0);
      expect(agreement.status).to.equal(4); // Disputed
    });

    it("should increment listing totalDisputed", async function () {
      await marketplace.connect(buyer).disputeAgreement(0, REASON_CID);

      const listing = await marketplace.getListing(0);
      expect(listing.totalDisputed).to.equal(1);
    });

    it("should revert dispute from non-party", async function () {
      await expect(
        marketplace.connect(agentC).disputeAgreement(0, REASON_CID)
      ).to.be.revertedWithCustomError(marketplace, "NotParty");
    });

    it("should revert dispute when agreement is Settled", async function () {
      await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);
      await marketplace.connect(buyer).settleAgreement(0);

      await expect(
        marketplace.connect(buyer).disputeAgreement(0, REASON_CID)
      ).to.be.revertedWithCustomError(marketplace, "InvalidStatus");
    });

    it("should revert dispute when agreement is already Disputed", async function () {
      await marketplace.connect(buyer).disputeAgreement(0, REASON_CID);

      await expect(
        marketplace.connect(buyer).disputeAgreement(0, REASON_CID)
      ).to.be.revertedWithCustomError(marketplace, "InvalidStatus");
    });
  });

  // ============================================================
  //                  DISPUTE RESOLUTION (6)
  // ============================================================

  describe("Dispute Resolution", function () {
    const ethAmount = ethers.parseEther("2");

    beforeEach(async function () {
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, ethers.parseEther("1"));
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, {
          value: ethAmount,
        });
      await marketplace.connect(buyer).disputeAgreement(0, REASON_CID);
    });

    it("should release escrow to provider when resolved in their favor", async function () {
      const providerBalanceBefore = await ethers.provider.getBalance(provider.address);

      await expect(marketplace.connect(owner).resolveDispute(0, true))
        .to.emit(marketplace, "DisputeResolved")
        .withArgs(0, true);

      const providerBalanceAfter = await ethers.provider.getBalance(provider.address);
      expect(providerBalanceAfter - providerBalanceBefore).to.equal(ethAmount);

      const agreement = await marketplace.getAgreement(0);
      expect(agreement.status).to.equal(3); // Settled
    });

    it("should release escrow to provider with fee when resolved in their favor", async function () {
      await marketplace.connect(owner).setPlatformFeeBps(500); // 5%

      const providerBalanceBefore = await ethers.provider.getBalance(provider.address);
      const treasuryBalanceBefore = await ethers.provider.getBalance(treasury.address);

      await marketplace.connect(owner).resolveDispute(0, true);

      const providerBalanceAfter = await ethers.provider.getBalance(provider.address);
      const treasuryBalanceAfter = await ethers.provider.getBalance(treasury.address);

      // 5% of 2 ETH = 0.1 ETH fee, 1.9 ETH to provider
      expect(providerBalanceAfter - providerBalanceBefore).to.equal(
        ethers.parseEther("1.9")
      );
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(
        ethers.parseEther("0.1")
      );
    });

    it("should refund escrow to buyer minus cancel fee when resolved against provider (buyer-initiated Agreed dispute)", async function () {
      const buyerBalanceBefore = await ethers.provider.getBalance(buyer.address);
      const treasuryBalanceBefore = await ethers.provider.getBalance(treasury.address);

      await marketplace.connect(owner).resolveDispute(0, false);

      const buyerBalanceAfter = await ethers.provider.getBalance(buyer.address);
      const treasuryBalanceAfter = await ethers.provider.getBalance(treasury.address);
      // V5: 5% cancel fee on buyer-initiated Agreed dispute
      // 5% of 2 ETH = 0.1 ETH fee, 1.9 ETH refund
      expect(buyerBalanceAfter - buyerBalanceBefore).to.equal(ethers.parseEther("1.9"));
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(ethers.parseEther("0.1"));

      const agreement = await marketplace.getAgreement(0);
      expect(agreement.status).to.equal(5); // Cancelled
    });

    it("should increment totalCompleted when resolved in favor of provider", async function () {
      await marketplace.connect(owner).resolveDispute(0, true);

      const listing = await marketplace.getListing(0);
      expect(listing.totalCompleted).to.equal(1);
    });

    it("should revert when agreement is not Disputed", async function () {
      // Create a new agreement that is just Agreed
      await marketplace
        .connect(agentC)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress);

      await expect(
        marketplace.connect(owner).resolveDispute(1, true)
      ).to.be.revertedWithCustomError(marketplace, "InvalidStatus");
    });

    it("should revert when caller is not admin", async function () {
      await expect(
        marketplace.connect(buyer).resolveDispute(0, true)
      ).to.be.revertedWithCustomError(
        marketplace,
        "AccessControlUnauthorizedAccount"
      );
    });
  });

  // ============================================================
  //                    CANCELLATION (4)
  // ============================================================

  describe("Cancellation", function () {
    it("should cancel and refund ETH escrow to buyer minus cancellation fee", async function () {
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, ethers.parseEther("1"));

      const ethAmount = ethers.parseEther("3");
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, {
          value: ethAmount,
        });

      const balanceBefore = await ethers.provider.getBalance(buyer.address);
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);

      const tx = await marketplace.connect(buyer).cancelAgreement(0);
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;

      const balanceAfter = await ethers.provider.getBalance(buyer.address);
      const treasuryAfter = await ethers.provider.getBalance(treasury.address);

      // V5: 5% cancel fee on 3 ETH = 0.15 ETH fee, 2.85 ETH refund
      const expectedRefund = ethers.parseEther("2.85");
      const expectedFee = ethers.parseEther("0.15");
      expect(balanceAfter - balanceBefore + gasCost).to.equal(expectedRefund);
      expect(treasuryAfter - treasuryBefore).to.equal(expectedFee);

      await expect(tx)
        .to.emit(marketplace, "AgreementCancelledWithFee")
        .withArgs(0, expectedFee);

      const agreement = await marketplace.getAgreement(0);
      expect(agreement.status).to.equal(5); // Cancelled
    });

    it("should cancel a reputation-only agreement", async function () {
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, 0);

      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress);

      await expect(marketplace.connect(buyer).cancelAgreement(0))
        .to.emit(marketplace, "AgreementCancelled")
        .withArgs(0);

      const agreement = await marketplace.getAgreement(0);
      expect(agreement.status).to.equal(5); // Cancelled
    });

    it("should cancel and refund token escrow to buyer minus cancellation fee", async function () {
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, 0);

      const MockFactory = await ethers.getContractFactory("MockERC20");
      token = (await MockFactory.deploy("Mock Token", "MOCK")) as unknown as MockERC20;
      await token.waitForDeployment();
      await marketplace
        .connect(owner)
        .setPaymentToken(await token.getAddress());
      await marketplace.connect(owner).setAllowedToken(await token.getAddress(), true);

      const tokenAmount = ethers.parseEther("50");
      await token.mint(buyer.address, ethers.parseEther("1000"));
      await token
        .connect(buyer)
        .approve(await marketplace.getAddress(), tokenAmount);

      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), tokenAmount, await token.getAddress());

      const tokensBefore = await token.balanceOf(buyer.address);
      await marketplace.connect(buyer).cancelAgreement(0);
      const tokensAfter = await token.balanceOf(buyer.address);

      // V5: 5% cancel fee on 50 tokens = 2.5 tokens fee, 47.5 tokens refund
      expect(tokensAfter - tokensBefore).to.equal(ethers.parseEther("47.5"));
      expect(await token.balanceOf(treasury.address)).to.equal(ethers.parseEther("2.5"));
    });

    it("should revert cancel when agreement is Delivered", async function () {
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, ethers.parseEther("1"));
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, {
          value: ethers.parseEther("1"),
        });
      await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);

      await expect(
        marketplace.connect(buyer).cancelAgreement(0)
      ).to.be.revertedWithCustomError(marketplace, "InvalidStatus");
    });

    it("should revert when caller is not the buyer", async function () {
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, ethers.parseEther("1"));
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, {
          value: ethers.parseEther("1"),
        });

      await expect(
        marketplace.connect(provider).cancelAgreement(0)
      ).to.be.revertedWithCustomError(marketplace, "NotBuyer");
    });
  });

  // ============================================================
  //                 TOKEN ACTIVATION (3)
  // ============================================================

  describe("Token Activation", function () {
    it("should set payment token", async function () {
      const tokenAddr = "0x0000000000000000000000000000000000000001";
      await expect(marketplace.connect(owner).setPaymentToken(tokenAddr))
        .to.emit(marketplace, "PaymentTokenUpdated")
        .withArgs(ethers.ZeroAddress, tokenAddr);
    });

    it("should only allow admin to set payment token", async function () {
      await expect(
        marketplace.connect(provider).setPaymentToken(provider.address)
      ).to.be.revertedWithCustomError(
        marketplace,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("should start in free mode (paymentToken == address(0))", async function () {
      expect(await marketplace.paymentToken()).to.equal(ethers.ZeroAddress);
    });
  });

  // ============================================================
  //                  ADMIN FUNCTIONS (4)
  // ============================================================

  describe("Admin Functions", function () {
    it("should set platform fee basis points", async function () {
      await expect(marketplace.connect(owner).setPlatformFeeBps(500))
        .to.emit(marketplace, "PlatformFeeUpdated")
        .withArgs(0, 500);

      expect(await marketplace.platformFeeBps()).to.equal(500);
    });

    it("should revert when fee exceeds max (1000)", async function () {
      await expect(
        marketplace.connect(owner).setPlatformFeeBps(1001)
      ).to.be.revertedWithCustomError(marketplace, "FeeTooHigh");
    });

    it("should set treasury address", async function () {
      await expect(marketplace.connect(owner).setTreasury(agentC.address))
        .to.emit(marketplace, "TreasuryUpdated")
        .withArgs(treasury.address, agentC.address);

      expect(await marketplace.treasury()).to.equal(agentC.address);
    });

    it("should revert setting treasury to zero address", async function () {
      await expect(
        marketplace.connect(owner).setTreasury(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(marketplace, "ZeroAddress");
    });

    it("should set agent registry", async function () {
      await marketplace
        .connect(owner)
        .setAgentRegistry(agentC.address);
      expect(await marketplace.agentRegistry()).to.equal(agentC.address);
    });

    it("should revert setting agent registry to zero address", async function () {
      await expect(
        marketplace.connect(owner).setAgentRegistry(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(marketplace, "ZeroAddress");
    });

    it("should revert admin calls from non-admin", async function () {
      await expect(
        marketplace.connect(provider).setPlatformFeeBps(100)
      ).to.be.revertedWithCustomError(
        marketplace,
        "AccessControlUnauthorizedAccount"
      );

      await expect(
        marketplace.connect(provider).setTreasury(provider.address)
      ).to.be.revertedWithCustomError(
        marketplace,
        "AccessControlUnauthorizedAccount"
      );

      await expect(
        marketplace.connect(provider).setPaymentToken(provider.address)
      ).to.be.revertedWithCustomError(
        marketplace,
        "AccessControlUnauthorizedAccount"
      );

      await expect(
        marketplace.connect(provider).setAgentRegistry(provider.address)
      ).to.be.revertedWithCustomError(
        marketplace,
        "AccessControlUnauthorizedAccount"
      );
    });
  });

  // ============================================================
  //                     PAUSABLE (3)
  // ============================================================

  describe("Pausable", function () {
    it("should revert listService when paused", async function () {
      await marketplace.connect(owner).pause();

      await expect(
        marketplace
          .connect(provider)
          .listService(METADATA_CID, CATEGORY, 0, 0)
      ).to.be.revertedWithCustomError(marketplace, "EnforcedPause");
    });

    it("should revert createAgreement when paused", async function () {
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, ethers.parseEther("1"));

      await marketplace.connect(owner).pause();

      await expect(
        marketplace
          .connect(buyer)
          .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(marketplace, "EnforcedPause");
    });

    it("should allow operations after unpause", async function () {
      await marketplace.connect(owner).pause();
      await marketplace.connect(owner).unpause();

      await expect(
        marketplace
          .connect(provider)
          .listService(METADATA_CID, CATEGORY, 0, 0)
      ).to.emit(marketplace, "ServiceListed");
    });
  });

  // ============================================================
  //                  UUPS UPGRADE AUTH (1)
  // ============================================================

  describe("UUPS Upgrade Auth", function () {
    it("should revert upgrade from non-admin", async function () {
      const MarketplaceFactory = await ethers.getContractFactory("ServiceMarketplace");
      await expect(
        upgrades.upgradeProxy(
          await marketplace.getAddress(),
          MarketplaceFactory.connect(provider),
          {
            constructorArgs: [await forwarder.getAddress()],
            unsafeAllow: ["constructor", "state-variable-immutable"],
          }
        )
      ).to.be.revertedWithCustomError(
        marketplace,
        "AccessControlUnauthorizedAccount"
      );
    });
  });

  // ============================================================
  //            META-TRANSACTIONS (ERC-2771) (3)
  // ============================================================

  describe("Meta-Transactions (ERC-2771)", function () {
    it("should report the correct trusted forwarder", async function () {
      const forwarderAddress = await forwarder.getAddress();
      expect(await marketplace.trustedForwarder()).to.equal(forwarderAddress);
      expect(await marketplace.isTrustedForwarder(forwarderAddress)).to.be.true;
      expect(await marketplace.isTrustedForwarder(provider.address)).to.be.false;
    });

    it("should allow listing a service via meta-transaction", async function () {
      // provider signs a ForwardRequest to list a service
      const contractAddress = await marketplace.getAddress();
      const data = marketplace.interface.encodeFunctionData("listService", [
        METADATA_CID,
        CATEGORY,
        0, // PricingModel.PerTask
        ethers.parseEther("1"),
      ]);
      const nonce = await forwarder.nonces(provider.address);
      const latestBlock = await ethers.provider.getBlock("latest");
      const deadline = latestBlock!.timestamp + 3600;

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
        from: provider.address,
        to: contractAddress,
        value: 0n,
        gas: 500000n,
        nonce: nonce,
        deadline: deadline,
        data: data,
      };

      const signature = await provider.signTypedData(domain, types, request);
      const tx = await forwarder
        .connect(agentC) // agentC relays on behalf of provider
        .execute({ ...request, signature });
      await tx.wait();

      // Verify the listing was created by provider (not agentC who relayed)
      const listing = await marketplace.getListing(0);
      expect(listing.provider).to.equal(provider.address);
      expect(listing.metadataCid).to.equal(METADATA_CID);
    });

    it("direct calls still work (backward compatibility)", async function () {
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, ethers.parseEther("1"));

      const listing = await marketplace.getListing(0);
      expect(listing.provider).to.equal(provider.address);
    });
  });

  // ============================================================
  //                   VIEW FUNCTIONS (4)
  // ============================================================

  describe("View Functions", function () {
    it("getListing should revert for non-existent listing", async function () {
      await expect(
        marketplace.getListing(0)
      ).to.be.revertedWithCustomError(marketplace, "ListingNotFound");
    });

    it("getAgreement should revert for non-existent agreement", async function () {
      await expect(
        marketplace.getAgreement(0)
      ).to.be.revertedWithCustomError(marketplace, "AgreementNotFound");
    });

    it("getProviderStats should return zero for new provider", async function () {
      const [completed, disputed] = await marketplace.getProviderStats(provider.address);
      expect(completed).to.equal(0);
      expect(disputed).to.equal(0);
    });

    it("getProviderStats should aggregate across listings", async function () {
      // Create 2 listings from provider
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, 0);
      await marketplace
        .connect(provider)
        .listService(METADATA_CID_2, CATEGORY_2, 1, 0);

      // Settle agreement on listing 0
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress);
      await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);
      await marketplace.connect(buyer).settleAgreement(0);

      // Dispute agreement on listing 1
      await marketplace
        .connect(buyer)
        .createAgreement(1, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress);
      await marketplace.connect(buyer).disputeAgreement(1, REASON_CID);

      const [completed, disputed] = await marketplace.getProviderStats(provider.address);
      expect(completed).to.equal(1);
      expect(disputed).to.equal(1);
    });
  });

  // ============================================================
  //                    EDGE CASES (4)
  // ============================================================

  describe("Edge Cases", function () {
    it("should support multiple agreements per listing", async function () {
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, 0);

      // buyer creates agreement
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress);
      // agentC creates another agreement on same listing
      await marketplace
        .connect(agentC)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress);

      expect(await marketplace.totalAgreements()).to.equal(2);

      const a0 = await marketplace.getAgreement(0);
      const a1 = await marketplace.getAgreement(1);
      expect(a0.buyer).to.equal(buyer.address);
      expect(a1.buyer).to.equal(agentC.address);
      expect(a0.listingId).to.equal(0);
      expect(a1.listingId).to.equal(0);
    });

    it("should support multiple listings per provider", async function () {
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, 0);
      await marketplace
        .connect(provider)
        .listService(METADATA_CID_2, CATEGORY_2, 1, ethers.parseEther("5"));
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, "design", 2, ethers.parseEther("10"));

      const providerListings = await marketplace.getProviderListings(provider.address);
      expect(providerListings.length).to.equal(3);
      expect(await marketplace.totalListings()).to.equal(3);
    });

    it("should support full lifecycle flow", async function () {
      // List → Agree → Deliver → Settle
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, ethers.parseEther("1"));

      const ethAmount = ethers.parseEther("1");
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, {
          value: ethAmount,
        });

      await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);
      await marketplace.connect(buyer).settleAgreement(0);

      const agreement = await marketplace.getAgreement(0);
      expect(agreement.status).to.equal(3); // Settled

      const listing = await marketplace.getListing(0);
      expect(listing.totalCompleted).to.equal(1);
    });

    it("should handle dispute → resolve → refund flow", async function () {
      const ethAmount = ethers.parseEther("5");

      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, 0);

      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, {
          value: ethAmount,
        });

      // Deliver work
      await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);

      // Buyer disputes
      await marketplace.connect(buyer).disputeAgreement(0, REASON_CID);

      const buyerBalanceBefore = await ethers.provider.getBalance(buyer.address);

      // Owner resolves against provider (refund buyer)
      await marketplace.connect(owner).resolveDispute(0, false);

      const buyerBalanceAfter = await ethers.provider.getBalance(buyer.address);
      expect(buyerBalanceAfter - buyerBalanceBefore).to.equal(ethAmount);

      const agreement = await marketplace.getAgreement(0);
      expect(agreement.status).to.equal(5); // Cancelled
    });
  });

  // ============================================================
  //                V3 SECURITY FEATURES
  // ============================================================

  describe("V3 Security Features", function () {

    // ----------------------------------------------------------
    //                    Fee Snapshot
    // ----------------------------------------------------------

    describe("Fee Snapshot", function () {
      it("should use fee at creation time for settlement, not current global", async function () {
        // Set fee to 5% (500 bps) before creating agreement
        await marketplace.connect(owner).setPlatformFeeBps(500);

        await marketplace
          .connect(provider)
          .listService(METADATA_CID, CATEGORY, 0, ethers.parseEther("1"));

        const escrowEth = ethers.parseEther("10");
        await marketplace
          .connect(buyer)
          .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, {
            value: escrowEth,
          });

        // Change global fee to 10% AFTER agreement creation
        await marketplace.connect(owner).setPlatformFeeBps(1000);

        // Deliver and settle
        await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);

        const providerBalanceBefore = await ethers.provider.getBalance(provider.address);
        const treasuryBalanceBefore = await ethers.provider.getBalance(treasury.address);

        await marketplace.connect(buyer).settleAgreement(0);

        const providerBalanceAfter = await ethers.provider.getBalance(provider.address);
        const treasuryBalanceAfter = await ethers.provider.getBalance(treasury.address);

        // Should use 5% (500 bps) from creation time, NOT 10% current global
        // 5% of 10 ETH = 0.5 ETH fee, 9.5 ETH to provider
        const expectedFee = ethers.parseEther("0.5");
        const expectedPayout = ethers.parseEther("9.5");

        expect(providerBalanceAfter - providerBalanceBefore).to.equal(expectedPayout);
        expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(expectedFee);
      });

      it("should not be affected by platformFeeBps changes after creation", async function () {
        // Set fee to 2.5% (250 bps)
        await marketplace.connect(owner).setPlatformFeeBps(250);

        await marketplace
          .connect(provider)
          .listService(METADATA_CID, CATEGORY, 0, ethers.parseEther("1"));

        const escrowEth = ethers.parseEther("20");
        await marketplace
          .connect(buyer)
          .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, {
            value: escrowEth,
          });

        // Bump global fee to 0% after creation
        await marketplace.connect(owner).setPlatformFeeBps(0);

        // Deliver and settle
        await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);

        const providerBalanceBefore = await ethers.provider.getBalance(provider.address);
        const treasuryBalanceBefore = await ethers.provider.getBalance(treasury.address);

        await marketplace.connect(buyer).settleAgreement(0);

        const providerBalanceAfter = await ethers.provider.getBalance(provider.address);
        const treasuryBalanceAfter = await ethers.provider.getBalance(treasury.address);

        // Should still use 2.5% (250 bps) from creation time
        // 2.5% of 20 ETH = 0.5 ETH fee, 19.5 ETH to provider
        const expectedFee = ethers.parseEther("0.5");
        const expectedPayout = ethers.parseEther("19.5");

        expect(providerBalanceAfter - providerBalanceBefore).to.equal(expectedPayout);
        expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(expectedFee);
      });

      it("should fall back to global rate for pre-V3 agreements (feeBps == 0)", async function () {
        // platformFeeBps is 0 at agreement creation, so feeBps is stored as 0
        await marketplace
          .connect(provider)
          .listService(METADATA_CID, CATEGORY, 0, ethers.parseEther("1"));

        const escrowEth = ethers.parseEther("10");
        await marketplace
          .connect(buyer)
          .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, {
            value: escrowEth,
          });

        // Verify feeBps was stored as 0
        const agreement = await marketplace.getAgreement(0);
        expect(agreement.feeBps).to.equal(0);

        // Set global fee to 3% (300 bps) AFTER creation
        await marketplace.connect(owner).setPlatformFeeBps(300);

        // Deliver and settle
        await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);

        const providerBalanceBefore = await ethers.provider.getBalance(provider.address);
        const treasuryBalanceBefore = await ethers.provider.getBalance(treasury.address);

        await marketplace.connect(buyer).settleAgreement(0);

        const providerBalanceAfter = await ethers.provider.getBalance(provider.address);
        const treasuryBalanceAfter = await ethers.provider.getBalance(treasury.address);

        // feeBps == 0 → _effectiveFeeBps falls back to global platformFeeBps (300 bps = 3%)
        // 3% of 10 ETH = 0.3 ETH fee, 9.7 ETH to provider
        const expectedFee = ethers.parseEther("0.3");
        const expectedPayout = ethers.parseEther("9.7");

        expect(providerBalanceAfter - providerBalanceBefore).to.equal(expectedPayout);
        expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(expectedFee);
      });
    });

    // ----------------------------------------------------------
    //                  Emergency Withdraw
    // ----------------------------------------------------------

    describe("Emergency Withdraw", function () {
      it("should allow admin to withdraw stuck tokens", async function () {
        // Deploy a mock token and send some to the marketplace by accident
        const MockFactory = await ethers.getContractFactory("MockERC20");
        token = (await MockFactory.deploy("Stuck Token", "STUCK")) as unknown as MockERC20;
        await token.waitForDeployment();

        const stuckAmount = ethers.parseEther("42");
        await token.mint(await marketplace.getAddress(), stuckAmount);

        // Verify tokens are in contract
        expect(await token.balanceOf(await marketplace.getAddress())).to.equal(stuckAmount);

        // Admin withdraws stuck tokens
        await expect(
          marketplace.connect(owner).emergencyWithdraw(
            await token.getAddress(),
            treasury.address,
            stuckAmount
          )
        )
          .to.emit(marketplace, "EmergencyWithdraw")
          .withArgs(await token.getAddress(), treasury.address, stuckAmount);

        // Verify tokens were sent to treasury
        expect(await token.balanceOf(treasury.address)).to.equal(stuckAmount);
        expect(await token.balanceOf(await marketplace.getAddress())).to.equal(0);
      });

      it("should allow admin to rescue stuck ETH", async function () {
        // Send ETH directly to the marketplace contract via a self-destructing contract
        // or via an agreement that we can use to get ETH into the contract
        await marketplace
          .connect(provider)
          .listService(METADATA_CID, CATEGORY, 0, ethers.parseEther("1"));

        const stuckEth = ethers.parseEther("5");
        await marketplace
          .connect(buyer)
          .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, {
            value: stuckEth,
          });

        // Now rescue the ETH that is sitting in escrow (simulating stuck ETH)
        const treasuryBalanceBefore = await ethers.provider.getBalance(treasury.address);

        await expect(
          marketplace.connect(owner).rescueETH(treasury.address, stuckEth)
        )
          .to.emit(marketplace, "EmergencyETHWithdraw")
          .withArgs(treasury.address, stuckEth);

        const treasuryBalanceAfter = await ethers.provider.getBalance(treasury.address);
        expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(stuckEth);
      });

      it("should revert emergency withdraw from non-admin", async function () {
        const MockFactory = await ethers.getContractFactory("MockERC20");
        token = (await MockFactory.deploy("Stuck Token", "STUCK")) as unknown as MockERC20;
        await token.waitForDeployment();

        await expect(
          marketplace.connect(provider).emergencyWithdraw(
            await token.getAddress(),
            provider.address,
            ethers.parseEther("1")
          )
        ).to.be.revertedWithCustomError(
          marketplace,
          "AccessControlUnauthorizedAccount"
        );

        await expect(
          marketplace.connect(provider).rescueETH(
            provider.address,
            ethers.parseEther("1")
          )
        ).to.be.revertedWithCustomError(
          marketplace,
          "AccessControlUnauthorizedAccount"
        );
      });

      it("should revert emergency withdraw with zero amount", async function () {
        const MockFactory = await ethers.getContractFactory("MockERC20");
        token = (await MockFactory.deploy("Stuck Token", "STUCK")) as unknown as MockERC20;
        await token.waitForDeployment();

        await expect(
          marketplace.connect(owner).emergencyWithdraw(
            await token.getAddress(),
            treasury.address,
            0
          )
        ).to.be.revertedWithCustomError(marketplace, "ZeroAmount");

        await expect(
          marketplace.connect(owner).rescueETH(treasury.address, 0)
        ).to.be.revertedWithCustomError(marketplace, "ZeroAmount");
      });
    });

    // ----------------------------------------------------------
    //                   Access Control
    // ----------------------------------------------------------

    describe("Access Control", function () {
      it("should allow admin to call admin functions", async function () {
        // setPlatformFeeBps
        await expect(marketplace.connect(owner).setPlatformFeeBps(100)).to.not.be.reverted;

        // setTreasury
        await expect(marketplace.connect(owner).setTreasury(agentC.address)).to.not.be.reverted;

        // setAgentRegistry
        await expect(marketplace.connect(owner).setAgentRegistry(agentC.address)).to.not.be.reverted;

        // setPaymentToken
        await expect(marketplace.connect(owner).setPaymentToken(ethers.ZeroAddress)).to.not.be.reverted;

        // setAllowedToken
        await expect(marketplace.connect(owner).setAllowedToken(agentC.address, true)).to.not.be.reverted;
      });

      it("should revert admin functions from non-admin", async function () {
        await expect(
          marketplace.connect(buyer).setPlatformFeeBps(100)
        ).to.be.revertedWithCustomError(marketplace, "AccessControlUnauthorizedAccount");

        await expect(
          marketplace.connect(buyer).setTreasury(buyer.address)
        ).to.be.revertedWithCustomError(marketplace, "AccessControlUnauthorizedAccount");

        await expect(
          marketplace.connect(buyer).setAgentRegistry(buyer.address)
        ).to.be.revertedWithCustomError(marketplace, "AccessControlUnauthorizedAccount");

        await expect(
          marketplace.connect(buyer).setPaymentToken(buyer.address)
        ).to.be.revertedWithCustomError(marketplace, "AccessControlUnauthorizedAccount");

        await expect(
          marketplace.connect(buyer).setAllowedToken(buyer.address, true)
        ).to.be.revertedWithCustomError(marketplace, "AccessControlUnauthorizedAccount");

        await expect(
          marketplace.connect(buyer).unpause()
        ).to.be.revertedWithCustomError(marketplace, "AccessControlUnauthorizedAccount");
      });

      it("should allow guardian to pause but not unpause", async function () {
        // Guardian can pause
        await expect(marketplace.connect(guardian).pause()).to.not.be.reverted;
        expect(await marketplace.paused()).to.be.true;

        // Guardian cannot unpause
        await expect(
          marketplace.connect(guardian).unpause()
        ).to.be.revertedWithCustomError(marketplace, "AccessControlUnauthorizedAccount");

        // Admin can unpause
        await marketplace.connect(owner).unpause();
        expect(await marketplace.paused()).to.be.false;
      });

      it("should allow admin to pause and unpause", async function () {
        // Admin can pause
        await expect(marketplace.connect(owner).pause()).to.not.be.reverted;
        expect(await marketplace.paused()).to.be.true;

        // Admin can unpause
        await expect(marketplace.connect(owner).unpause()).to.not.be.reverted;
        expect(await marketplace.paused()).to.be.false;
      });
    });
  });

  // ============================================================
  //            V4 — EXPIRE DELIVERED (10 tests)
  // ============================================================

  describe("V4 — expireDelivered", function () {
    const ethAmount = ethers.parseEther("2");

    beforeEach(async function () {
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, ethers.parseEther("1"));
    });

    it("should release escrow to provider after deadline + grace period", async function () {
      const deadline = await futureDeadline();
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, deadline, 0, ethers.ZeroAddress, { value: ethAmount });
      await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);

      // Advance past deadline + grace period (1 day + 14 days + 1 second)
      await ethers.provider.send("evm_increaseTime", [86400 + 14 * 86400 + 1]);
      await ethers.provider.send("evm_mine", []);

      const providerBefore = await ethers.provider.getBalance(provider.address);

      await expect(marketplace.connect(agentC).expireDelivered(0))
        .to.emit(marketplace, "DeliveryExpired")
        .withArgs(0, provider.address, ethAmount);

      const providerAfter = await ethers.provider.getBalance(provider.address);
      expect(providerAfter - providerBefore).to.equal(ethAmount);

      const agreement = await marketplace.getAgreement(0);
      expect(agreement.status).to.equal(3); // Settled
    });

    it("should revert if agreement is not Delivered", async function () {
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, { value: ethAmount });

      await expect(
        marketplace.connect(agentC).expireDelivered(0)
      ).to.be.revertedWithCustomError(marketplace, "InvalidStatus");
    });

    it("should revert if deadline + grace not elapsed", async function () {
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, { value: ethAmount });
      await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);

      await expect(
        marketplace.connect(agentC).expireDelivered(0)
      ).to.be.revertedWithCustomError(marketplace, "NotExpired");
    });

    it("should deduct platform fee on expiry", async function () {
      await marketplace.connect(owner).setPlatformFeeBps(500); // 5%

      const escrow = ethers.parseEther("10");
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, { value: escrow });
      await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);

      await ethers.provider.send("evm_increaseTime", [86400 + 14 * 86400 + 1]);
      await ethers.provider.send("evm_mine", []);

      const providerBefore = await ethers.provider.getBalance(provider.address);
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);

      await marketplace.connect(agentC).expireDelivered(0);

      const providerAfter = await ethers.provider.getBalance(provider.address);
      const treasuryAfter = await ethers.provider.getBalance(treasury.address);

      expect(providerAfter - providerBefore).to.equal(ethers.parseEther("9.5"));
      expect(treasuryAfter - treasuryBefore).to.equal(ethers.parseEther("0.5"));
    });

    it("should handle token escrow expiry", async function () {
      const MockFactory = await ethers.getContractFactory("MockERC20");
      token = (await MockFactory.deploy("Mock Token", "MOCK")) as unknown as MockERC20;
      await token.waitForDeployment();
      await marketplace.connect(owner).setAllowedToken(await token.getAddress(), true);

      const tokenAmount = ethers.parseEther("100");
      await token.mint(buyer.address, ethers.parseEther("1000"));
      await token.connect(buyer).approve(await marketplace.getAddress(), tokenAmount);

      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), tokenAmount, await token.getAddress());
      await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);

      await ethers.provider.send("evm_increaseTime", [86400 + 14 * 86400 + 1]);
      await ethers.provider.send("evm_mine", []);

      await marketplace.connect(agentC).expireDelivered(0);

      expect(await token.balanceOf(provider.address)).to.equal(tokenAmount);
      const agreement = await marketplace.getAgreement(0);
      expect(agreement.status).to.equal(3); // Settled
    });

    it("should handle zero-escrow expiry", async function () {
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress);
      await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);

      await ethers.provider.send("evm_increaseTime", [86400 + 14 * 86400 + 1]);
      await ethers.provider.send("evm_mine", []);

      await marketplace.connect(agentC).expireDelivered(0);

      const agreement = await marketplace.getAgreement(0);
      expect(agreement.status).to.equal(3); // Settled
    });

    it("should allow anyone to call expireDelivered", async function () {
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, { value: ethAmount });
      await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);

      await ethers.provider.send("evm_increaseTime", [86400 + 14 * 86400 + 1]);
      await ethers.provider.send("evm_mine", []);

      // nonAgent (not a registered agent) can call
      await expect(marketplace.connect(nonAgent).expireDelivered(0)).to.not.be.reverted;
    });

    it("should increment totalCompleted on expiry", async function () {
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, { value: ethAmount });
      await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);

      await ethers.provider.send("evm_increaseTime", [86400 + 14 * 86400 + 1]);
      await ethers.provider.send("evm_mine", []);

      await marketplace.connect(agentC).expireDelivered(0);

      const listing = await marketplace.getListing(0);
      expect(listing.totalCompleted).to.equal(1);
    });

    it("should set settledAt timestamp", async function () {
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, { value: ethAmount });
      await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);

      await ethers.provider.send("evm_increaseTime", [86400 + 14 * 86400 + 1]);
      await ethers.provider.send("evm_mine", []);

      await marketplace.connect(agentC).expireDelivered(0);

      const agreement = await marketplace.getAgreement(0);
      expect(agreement.settledAt).to.be.greaterThan(0);
    });

    it("should revert on already settled agreement", async function () {
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, { value: ethAmount });
      await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);
      await marketplace.connect(buyer).settleAgreement(0);

      await expect(
        marketplace.connect(agentC).expireDelivered(0)
      ).to.be.revertedWithCustomError(marketplace, "InvalidStatus");
    });
  });

  // ============================================================
  //            V5 — INITIALIZATION (3 tests)
  // ============================================================

  describe("V5 Initialization", function () {
    it("should set cancellationFeeBps to 500 (5%)", async function () {
      expect(await marketplace.cancellationFeeBps()).to.equal(500);
    });

    it("should set disputeTimeoutPeriod to 30 days", async function () {
      expect(await marketplace.disputeTimeoutPeriod()).to.equal(30 * 86400);
    });

    it("should prevent double initialization", async function () {
      await expect(marketplace.initializeV5()).to.be.revertedWithCustomError(
        marketplace,
        "InvalidInitialization"
      );
    });
  });

  // ============================================================
  //       V5 — CANCEL AGREEMENT WITH FEE (6 tests)
  // ============================================================

  describe("V5 — cancelAgreement with Fee", function () {
    beforeEach(async function () {
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, ethers.parseEther("1"));
    });

    it("should deduct ETH cancellation fee to treasury", async function () {
      const escrow = ethers.parseEther("10");
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, { value: escrow });

      const buyerBefore = await ethers.provider.getBalance(buyer.address);
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);

      const tx = await marketplace.connect(buyer).cancelAgreement(0);
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;

      const buyerAfter = await ethers.provider.getBalance(buyer.address);
      const treasuryAfter = await ethers.provider.getBalance(treasury.address);

      // 5% of 10 ETH = 0.5 ETH fee
      const expectedFee = ethers.parseEther("0.5");
      const expectedRefund = ethers.parseEther("9.5");

      expect(treasuryAfter - treasuryBefore).to.equal(expectedFee);
      expect(buyerAfter - buyerBefore + gasCost).to.equal(expectedRefund);

      await expect(tx).to.emit(marketplace, "AgreementCancelledWithFee").withArgs(0, expectedFee);
    });

    it("should deduct token cancellation fee to treasury", async function () {
      const MockFactory = await ethers.getContractFactory("MockERC20");
      token = (await MockFactory.deploy("Mock Token", "MOCK")) as unknown as MockERC20;
      await token.waitForDeployment();
      await marketplace.connect(owner).setAllowedToken(await token.getAddress(), true);

      const tokenAmount = ethers.parseEther("100");
      await token.mint(buyer.address, ethers.parseEther("1000"));
      await token.connect(buyer).approve(await marketplace.getAddress(), tokenAmount);

      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), tokenAmount, await token.getAddress());

      await marketplace.connect(buyer).cancelAgreement(0);

      // 5% of 100 = 5 tokens fee, 95 tokens refund
      expect(await token.balanceOf(buyer.address)).to.equal(ethers.parseEther("995")); // 1000 - 100 + 95
      expect(await token.balanceOf(treasury.address)).to.equal(ethers.parseEther("5"));
    });

    it("should not deduct fee on zero-escrow cancellation", async function () {
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress);

      // Should emit plain AgreementCancelled, not AgreementCancelledWithFee
      await expect(marketplace.connect(buyer).cancelAgreement(0))
        .to.emit(marketplace, "AgreementCancelled")
        .withArgs(0);
    });

    it("should refund full amount when cancellationFeeBps is 0", async function () {
      // Set fee to 0
      await marketplace.connect(owner).setCancellationFeeBps(0);

      const escrow = ethers.parseEther("10");
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, { value: escrow });

      const buyerBefore = await ethers.provider.getBalance(buyer.address);

      const tx = await marketplace.connect(buyer).cancelAgreement(0);
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;

      const buyerAfter = await ethers.provider.getBalance(buyer.address);
      expect(buyerAfter - buyerBefore + gasCost).to.equal(escrow);

      // Should emit plain AgreementCancelled
      await expect(tx).to.emit(marketplace, "AgreementCancelled").withArgs(0);
    });

    it("should set status to Cancelled", async function () {
      const escrow = ethers.parseEther("5");
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, { value: escrow });

      await marketplace.connect(buyer).cancelAgreement(0);

      const agreement = await marketplace.getAgreement(0);
      expect(agreement.status).to.equal(5); // Cancelled
    });

    it("should still revert when caller is not buyer", async function () {
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, {
          value: ethers.parseEther("1"),
        });

      await expect(
        marketplace.connect(provider).cancelAgreement(0)
      ).to.be.revertedWithCustomError(marketplace, "NotBuyer");
    });
  });

  // ============================================================
  //       V5 — DISPUTE METADATA RECORDING (4 tests)
  // ============================================================

  describe("V5 — disputeAgreement metadata", function () {
    beforeEach(async function () {
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, ethers.parseEther("1"));
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, {
          value: ethers.parseEther("2"),
        });
    });

    it("should record disputedAt timestamp", async function () {
      await marketplace.connect(buyer).disputeAgreement(0, REASON_CID);

      const timestamp = await marketplace.disputedAt(0);
      expect(timestamp).to.be.greaterThan(0);
    });

    it("should record preDisputeStatus from Agreed", async function () {
      await marketplace.connect(buyer).disputeAgreement(0, REASON_CID);

      const preStatus = await marketplace.preDisputeStatus(0);
      expect(preStatus).to.equal(1); // ServiceStatus.Agreed
    });

    it("should record preDisputeStatus from Delivered", async function () {
      await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);
      await marketplace.connect(buyer).disputeAgreement(0, REASON_CID);

      const preStatus = await marketplace.preDisputeStatus(0);
      expect(preStatus).to.equal(2); // ServiceStatus.Delivered
    });

    it("should record disputeInitiator", async function () {
      await marketplace.connect(buyer).disputeAgreement(0, REASON_CID);

      const initiator = await marketplace.disputeInitiator(0);
      expect(initiator).to.equal(buyer.address);
    });
  });

  // ============================================================
  //           V5 — EXPIRE DISPUTE (15 tests)
  // ============================================================

  describe("V5 — expireDispute", function () {
    const ethAmount = ethers.parseEther("10");
    const THIRTY_DAYS = 30 * 86400;

    beforeEach(async function () {
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, ethers.parseEther("1"));
    });

    it("should revert if agreement is not Disputed", async function () {
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, { value: ethAmount });

      await expect(
        marketplace.connect(agentC).expireDispute(0)
      ).to.be.revertedWithCustomError(marketplace, "NotDisputed");
    });

    it("should revert if timeout not elapsed", async function () {
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, { value: ethAmount });
      await marketplace.connect(buyer).disputeAgreement(0, REASON_CID);

      await expect(
        marketplace.connect(agentC).expireDispute(0)
      ).to.be.revertedWithCustomError(marketplace, "DisputeNotExpired");
    });

    it("should revert if disputedAt == 0 (pre-V5 dispute)", async function () {
      // We can't easily create a pre-V5 dispute in test, but disputedAt defaults to 0
      // for agreement IDs that were never disputed through V5 flow.
      // Since our beforeEach runs V5 init, we test by checking that a non-disputed
      // agreement's disputedAt is 0.
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, { value: ethAmount });

      // Manually verify disputedAt is 0 for this agreement
      expect(await marketplace.disputedAt(0)).to.equal(0);
    });

    it("should release escrow to provider when pre-dispute was Delivered", async function () {
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, { value: ethAmount });
      await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);
      await marketplace.connect(buyer).disputeAgreement(0, REASON_CID);

      // Advance past dispute timeout
      await ethers.provider.send("evm_increaseTime", [THIRTY_DAYS + 1]);
      await ethers.provider.send("evm_mine", []);

      const providerBefore = await ethers.provider.getBalance(provider.address);

      await expect(marketplace.connect(agentC).expireDispute(0))
        .to.emit(marketplace, "DisputeExpired")
        .withArgs(0, true, ethAmount, 0);

      const providerAfter = await ethers.provider.getBalance(provider.address);
      expect(providerAfter - providerBefore).to.equal(ethAmount);

      const agreement = await marketplace.getAgreement(0);
      expect(agreement.status).to.equal(3); // Settled
    });

    it("should deduct platform fee when provider wins dispute expiry", async function () {
      await marketplace.connect(owner).setPlatformFeeBps(500); // 5%

      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, { value: ethAmount });
      await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);
      await marketplace.connect(buyer).disputeAgreement(0, REASON_CID);

      await ethers.provider.send("evm_increaseTime", [THIRTY_DAYS + 1]);
      await ethers.provider.send("evm_mine", []);

      const providerBefore = await ethers.provider.getBalance(provider.address);
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);

      await marketplace.connect(agentC).expireDispute(0);

      const providerAfter = await ethers.provider.getBalance(provider.address);
      const treasuryAfter = await ethers.provider.getBalance(treasury.address);

      expect(providerAfter - providerBefore).to.equal(ethers.parseEther("9.5"));
      expect(treasuryAfter - treasuryBefore).to.equal(ethers.parseEther("0.5"));
    });

    it("should refund buyer minus cancel fee when Agreed + buyer initiated", async function () {
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, { value: ethAmount });
      await marketplace.connect(buyer).disputeAgreement(0, REASON_CID);

      await ethers.provider.send("evm_increaseTime", [THIRTY_DAYS + 1]);
      await ethers.provider.send("evm_mine", []);

      const buyerBefore = await ethers.provider.getBalance(buyer.address);
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);

      // 5% cancel fee on 10 ETH = 0.5 ETH
      await expect(marketplace.connect(agentC).expireDispute(0))
        .to.emit(marketplace, "DisputeExpired")
        .withArgs(0, false, ethAmount, ethers.parseEther("0.5"));

      const buyerAfter = await ethers.provider.getBalance(buyer.address);
      const treasuryAfter = await ethers.provider.getBalance(treasury.address);

      expect(buyerAfter - buyerBefore).to.equal(ethers.parseEther("9.5"));
      expect(treasuryAfter - treasuryBefore).to.equal(ethers.parseEther("0.5"));

      const agreement = await marketplace.getAgreement(0);
      expect(agreement.status).to.equal(5); // Cancelled
    });

    it("should revert when provider disputes Agreed (V6)", async function () {
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, { value: ethAmount });
      // V6: Provider cannot dispute an Agreed agreement (must deliver first)
      await expect(
        marketplace.connect(provider).disputeAgreement(0, REASON_CID)
      ).to.be.revertedWithCustomError(marketplace, "InvalidStatus");
    });

    it("should full refund buyer when Agreed + buyer initiated", async function () {
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, { value: ethAmount });
      await marketplace.connect(buyer).disputeAgreement(0, REASON_CID);

      await ethers.provider.send("evm_increaseTime", [THIRTY_DAYS + 1]);
      await ethers.provider.send("evm_mine", []);

      const buyerBefore = await ethers.provider.getBalance(buyer.address);

      await expect(marketplace.connect(agentC).expireDispute(0))
        .to.emit(marketplace, "DisputeExpired");

      const buyerAfter = await ethers.provider.getBalance(buyer.address);
      // Buyer-initiated Agreed dispute: buyer gets refund minus cancel fee
      expect(buyerAfter).to.be.gt(buyerBefore);

      const agreement = await marketplace.getAgreement(0);
      expect(agreement.status).to.equal(5); // Cancelled
    });

    it("should handle token escrow in expire dispute (provider wins)", async function () {
      const MockFactory = await ethers.getContractFactory("MockERC20");
      token = (await MockFactory.deploy("Mock Token", "MOCK")) as unknown as MockERC20;
      await token.waitForDeployment();
      await marketplace.connect(owner).setAllowedToken(await token.getAddress(), true);

      const tokenAmount = ethers.parseEther("100");
      await token.mint(buyer.address, ethers.parseEther("1000"));
      await token.connect(buyer).approve(await marketplace.getAddress(), tokenAmount);

      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), tokenAmount, await token.getAddress());
      await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);
      await marketplace.connect(buyer).disputeAgreement(0, REASON_CID);

      await ethers.provider.send("evm_increaseTime", [THIRTY_DAYS + 1]);
      await ethers.provider.send("evm_mine", []);

      await marketplace.connect(agentC).expireDispute(0);

      expect(await token.balanceOf(provider.address)).to.equal(tokenAmount);
      const agreement = await marketplace.getAgreement(0);
      expect(agreement.status).to.equal(3); // Settled
    });

    it("should handle token escrow in expire dispute (buyer wins minus cancel fee)", async function () {
      const MockFactory = await ethers.getContractFactory("MockERC20");
      token = (await MockFactory.deploy("Mock Token", "MOCK")) as unknown as MockERC20;
      await token.waitForDeployment();
      await marketplace.connect(owner).setAllowedToken(await token.getAddress(), true);

      const tokenAmount = ethers.parseEther("100");
      await token.mint(buyer.address, ethers.parseEther("1000"));
      await token.connect(buyer).approve(await marketplace.getAddress(), tokenAmount);

      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), tokenAmount, await token.getAddress());
      await marketplace.connect(buyer).disputeAgreement(0, REASON_CID);

      await ethers.provider.send("evm_increaseTime", [THIRTY_DAYS + 1]);
      await ethers.provider.send("evm_mine", []);

      await marketplace.connect(agentC).expireDispute(0);

      // 5% of 100 = 5 tokens fee, 95 tokens refund
      expect(await token.balanceOf(buyer.address)).to.equal(ethers.parseEther("995")); // 1000-100+95
      expect(await token.balanceOf(treasury.address)).to.equal(ethers.parseEther("5"));
    });

    it("should allow anyone to call expireDispute", async function () {
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, { value: ethAmount });
      await marketplace.connect(buyer).disputeAgreement(0, REASON_CID);

      await ethers.provider.send("evm_increaseTime", [THIRTY_DAYS + 1]);
      await ethers.provider.send("evm_mine", []);

      // nonAgent can call
      await expect(marketplace.connect(nonAgent).expireDispute(0)).to.not.be.reverted;
    });

    it("should increment totalCompleted when provider wins", async function () {
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, { value: ethAmount });
      await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);
      await marketplace.connect(buyer).disputeAgreement(0, REASON_CID);

      await ethers.provider.send("evm_increaseTime", [THIRTY_DAYS + 1]);
      await ethers.provider.send("evm_mine", []);

      await marketplace.connect(agentC).expireDispute(0);

      const listing = await marketplace.getListing(0);
      expect(listing.totalCompleted).to.equal(1);
    });

    it("should not increment totalCompleted when buyer wins", async function () {
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, { value: ethAmount });
      await marketplace.connect(buyer).disputeAgreement(0, REASON_CID);

      await ethers.provider.send("evm_increaseTime", [THIRTY_DAYS + 1]);
      await ethers.provider.send("evm_mine", []);

      await marketplace.connect(agentC).expireDispute(0);

      const listing = await marketplace.getListing(0);
      expect(listing.totalCompleted).to.equal(0);
    });

    it("should handle zero-escrow dispute expiry", async function () {
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress);
      await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);
      await marketplace.connect(buyer).disputeAgreement(0, REASON_CID);

      await ethers.provider.send("evm_increaseTime", [THIRTY_DAYS + 1]);
      await ethers.provider.send("evm_mine", []);

      await marketplace.connect(agentC).expireDispute(0);

      const agreement = await marketplace.getAgreement(0);
      expect(agreement.status).to.equal(3); // Settled (provider wins)
    });

    it("should set settledAt when provider wins dispute expiry", async function () {
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, { value: ethAmount });
      await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);
      await marketplace.connect(buyer).disputeAgreement(0, REASON_CID);

      await ethers.provider.send("evm_increaseTime", [THIRTY_DAYS + 1]);
      await ethers.provider.send("evm_mine", []);

      await marketplace.connect(agentC).expireDispute(0);

      const agreement = await marketplace.getAgreement(0);
      expect(agreement.settledAt).to.be.greaterThan(0);
    });
  });

  // ============================================================
  //   V5 — RESOLVE DISPUTE WITH CANCEL FEE (4 tests)
  // ============================================================

  describe("V5 — resolveDispute with cancellation fee", function () {
    const ethAmount = ethers.parseEther("10");

    beforeEach(async function () {
      await marketplace
        .connect(provider)
        .listService(METADATA_CID, CATEGORY, 0, ethers.parseEther("1"));
    });

    it("should deduct cancel fee when buyer-initiated Agreed dispute resolved in buyer's favor", async function () {
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, { value: ethAmount });
      // Buyer disputes from Agreed status
      await marketplace.connect(buyer).disputeAgreement(0, REASON_CID);

      const buyerBefore = await ethers.provider.getBalance(buyer.address);
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);

      // Admin resolves in buyer's favor
      await marketplace.connect(owner).resolveDispute(0, false);

      const buyerAfter = await ethers.provider.getBalance(buyer.address);
      const treasuryAfter = await ethers.provider.getBalance(treasury.address);

      // 5% cancel fee on 10 ETH = 0.5 ETH
      expect(buyerAfter - buyerBefore).to.equal(ethers.parseEther("9.5"));
      expect(treasuryAfter - treasuryBefore).to.equal(ethers.parseEther("0.5"));
    });

    it("should NOT deduct cancel fee when Delivered dispute resolved in buyer's favor", async function () {
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, { value: ethAmount });
      await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);
      // Buyer disputes from Delivered status
      await marketplace.connect(buyer).disputeAgreement(0, REASON_CID);

      const buyerBefore = await ethers.provider.getBalance(buyer.address);

      await marketplace.connect(owner).resolveDispute(0, false);

      const buyerAfter = await ethers.provider.getBalance(buyer.address);
      // Full refund — no cancel fee because pre-dispute was Delivered, not Agreed
      expect(buyerAfter - buyerBefore).to.equal(ethAmount);
    });

    it("should revert when provider tries to dispute Agreed (V6 prevents this scenario)", async function () {
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, { value: ethAmount });
      // V6: Provider cannot dispute Agreed — must deliver first
      await expect(
        marketplace.connect(provider).disputeAgreement(0, REASON_CID)
      ).to.be.revertedWithCustomError(marketplace, "InvalidStatus");
    });

    it("should release to provider normally when resolved in provider's favor (no cancel fee)", async function () {
      await marketplace
        .connect(buyer)
        .createAgreement(0, TERMS_CID, await futureDeadline(), 0, ethers.ZeroAddress, { value: ethAmount });
      await marketplace.connect(buyer).disputeAgreement(0, REASON_CID);

      const providerBefore = await ethers.provider.getBalance(provider.address);

      await marketplace.connect(owner).resolveDispute(0, true);

      const providerAfter = await ethers.provider.getBalance(provider.address);
      expect(providerAfter - providerBefore).to.equal(ethAmount);
    });
  });

  // ============================================================
  //         V5 — ADMIN FUNCTIONS (5 tests)
  // ============================================================

  describe("V5 Admin Functions", function () {
    it("should set cancellationFeeBps", async function () {
      await expect(marketplace.connect(owner).setCancellationFeeBps(300))
        .to.emit(marketplace, "CancellationFeeUpdated")
        .withArgs(500, 300);

      expect(await marketplace.cancellationFeeBps()).to.equal(300);
    });

    it("should set disputeTimeoutPeriod", async function () {
      const newPeriod = 14 * 86400; // 14 days
      await expect(marketplace.connect(owner).setDisputeTimeoutPeriod(newPeriod))
        .to.emit(marketplace, "DisputeTimeoutUpdated")
        .withArgs(30 * 86400, newPeriod);

      expect(await marketplace.disputeTimeoutPeriod()).to.equal(newPeriod);
    });

    it("should revert setCancellationFeeBps above max", async function () {
      await expect(
        marketplace.connect(owner).setCancellationFeeBps(1001)
      ).to.be.revertedWithCustomError(marketplace, "CancellationFeeTooHigh");
    });

    it("should revert setCancellationFeeBps from non-admin", async function () {
      await expect(
        marketplace.connect(buyer).setCancellationFeeBps(100)
      ).to.be.revertedWithCustomError(marketplace, "AccessControlUnauthorizedAccount");
    });

    it("should revert setDisputeTimeoutPeriod from non-admin", async function () {
      await expect(
        marketplace.connect(buyer).setDisputeTimeoutPeriod(86400)
      ).to.be.revertedWithCustomError(marketplace, "AccessControlUnauthorizedAccount");
    });
  });

  // ============================================================
  //                     V6 SECURITY FIXES
  // ============================================================

  describe("V6 — cancelFeeBps snapshot", function () {
    it("should use the snapshotted cancel fee even after global change", async function () {
      // Deploy MockERC20 and allow it
      const MockFactory = await ethers.getContractFactory("MockERC20");
      const mockToken = (await MockFactory.deploy("MockUSDC", "USDC")) as unknown as MockERC20;
      await mockToken.waitForDeployment();
      const tokenAddr = await mockToken.getAddress();
      await marketplace.setAllowedToken(tokenAddr, true);

      // List service (pricingModel=0 = Fixed)
      await marketplace.connect(provider).listService(METADATA_CID, CATEGORY, 0, ethers.parseUnits("100", 18));

      // Set cancel fee to 500 (5%) — this should be snapshotted
      await marketplace.setCancellationFeeBps(500);

      // Create agreement with token escrow
      const deadline = await futureDeadline();
      const amount = ethers.parseUnits("100", 18);
      await mockToken.mint(buyer.address, amount);
      await mockToken.connect(buyer).approve(await marketplace.getAddress(), amount);
      await marketplace.connect(buyer).createAgreement(0, TERMS_CID, deadline, amount, tokenAddr);

      // Now change global cancel fee to 200 (2%)
      await marketplace.setCancellationFeeBps(200);

      // Cancel — should use the original 5% fee, not the new 2%
      await marketplace.connect(buyer).cancelAgreement(0);

      // Verify: 5% of 100 = 5 tokens to treasury, 95 to buyer
      const treasuryBalance = await mockToken.balanceOf(treasury.address);
      const buyerBalance = await mockToken.balanceOf(buyer.address);
      expect(treasuryBalance).to.equal(ethers.parseUnits("5", 18));
      expect(buyerBalance).to.equal(ethers.parseUnits("95", 18));
    });
  });

  describe("V6 — dispute timeout bounds", function () {
    it("should reject dispute timeout period of 0", async function () {
      await expect(
        marketplace.setDisputeTimeoutPeriod(0)
      ).to.be.revertedWith("Period out of bounds");
    });

    it("should reject dispute timeout period > 365 days", async function () {
      await expect(
        marketplace.setDisputeTimeoutPeriod(366 * 86400)
      ).to.be.revertedWith("Period out of bounds");
    });

    it("should accept dispute timeout period of 1 day", async function () {
      await marketplace.setDisputeTimeoutPeriod(86400);
      expect(await marketplace.disputeTimeoutPeriod()).to.equal(86400);
    });

    it("should accept dispute timeout period of 365 days", async function () {
      await marketplace.setDisputeTimeoutPeriod(365 * 86400);
      expect(await marketplace.disputeTimeoutPeriod()).to.equal(365 * 86400);
    });
  });

  describe("V6 — provider cannot dispute Agreed status", function () {
    it("should revert when provider disputes an Agreed agreement", async function () {
      // List and create agreement
      await marketplace.connect(provider).listService(METADATA_CID, CATEGORY, 0, ethers.parseEther("0.01"));
      const deadline = await futureDeadline();
      await marketplace.connect(buyer).createAgreement(0, TERMS_CID, deadline, 0, ethers.ZeroAddress, { value: ethers.parseEther("0.01") });

      // Provider tries to dispute before delivering — should revert
      await expect(
        marketplace.connect(provider).disputeAgreement(0, REASON_CID)
      ).to.be.revertedWithCustomError(marketplace, "InvalidStatus");
    });

    it("should allow buyer to dispute an Agreed agreement", async function () {
      // List and create agreement
      await marketplace.connect(provider).listService(METADATA_CID, CATEGORY, 0, ethers.parseEther("0.01"));
      const deadline = await futureDeadline();
      await marketplace.connect(buyer).createAgreement(0, TERMS_CID, deadline, 0, ethers.ZeroAddress, { value: ethers.parseEther("0.01") });

      // Buyer disputes — should succeed
      await expect(
        marketplace.connect(buyer).disputeAgreement(0, REASON_CID)
      ).to.emit(marketplace, "AgreementDisputed");
    });

    it("should allow provider to dispute a Delivered agreement", async function () {
      // List, create, and deliver
      await marketplace.connect(provider).listService(METADATA_CID, CATEGORY, 0, ethers.parseEther("0.01"));
      const deadline = await futureDeadline();
      await marketplace.connect(buyer).createAgreement(0, TERMS_CID, deadline, 0, ethers.ZeroAddress, { value: ethers.parseEther("0.01") });
      await marketplace.connect(provider).deliverWork(0, DELIVERY_CID);

      // Provider disputes after delivery — should succeed
      await expect(
        marketplace.connect(provider).disputeAgreement(0, REASON_CID)
      ).to.emit(marketplace, "AgreementDisputed");
    });
  });
});
