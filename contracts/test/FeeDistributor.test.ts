import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { FeeDistributor, MockERC20 } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("FeeDistributor", function () {
  let distributor: FeeDistributor;
  let weth: MockERC20;
  let nook: MockERC20;
  let admin: SignerWithAddress;
  let operator: SignerWithAddress;
  let guardian: SignerWithAddress;
  let rdWallet: SignerWithAddress;
  let buybackWallet: SignerWithAddress;
  let ecosystemWallet: SignerWithAddress;
  let agentRewardPool: SignerWithAddress;
  let citationPool: SignerWithAddress;
  let other: SignerWithAddress;

  const WETH_SUPPLY = ethers.parseEther("1000");
  const NOOK_SUPPLY = ethers.parseEther("1000000");

  const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
  const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"));
  const GUARDIAN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GUARDIAN_ROLE"));

  beforeEach(async function () {
    [admin, operator, guardian, rdWallet, buybackWallet, ecosystemWallet, agentRewardPool, citationPool, other] =
      await ethers.getSigners();

    // Deploy mock tokens
    const MockFactory = await ethers.getContractFactory("MockERC20");
    weth = (await MockFactory.deploy("Wrapped ETH", "WETH")) as unknown as MockERC20;
    await weth.waitForDeployment();
    nook = (await MockFactory.deploy("Nook Token", "NOOK")) as unknown as MockERC20;
    await nook.waitForDeployment();

    // Deploy FeeDistributor via UUPS proxy
    const DistributorFactory = await ethers.getContractFactory("FeeDistributor");
    distributor = (await upgrades.deployProxy(
      DistributorFactory,
      [
        admin.address,
        await weth.getAddress(),
        await nook.getAddress(),
        rdWallet.address,
        buybackWallet.address,
        ecosystemWallet.address,
      ],
      { kind: "uups" },
    )) as unknown as FeeDistributor;
    await distributor.waitForDeployment();

    // Initialize V2 with roles
    await distributor.initializeV2(admin.address, operator.address, guardian.address);

    // Wire pools (admin has DEFAULT_ADMIN_ROLE)
    await distributor.connect(admin).setAgentRewardPool(agentRewardPool.address);
    await distributor.connect(admin).setCitationPool(citationPool.address);

    // Fund the distributor
    const distributorAddr = await distributor.getAddress();
    await weth.mint(distributorAddr, WETH_SUPPLY);
    await nook.mint(distributorAddr, NOOK_SUPPLY);
  });

  // -------------------------------------------------------
  //  Initialization
  // -------------------------------------------------------

  describe("Initialization", function () {
    it("should set correct token addresses", async function () {
      expect(await distributor.weth()).to.equal(await weth.getAddress());
      expect(await distributor.nook()).to.equal(await nook.getAddress());
    });

    it("should set correct wallet addresses", async function () {
      expect(await distributor.rdWallet()).to.equal(rdWallet.address);
      expect(await distributor.buybackWallet()).to.equal(buybackWallet.address);
      expect(await distributor.ecosystemWallet()).to.equal(ecosystemWallet.address);
    });

    it("should set correct pool addresses", async function () {
      expect(await distributor.agentRewardPool()).to.equal(agentRewardPool.address);
      expect(await distributor.citationPool()).to.equal(citationPool.address);
    });

    it("should set default wETH splits", async function () {
      expect(await distributor.rdBps()).to.equal(5000);
      expect(await distributor.buybackBps()).to.equal(3000);
      expect(await distributor.agentRewardBps()).to.equal(2000);
    });

    it("should set default NOOK splits", async function () {
      expect(await distributor.citationBps()).to.equal(4000);
      expect(await distributor.ecosystemBps()).to.equal(6000);
    });

    it("should have set minDistributionAmount", async function () {
      expect(await distributor.minDistributionAmount()).to.equal(1000000000000n); // 1e12
    });

    it("should revert with zero owner", async function () {
      const F = await ethers.getContractFactory("FeeDistributor");
      await expect(
        upgrades.deployProxy(F, [
          ethers.ZeroAddress,
          await weth.getAddress(),
          await nook.getAddress(),
          rdWallet.address,
          buybackWallet.address,
          ecosystemWallet.address,
        ], { kind: "uups" }),
      ).to.be.revertedWithCustomError(distributor, "ZeroAddress");
    });

    it("should revert with zero weth", async function () {
      const F = await ethers.getContractFactory("FeeDistributor");
      await expect(
        upgrades.deployProxy(F, [
          admin.address,
          ethers.ZeroAddress,
          await nook.getAddress(),
          rdWallet.address,
          buybackWallet.address,
          ecosystemWallet.address,
        ], { kind: "uups" }),
      ).to.be.revertedWithCustomError(distributor, "ZeroAddress");
    });

    it("should revert with zero nook", async function () {
      const F = await ethers.getContractFactory("FeeDistributor");
      await expect(
        upgrades.deployProxy(F, [
          admin.address,
          await weth.getAddress(),
          ethers.ZeroAddress,
          rdWallet.address,
          buybackWallet.address,
          ecosystemWallet.address,
        ], { kind: "uups" }),
      ).to.be.revertedWithCustomError(distributor, "ZeroAddress");
    });

    it("should not allow initializeV2 to be called twice", async function () {
      await expect(
        distributor.initializeV2(admin.address, operator.address, guardian.address),
      ).to.be.revertedWithCustomError(distributor, "InvalidInitialization");
    });
  });

  // -------------------------------------------------------
  //  Role Management
  // -------------------------------------------------------

  describe("Role Management", function () {
    it("should have granted DEFAULT_ADMIN_ROLE to admin", async function () {
      expect(await distributor.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
    });

    it("should have granted OPERATOR_ROLE to operator", async function () {
      expect(await distributor.hasRole(OPERATOR_ROLE, operator.address)).to.be.true;
    });

    it("should have granted GUARDIAN_ROLE to guardian", async function () {
      expect(await distributor.hasRole(GUARDIAN_ROLE, guardian.address)).to.be.true;
    });

    it("should allow admin to grant OPERATOR_ROLE", async function () {
      await distributor.connect(admin).grantRole(OPERATOR_ROLE, other.address);
      expect(await distributor.hasRole(OPERATOR_ROLE, other.address)).to.be.true;
    });

    it("should allow admin to revoke OPERATOR_ROLE", async function () {
      await distributor.connect(admin).revokeRole(OPERATOR_ROLE, operator.address);
      expect(await distributor.hasRole(OPERATOR_ROLE, operator.address)).to.be.false;
    });

    it("should not allow non-admin to grant roles", async function () {
      await expect(
        distributor.connect(other).grantRole(OPERATOR_ROLE, other.address),
      ).to.be.revertedWithCustomError(distributor, "AccessControlUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------
  //  wETH Distribution
  // -------------------------------------------------------

  describe("distributeWeth", function () {
    it("should split wETH correctly (50/30/20)", async function () {
      const amount = ethers.parseEther("100");
      await expect(distributor.connect(operator).distributeWeth(amount))
        .to.emit(distributor, "WethDistributed")
        .withArgs(
          amount,
          ethers.parseEther("50"),  // 50%
          ethers.parseEther("30"),  // 30%
          ethers.parseEther("20"),  // 20%
          (v: bigint) => v > 0,
        );

      expect(await weth.balanceOf(rdWallet.address)).to.equal(ethers.parseEther("50"));
      expect(await weth.balanceOf(buybackWallet.address)).to.equal(ethers.parseEther("30"));
      expect(await weth.balanceOf(agentRewardPool.address)).to.equal(ethers.parseEther("20"));
    });

    it("should handle odd amounts without dust loss", async function () {
      const amount = ethers.parseEther("33");
      await distributor.connect(operator).distributeWeth(amount);

      const rdBal = await weth.balanceOf(rdWallet.address);
      const bbBal = await weth.balanceOf(buybackWallet.address);
      const rpBal = await weth.balanceOf(agentRewardPool.address);

      // Sum must equal total (no dust lost)
      expect(rdBal + bbBal + rpBal).to.equal(amount);
    });

    it("should update totalWethDistributed", async function () {
      const amount = ethers.parseEther("100");
      await distributor.connect(operator).distributeWeth(amount);
      expect(await distributor.totalWethDistributed()).to.equal(amount);

      await distributor.connect(operator).distributeWeth(amount);
      expect(await distributor.totalWethDistributed()).to.equal(amount * 2n);
    });

    it("should revert with zero amount", async function () {
      await expect(distributor.connect(operator).distributeWeth(0))
        .to.be.revertedWithCustomError(distributor, "ZeroAmount");
    });

    it("should revert below minimum distribution amount", async function () {
      await expect(distributor.connect(operator).distributeWeth(100n))
        .to.be.revertedWithCustomError(distributor, "BelowMinimum");
    });

    it("should revert if agentRewardPool not set", async function () {
      // Deploy fresh without setting pool
      const F = await ethers.getContractFactory("FeeDistributor");
      const fresh = (await upgrades.deployProxy(F, [
        admin.address,
        await weth.getAddress(),
        await nook.getAddress(),
        rdWallet.address,
        buybackWallet.address,
        ecosystemWallet.address,
      ], { kind: "uups" })) as unknown as FeeDistributor;
      await fresh.waitForDeployment();
      await fresh.initializeV2(admin.address, operator.address, guardian.address);

      // Fund it
      await weth.mint(await fresh.getAddress(), WETH_SUPPLY);

      await expect(fresh.connect(operator).distributeWeth(ethers.parseEther("100")))
        .to.be.revertedWithCustomError(fresh, "PoolNotSet");
    });

    it("should revert when paused", async function () {
      await distributor.connect(guardian).pause();
      await expect(distributor.connect(operator).distributeWeth(ethers.parseEther("100")))
        .to.be.revertedWithCustomError(distributor, "EnforcedPause");
    });

    it("should revert if non-operator calls", async function () {
      await expect(distributor.connect(other).distributeWeth(ethers.parseEther("100")))
        .to.be.revertedWithCustomError(distributor, "AccessControlUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------
  //  NOOK Distribution
  // -------------------------------------------------------

  describe("distributeNook", function () {
    it("should split NOOK correctly (40/60)", async function () {
      const amount = ethers.parseEther("1000");
      await expect(distributor.connect(operator).distributeNook(amount))
        .to.emit(distributor, "NookDistributed")
        .withArgs(
          amount,
          ethers.parseEther("400"),  // 40%
          ethers.parseEther("600"),  // 60%
          (v: bigint) => v > 0,
        );

      expect(await nook.balanceOf(citationPool.address)).to.equal(ethers.parseEther("400"));
      expect(await nook.balanceOf(ecosystemWallet.address)).to.equal(ethers.parseEther("600"));
    });

    it("should handle odd amounts without dust loss", async function () {
      const amount = ethers.parseEther("33");
      await distributor.connect(operator).distributeNook(amount);

      const cpBal = await nook.balanceOf(citationPool.address);
      const ewBal = await nook.balanceOf(ecosystemWallet.address);

      expect(cpBal + ewBal).to.equal(amount);
    });

    it("should update totalNookDistributed", async function () {
      const amount = ethers.parseEther("1000");
      await distributor.connect(operator).distributeNook(amount);
      expect(await distributor.totalNookDistributed()).to.equal(amount);
    });

    it("should revert with zero amount", async function () {
      await expect(distributor.connect(operator).distributeNook(0))
        .to.be.revertedWithCustomError(distributor, "ZeroAmount");
    });

    it("should revert below minimum distribution amount", async function () {
      await expect(distributor.connect(operator).distributeNook(100n))
        .to.be.revertedWithCustomError(distributor, "BelowMinimum");
    });

    it("should revert if citationPool not set", async function () {
      const F = await ethers.getContractFactory("FeeDistributor");
      const fresh = (await upgrades.deployProxy(F, [
        admin.address,
        await weth.getAddress(),
        await nook.getAddress(),
        rdWallet.address,
        buybackWallet.address,
        ecosystemWallet.address,
      ], { kind: "uups" })) as unknown as FeeDistributor;
      await fresh.waitForDeployment();
      await fresh.initializeV2(admin.address, operator.address, guardian.address);

      await nook.mint(await fresh.getAddress(), NOOK_SUPPLY);

      await expect(fresh.connect(operator).distributeNook(ethers.parseEther("100")))
        .to.be.revertedWithCustomError(fresh, "PoolNotSet");
    });

    it("should revert when paused", async function () {
      await distributor.connect(guardian).pause();
      await expect(distributor.connect(operator).distributeNook(ethers.parseEther("100")))
        .to.be.revertedWithCustomError(distributor, "EnforcedPause");
    });

    it("should revert if non-operator calls", async function () {
      await expect(distributor.connect(other).distributeNook(ethers.parseEther("100")))
        .to.be.revertedWithCustomError(distributor, "AccessControlUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------
  //  distributeAll
  // -------------------------------------------------------

  describe("distributeAll", function () {
    it("should distribute all wETH and NOOK", async function () {
      await distributor.connect(operator).distributeAll();

      // wETH fully distributed
      expect(await weth.balanceOf(await distributor.getAddress())).to.equal(0);
      const rdBal = await weth.balanceOf(rdWallet.address);
      const bbBal = await weth.balanceOf(buybackWallet.address);
      const rpBal = await weth.balanceOf(agentRewardPool.address);
      expect(rdBal + bbBal + rpBal).to.equal(WETH_SUPPLY);

      // NOOK fully distributed
      expect(await nook.balanceOf(await distributor.getAddress())).to.equal(0);
      const cpBal = await nook.balanceOf(citationPool.address);
      const ewBal = await nook.balanceOf(ecosystemWallet.address);
      expect(cpBal + ewBal).to.equal(NOOK_SUPPLY);
    });

    it("should handle zero wETH balance gracefully", async function () {
      // Empty the wETH
      await distributor.connect(admin).emergencyWithdraw(await weth.getAddress(), admin.address, WETH_SUPPLY);

      // Should still distribute NOOK
      await distributor.connect(operator).distributeAll();
      const cpBal = await nook.balanceOf(citationPool.address);
      const ewBal = await nook.balanceOf(ecosystemWallet.address);
      expect(cpBal + ewBal).to.equal(NOOK_SUPPLY);
    });

    it("should handle zero NOOK balance gracefully", async function () {
      await distributor.connect(admin).emergencyWithdraw(await nook.getAddress(), admin.address, NOOK_SUPPLY);

      await distributor.connect(operator).distributeAll();
      const rdBal = await weth.balanceOf(rdWallet.address);
      const bbBal = await weth.balanceOf(buybackWallet.address);
      const rpBal = await weth.balanceOf(agentRewardPool.address);
      expect(rdBal + bbBal + rpBal).to.equal(WETH_SUPPLY);
    });

    it("should handle both zero balances gracefully", async function () {
      await distributor.connect(admin).emergencyWithdraw(await weth.getAddress(), admin.address, WETH_SUPPLY);
      await distributor.connect(admin).emergencyWithdraw(await nook.getAddress(), admin.address, NOOK_SUPPLY);

      // Should not revert — just noop
      await expect(distributor.connect(operator).distributeAll()).to.not.be.reverted;
    });

    it("should skip distribution when balance is below minDistributionAmount", async function () {
      // Empty both balances
      await distributor.connect(admin).emergencyWithdraw(await weth.getAddress(), admin.address, WETH_SUPPLY);
      await distributor.connect(admin).emergencyWithdraw(await nook.getAddress(), admin.address, NOOK_SUPPLY);

      // Fund with dust (below 1e12 minimum)
      const dustAmount = 100n;
      const distributorAddr = await distributor.getAddress();
      await weth.mint(distributorAddr, dustAmount);
      await nook.mint(distributorAddr, dustAmount);

      // distributeAll should noop — dust stays in contract
      await distributor.connect(operator).distributeAll();
      expect(await distributor.wethBalance()).to.equal(dustAmount);
      expect(await distributor.nookBalance()).to.equal(dustAmount);
      expect(await distributor.totalWethDistributed()).to.equal(0);
      expect(await distributor.totalNookDistributed()).to.equal(0);
    });

    it("should emit events for both distributions", async function () {
      const tx = await distributor.connect(operator).distributeAll();
      const receipt = await tx.wait();

      // Should have both WethDistributed and NookDistributed events
      const wethEvents = receipt!.logs.filter((log) => {
        try {
          return distributor.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "WethDistributed";
        } catch { return false; }
      });
      const nookEvents = receipt!.logs.filter((log) => {
        try {
          return distributor.interface.parseLog({ topics: [...log.topics], data: log.data })?.name === "NookDistributed";
        } catch { return false; }
      });

      expect(wethEvents.length).to.equal(1);
      expect(nookEvents.length).to.equal(1);
    });

    it("should revert when paused", async function () {
      await distributor.connect(guardian).pause();
      await expect(distributor.connect(operator).distributeAll())
        .to.be.revertedWithCustomError(distributor, "EnforcedPause");
    });

    it("should revert if non-operator calls", async function () {
      await expect(distributor.connect(other).distributeAll())
        .to.be.revertedWithCustomError(distributor, "AccessControlUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------
  //  Split Configuration
  // -------------------------------------------------------

  describe("Split Configuration", function () {
    it("should update wETH split", async function () {
      await expect(distributor.connect(admin).setWethSplit(6000, 2000, 2000))
        .to.emit(distributor, "WethSplitUpdated")
        .withArgs(6000, 2000, 2000);

      expect(await distributor.rdBps()).to.equal(6000);
      expect(await distributor.buybackBps()).to.equal(2000);
      expect(await distributor.agentRewardBps()).to.equal(2000);
    });

    it("should update NOOK split", async function () {
      await expect(distributor.connect(admin).setNookSplit(5000, 5000))
        .to.emit(distributor, "NookSplitUpdated")
        .withArgs(5000, 5000);

      expect(await distributor.citationBps()).to.equal(5000);
      expect(await distributor.ecosystemBps()).to.equal(5000);
    });

    it("should revert wETH split not summing to 10000", async function () {
      await expect(distributor.connect(admin).setWethSplit(5000, 3000, 1000))
        .to.be.revertedWithCustomError(distributor, "InvalidSplit");
    });

    it("should revert NOOK split not summing to 10000", async function () {
      await expect(distributor.connect(admin).setNookSplit(5000, 4000))
        .to.be.revertedWithCustomError(distributor, "InvalidSplit");
    });

    it("should only allow admin to set wETH split", async function () {
      await expect(distributor.connect(other).setWethSplit(5000, 3000, 2000))
        .to.be.revertedWithCustomError(distributor, "AccessControlUnauthorizedAccount");
    });

    it("should not allow operator to set wETH split", async function () {
      await expect(distributor.connect(operator).setWethSplit(5000, 3000, 2000))
        .to.be.revertedWithCustomError(distributor, "AccessControlUnauthorizedAccount");
    });

    it("should only allow admin to set NOOK split", async function () {
      await expect(distributor.connect(other).setNookSplit(5000, 5000))
        .to.be.revertedWithCustomError(distributor, "AccessControlUnauthorizedAccount");
    });

    it("should use updated split for next distribution", async function () {
      await distributor.connect(admin).setWethSplit(8000, 1000, 1000);

      const amount = ethers.parseEther("100");
      await distributor.connect(operator).distributeWeth(amount);

      expect(await weth.balanceOf(rdWallet.address)).to.equal(ethers.parseEther("80"));
      expect(await weth.balanceOf(buybackWallet.address)).to.equal(ethers.parseEther("10"));
      expect(await weth.balanceOf(agentRewardPool.address)).to.equal(ethers.parseEther("10"));
    });
  });

  // -------------------------------------------------------
  //  Destination Setters
  // -------------------------------------------------------

  describe("Destination Setters", function () {
    it("should update R&D wallet", async function () {
      await expect(distributor.connect(admin).setRdWallet(other.address))
        .to.emit(distributor, "RdWalletUpdated")
        .withArgs(rdWallet.address, other.address);
      expect(await distributor.rdWallet()).to.equal(other.address);
    });

    it("should update buyback wallet", async function () {
      await expect(distributor.connect(admin).setBuybackWallet(other.address))
        .to.emit(distributor, "BuybackWalletUpdated")
        .withArgs(buybackWallet.address, other.address);
      expect(await distributor.buybackWallet()).to.equal(other.address);
    });

    it("should update agent reward pool", async function () {
      await expect(distributor.connect(admin).setAgentRewardPool(other.address))
        .to.emit(distributor, "AgentRewardPoolUpdated")
        .withArgs(agentRewardPool.address, other.address);
      expect(await distributor.agentRewardPool()).to.equal(other.address);
    });

    it("should update citation pool", async function () {
      await expect(distributor.connect(admin).setCitationPool(other.address))
        .to.emit(distributor, "CitationPoolUpdated")
        .withArgs(citationPool.address, other.address);
      expect(await distributor.citationPool()).to.equal(other.address);
    });

    it("should update ecosystem wallet", async function () {
      await expect(distributor.connect(admin).setEcosystemWallet(other.address))
        .to.emit(distributor, "EcosystemWalletUpdated")
        .withArgs(ecosystemWallet.address, other.address);
      expect(await distributor.ecosystemWallet()).to.equal(other.address);
    });

    it("should revert setRdWallet with zero address", async function () {
      await expect(distributor.connect(admin).setRdWallet(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(distributor, "ZeroAddress");
    });

    it("should revert setBuybackWallet with zero address", async function () {
      await expect(distributor.connect(admin).setBuybackWallet(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(distributor, "ZeroAddress");
    });

    it("should revert setAgentRewardPool with zero address", async function () {
      await expect(distributor.connect(admin).setAgentRewardPool(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(distributor, "ZeroAddress");
    });

    it("should revert setCitationPool with zero address", async function () {
      await expect(distributor.connect(admin).setCitationPool(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(distributor, "ZeroAddress");
    });

    it("should revert setEcosystemWallet with zero address", async function () {
      await expect(distributor.connect(admin).setEcosystemWallet(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(distributor, "ZeroAddress");
    });

    it("should only allow admin for destination setters", async function () {
      await expect(distributor.connect(other).setRdWallet(other.address))
        .to.be.revertedWithCustomError(distributor, "AccessControlUnauthorizedAccount");
    });

    it("should not allow operator for destination setters", async function () {
      await expect(distributor.connect(operator).setRdWallet(other.address))
        .to.be.revertedWithCustomError(distributor, "AccessControlUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------
  //  Emergency Withdraw
  // -------------------------------------------------------

  describe("Emergency Withdraw", function () {
    it("should allow admin to emergency withdraw wETH", async function () {
      const amount = ethers.parseEther("500");
      await expect(distributor.connect(admin).emergencyWithdraw(await weth.getAddress(), admin.address, amount))
        .to.emit(distributor, "EmergencyWithdraw")
        .withArgs(await weth.getAddress(), admin.address, amount);
      expect(await weth.balanceOf(admin.address)).to.equal(amount);
    });

    it("should allow emergency withdraw of NOOK", async function () {
      const amount = ethers.parseEther("100000");
      await distributor.connect(admin).emergencyWithdraw(await nook.getAddress(), admin.address, amount);
      expect(await nook.balanceOf(admin.address)).to.equal(amount);
    });

    it("should revert with zero address", async function () {
      await expect(distributor.connect(admin).emergencyWithdraw(await weth.getAddress(), ethers.ZeroAddress, 100n))
        .to.be.revertedWithCustomError(distributor, "ZeroAddress");
    });

    it("should revert with zero amount", async function () {
      await expect(distributor.connect(admin).emergencyWithdraw(await weth.getAddress(), admin.address, 0n))
        .to.be.revertedWithCustomError(distributor, "ZeroAmount");
    });

    it("should revert if non-admin", async function () {
      await expect(
        distributor.connect(other).emergencyWithdraw(await weth.getAddress(), other.address, 100n),
      ).to.be.revertedWithCustomError(distributor, "AccessControlUnauthorizedAccount");
    });

    it("should revert if operator calls", async function () {
      await expect(
        distributor.connect(operator).emergencyWithdraw(await weth.getAddress(), operator.address, 100n),
      ).to.be.revertedWithCustomError(distributor, "AccessControlUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------
  //  rescueETH
  // -------------------------------------------------------

  describe("rescueETH", function () {
    it("should rescue native ETH", async function () {
      const distributorAddr = await distributor.getAddress();
      // Send ETH to the distributor
      await admin.sendTransaction({ to: distributorAddr, value: ethers.parseEther("1") });

      const balBefore = await ethers.provider.getBalance(other.address);
      await expect(distributor.connect(admin).rescueETH(other.address, ethers.parseEther("1")))
        .to.emit(distributor, "NativeETHRescued")
        .withArgs(other.address, ethers.parseEther("1"));
      const balAfter = await ethers.provider.getBalance(other.address);
      expect(balAfter - balBefore).to.equal(ethers.parseEther("1"));
    });

    it("should revert with zero address", async function () {
      await expect(distributor.connect(admin).rescueETH(ethers.ZeroAddress, 100n))
        .to.be.revertedWithCustomError(distributor, "ZeroAddress");
    });

    it("should revert with zero amount", async function () {
      await expect(distributor.connect(admin).rescueETH(other.address, 0n))
        .to.be.revertedWithCustomError(distributor, "ZeroAmount");
    });

    it("should revert if non-admin", async function () {
      await expect(distributor.connect(other).rescueETH(other.address, 100n))
        .to.be.revertedWithCustomError(distributor, "AccessControlUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------
  //  View Functions
  // -------------------------------------------------------

  describe("View Functions", function () {
    it("should return correct wethBalance", async function () {
      expect(await distributor.wethBalance()).to.equal(WETH_SUPPLY);
    });

    it("should return correct nookBalance", async function () {
      expect(await distributor.nookBalance()).to.equal(NOOK_SUPPLY);
    });

    it("should reflect balance changes", async function () {
      await distributor.connect(operator).distributeWeth(ethers.parseEther("100"));
      expect(await distributor.wethBalance()).to.equal(WETH_SUPPLY - ethers.parseEther("100"));
    });
  });

  // -------------------------------------------------------
  //  Pausable
  // -------------------------------------------------------

  describe("Pausable", function () {
    it("should allow guardian to pause", async function () {
      await expect(distributor.connect(guardian).pause()).to.not.be.reverted;
      expect(await distributor.paused()).to.be.true;
    });

    it("should allow admin to pause", async function () {
      await expect(distributor.connect(admin).pause()).to.not.be.reverted;
      expect(await distributor.paused()).to.be.true;
    });

    it("should not allow guardian to unpause", async function () {
      await distributor.connect(guardian).pause();
      await expect(distributor.connect(guardian).unpause())
        .to.be.revertedWithCustomError(distributor, "AccessControlUnauthorizedAccount");
    });

    it("should allow admin to unpause", async function () {
      await distributor.connect(guardian).pause();
      await distributor.connect(admin).unpause();
      expect(await distributor.paused()).to.be.false;
    });

    it("should allow operations after unpause", async function () {
      await distributor.connect(guardian).pause();
      await distributor.connect(admin).unpause();
      await expect(distributor.connect(operator).distributeWeth(ethers.parseEther("10"))).to.not.be.reverted;
    });

    it("should not allow non-guardian/admin to pause", async function () {
      await expect(distributor.connect(other).pause())
        .to.be.revertedWithCustomError(distributor, "AccessControlUnauthorizedAccount");
    });

    it("should not allow operator to pause", async function () {
      await expect(distributor.connect(operator).pause())
        .to.be.revertedWithCustomError(distributor, "AccessControlUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------
  //  UUPS Upgrade
  // -------------------------------------------------------

  describe("UUPS Upgrade", function () {
    it("should allow admin to upgrade", async function () {
      const V2Factory = await ethers.getContractFactory("FeeDistributor", admin);
      await expect(
        upgrades.upgradeProxy(await distributor.getAddress(), V2Factory),
      ).to.not.be.reverted;
    });

    it("should reject upgrade from non-admin", async function () {
      const V2Factory = await ethers.getContractFactory("FeeDistributor", other);
      await expect(
        upgrades.upgradeProxy(await distributor.getAddress(), V2Factory),
      ).to.be.revertedWithCustomError(distributor, "AccessControlUnauthorizedAccount");
    });

    it("should reject upgrade from operator", async function () {
      const V2Factory = await ethers.getContractFactory("FeeDistributor", operator);
      await expect(
        upgrades.upgradeProxy(await distributor.getAddress(), V2Factory),
      ).to.be.revertedWithCustomError(distributor, "AccessControlUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------
  //  Min Distribution Amount
  // -------------------------------------------------------

  describe("Min Distribution Amount", function () {
    it("should allow admin to update minDistributionAmount", async function () {
      await distributor.connect(admin).setMinDistributionAmount(ethers.parseEther("1"));
      expect(await distributor.minDistributionAmount()).to.equal(ethers.parseEther("1"));
    });

    it("should emit MinDistributionAmountUpdated event", async function () {
      const newAmount = ethers.parseEther("2");
      await expect(distributor.connect(admin).setMinDistributionAmount(newAmount))
        .to.emit(distributor, "MinDistributionAmountUpdated")
        .withArgs(1000000000000n, newAmount); // 1e12 → 2 ETH
    });

    it("should allow setting to zero (disable minimum)", async function () {
      await distributor.connect(admin).setMinDistributionAmount(0);
      expect(await distributor.minDistributionAmount()).to.equal(0);
    });

    it("should revert if non-admin sets minimum", async function () {
      await expect(distributor.connect(other).setMinDistributionAmount(100n))
        .to.be.revertedWithCustomError(distributor, "AccessControlUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------
  //  initializeAll (atomic V1+V2 — no init-gap)
  // -------------------------------------------------------

  describe("initializeAll", function () {
    let fresh: FeeDistributor;

    beforeEach(async function () {
      const F = await ethers.getContractFactory("FeeDistributor");
      fresh = (await upgrades.deployProxy(
        F,
        [
          admin.address,
          await weth.getAddress(),
          await nook.getAddress(),
          rdWallet.address,
          buybackWallet.address,
          ecosystemWallet.address,
          operator.address,
          guardian.address,
        ],
        { kind: "uups", initializer: "initializeAll" },
      )) as unknown as FeeDistributor;
      await fresh.waitForDeployment();
    });

    it("should set correct token addresses", async function () {
      expect(await fresh.weth()).to.equal(await weth.getAddress());
      expect(await fresh.nook()).to.equal(await nook.getAddress());
    });

    it("should set correct wallet addresses", async function () {
      expect(await fresh.rdWallet()).to.equal(rdWallet.address);
      expect(await fresh.buybackWallet()).to.equal(buybackWallet.address);
      expect(await fresh.ecosystemWallet()).to.equal(ecosystemWallet.address);
    });

    it("should set default wETH splits", async function () {
      expect(await fresh.rdBps()).to.equal(5000);
      expect(await fresh.buybackBps()).to.equal(3000);
      expect(await fresh.agentRewardBps()).to.equal(2000);
    });

    it("should set default NOOK splits", async function () {
      expect(await fresh.citationBps()).to.equal(4000);
      expect(await fresh.ecosystemBps()).to.equal(6000);
    });

    it("should set minDistributionAmount", async function () {
      expect(await fresh.minDistributionAmount()).to.equal(1000000000000n); // 1e12
    });

    it("should grant DEFAULT_ADMIN_ROLE to admin", async function () {
      expect(await fresh.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
    });

    it("should grant OPERATOR_ROLE to operator", async function () {
      expect(await fresh.hasRole(OPERATOR_ROLE, operator.address)).to.be.true;
    });

    it("should grant GUARDIAN_ROLE to guardian", async function () {
      expect(await fresh.hasRole(GUARDIAN_ROLE, guardian.address)).to.be.true;
    });

    it("should not have owner() function (Ownable removed)", async function () {
      expect((fresh as any).owner).to.be.undefined;
    });

    it("should not allow initializeAll to be called twice", async function () {
      await expect(
        fresh.initializeAll(
          admin.address,
          await weth.getAddress(),
          await nook.getAddress(),
          rdWallet.address,
          buybackWallet.address,
          ecosystemWallet.address,
          operator.address,
          guardian.address,
        ),
      ).to.be.revertedWithCustomError(fresh, "InvalidInitialization");
    });

    it("should not allow initializeV2 after initializeAll", async function () {
      await expect(
        fresh.initializeV2(admin.address, operator.address, guardian.address),
      ).to.be.revertedWithCustomError(fresh, "InvalidInitialization");
    });

    it("should revert with zero admin", async function () {
      const F = await ethers.getContractFactory("FeeDistributor");
      await expect(
        upgrades.deployProxy(F, [
          ethers.ZeroAddress, await weth.getAddress(), await nook.getAddress(),
          rdWallet.address, buybackWallet.address, ecosystemWallet.address,
          operator.address, guardian.address,
        ], { kind: "uups", initializer: "initializeAll" }),
      ).to.be.revertedWithCustomError(fresh, "ZeroAddress");
    });

    it("should revert with zero weth", async function () {
      const F = await ethers.getContractFactory("FeeDistributor");
      await expect(
        upgrades.deployProxy(F, [
          admin.address, ethers.ZeroAddress, await nook.getAddress(),
          rdWallet.address, buybackWallet.address, ecosystemWallet.address,
          operator.address, guardian.address,
        ], { kind: "uups", initializer: "initializeAll" }),
      ).to.be.revertedWithCustomError(fresh, "ZeroAddress");
    });

    it("should revert with zero operator", async function () {
      const F = await ethers.getContractFactory("FeeDistributor");
      await expect(
        upgrades.deployProxy(F, [
          admin.address, await weth.getAddress(), await nook.getAddress(),
          rdWallet.address, buybackWallet.address, ecosystemWallet.address,
          ethers.ZeroAddress, guardian.address,
        ], { kind: "uups", initializer: "initializeAll" }),
      ).to.be.revertedWithCustomError(fresh, "ZeroAddress");
    });

    it("should revert with zero guardian", async function () {
      const F = await ethers.getContractFactory("FeeDistributor");
      await expect(
        upgrades.deployProxy(F, [
          admin.address, await weth.getAddress(), await nook.getAddress(),
          rdWallet.address, buybackWallet.address, ecosystemWallet.address,
          operator.address, ethers.ZeroAddress,
        ], { kind: "uups", initializer: "initializeAll" }),
      ).to.be.revertedWithCustomError(fresh, "ZeroAddress");
    });

    it("should be fully functional (admin can set splits)", async function () {
      await fresh.connect(admin).setWethSplit(6000, 2000, 2000);
      expect(await fresh.rdBps()).to.equal(6000);
    });

    it("should be fully functional (guardian can pause)", async function () {
      await expect(fresh.connect(guardian).pause()).to.not.be.reverted;
      expect(await fresh.paused()).to.be.true;
    });
  });
});
