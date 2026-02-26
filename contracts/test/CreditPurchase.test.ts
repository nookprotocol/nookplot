import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { CreditPurchase, MockERC20 } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("CreditPurchase", function () {
  let creditPurchase: CreditPurchase;
  let usdc: MockERC20;
  let owner: SignerWithAddress;
  let treasury: SignerWithAddress;
  let buyer: SignerWithAddress;

  // Credit pack configuration (Micro $1, Standard $5, Bulk $20)
  const MICRO_USDC = 1_000_000n;       // $1 (6 decimals)
  const MICRO_CREDITS = 2500n;          // 25.00 display
  const STANDARD_USDC = 5_000_000n;     // $5
  const STANDARD_CREDITS = 14_000n;     // 140.00 display
  const BULK_USDC = 20_000_000n;        // $20
  const BULK_CREDITS = 65_000n;         // 650.00 display

  beforeEach(async function () {
    [owner, treasury, buyer] = await ethers.getSigners();

    // Deploy mock USDC (6 decimals in practice, but MockERC20 uses 18)
    const MockFactory = await ethers.getContractFactory("MockERC20");
    usdc = (await MockFactory.deploy("USD Coin", "USDC")) as unknown as MockERC20;
    await usdc.waitForDeployment();

    // Deploy CreditPurchase via UUPS proxy
    const CreditPurchaseFactory = await ethers.getContractFactory("CreditPurchase");
    creditPurchase = (await upgrades.deployProxy(
      CreditPurchaseFactory,
      [owner.address, await usdc.getAddress(), treasury.address],
      { kind: "uups" },
    )) as unknown as CreditPurchase;
    await creditPurchase.waitForDeployment();

    // Add three packs
    await creditPurchase.addPack("Micro", MICRO_USDC, MICRO_CREDITS);
    await creditPurchase.addPack("Standard", STANDARD_USDC, STANDARD_CREDITS);
    await creditPurchase.addPack("Bulk", BULK_USDC, BULK_CREDITS);

    // Give buyer some USDC
    await usdc.mint(buyer.address, 100_000_000n); // $100
  });

  // -------------------------------------------------------
  //  USDC Purchases
  // -------------------------------------------------------

  describe("purchaseWithUSDC", function () {
    it("should transfer USDC and emit CreditsPurchased", async function () {
      const contractAddr = await creditPurchase.getAddress();
      await usdc.connect(buyer).approve(contractAddr, MICRO_USDC);

      await expect(creditPurchase.connect(buyer).purchaseWithUSDC(0))
        .to.emit(creditPurchase, "CreditsPurchased")
        .withArgs(buyer.address, 0, MICRO_CREDITS, MICRO_USDC, (v: bigint) => v > 0);

      // Treasury should have received USDC
      expect(await usdc.balanceOf(treasury.address)).to.equal(MICRO_USDC);
    });

    it("should purchase Standard pack", async function () {
      const contractAddr = await creditPurchase.getAddress();
      await usdc.connect(buyer).approve(contractAddr, STANDARD_USDC);

      await expect(creditPurchase.connect(buyer).purchaseWithUSDC(1))
        .to.emit(creditPurchase, "CreditsPurchased")
        .withArgs(buyer.address, 1, STANDARD_CREDITS, STANDARD_USDC, (v: bigint) => v > 0);
    });

    it("should purchase Bulk pack", async function () {
      const contractAddr = await creditPurchase.getAddress();
      await usdc.connect(buyer).approve(contractAddr, BULK_USDC);

      await expect(creditPurchase.connect(buyer).purchaseWithUSDC(2))
        .to.emit(creditPurchase, "CreditsPurchased")
        .withArgs(buyer.address, 2, BULK_CREDITS, BULK_USDC, (v: bigint) => v > 0);
    });

    it("should revert on invalid pack ID", async function () {
      await expect(creditPurchase.connect(buyer).purchaseWithUSDC(99))
        .to.be.revertedWithCustomError(creditPurchase, "PackNotFound");
    });

    it("should revert on inactive pack", async function () {
      await creditPurchase.updatePackActive(0, false);
      const contractAddr = await creditPurchase.getAddress();
      await usdc.connect(buyer).approve(contractAddr, MICRO_USDC);

      await expect(creditPurchase.connect(buyer).purchaseWithUSDC(0))
        .to.be.revertedWithCustomError(creditPurchase, "PackInactive");
    });

    it("should revert if buyer has insufficient allowance", async function () {
      // No approval
      await expect(creditPurchase.connect(buyer).purchaseWithUSDC(0))
        .to.be.reverted;
    });
  });

  // -------------------------------------------------------
  //  Admin functions
  // -------------------------------------------------------

  describe("Admin", function () {
    it("should add a pack", async function () {
      await expect(creditPurchase.addPack("Premium", 50_000_000n, 200_000n))
        .to.emit(creditPurchase, "PackAdded")
        .withArgs(3, "Premium", 50_000_000n, 200_000n);

      expect(await creditPurchase.getPackCount()).to.equal(4);
    });

    it("should revert addPack with zero price", async function () {
      await expect(creditPurchase.addPack("Bad", 0, 100))
        .to.be.revertedWithCustomError(creditPurchase, "InvalidPackConfig");
    });

    it("should revert addPack with zero credits", async function () {
      await expect(creditPurchase.addPack("Bad", 1_000_000n, 0))
        .to.be.revertedWithCustomError(creditPurchase, "InvalidPackConfig");
    });

    it("should toggle pack active status", async function () {
      await creditPurchase.updatePackActive(0, false);
      const pack = await creditPurchase.getPack(0);
      expect(pack.active).to.be.false;

      await creditPurchase.updatePackActive(0, true);
      const pack2 = await creditPurchase.getPack(0);
      expect(pack2.active).to.be.true;
    });

    it("should update pack price", async function () {
      await creditPurchase.updatePackPrice(0, 2_000_000n);
      const pack = await creditPurchase.getPack(0);
      expect(pack.usdcPrice).to.equal(2_000_000n);
    });

    it("should only allow owner to add packs", async function () {
      await expect(creditPurchase.connect(buyer).addPack("Hack", 1, 1))
        .to.be.revertedWithCustomError(creditPurchase, "OwnableUnauthorizedAccount");
    });

    it("should set treasury", async function () {
      await creditPurchase.setTreasury(buyer.address);
      expect(await creditPurchase.treasury()).to.equal(buyer.address);
    });

    it("should revert setTreasury with zero address", async function () {
      await expect(creditPurchase.setTreasury(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(creditPurchase, "ZeroAddress");
    });
  });

  // -------------------------------------------------------
  //  Pausable
  // -------------------------------------------------------

  describe("Pausable", function () {
    it("should block purchases when paused", async function () {
      await creditPurchase.pause();

      const contractAddr = await creditPurchase.getAddress();
      await usdc.connect(buyer).approve(contractAddr, MICRO_USDC);

      await expect(creditPurchase.connect(buyer).purchaseWithUSDC(0))
        .to.be.revertedWithCustomError(creditPurchase, "EnforcedPause");
    });

    it("should allow purchases after unpause", async function () {
      await creditPurchase.pause();
      await creditPurchase.unpause();

      const contractAddr = await creditPurchase.getAddress();
      await usdc.connect(buyer).approve(contractAddr, MICRO_USDC);

      await expect(creditPurchase.connect(buyer).purchaseWithUSDC(0))
        .to.emit(creditPurchase, "CreditsPurchased");
    });
  });

  // -------------------------------------------------------
  //  View functions
  // -------------------------------------------------------

  describe("View", function () {
    it("should return active packs", async function () {
      await creditPurchase.updatePackActive(1, false);
      const [activePacks, ids] = await creditPurchase.getActivePacks();
      expect(activePacks.length).to.equal(2);
      expect(ids[0]).to.equal(0);
      expect(ids[1]).to.equal(2);
    });

    it("should return pack count", async function () {
      expect(await creditPurchase.getPackCount()).to.equal(3);
    });
  });
});
