import { expect } from "chai";
import { ethers } from "hardhat";
import {
  AgentRegistry,
  ServiceMarketplace,
  NookplotForwarder,
} from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Tests for ServiceMarketplace.initializeAll() — the combined V1–V6
 * atomic initializer used for fresh proxy deploys.
 */
describe("ServiceMarketplace — initializeAll", function () {
  let registry: AgentRegistry;
  let forwarder: NookplotForwarder;
  let owner: SignerWithAddress;
  let treasury: SignerWithAddress;
  let guardian: SignerWithAddress;
  let attacker: SignerWithAddress;
  let provider: SignerWithAddress;
  let buyer: SignerWithAddress;

  const DID_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const METADATA_CID = "QmServiceMetadataCidForTesting1234567890abcde";
  const TERMS_CID = "QmTermsDocumentCidForServiceAgreement1234567890";

  const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
  const GUARDIAN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GUARDIAN_ROLE"));

  // Synthetic token addresses for testing
  const USDC = "0x1111111111111111111111111111111111111111";
  const NOOK = "0x2222222222222222222222222222222222222222";

  let forwarderAddress: string;
  let registryAddress: string;

  beforeEach(async function () {
    [owner, treasury, guardian, attacker, provider, buyer] =
      await ethers.getSigners();

    const ForwarderFactory = await ethers.getContractFactory("NookplotForwarder");
    forwarder = (await ForwarderFactory.deploy()) as unknown as NookplotForwarder;
    await forwarder.waitForDeployment();
    forwarderAddress = await forwarder.getAddress();

    const RegistryFactory = await ethers.getContractFactory("AgentRegistry");
    registry = (await (await import("hardhat")).upgrades.deployProxy(
      RegistryFactory,
      [owner.address, treasury.address],
      {
        kind: "uups",
        constructorArgs: [forwarderAddress],
        unsafeAllow: ["constructor", "state-variable-immutable"],
      }
    )) as unknown as AgentRegistry;
    await registry.waitForDeployment();
    registryAddress = await registry.getAddress();
  });

  /**
   * Helper: deploy a fresh ServiceMarketplace proxy using initializeAll.
   * Mirrors the production deploy script pattern (manual impl + ERC1967Proxy).
   */
  async function deployWithInitializeAll(
    admin: string,
    guardianAddr: string,
    agentRegistry: string,
    treasuryAddr: string,
    usdc: string,
    nook: string,
  ): Promise<ServiceMarketplace> {
    const Factory = await ethers.getContractFactory("ServiceMarketplace");
    const impl = await Factory.deploy(forwarderAddress);
    await impl.waitForDeployment();
    const implAddress = await impl.getAddress();

    const initData = Factory.interface.encodeFunctionData("initializeAll", [
      admin, guardianAddr, agentRegistry, treasuryAddr, usdc, nook,
    ]);

    const ProxyFactory = await ethers.getContractFactory(
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy"
    );
    const proxy = await ProxyFactory.deploy(implAddress, initData);
    await proxy.waitForDeployment();

    return Factory.attach(await proxy.getAddress()) as unknown as ServiceMarketplace;
  }

  // ── Core state verification ────────────────────────────────────────

  describe("State after initializeAll", function () {
    let marketplace: ServiceMarketplace;

    beforeEach(async function () {
      marketplace = await deployWithInitializeAll(
        owner.address, guardian.address, registryAddress,
        treasury.address, USDC, NOOK,
      );
    });

    it("should grant DEFAULT_ADMIN_ROLE to admin", async function () {
      expect(await marketplace.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;
    });

    it("should grant GUARDIAN_ROLE to guardian", async function () {
      expect(await marketplace.hasRole(GUARDIAN_ROLE, guardian.address)).to.be.true;
    });

    it("should set owner() to address(0) (Ownable not initialized)", async function () {
      expect(await marketplace.owner()).to.equal(ethers.ZeroAddress);
    });

    it("should set agentRegistry correctly", async function () {
      expect(await marketplace.agentRegistry()).to.equal(registryAddress);
    });

    it("should set treasury correctly", async function () {
      expect(await marketplace.treasury()).to.equal(treasury.address);
    });

    it("should whitelist USDC", async function () {
      expect(await marketplace.allowedTokens(USDC)).to.be.true;
    });

    it("should whitelist NOOK", async function () {
      expect(await marketplace.allowedTokens(NOOK)).to.be.true;
    });

    it("should set deliveryGracePeriod to 14 days", async function () {
      expect(await marketplace.deliveryGracePeriod()).to.equal(14 * 24 * 60 * 60);
    });

    it("should set cancellationFeeBps to 500 (5%)", async function () {
      expect(await marketplace.cancellationFeeBps()).to.equal(500);
    });

    it("should set disputeTimeoutPeriod to 30 days", async function () {
      expect(await marketplace.disputeTimeoutPeriod()).to.equal(30 * 24 * 60 * 60);
    });

    it("should leave platformFeeBps at 0", async function () {
      expect(await marketplace.platformFeeBps()).to.equal(0);
    });

    it("should allow admin to set platformFeeBps", async function () {
      await marketplace.connect(owner).setPlatformFeeBps(250);
      expect(await marketplace.platformFeeBps()).to.equal(250);
    });

    it("should allow admin to pause/unpause", async function () {
      await marketplace.connect(owner).pause();
      expect(await marketplace.paused()).to.be.true;
      await marketplace.connect(owner).unpause();
      expect(await marketplace.paused()).to.be.false;
    });

    it("should allow guardian to pause", async function () {
      await marketplace.connect(guardian).pause();
      expect(await marketplace.paused()).to.be.true;
    });
  });

  // ── Same admin and guardian ────────────────────────────────────────

  describe("admin == guardian (production pattern)", function () {
    it("should grant both roles to same address", async function () {
      const marketplace = await deployWithInitializeAll(
        owner.address, owner.address, registryAddress,
        treasury.address, USDC, NOOK,
      );
      expect(await marketplace.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;
      expect(await marketplace.hasRole(GUARDIAN_ROLE, owner.address)).to.be.true;
    });
  });

  // ── Re-initialization protection ──────────────────────────────────

  describe("Re-initialization blocked", function () {
    let marketplace: ServiceMarketplace;

    beforeEach(async function () {
      marketplace = await deployWithInitializeAll(
        owner.address, guardian.address, registryAddress,
        treasury.address, USDC, NOOK,
      );
    });

    it("should revert on second initializeAll call", async function () {
      await expect(
        marketplace.initializeAll(
          attacker.address, attacker.address, registryAddress,
          treasury.address, USDC, NOOK,
        )
      ).to.be.reverted;
    });

    it("should revert on initialize (V1)", async function () {
      await expect(
        marketplace.initialize(attacker.address, registryAddress, treasury.address)
      ).to.be.reverted;
    });

    it("should revert on initializeV2", async function () {
      await expect(
        marketplace.initializeV2(USDC, NOOK)
      ).to.be.reverted;
    });

    it("should revert on initializeV3", async function () {
      await expect(
        marketplace.initializeV3(attacker.address, attacker.address)
      ).to.be.reverted;
    });

    it("should revert on initializeV4", async function () {
      await expect(marketplace.initializeV4()).to.be.reverted;
    });

    it("should revert on initializeV5", async function () {
      await expect(marketplace.initializeV5()).to.be.reverted;
    });

    it("should revert on initializeV6", async function () {
      await expect(marketplace.initializeV6()).to.be.reverted;
    });
  });

  // ── Input validation ──────────────────────────────────────────────

  describe("Input validation", function () {
    it("should revert if admin is address(0)", async function () {
      await expect(
        deployWithInitializeAll(
          ethers.ZeroAddress, guardian.address, registryAddress,
          treasury.address, USDC, NOOK,
        )
      ).to.be.reverted;
    });

    it("should revert if agentRegistry is address(0)", async function () {
      await expect(
        deployWithInitializeAll(
          owner.address, guardian.address, ethers.ZeroAddress,
          treasury.address, USDC, NOOK,
        )
      ).to.be.reverted;
    });

    it("should revert if treasury is address(0)", async function () {
      await expect(
        deployWithInitializeAll(
          owner.address, guardian.address, registryAddress,
          ethers.ZeroAddress, USDC, NOOK,
        )
      ).to.be.reverted;
    });

    it("should allow guardian to be address(0) (no guardian)", async function () {
      const marketplace = await deployWithInitializeAll(
        owner.address, ethers.ZeroAddress, registryAddress,
        treasury.address, USDC, NOOK,
      );
      expect(await marketplace.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;
      // No one should have GUARDIAN_ROLE
      expect(await marketplace.hasRole(GUARDIAN_ROLE, owner.address)).to.be.false;
    });

    it("should allow USDC to be address(0) (no USDC whitelisted)", async function () {
      const marketplace = await deployWithInitializeAll(
        owner.address, guardian.address, registryAddress,
        treasury.address, ethers.ZeroAddress, NOOK,
      );
      expect(await marketplace.allowedTokens(USDC)).to.be.false;
      expect(await marketplace.allowedTokens(NOOK)).to.be.true;
    });

    it("should allow NOOK to be address(0) (no NOOK whitelisted)", async function () {
      const marketplace = await deployWithInitializeAll(
        owner.address, guardian.address, registryAddress,
        treasury.address, USDC, ethers.ZeroAddress,
      );
      expect(await marketplace.allowedTokens(USDC)).to.be.true;
      expect(await marketplace.allowedTokens(NOOK)).to.be.false;
    });
  });

  // ── Functional: marketplace works after initializeAll ─────────────

  describe("Marketplace functionality after initializeAll", function () {
    let marketplace: ServiceMarketplace;

    beforeEach(async function () {
      marketplace = await deployWithInitializeAll(
        owner.address, guardian.address, registryAddress,
        treasury.address, USDC, NOOK,
      );
      // Register agents
      await registry.connect(provider).register(DID_CID);
      await registry.connect(buyer).register(DID_CID);
    });

    it("should allow listing a service", async function () {
      await marketplace.connect(provider).listService(METADATA_CID, "research", 0, 100);
      const listing = await marketplace.getListing(0);
      expect(listing.provider).to.equal(provider.address);
      expect(listing.metadataCid).to.equal(METADATA_CID);
    });

    it("should allow creating an agreement (no escrow)", async function () {
      await marketplace.connect(provider).listService(METADATA_CID, "research", 0, 100);

      const block = await ethers.provider.getBlock("latest");
      const deadline = block!.timestamp + 86400;

      await marketplace.connect(buyer).createAgreement(
        0, TERMS_CID, deadline, 0, ethers.ZeroAddress,
      );

      const agreement = await marketplace.getAgreement(0);
      expect(agreement.buyer).to.equal(buyer.address);
      expect(agreement.provider).to.equal(provider.address);
    });

    it("should allow admin to upgrade (UUPS)", async function () {
      const Factory = await ethers.getContractFactory("ServiceMarketplace");
      const newImpl = await Factory.deploy(forwarderAddress);
      await newImpl.waitForDeployment();

      // Admin can upgrade via DEFAULT_ADMIN_ROLE
      await marketplace.connect(owner).upgradeToAndCall(
        await newImpl.getAddress(), "0x",
      );
    });

    it("should reject upgrade from non-admin", async function () {
      const Factory = await ethers.getContractFactory("ServiceMarketplace");
      const newImpl = await Factory.deploy(forwarderAddress);
      await newImpl.waitForDeployment();

      await expect(
        marketplace.connect(attacker).upgradeToAndCall(
          await newImpl.getAddress(), "0x",
        )
      ).to.be.reverted;
    });
  });

  // ── Equivalence: initializeAll produces same state as sequential ──

  describe("Equivalence with sequential V1–V6 init", function () {
    it("should produce identical state", async function () {
      // Deploy with initializeAll
      const atomicMarketplace = await deployWithInitializeAll(
        owner.address, guardian.address, registryAddress,
        treasury.address, USDC, NOOK,
      );

      // Deploy with sequential V1 → V6 (using upgrades plugin for V1)
      const Factory = await ethers.getContractFactory("ServiceMarketplace");
      const seqMarketplace = (await (await import("hardhat")).upgrades.deployProxy(
        Factory,
        [owner.address, registryAddress, treasury.address],
        {
          kind: "uups",
          constructorArgs: [forwarderAddress],
          unsafeAllow: ["constructor", "state-variable-immutable"],
        }
      )) as unknown as ServiceMarketplace;
      await seqMarketplace.waitForDeployment();
      await seqMarketplace.initializeV2(USDC, NOOK);
      await seqMarketplace.initializeV3(owner.address, guardian.address);
      await seqMarketplace.initializeV4();
      await seqMarketplace.initializeV5();
      await seqMarketplace.initializeV6();

      // Compare all state
      expect(await atomicMarketplace.hasRole(DEFAULT_ADMIN_ROLE, owner.address))
        .to.equal(await seqMarketplace.hasRole(DEFAULT_ADMIN_ROLE, owner.address));
      expect(await atomicMarketplace.hasRole(GUARDIAN_ROLE, guardian.address))
        .to.equal(await seqMarketplace.hasRole(GUARDIAN_ROLE, guardian.address));
      expect(await atomicMarketplace.owner())
        .to.equal(await seqMarketplace.owner());
      expect(await atomicMarketplace.treasury())
        .to.equal(await seqMarketplace.treasury());
      expect(await atomicMarketplace.agentRegistry())
        .to.equal(await seqMarketplace.agentRegistry());
      expect(await atomicMarketplace.allowedTokens(USDC))
        .to.equal(await seqMarketplace.allowedTokens(USDC));
      expect(await atomicMarketplace.allowedTokens(NOOK))
        .to.equal(await seqMarketplace.allowedTokens(NOOK));
      expect(await atomicMarketplace.deliveryGracePeriod())
        .to.equal(await seqMarketplace.deliveryGracePeriod());
      expect(await atomicMarketplace.cancellationFeeBps())
        .to.equal(await seqMarketplace.cancellationFeeBps());
      expect(await atomicMarketplace.disputeTimeoutPeriod())
        .to.equal(await seqMarketplace.disputeTimeoutPeriod());
      expect(await atomicMarketplace.platformFeeBps())
        .to.equal(await seqMarketplace.platformFeeBps());
    });
  });
});
