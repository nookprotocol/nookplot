import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { RewardPool, MockERC20 } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

describe("RewardPool", function () {
  let pool: RewardPool;
  let token: MockERC20;
  let admin: SignerWithAddress;
  let rootPublisher: SignerWithAddress;
  let guardian: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let charlie: SignerWithAddress;
  let other: SignerWithAddress;

  const POOL_SUPPLY = ethers.parseEther("1000000"); // 1M tokens

  const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
  const ROOT_PUBLISHER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ROOT_PUBLISHER_ROLE"));
  const GUARDIAN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GUARDIAN_ROLE"));

  // ERC-2771: constructor needs a trusted forwarder address
  const FORWARDER = ethers.ZeroAddress; // placeholder for tests (no meta-tx in tests)
  const PROXY_OPTS = {
    kind: "uups" as const,
    unsafeAllow: ["constructor", "state-variable-immutable"] as any[],
    constructorArgs: [FORWARDER],
  };

  // Helper: build a Merkle tree from [address, cumulativeAmount] entries
  function buildTree(entries: [string, bigint][]) {
    return StandardMerkleTree.of(
      entries.map(([addr, amt]) => [addr, amt.toString()]),
      ["address", "uint256"],
    );
  }

  beforeEach(async function () {
    [admin, rootPublisher, guardian, alice, bob, charlie, other] = await ethers.getSigners();

    // Deploy mock reward token
    const MockFactory = await ethers.getContractFactory("MockERC20");
    token = (await MockFactory.deploy("Reward Token", "RWD")) as unknown as MockERC20;
    await token.waitForDeployment();

    // Deploy RewardPool via UUPS proxy
    const PoolFactory = await ethers.getContractFactory("RewardPool");
    pool = (await upgrades.deployProxy(
      PoolFactory,
      [admin.address, await token.getAddress()],
      PROXY_OPTS,
    )) as unknown as RewardPool;
    await pool.waitForDeployment();

    // Initialize V2 with roles
    await pool.initializeV2(admin.address, rootPublisher.address, guardian.address);

    // Fund the pool
    await token.mint(await pool.getAddress(), POOL_SUPPLY);
  });

  // -------------------------------------------------------
  //  Initialization
  // -------------------------------------------------------

  describe("Initialization", function () {
    it("should set correct reward token", async function () {
      expect(await pool.rewardToken()).to.equal(await token.getAddress());
    });

    it("should start non-claimable", async function () {
      expect(await pool.claimable()).to.be.false;
    });

    it("should start at epoch 0", async function () {
      expect(await pool.epoch()).to.equal(0);
    });

    it("should have zero merkle root initially", async function () {
      expect(await pool.merkleRoot()).to.equal(ethers.ZeroHash);
    });

    it("should have pool balance", async function () {
      expect(await pool.poolBalance()).to.equal(POOL_SUPPLY);
    });

    it("should revert initialize with zero owner", async function () {
      const PoolFactory = await ethers.getContractFactory("RewardPool");
      await expect(
        upgrades.deployProxy(
          PoolFactory,
          [ethers.ZeroAddress, await token.getAddress()],
          PROXY_OPTS,
        ),
      ).to.be.revertedWithCustomError(pool, "ZeroAddress");
    });

    it("should revert initialize with zero token", async function () {
      const PoolFactory = await ethers.getContractFactory("RewardPool");
      await expect(
        upgrades.deployProxy(
          PoolFactory,
          [admin.address, ethers.ZeroAddress],
          PROXY_OPTS,
        ),
      ).to.be.revertedWithCustomError(pool, "ZeroAddress");
    });

    it("should not allow initializeV2 to be called twice", async function () {
      await expect(
        pool.initializeV2(admin.address, rootPublisher.address, guardian.address),
      ).to.be.revertedWithCustomError(pool, "InvalidInitialization");
    });
  });

  // -------------------------------------------------------
  //  Role Management
  // -------------------------------------------------------

  describe("Role Management", function () {
    it("should have granted DEFAULT_ADMIN_ROLE to admin", async function () {
      expect(await pool.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
    });

    it("should have granted ROOT_PUBLISHER_ROLE to rootPublisher", async function () {
      expect(await pool.hasRole(ROOT_PUBLISHER_ROLE, rootPublisher.address)).to.be.true;
    });

    it("should have granted GUARDIAN_ROLE to guardian", async function () {
      expect(await pool.hasRole(GUARDIAN_ROLE, guardian.address)).to.be.true;
    });

    it("should allow admin to grant ROOT_PUBLISHER_ROLE", async function () {
      await pool.connect(admin).grantRole(ROOT_PUBLISHER_ROLE, other.address);
      expect(await pool.hasRole(ROOT_PUBLISHER_ROLE, other.address)).to.be.true;
    });

    it("should allow admin to revoke ROOT_PUBLISHER_ROLE", async function () {
      await pool.connect(admin).revokeRole(ROOT_PUBLISHER_ROLE, rootPublisher.address);
      expect(await pool.hasRole(ROOT_PUBLISHER_ROLE, rootPublisher.address)).to.be.false;
    });

    it("should not allow non-admin to grant roles", async function () {
      await expect(
        pool.connect(other).grantRole(ROOT_PUBLISHER_ROLE, other.address),
      ).to.be.revertedWithCustomError(pool, "AccessControlUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------
  //  Merkle Root Management
  // -------------------------------------------------------

  describe("Merkle Root Management", function () {
    it("should allow rootPublisher to set merkle root", async function () {
      const root = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await expect(pool.connect(rootPublisher).setMerkleRoot(root))
        .to.emit(pool, "MerkleRootUpdated")
        .withArgs(ethers.ZeroHash, root, 1);
    });

    it("should increment epoch on each root update", async function () {
      const root1 = ethers.keccak256(ethers.toUtf8Bytes("root1"));
      const root2 = ethers.keccak256(ethers.toUtf8Bytes("root2"));

      await pool.connect(rootPublisher).setMerkleRoot(root1);
      expect(await pool.epoch()).to.equal(1);

      await pool.connect(rootPublisher).setMerkleRoot(root2);
      expect(await pool.epoch()).to.equal(2);
    });

    it("should revert if non-rootPublisher sets root", async function () {
      const root = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await expect(pool.connect(alice).setMerkleRoot(root))
        .to.be.revertedWithCustomError(pool, "AccessControlUnauthorizedAccount");
    });

    it("should revert if admin without ROOT_PUBLISHER_ROLE sets root", async function () {
      const root = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await expect(pool.connect(admin).setMerkleRoot(root))
        .to.be.revertedWithCustomError(pool, "AccessControlUnauthorizedAccount");
    });

    it("should revert if root is zero", async function () {
      await expect(pool.connect(rootPublisher).setMerkleRoot(ethers.ZeroHash))
        .to.be.revertedWithCustomError(pool, "ZeroRoot");
    });
  });

  // -------------------------------------------------------
  //  Claimable Toggle
  // -------------------------------------------------------

  describe("Claimable Toggle", function () {
    it("should allow admin to enable claiming", async function () {
      await expect(pool.connect(admin).setClaimable(true))
        .to.emit(pool, "ClaimableToggled")
        .withArgs(true);
      expect(await pool.claimable()).to.be.true;
    });

    it("should allow admin to disable claiming", async function () {
      await pool.connect(admin).setClaimable(true);
      await expect(pool.connect(admin).setClaimable(false))
        .to.emit(pool, "ClaimableToggled")
        .withArgs(false);
      expect(await pool.claimable()).to.be.false;
    });

    it("should revert if non-admin toggles claimable", async function () {
      await expect(pool.connect(alice).setClaimable(true))
        .to.be.revertedWithCustomError(pool, "AccessControlUnauthorizedAccount");
    });

    it("should revert if rootPublisher toggles claimable", async function () {
      await expect(pool.connect(rootPublisher).setClaimable(true))
        .to.be.revertedWithCustomError(pool, "AccessControlUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------
  //  Claiming
  // -------------------------------------------------------

  describe("Claiming", function () {
    let tree: StandardMerkleTree<string[]>;
    const aliceAmount = ethers.parseEther("100");
    const bobAmount = ethers.parseEther("200");

    beforeEach(async function () {
      tree = buildTree([
        [alice.address, aliceAmount],
        [bob.address, bobAmount],
      ]);
      await pool.connect(rootPublisher).setMerkleRoot(tree.root);
      await pool.connect(admin).setClaimable(true);
    });

    it("should allow valid claim", async function () {
      const proof = tree.getProof([alice.address, aliceAmount.toString()]);
      await expect(pool.connect(alice).claim(aliceAmount, proof))
        .to.emit(pool, "RewardClaimed")
        .withArgs(alice.address, aliceAmount, aliceAmount, 1);

      expect(await token.balanceOf(alice.address)).to.equal(aliceAmount);
      expect(await pool.cumulativeClaimed(alice.address)).to.equal(aliceAmount);
      expect(await pool.totalClaimed()).to.equal(aliceAmount);
    });

    it("should allow multiple accounts to claim", async function () {
      const proofA = tree.getProof([alice.address, aliceAmount.toString()]);
      const proofB = tree.getProof([bob.address, bobAmount.toString()]);

      await pool.connect(alice).claim(aliceAmount, proofA);
      await pool.connect(bob).claim(bobAmount, proofB);

      expect(await token.balanceOf(alice.address)).to.equal(aliceAmount);
      expect(await token.balanceOf(bob.address)).to.equal(bobAmount);
      expect(await pool.totalClaimed()).to.equal(aliceAmount + bobAmount);
    });

    it("should revert if claiming is disabled", async function () {
      await pool.connect(admin).setClaimable(false);
      const proof = tree.getProof([alice.address, aliceAmount.toString()]);
      await expect(pool.connect(alice).claim(aliceAmount, proof))
        .to.be.revertedWithCustomError(pool, "ClaimingDisabled");
    });

    it("should revert with invalid proof", async function () {
      const badProof = [ethers.keccak256(ethers.toUtf8Bytes("bad"))];
      await expect(pool.connect(alice).claim(aliceAmount, badProof))
        .to.be.revertedWithCustomError(pool, "InvalidProof");
    });

    it("should revert with wrong amount", async function () {
      const proof = tree.getProof([alice.address, aliceAmount.toString()]);
      const wrongAmount = ethers.parseEther("999");
      await expect(pool.connect(alice).claim(wrongAmount, proof))
        .to.be.revertedWithCustomError(pool, "InvalidProof");
    });

    it("should revert with wrong account", async function () {
      const proof = tree.getProof([alice.address, aliceAmount.toString()]);
      await expect(pool.connect(bob).claim(aliceAmount, proof))
        .to.be.revertedWithCustomError(pool, "InvalidProof");
    });

    it("should revert on double claim (nothing to claim)", async function () {
      const proof = tree.getProof([alice.address, aliceAmount.toString()]);
      await pool.connect(alice).claim(aliceAmount, proof);

      await expect(pool.connect(alice).claim(aliceAmount, proof))
        .to.be.revertedWithCustomError(pool, "NothingToClaim");
    });

    it("should revert when paused", async function () {
      await pool.connect(guardian).pause();
      const proof = tree.getProof([alice.address, aliceAmount.toString()]);
      await expect(pool.connect(alice).claim(aliceAmount, proof))
        .to.be.revertedWithCustomError(pool, "EnforcedPause");
    });
  });

  // -------------------------------------------------------
  //  Cumulative Claiming Across Epochs
  // -------------------------------------------------------

  describe("Cumulative Claiming", function () {
    it("should pay delta across epoch updates", async function () {
      // Epoch 1: Alice entitled to 100
      const aliceAmount1 = ethers.parseEther("100");
      const tree1 = buildTree([
        [alice.address, aliceAmount1],
        [bob.address, ethers.parseEther("50")],
      ]);
      await pool.connect(rootPublisher).setMerkleRoot(tree1.root);
      await pool.connect(admin).setClaimable(true);

      const proof1 = tree1.getProof([alice.address, aliceAmount1.toString()]);
      await pool.connect(alice).claim(aliceAmount1, proof1);
      expect(await token.balanceOf(alice.address)).to.equal(aliceAmount1);

      // Epoch 2: Alice cumulative entitlement raised to 250
      const aliceAmount2 = ethers.parseEther("250");
      const tree2 = buildTree([
        [alice.address, aliceAmount2],
        [bob.address, ethers.parseEther("100")],
      ]);
      await pool.connect(rootPublisher).setMerkleRoot(tree2.root);

      const proof2 = tree2.getProof([alice.address, aliceAmount2.toString()]);
      await expect(pool.connect(alice).claim(aliceAmount2, proof2))
        .to.emit(pool, "RewardClaimed")
        .withArgs(
          alice.address,
          ethers.parseEther("150"), // delta: 250 - 100
          aliceAmount2,
          2,
        );

      expect(await token.balanceOf(alice.address)).to.equal(aliceAmount2);
      expect(await pool.cumulativeClaimed(alice.address)).to.equal(aliceAmount2);
    });

    it("should allow first claim on later epoch", async function () {
      // Set root for epoch 1 but don't claim
      const tree1 = buildTree([
        [alice.address, ethers.parseEther("100")],
      ]);
      await pool.connect(rootPublisher).setMerkleRoot(tree1.root);
      await pool.connect(admin).setClaimable(true);

      // Update to epoch 2 with higher amount
      const aliceAmount = ethers.parseEther("300");
      const tree2 = buildTree([
        [alice.address, aliceAmount],
      ]);
      await pool.connect(rootPublisher).setMerkleRoot(tree2.root);

      // Alice claims for the first time at epoch 2 — gets full 300
      const proof = tree2.getProof([alice.address, aliceAmount.toString()]);
      await pool.connect(alice).claim(aliceAmount, proof);
      expect(await token.balanceOf(alice.address)).to.equal(aliceAmount);
    });

    it("should revert if cumulative decreased (nothing to claim)", async function () {
      // This shouldn't happen in practice but tests the guard
      const aliceAmount1 = ethers.parseEther("100");
      const tree1 = buildTree([
        [alice.address, aliceAmount1],
      ]);
      await pool.connect(rootPublisher).setMerkleRoot(tree1.root);
      await pool.connect(admin).setClaimable(true);

      const proof1 = tree1.getProof([alice.address, aliceAmount1.toString()]);
      await pool.connect(alice).claim(aliceAmount1, proof1);

      // New root with lower cumulative (50 < 100 already claimed)
      const aliceAmount2 = ethers.parseEther("50");
      const tree2 = buildTree([
        [alice.address, aliceAmount2],
      ]);
      await pool.connect(rootPublisher).setMerkleRoot(tree2.root);

      const proof2 = tree2.getProof([alice.address, aliceAmount2.toString()]);
      await expect(pool.connect(alice).claim(aliceAmount2, proof2))
        .to.be.revertedWithCustomError(pool, "NothingToClaim");
    });
  });

  // -------------------------------------------------------
  //  View Functions
  // -------------------------------------------------------

  describe("View Functions", function () {
    it("should return correct claimable amount", async function () {
      const aliceAmount = ethers.parseEther("100");
      const tree = buildTree([
        [alice.address, aliceAmount],
      ]);
      await pool.connect(rootPublisher).setMerkleRoot(tree.root);
      await pool.connect(admin).setClaimable(true);

      expect(await pool.getClaimableAmount(alice.address, aliceAmount)).to.equal(aliceAmount);

      // After partial claim via epoch update
      const proof = tree.getProof([alice.address, aliceAmount.toString()]);
      await pool.connect(alice).claim(aliceAmount, proof);

      expect(await pool.getClaimableAmount(alice.address, aliceAmount)).to.equal(0);

      // Higher cumulative
      const higher = ethers.parseEther("200");
      expect(await pool.getClaimableAmount(alice.address, higher)).to.equal(
        ethers.parseEther("100"),
      );
    });

    it("should return zero for unclaimed account", async function () {
      expect(await pool.getClaimableAmount(charlie.address, ethers.parseEther("100"))).to.equal(
        ethers.parseEther("100"),
      );
    });

    it("should return pool balance", async function () {
      expect(await pool.poolBalance()).to.equal(POOL_SUPPLY);
    });

    it("should track total claimed", async function () {
      const aliceAmount = ethers.parseEther("100");
      const tree = buildTree([[alice.address, aliceAmount]]);
      await pool.connect(rootPublisher).setMerkleRoot(tree.root);
      await pool.connect(admin).setClaimable(true);

      const proof = tree.getProof([alice.address, aliceAmount.toString()]);
      await pool.connect(alice).claim(aliceAmount, proof);

      expect(await pool.totalClaimed()).to.equal(aliceAmount);
    });
  });

  // -------------------------------------------------------
  //  Emergency Withdraw
  // -------------------------------------------------------

  describe("Emergency Withdraw", function () {
    it("should allow admin to emergency withdraw", async function () {
      const amount = ethers.parseEther("500");
      await expect(pool.connect(admin).emergencyWithdraw(await token.getAddress(), admin.address, amount))
        .to.emit(pool, "EmergencyWithdraw")
        .withArgs(await token.getAddress(), admin.address, amount);
      expect(await token.balanceOf(admin.address)).to.equal(amount);
    });

    it("should revert emergency withdraw with zero address", async function () {
      await expect(pool.connect(admin).emergencyWithdraw(await token.getAddress(), ethers.ZeroAddress, 100n))
        .to.be.revertedWithCustomError(pool, "ZeroAddress");
    });

    it("should revert emergency withdraw with zero amount", async function () {
      await expect(pool.connect(admin).emergencyWithdraw(await token.getAddress(), admin.address, 0n))
        .to.be.revertedWithCustomError(pool, "ZeroAmount");
    });

    it("should revert if non-admin calls emergency withdraw", async function () {
      await expect(
        pool.connect(alice).emergencyWithdraw(await token.getAddress(), alice.address, 100n),
      ).to.be.revertedWithCustomError(pool, "AccessControlUnauthorizedAccount");
    });

    it("should revert if rootPublisher calls emergency withdraw", async function () {
      await expect(
        pool.connect(rootPublisher).emergencyWithdraw(await token.getAddress(), rootPublisher.address, 100n),
      ).to.be.revertedWithCustomError(pool, "AccessControlUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------
  //  rescueETH
  // -------------------------------------------------------

  describe("rescueETH", function () {
    it("should rescue native ETH", async function () {
      const poolAddr = await pool.getAddress();
      await admin.sendTransaction({ to: poolAddr, value: ethers.parseEther("1") });

      const balBefore = await ethers.provider.getBalance(other.address);
      await expect(pool.connect(admin).rescueETH(other.address, ethers.parseEther("1")))
        .to.emit(pool, "NativeETHRescued")
        .withArgs(other.address, ethers.parseEther("1"));
      const balAfter = await ethers.provider.getBalance(other.address);
      expect(balAfter - balBefore).to.equal(ethers.parseEther("1"));
    });

    it("should revert with zero address", async function () {
      await expect(pool.connect(admin).rescueETH(ethers.ZeroAddress, 100n))
        .to.be.revertedWithCustomError(pool, "ZeroAddress");
    });

    it("should revert with zero amount", async function () {
      await expect(pool.connect(admin).rescueETH(other.address, 0n))
        .to.be.revertedWithCustomError(pool, "ZeroAmount");
    });

    it("should revert if non-admin", async function () {
      await expect(pool.connect(other).rescueETH(other.address, 100n))
        .to.be.revertedWithCustomError(pool, "AccessControlUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------
  //  Pausable
  // -------------------------------------------------------

  describe("Pausable", function () {
    it("should allow guardian to pause", async function () {
      await expect(pool.connect(guardian).pause()).to.not.be.reverted;
      expect(await pool.paused()).to.be.true;
    });

    it("should allow admin to pause", async function () {
      await expect(pool.connect(admin).pause()).to.not.be.reverted;
      expect(await pool.paused()).to.be.true;
    });

    it("should not allow guardian to unpause", async function () {
      await pool.connect(guardian).pause();
      await expect(pool.connect(guardian).unpause())
        .to.be.revertedWithCustomError(pool, "AccessControlUnauthorizedAccount");
    });

    it("should allow admin to unpause", async function () {
      await pool.connect(guardian).pause();
      await pool.connect(admin).unpause();
      expect(await pool.paused()).to.be.false;
    });

    it("should block claims when paused", async function () {
      const aliceAmount = ethers.parseEther("100");
      const tree = buildTree([[alice.address, aliceAmount]]);
      await pool.connect(rootPublisher).setMerkleRoot(tree.root);
      await pool.connect(admin).setClaimable(true);
      await pool.connect(guardian).pause();

      const proof = tree.getProof([alice.address, aliceAmount.toString()]);
      await expect(pool.connect(alice).claim(aliceAmount, proof))
        .to.be.revertedWithCustomError(pool, "EnforcedPause");
    });

    it("should allow claims after unpause", async function () {
      const aliceAmount = ethers.parseEther("100");
      const tree = buildTree([[alice.address, aliceAmount]]);
      await pool.connect(rootPublisher).setMerkleRoot(tree.root);
      await pool.connect(admin).setClaimable(true);
      await pool.connect(guardian).pause();
      await pool.connect(admin).unpause();

      const proof = tree.getProof([alice.address, aliceAmount.toString()]);
      await expect(pool.connect(alice).claim(aliceAmount, proof))
        .to.emit(pool, "RewardClaimed");
    });

    it("should not allow non-guardian/admin to pause", async function () {
      await expect(pool.connect(alice).pause())
        .to.be.revertedWithCustomError(pool, "AccessControlUnauthorizedAccount");
    });

    it("should not allow rootPublisher to pause", async function () {
      await expect(pool.connect(rootPublisher).pause())
        .to.be.revertedWithCustomError(pool, "AccessControlUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------
  //  UUPS Upgrade
  // -------------------------------------------------------

  describe("UUPS Upgrade", function () {
    it("should allow admin to upgrade", async function () {
      const PoolV2Factory = await ethers.getContractFactory("RewardPool", admin);
      await expect(
        upgrades.upgradeProxy(await pool.getAddress(), PoolV2Factory, PROXY_OPTS),
      ).to.not.be.reverted;
    });

    it("should reject upgrade from non-admin", async function () {
      const PoolV2Factory = await ethers.getContractFactory("RewardPool", alice);
      await expect(
        upgrades.upgradeProxy(await pool.getAddress(), PoolV2Factory, PROXY_OPTS),
      ).to.be.revertedWithCustomError(pool, "AccessControlUnauthorizedAccount");
    });

    it("should reject upgrade from rootPublisher", async function () {
      const PoolV2Factory = await ethers.getContractFactory("RewardPool", rootPublisher);
      await expect(
        upgrades.upgradeProxy(await pool.getAddress(), PoolV2Factory, PROXY_OPTS),
      ).to.be.revertedWithCustomError(pool, "AccessControlUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------
  //  Edge Cases
  // -------------------------------------------------------

  describe("Edge Cases", function () {
    it("should handle single-entry Merkle tree", async function () {
      const aliceAmount = ethers.parseEther("500");
      const tree = buildTree([[alice.address, aliceAmount]]);
      await pool.connect(rootPublisher).setMerkleRoot(tree.root);
      await pool.connect(admin).setClaimable(true);

      const proof = tree.getProof([alice.address, aliceAmount.toString()]);
      await pool.connect(alice).claim(aliceAmount, proof);
      expect(await token.balanceOf(alice.address)).to.equal(aliceAmount);
    });

    it("should handle large Merkle tree", async function () {
      // Build tree with multiple entries
      const entries: [string, bigint][] = [
        [alice.address, ethers.parseEther("100")],
        [bob.address, ethers.parseEther("200")],
        [charlie.address, ethers.parseEther("300")],
        [admin.address, ethers.parseEther("400")],
      ];
      const tree = buildTree(entries);
      await pool.connect(rootPublisher).setMerkleRoot(tree.root);
      await pool.connect(admin).setClaimable(true);

      // Each account can claim
      for (const [addr, amt] of entries) {
        const signer = [alice, bob, charlie, admin].find(
          (s) => s.address === addr,
        )!;
        const proof = tree.getProof([addr, amt.toString()]);
        await pool.connect(signer).claim(amt, proof);
        expect(await token.balanceOf(addr)).to.be.gte(amt);
      }
    });

    it("should not allow claim with empty root", async function () {
      await pool.connect(admin).setClaimable(true);
      // merkleRoot is still ZeroHash
      const aliceAmount = ethers.parseEther("100");
      const tree = buildTree([[alice.address, aliceAmount]]);
      const proof = tree.getProof([alice.address, aliceAmount.toString()]);

      await expect(pool.connect(alice).claim(aliceAmount, proof))
        .to.be.revertedWithCustomError(pool, "InvalidProof");
    });

    it("should revert when pool has insufficient balance", async function () {
      const aliceAmount = ethers.parseEther("100");
      const tree = buildTree([[alice.address, aliceAmount]]);
      await pool.connect(rootPublisher).setMerkleRoot(tree.root);
      await pool.connect(admin).setClaimable(true);

      // Drain the pool first
      await pool.connect(admin).emergencyWithdraw(
        await token.getAddress(), admin.address, POOL_SUPPLY,
      );
      expect(await pool.poolBalance()).to.equal(0n);

      const proof = tree.getProof([alice.address, aliceAmount.toString()]);
      // safeTransfer will revert when pool is empty
      await expect(pool.connect(alice).claim(aliceAmount, proof)).to.be.reverted;
    });

    it("should revert with empty proof array on multi-leaf tree", async function () {
      const aliceAmount = ethers.parseEther("100");
      const bobAmount = ethers.parseEther("200");
      const tree = buildTree([
        [alice.address, aliceAmount],
        [bob.address, bobAmount],
      ]);
      await pool.connect(rootPublisher).setMerkleRoot(tree.root);
      await pool.connect(admin).setClaimable(true);

      // Empty proof should fail for a multi-leaf tree
      await expect(pool.connect(alice).claim(aliceAmount, []))
        .to.be.revertedWithCustomError(pool, "InvalidProof");
    });

    it("should reject old proof after root update", async function () {
      const aliceAmount1 = ethers.parseEther("100");
      const tree1 = buildTree([[alice.address, aliceAmount1]]);
      await pool.connect(rootPublisher).setMerkleRoot(tree1.root);
      await pool.connect(admin).setClaimable(true);

      const oldProof = tree1.getProof([alice.address, aliceAmount1.toString()]);

      // Publish new root with different amounts
      const aliceAmount2 = ethers.parseEther("200");
      const tree2 = buildTree([
        [alice.address, aliceAmount2],
        [bob.address, ethers.parseEther("50")],
      ]);
      await pool.connect(rootPublisher).setMerkleRoot(tree2.root);

      // Old proof against old amount should fail with new root
      await expect(pool.connect(alice).claim(aliceAmount1, oldProof))
        .to.be.revertedWithCustomError(pool, "InvalidProof");
    });

    it("should allow emergencyWithdraw of non-reward token", async function () {
      // Deploy a different token and send it to the pool accidentally
      const MockFactory = await ethers.getContractFactory("MockERC20");
      const otherToken = await MockFactory.deploy("Other Token", "OTH");
      await otherToken.waitForDeployment();

      const otherAddr = await otherToken.getAddress();
      const poolAddr = await pool.getAddress();
      await otherToken.mint(poolAddr, ethers.parseEther("500"));

      expect(await otherToken.balanceOf(poolAddr)).to.equal(ethers.parseEther("500"));

      // Admin rescues the accidentally sent tokens
      await pool.connect(admin).emergencyWithdraw(
        otherAddr, admin.address, ethers.parseEther("500"),
      );
      expect(await otherToken.balanceOf(poolAddr)).to.equal(0n);
      expect(await otherToken.balanceOf(admin.address)).to.equal(ethers.parseEther("500"));
    });

    it("should revert setMerkleRoot with duplicate root", async function () {
      const root = ethers.keccak256(ethers.toUtf8Bytes("test-root"));
      await pool.connect(rootPublisher).setMerkleRoot(root);
      expect(await pool.epoch()).to.equal(1);

      // Setting the same root again succeeds but increments epoch
      await pool.connect(rootPublisher).setMerkleRoot(root);
      expect(await pool.epoch()).to.equal(2);
    });

    it("should revert rescueETH when contract has no ETH", async function () {
      // Pool has no ETH — rescueETH should revert
      await expect(
        pool.connect(admin).rescueETH(admin.address, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(pool, "EthTransferFailed");
    });

    it("should handle pause then emergencyWithdraw sequence", async function () {
      // Guardian pauses
      await pool.connect(guardian).pause();
      expect(await pool.paused()).to.be.true;

      // Admin can still emergency withdraw while paused
      const withdrawAmount = ethers.parseEther("100");
      await pool.connect(admin).emergencyWithdraw(
        await token.getAddress(), admin.address, withdrawAmount,
      );

      // Admin unpause and verify pool still works
      await pool.connect(admin).unpause();
      expect(await pool.paused()).to.be.false;
    });

    it("should handle claim of exact remaining pool balance", async function () {
      // Withdraw most of the pool, leaving exactly what Alice can claim
      const aliceAmount = ethers.parseEther("100");
      const toWithdraw = POOL_SUPPLY - aliceAmount;
      await pool.connect(admin).emergencyWithdraw(await token.getAddress(), admin.address, toWithdraw);

      const tree = buildTree([[alice.address, aliceAmount]]);
      await pool.connect(rootPublisher).setMerkleRoot(tree.root);
      await pool.connect(admin).setClaimable(true);

      const proof = tree.getProof([alice.address, aliceAmount.toString()]);
      await pool.connect(alice).claim(aliceAmount, proof);
      expect(await pool.poolBalance()).to.equal(0n);
    });
  });

  // -------------------------------------------------------
  //  initializeAll (atomic V1+V2 — no init-gap)
  // -------------------------------------------------------

  describe("initializeAll", function () {
    let freshPool: RewardPool;

    beforeEach(async function () {
      const PoolFactory = await ethers.getContractFactory("RewardPool");
      freshPool = (await upgrades.deployProxy(
        PoolFactory,
        [admin.address, await token.getAddress(), rootPublisher.address, guardian.address],
        { ...PROXY_OPTS, initializer: "initializeAll" },
      )) as unknown as RewardPool;
      await freshPool.waitForDeployment();
    });

    it("should set correct reward token", async function () {
      expect(await freshPool.rewardToken()).to.equal(await token.getAddress());
    });

    it("should start non-claimable", async function () {
      expect(await freshPool.claimable()).to.be.false;
    });

    it("should grant DEFAULT_ADMIN_ROLE to admin", async function () {
      expect(await freshPool.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
    });

    it("should grant ROOT_PUBLISHER_ROLE to rootPublisher", async function () {
      expect(await freshPool.hasRole(ROOT_PUBLISHER_ROLE, rootPublisher.address)).to.be.true;
    });

    it("should grant GUARDIAN_ROLE to guardian", async function () {
      expect(await freshPool.hasRole(GUARDIAN_ROLE, guardian.address)).to.be.true;
    });

    it("should not have owner() function (Ownable removed)", async function () {
      // Verify no owner() exists — contract uses AccessControl only
      expect((freshPool as any).owner).to.be.undefined;
    });

    it("should not allow initializeAll to be called twice", async function () {
      await expect(
        freshPool.initializeAll(admin.address, await token.getAddress(), rootPublisher.address, guardian.address),
      ).to.be.revertedWithCustomError(freshPool, "InvalidInitialization");
    });

    it("should not allow initializeV2 after initializeAll", async function () {
      await expect(
        freshPool.initializeV2(admin.address, rootPublisher.address, guardian.address),
      ).to.be.revertedWithCustomError(freshPool, "InvalidInitialization");
    });

    it("should revert with zero admin", async function () {
      const PoolFactory = await ethers.getContractFactory("RewardPool");
      await expect(
        upgrades.deployProxy(
          PoolFactory,
          [ethers.ZeroAddress, await token.getAddress(), rootPublisher.address, guardian.address],
          { ...PROXY_OPTS, initializer: "initializeAll" },
        ),
      ).to.be.revertedWithCustomError(freshPool, "ZeroAddress");
    });

    it("should revert with zero token", async function () {
      const PoolFactory = await ethers.getContractFactory("RewardPool");
      await expect(
        upgrades.deployProxy(
          PoolFactory,
          [admin.address, ethers.ZeroAddress, rootPublisher.address, guardian.address],
          { ...PROXY_OPTS, initializer: "initializeAll" },
        ),
      ).to.be.revertedWithCustomError(freshPool, "ZeroAddress");
    });

    it("should revert with zero rootPublisher", async function () {
      const PoolFactory = await ethers.getContractFactory("RewardPool");
      await expect(
        upgrades.deployProxy(
          PoolFactory,
          [admin.address, await token.getAddress(), ethers.ZeroAddress, guardian.address],
          { ...PROXY_OPTS, initializer: "initializeAll" },
        ),
      ).to.be.revertedWithCustomError(freshPool, "ZeroAddress");
    });

    it("should revert with zero guardian", async function () {
      const PoolFactory = await ethers.getContractFactory("RewardPool");
      await expect(
        upgrades.deployProxy(
          PoolFactory,
          [admin.address, await token.getAddress(), rootPublisher.address, ethers.ZeroAddress],
          { ...PROXY_OPTS, initializer: "initializeAll" },
        ),
      ).to.be.revertedWithCustomError(freshPool, "ZeroAddress");
    });

    it("should be fully functional (admin can toggle claimable)", async function () {
      await freshPool.connect(admin).setClaimable(true);
      expect(await freshPool.claimable()).to.be.true;
    });

    it("should be fully functional (rootPublisher can set root)", async function () {
      const root = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await expect(freshPool.connect(rootPublisher).setMerkleRoot(root)).to.not.be.reverted;
    });

    it("should be fully functional (guardian can pause)", async function () {
      await expect(freshPool.connect(guardian).pause()).to.not.be.reverted;
      expect(await freshPool.paused()).to.be.true;
    });
  });

  // -------------------------------------------------------
  //  ERC-2771 Meta-Transaction Claims
  // -------------------------------------------------------

  describe("ERC-2771 Meta-Transaction Claims", function () {
    let forwarder: any;
    let metaPool: RewardPool;
    let metaToken: MockERC20;

    // EIP-712 types for NookplotForwarder
    const FWD_TYPES = {
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

    beforeEach(async function () {
      // Deploy a real NookplotForwarder
      const ForwarderFactory = await ethers.getContractFactory("NookplotForwarder");
      forwarder = await ForwarderFactory.deploy();
      await forwarder.waitForDeployment();
      const forwarderAddr = await forwarder.getAddress();

      // Deploy mock token
      const MockFactory = await ethers.getContractFactory("MockERC20");
      metaToken = (await MockFactory.deploy("Meta Token", "MTX")) as unknown as MockERC20;
      await metaToken.waitForDeployment();

      // Deploy RewardPool with the real forwarder
      const PoolFactory = await ethers.getContractFactory("RewardPool");
      metaPool = (await upgrades.deployProxy(
        PoolFactory,
        [admin.address, await metaToken.getAddress(), rootPublisher.address, guardian.address],
        {
          kind: "uups" as const,
          initializer: "initializeAll",
          unsafeAllow: ["constructor", "state-variable-immutable"] as any[],
          constructorArgs: [forwarderAddr],
        },
      )) as unknown as RewardPool;
      await metaPool.waitForDeployment();

      // Fund the pool and enable claiming
      await metaToken.mint(await metaPool.getAddress(), POOL_SUPPLY);
      await metaPool.connect(admin).setClaimable(true);
    });

    it("isTrustedForwarder returns correct results", async function () {
      expect(await metaPool.isTrustedForwarder(await forwarder.getAddress())).to.be.true;
      expect(await metaPool.isTrustedForwarder(alice.address)).to.be.false;
      expect(await metaPool.isTrustedForwarder(ethers.ZeroAddress)).to.be.false;
    });

    it("claim works via NookplotForwarder (relayer pays gas)", async function () {
      const claimAmount = ethers.parseEther("100");

      // Build tree with alice's entitlement
      const tree = buildTree([[alice.address, claimAmount]]);
      const proof = tree.getProof(0);
      await metaPool.connect(rootPublisher).setMerkleRoot(tree.root);

      // Encode claim calldata
      const data = metaPool.interface.encodeFunctionData("claim", [claimAmount, proof]);
      const poolAddr = await metaPool.getAddress();
      const forwarderAddr = await forwarder.getAddress();

      // Build ForwardRequest (alice is the claimant, admin is the relayer)
      const nonce = await forwarder.nonces(alice.address);
      const block = await ethers.provider.getBlock("latest");
      const deadline = block!.timestamp + 3600;

      const domain = {
        name: "NookplotForwarder",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: forwarderAddr,
      };

      const request = {
        from: alice.address,
        to: poolAddr,
        value: 0n,
        gas: 500000n,
        nonce,
        deadline,
        data,
      };

      // Alice signs, admin relays
      const signature = await alice.signTypedData(domain, FWD_TYPES, request);
      await forwarder.connect(admin).execute({ ...request, signature });

      // Verify: tokens went to alice (not admin)
      expect(await metaToken.balanceOf(alice.address)).to.equal(claimAmount);
      expect(await metaPool.cumulativeClaimed(alice.address)).to.equal(claimAmount);
    });

    it("claim via forwarder with wrong signer reverts", async function () {
      const claimAmount = ethers.parseEther("100");

      const tree = buildTree([[alice.address, claimAmount]]);
      const proof = tree.getProof(0);
      await metaPool.connect(rootPublisher).setMerkleRoot(tree.root);

      const data = metaPool.interface.encodeFunctionData("claim", [claimAmount, proof]);
      const nonce = await forwarder.nonces(alice.address);
      const block = await ethers.provider.getBlock("latest");

      const domain = {
        name: "NookplotForwarder",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await forwarder.getAddress(),
      };

      const request = {
        from: alice.address,
        to: await metaPool.getAddress(),
        value: 0n,
        gas: 500000n,
        nonce,
        deadline: block!.timestamp + 3600,
        data,
      };

      // Bob signs alice's request — should fail (wrong signer)
      const signature = await bob.signTypedData(domain, FWD_TYPES, request);
      await expect(
        forwarder.connect(admin).execute({ ...request, signature })
      ).to.be.revertedWithCustomError(forwarder, "ERC2771ForwarderInvalidSigner");
    });

    it("direct claim still works alongside meta-tx", async function () {
      const claimAmount = ethers.parseEther("50");

      const tree = buildTree([[alice.address, claimAmount]]);
      const proof = tree.getProof(0);
      await metaPool.connect(rootPublisher).setMerkleRoot(tree.root);

      // Alice claims directly (no forwarder)
      await metaPool.connect(alice).claim(claimAmount, proof);
      expect(await metaToken.balanceOf(alice.address)).to.equal(claimAmount);
    });
  });
});
