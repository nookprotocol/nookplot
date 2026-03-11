import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { CreditPurchase, MockERC20 } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("CreditPurchase", function () {
  let creditPurchase: CreditPurchase;
  let usdc: MockERC20;
  let nookToken: MockERC20;
  let owner: SignerWithAddress;
  let treasury: SignerWithAddress;
  let feeDistributor: SignerWithAddress;
  let buyer: SignerWithAddress;

  // Pack config matching ECONOMICS.md
  const MICRO_USDC = 1_000_000n;       // $1 (6 decimals)
  const MICRO_CREDITS = 2500n;          // 25.00 display
  const STANDARD_USDC = 5_000_000n;     // $5
  const STANDARD_CREDITS = 14_000n;     // 140.00 display
  const BULK_USDC = 20_000_000n;        // $20
  const BULK_CREDITS = 65_000n;         // 650.00 display

  // NOOK prices (18 decimals) — discounted equivalents
  const MICRO_NOOK = ethers.parseEther("0.80");      // 20% discount
  const STANDARD_NOOK = ethers.parseEther("3.75");    // 25% discount
  const BULK_NOOK = ethers.parseEther("14.00");       // 30% discount

  beforeEach(async function () {
    [owner, treasury, feeDistributor, buyer] = await ethers.getSigners();

    // Deploy mock USDC (6 decimals in practice, but MockERC20 uses 18)
    const MockFactory = await ethers.getContractFactory("MockERC20");
    usdc = (await MockFactory.deploy("USD Coin", "USDC")) as unknown as MockERC20;
    await usdc.waitForDeployment();

    // Deploy mock NOOK token
    nookToken = (await MockFactory.deploy("Nookplot", "NOOK")) as unknown as MockERC20;
    await nookToken.waitForDeployment();

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

    // Configure NOOK on contract
    await creditPurchase.setNookToken(await nookToken.getAddress());
    await creditPurchase.setFeeDistributor(feeDistributor.address);
    await creditPurchase.setNookPrice(0, MICRO_NOOK);
    await creditPurchase.setNookPrice(1, STANDARD_NOOK);
    await creditPurchase.setNookPrice(2, BULK_NOOK);

    // Give buyer some NOOK
    await nookToken.mint(buyer.address, ethers.parseEther("1000"));
  });

  // -------------------------------------------------------
  //  USDC Purchases
  // -------------------------------------------------------

  describe("purchaseWithUSDC", function () {
    it("should transfer USDC and emit CreditsPurchased with isNook=false", async function () {
      const contractAddr = await creditPurchase.getAddress();
      await usdc.connect(buyer).approve(contractAddr, MICRO_USDC);

      await expect(creditPurchase.connect(buyer).purchaseWithUSDC(0))
        .to.emit(creditPurchase, "CreditsPurchased")
        .withArgs(buyer.address, 0, MICRO_CREDITS, MICRO_USDC, false, (v: bigint) => v > 0);

      // Treasury should have received USDC
      expect(await usdc.balanceOf(treasury.address)).to.equal(MICRO_USDC);
    });

    it("should purchase Standard pack", async function () {
      const contractAddr = await creditPurchase.getAddress();
      await usdc.connect(buyer).approve(contractAddr, STANDARD_USDC);

      await expect(creditPurchase.connect(buyer).purchaseWithUSDC(1))
        .to.emit(creditPurchase, "CreditsPurchased")
        .withArgs(buyer.address, 1, STANDARD_CREDITS, STANDARD_USDC, false, (v: bigint) => v > 0);
    });

    it("should purchase Bulk pack", async function () {
      const contractAddr = await creditPurchase.getAddress();
      await usdc.connect(buyer).approve(contractAddr, BULK_USDC);

      await expect(creditPurchase.connect(buyer).purchaseWithUSDC(2))
        .to.emit(creditPurchase, "CreditsPurchased")
        .withArgs(buyer.address, 2, BULK_CREDITS, BULK_USDC, false, (v: bigint) => v > 0);
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
  //  NOOK Purchases
  // -------------------------------------------------------

  describe("purchaseWithNook", function () {
    beforeEach(async function () {
      // Enable NOOK purchases for these tests
      await creditPurchase.setNookEnabled(true);
    });

    it("should purchase Micro pack with NOOK and send to feeDistributor", async function () {
      const contractAddr = await creditPurchase.getAddress();
      await nookToken.connect(buyer).approve(contractAddr, MICRO_NOOK);

      await expect(creditPurchase.connect(buyer).purchaseWithNook(0))
        .to.emit(creditPurchase, "CreditsPurchased")
        .withArgs(buyer.address, 0, MICRO_CREDITS, MICRO_NOOK, true, (v: bigint) => v > 0);

      // FeeDistributor should have received NOOK (not treasury)
      expect(await nookToken.balanceOf(feeDistributor.address)).to.equal(MICRO_NOOK);
      expect(await nookToken.balanceOf(treasury.address)).to.equal(0);
    });

    it("should purchase Standard pack with NOOK", async function () {
      const contractAddr = await creditPurchase.getAddress();
      await nookToken.connect(buyer).approve(contractAddr, STANDARD_NOOK);

      await expect(creditPurchase.connect(buyer).purchaseWithNook(1))
        .to.emit(creditPurchase, "CreditsPurchased")
        .withArgs(buyer.address, 1, STANDARD_CREDITS, STANDARD_NOOK, true, (v: bigint) => v > 0);

      expect(await nookToken.balanceOf(feeDistributor.address)).to.equal(STANDARD_NOOK);
    });

    it("should purchase Bulk pack with NOOK", async function () {
      const contractAddr = await creditPurchase.getAddress();
      await nookToken.connect(buyer).approve(contractAddr, BULK_NOOK);

      await expect(creditPurchase.connect(buyer).purchaseWithNook(2))
        .to.emit(creditPurchase, "CreditsPurchased")
        .withArgs(buyer.address, 2, BULK_CREDITS, BULK_NOOK, true, (v: bigint) => v > 0);

      expect(await nookToken.balanceOf(feeDistributor.address)).to.equal(BULK_NOOK);
    });

    it("should revert when NOOK is disabled", async function () {
      await creditPurchase.setNookEnabled(false);
      const contractAddr = await creditPurchase.getAddress();
      await nookToken.connect(buyer).approve(contractAddr, MICRO_NOOK);

      await expect(creditPurchase.connect(buyer).purchaseWithNook(0))
        .to.be.revertedWithCustomError(creditPurchase, "NookNotEnabled");
    });

    it("should revert when NOOK token not configured", async function () {
      // Deploy a fresh contract without NOOK configured
      const CreditPurchaseFactory = await ethers.getContractFactory("CreditPurchase");
      const fresh = (await upgrades.deployProxy(
        CreditPurchaseFactory,
        [owner.address, await usdc.getAddress(), treasury.address],
        { kind: "uups" },
      )) as unknown as CreditPurchase;
      await fresh.addPack("Micro", MICRO_USDC, MICRO_CREDITS);
      await fresh.setNookEnabled(true);

      await expect(fresh.connect(buyer).purchaseWithNook(0))
        .to.be.revertedWithCustomError(fresh, "NookNotEnabled");
    });

    it("should revert when feeDistributor not configured", async function () {
      const CreditPurchaseFactory = await ethers.getContractFactory("CreditPurchase");
      const fresh = (await upgrades.deployProxy(
        CreditPurchaseFactory,
        [owner.address, await usdc.getAddress(), treasury.address],
        { kind: "uups" },
      )) as unknown as CreditPurchase;
      await fresh.addPack("Micro", MICRO_USDC, MICRO_CREDITS);
      await fresh.setNookToken(await nookToken.getAddress());
      await fresh.setNookEnabled(true);

      await expect(fresh.connect(buyer).purchaseWithNook(0))
        .to.be.revertedWithCustomError(fresh, "FeeDistributorNotSet");
    });

    it("should revert on invalid pack ID", async function () {
      await expect(creditPurchase.connect(buyer).purchaseWithNook(99))
        .to.be.revertedWithCustomError(creditPurchase, "PackNotFound");
    });

    it("should revert on inactive pack", async function () {
      await creditPurchase.updatePackActive(0, false);
      const contractAddr = await creditPurchase.getAddress();
      await nookToken.connect(buyer).approve(contractAddr, MICRO_NOOK);

      await expect(creditPurchase.connect(buyer).purchaseWithNook(0))
        .to.be.revertedWithCustomError(creditPurchase, "PackInactive");
    });

    it("should revert when NOOK price not set for pack", async function () {
      // Add a new pack without setting NOOK price
      await creditPurchase.addPack("Premium", 50_000_000n, 200_000n);
      const contractAddr = await creditPurchase.getAddress();
      await nookToken.connect(buyer).approve(contractAddr, ethers.parseEther("100"));

      await expect(creditPurchase.connect(buyer).purchaseWithNook(3))
        .to.be.revertedWithCustomError(creditPurchase, "NookPriceNotSet");
    });

    it("should revert when paused", async function () {
      await creditPurchase.pause();
      const contractAddr = await creditPurchase.getAddress();
      await nookToken.connect(buyer).approve(contractAddr, MICRO_NOOK);

      await expect(creditPurchase.connect(buyer).purchaseWithNook(0))
        .to.be.revertedWithCustomError(creditPurchase, "EnforcedPause");
    });

    it("should revert if buyer has insufficient NOOK allowance", async function () {
      // No approval
      await expect(creditPurchase.connect(buyer).purchaseWithNook(0))
        .to.be.reverted;
    });
  });

  // -------------------------------------------------------
  //  NOOK Config (admin setters)
  // -------------------------------------------------------

  describe("NOOK Config", function () {
    it("should set NOOK token address", async function () {
      const addr = await nookToken.getAddress();
      expect(await creditPurchase.nook()).to.equal(addr);
    });

    it("should revert setNookToken with zero address", async function () {
      await expect(creditPurchase.setNookToken(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(creditPurchase, "ZeroAddress");
    });

    it("should only allow admin to set NOOK token", async function () {
      await expect(creditPurchase.connect(buyer).setNookToken(buyer.address))
        .to.be.revertedWithCustomError(creditPurchase, "OwnableUnauthorizedAccount")
        .withArgs(buyer.address);
    });

    it("should set feeDistributor address", async function () {
      expect(await creditPurchase.feeDistributor()).to.equal(feeDistributor.address);
    });

    it("should revert setFeeDistributor with zero address", async function () {
      await expect(creditPurchase.setFeeDistributor(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(creditPurchase, "ZeroAddress");
    });

    it("should only allow admin to set feeDistributor", async function () {
      await expect(creditPurchase.connect(buyer).setFeeDistributor(buyer.address))
        .to.be.revertedWithCustomError(creditPurchase, "OwnableUnauthorizedAccount")
        .withArgs(buyer.address);
    });

    it("should toggle nookEnabled", async function () {
      expect(await creditPurchase.nookEnabled()).to.be.false;
      await creditPurchase.setNookEnabled(true);
      expect(await creditPurchase.nookEnabled()).to.be.true;
      await creditPurchase.setNookEnabled(false);
      expect(await creditPurchase.nookEnabled()).to.be.false;
    });

    it("should only allow admin to toggle nookEnabled", async function () {
      await expect(creditPurchase.connect(buyer).setNookEnabled(true))
        .to.be.revertedWithCustomError(creditPurchase, "OwnableUnauthorizedAccount")
        .withArgs(buyer.address);
    });

    it("should set NOOK price for a pack", async function () {
      const price = ethers.parseEther("5.0");
      await creditPurchase.setNookPrice(0, price);
      expect(await creditPurchase.getNookPrice(0)).to.equal(price);
    });

    it("should revert setNookPrice for invalid pack", async function () {
      await expect(creditPurchase.setNookPrice(99, ethers.parseEther("1.0")))
        .to.be.revertedWithCustomError(creditPurchase, "PackNotFound");
    });

    it("should only allow admin to set NOOK price", async function () {
      await expect(creditPurchase.connect(buyer).setNookPrice(0, 1n))
        .to.be.revertedWithCustomError(creditPurchase, "OwnableUnauthorizedAccount")
        .withArgs(buyer.address);
    });
  });

  // -------------------------------------------------------
  //  Admin functions (existing)
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

    it("should only allow admin to add packs", async function () {
      await expect(creditPurchase.connect(buyer).addPack("Hack", 1, 1))
        .to.be.revertedWithCustomError(creditPurchase, "OwnableUnauthorizedAccount")
        .withArgs(buyer.address);
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
    it("should block USDC purchases when paused", async function () {
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

    it("should revert pause() from non-owner", async function () {
      await expect(creditPurchase.connect(buyer).pause())
        .to.be.revertedWithCustomError(creditPurchase, "OwnableUnauthorizedAccount")
        .withArgs(buyer.address);
    });

    it("should revert unpause() from non-owner", async function () {
      await creditPurchase.pause();
      await expect(creditPurchase.connect(buyer).unpause())
        .to.be.revertedWithCustomError(creditPurchase, "OwnableUnauthorizedAccount")
        .withArgs(buyer.address);
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

    it("should return NOOK price for each pack", async function () {
      expect(await creditPurchase.getNookPrice(0)).to.equal(MICRO_NOOK);
      expect(await creditPurchase.getNookPrice(1)).to.equal(STANDARD_NOOK);
      expect(await creditPurchase.getNookPrice(2)).to.equal(BULK_NOOK);
    });

    it("should revert getNookPrice for invalid pack", async function () {
      await expect(creditPurchase.getNookPrice(99))
        .to.be.revertedWithCustomError(creditPurchase, "PackNotFound");
    });
  });

  // -------------------------------------------------------
  //  Backward compatibility
  // -------------------------------------------------------

  describe("Backward compatibility", function () {
    it("USDC purchases still work after NOOK config", async function () {
      await creditPurchase.setNookEnabled(true);
      const contractAddr = await creditPurchase.getAddress();
      await usdc.connect(buyer).approve(contractAddr, MICRO_USDC);

      await expect(creditPurchase.connect(buyer).purchaseWithUSDC(0))
        .to.emit(creditPurchase, "CreditsPurchased")
        .withArgs(buyer.address, 0, MICRO_CREDITS, MICRO_USDC, false, (v: bigint) => v > 0);

      // USDC goes to treasury, not feeDistributor
      expect(await usdc.balanceOf(treasury.address)).to.equal(MICRO_USDC);
      expect(await usdc.balanceOf(feeDistributor.address)).to.equal(0);
    });

    it("USDC and NOOK purchases work independently", async function () {
      await creditPurchase.setNookEnabled(true);
      const contractAddr = await creditPurchase.getAddress();

      // Buy Micro with USDC
      await usdc.connect(buyer).approve(contractAddr, MICRO_USDC);
      await creditPurchase.connect(buyer).purchaseWithUSDC(0);

      // Buy Standard with NOOK
      await nookToken.connect(buyer).approve(contractAddr, STANDARD_NOOK);
      await creditPurchase.connect(buyer).purchaseWithNook(1);

      // Verify correct routing
      expect(await usdc.balanceOf(treasury.address)).to.equal(MICRO_USDC);
      expect(await nookToken.balanceOf(feeDistributor.address)).to.equal(STANDARD_NOOK);
    });
  });

  // -------------------------------------------------------
  //  UUPS Upgrade
  // -------------------------------------------------------

  describe("UUPS Upgrade", function () {
    it("should preserve packs and NOOK config after upgrade", async function () {
      await creditPurchase.setNookEnabled(true);

      // Perform upgrade (to same implementation — verifies no storage corruption)
      const CreditPurchaseFactory = await ethers.getContractFactory("CreditPurchase");
      const upgraded = (await upgrades.upgradeProxy(
        await creditPurchase.getAddress(),
        CreditPurchaseFactory,
      )) as unknown as CreditPurchase;

      // Existing packs preserved
      expect(await upgraded.getPackCount()).to.equal(3);
      const pack0 = await upgraded.getPack(0);
      expect(pack0.name).to.equal("Micro");
      expect(pack0.usdcPrice).to.equal(MICRO_USDC);

      // NOOK config preserved
      expect(await upgraded.nookEnabled()).to.be.true;
      expect(await upgraded.nook()).to.equal(await nookToken.getAddress());
      expect(await upgraded.feeDistributor()).to.equal(feeDistributor.address);
      expect(await upgraded.getNookPrice(0)).to.equal(MICRO_NOOK);
    });
  });

  // -------------------------------------------------------
  //  Emergency Withdraw
  // -------------------------------------------------------
  describe("Emergency Withdraw", function () {
    it("emergencyWithdraw works for admin", async function () {
      // Send some tokens to the contract directly
      const amount = 50_000_000n;
      await usdc.mint(await creditPurchase.getAddress(), amount);

      const balanceBefore = await usdc.balanceOf(owner.address);

      await expect(
        creditPurchase.connect(owner).emergencyWithdraw(
          await usdc.getAddress(),
          owner.address,
          amount
        )
      ).to.emit(creditPurchase, "EmergencyWithdraw")
        .withArgs(await usdc.getAddress(), owner.address, amount);

      const balanceAfter = await usdc.balanceOf(owner.address);
      expect(balanceAfter - balanceBefore).to.equal(amount);
    });

    it("emergencyWithdraw reverts for non-admin", async function () {
      await expect(
        creditPurchase.connect(buyer).emergencyWithdraw(
          await usdc.getAddress(),
          buyer.address,
          100
        )
      ).to.be.revertedWithCustomError(
        creditPurchase,
        "OwnableUnauthorizedAccount"
      ).withArgs(buyer.address);
    });

    it("emergencyWithdraw reverts with ZeroAmount", async function () {
      await expect(
        creditPurchase.connect(owner).emergencyWithdraw(
          await usdc.getAddress(),
          owner.address,
          0
        )
      ).to.be.revertedWithCustomError(creditPurchase, "ZeroAmount");
    });

    it("emergencyWithdraw reverts with ZeroAddress recipient", async function () {
      await expect(
        creditPurchase.connect(owner).emergencyWithdraw(
          await usdc.getAddress(),
          ethers.ZeroAddress,
          100
        )
      ).to.be.revertedWithCustomError(creditPurchase, "ZeroAddress");
    });

    it("rescueETH reverts for non-admin", async function () {
      await expect(
        creditPurchase.connect(buyer).rescueETH(buyer.address, 100)
      ).to.be.revertedWithCustomError(
        creditPurchase,
        "OwnableUnauthorizedAccount"
      ).withArgs(buyer.address);
    });

    it("rescueETH reverts with ZeroAmount", async function () {
      await expect(
        creditPurchase.connect(owner).rescueETH(owner.address, 0)
      ).to.be.revertedWithCustomError(creditPurchase, "ZeroAmount");
    });

    it("rescueETH reverts with ZeroAddress recipient", async function () {
      await expect(
        creditPurchase.connect(owner).rescueETH(ethers.ZeroAddress, 100)
      ).to.be.revertedWithCustomError(creditPurchase, "ZeroAddress");
    });
  });
});
