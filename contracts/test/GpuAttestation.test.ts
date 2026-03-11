import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { GpuAttestation } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("GpuAttestation", function () {
  let gpuAttestation: GpuAttestation;
  let owner: SignerWithAddress;
  let provider1: SignerWithAddress;
  let provider2: SignerWithAddress;
  let randomUser: SignerWithAddress;

  const BENCHMARK_HASH = ethers.keccak256(ethers.toUtf8Bytes("benchmark-output-v1"));
  const BENCHMARK_HASH_2 = ethers.keccak256(ethers.toUtf8Bytes("benchmark-output-v2"));
  const GPU_MODEL = "NVIDIA A100 40GB";
  const VRAM_GB = 40;
  const COMPUTE_CAP = "8.0";
  const CUDA_VER = "12.1";

  beforeEach(async function () {
    [owner, provider1, provider2, randomUser] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("GpuAttestation");
    gpuAttestation = (await upgrades.deployProxy(
      Factory,
      [owner.address],
      { kind: "uups" },
    )) as unknown as GpuAttestation;
    await gpuAttestation.waitForDeployment();
  });

  // ============================================================
  //  submitAttestation
  // ============================================================

  describe("submitAttestation", function () {
    it("should submit a valid attestation", async function () {
      await expect(
        gpuAttestation.connect(provider1).submitAttestation(
          BENCHMARK_HASH, GPU_MODEL, VRAM_GB, COMPUTE_CAP, CUDA_VER,
        ),
      )
        .to.emit(gpuAttestation, "AttestationSubmitted")
        .withArgs(
          provider1.address,
          BENCHMARK_HASH,
          GPU_MODEL,
          VRAM_GB,
          COMPUTE_CAP,
          CUDA_VER,
          (v: bigint) => v > 0,
        );

      expect(await gpuAttestation.attestationCount()).to.equal(1);

      const att = await gpuAttestation.getAttestation(provider1.address);
      expect(att.benchmarkHash).to.equal(BENCHMARK_HASH);
      expect(att.gpuModel).to.equal(GPU_MODEL);
      expect(att.vramGb).to.equal(VRAM_GB);
      expect(att.computeCapability).to.equal(COMPUTE_CAP);
      expect(att.cudaVersion).to.equal(CUDA_VER);
      expect(att.active).to.be.true;
    });

    it("should revert on zero hash", async function () {
      await expect(
        gpuAttestation.connect(provider1).submitAttestation(
          ethers.ZeroHash, GPU_MODEL, VRAM_GB, COMPUTE_CAP, CUDA_VER,
        ),
      ).to.be.revertedWithCustomError(gpuAttestation, "ZeroHash");
    });

    it("should revert on empty model", async function () {
      await expect(
        gpuAttestation.connect(provider1).submitAttestation(
          BENCHMARK_HASH, "", VRAM_GB, COMPUTE_CAP, CUDA_VER,
        ),
      ).to.be.revertedWithCustomError(gpuAttestation, "EmptyModel");
    });

    it("should revert on zero VRAM", async function () {
      await expect(
        gpuAttestation.connect(provider1).submitAttestation(
          BENCHMARK_HASH, GPU_MODEL, 0, COMPUTE_CAP, CUDA_VER,
        ),
      ).to.be.revertedWithCustomError(gpuAttestation, "ZeroVram");
    });

    it("should revert if already attested", async function () {
      await gpuAttestation.connect(provider1).submitAttestation(
        BENCHMARK_HASH, GPU_MODEL, VRAM_GB, COMPUTE_CAP, CUDA_VER,
      );
      await expect(
        gpuAttestation.connect(provider1).submitAttestation(
          BENCHMARK_HASH_2, GPU_MODEL, VRAM_GB, COMPUTE_CAP, CUDA_VER,
        ),
      ).to.be.revertedWithCustomError(gpuAttestation, "AlreadyAttested");
    });

    it("should allow different providers to attest independently", async function () {
      await gpuAttestation.connect(provider1).submitAttestation(
        BENCHMARK_HASH, GPU_MODEL, VRAM_GB, COMPUTE_CAP, CUDA_VER,
      );
      await gpuAttestation.connect(provider2).submitAttestation(
        BENCHMARK_HASH_2, "NVIDIA H100 80GB", 80, "9.0", "12.4",
      );

      expect(await gpuAttestation.attestationCount()).to.equal(2);
      const att1 = await gpuAttestation.getAttestation(provider1.address);
      const att2 = await gpuAttestation.getAttestation(provider2.address);
      expect(att1.gpuModel).to.equal(GPU_MODEL);
      expect(att2.gpuModel).to.equal("NVIDIA H100 80GB");
    });
  });

  // ============================================================
  //  updateAttestation
  // ============================================================

  describe("updateAttestation", function () {
    beforeEach(async function () {
      await gpuAttestation.connect(provider1).submitAttestation(
        BENCHMARK_HASH, GPU_MODEL, VRAM_GB, COMPUTE_CAP, CUDA_VER,
      );
    });

    it("should update benchmark hash and timestamp", async function () {
      const attBefore = await gpuAttestation.getAttestation(provider1.address);

      // Advance time
      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        gpuAttestation.connect(provider1).updateAttestation(BENCHMARK_HASH_2),
      )
        .to.emit(gpuAttestation, "AttestationUpdated")
        .withArgs(provider1.address, BENCHMARK_HASH_2, (v: bigint) => v > 0);

      const attAfter = await gpuAttestation.getAttestation(provider1.address);
      expect(attAfter.benchmarkHash).to.equal(BENCHMARK_HASH_2);
      expect(attAfter.attestedAt).to.be.greaterThan(attBefore.attestedAt);
      // GPU model unchanged
      expect(attAfter.gpuModel).to.equal(GPU_MODEL);
    });

    it("should revert on zero hash", async function () {
      await expect(
        gpuAttestation.connect(provider1).updateAttestation(ethers.ZeroHash),
      ).to.be.revertedWithCustomError(gpuAttestation, "ZeroHash");
    });

    it("should revert if no attestation exists", async function () {
      await expect(
        gpuAttestation.connect(randomUser).updateAttestation(BENCHMARK_HASH),
      ).to.be.revertedWithCustomError(gpuAttestation, "NoAttestation");
    });

    it("should revert if attestation is revoked", async function () {
      await gpuAttestation.connect(provider1).revokeAttestation();
      await expect(
        gpuAttestation.connect(provider1).updateAttestation(BENCHMARK_HASH_2),
      ).to.be.revertedWithCustomError(gpuAttestation, "NotActive");
    });
  });

  // ============================================================
  //  revokeAttestation
  // ============================================================

  describe("revokeAttestation", function () {
    beforeEach(async function () {
      await gpuAttestation.connect(provider1).submitAttestation(
        BENCHMARK_HASH, GPU_MODEL, VRAM_GB, COMPUTE_CAP, CUDA_VER,
      );
    });

    it("should revoke an active attestation", async function () {
      await expect(gpuAttestation.connect(provider1).revokeAttestation())
        .to.emit(gpuAttestation, "AttestationRevoked")
        .withArgs(provider1.address, (v: bigint) => v > 0);

      const att = await gpuAttestation.attestations(provider1.address);
      expect(att.active).to.be.false;
    });

    it("should revert if no attestation exists", async function () {
      await expect(
        gpuAttestation.connect(randomUser).revokeAttestation(),
      ).to.be.revertedWithCustomError(gpuAttestation, "NoAttestation");
    });

    it("should revert if already revoked", async function () {
      await gpuAttestation.connect(provider1).revokeAttestation();
      await expect(
        gpuAttestation.connect(provider1).revokeAttestation(),
      ).to.be.revertedWithCustomError(gpuAttestation, "NotActive");
    });
  });

  // ============================================================
  //  View functions
  // ============================================================

  describe("getAttestation", function () {
    it("should revert for non-existent provider", async function () {
      await expect(
        gpuAttestation.getAttestation(randomUser.address),
      ).to.be.revertedWithCustomError(gpuAttestation, "NoAttestation");
    });
  });

  describe("isAttestationValid", function () {
    beforeEach(async function () {
      await gpuAttestation.connect(provider1).submitAttestation(
        BENCHMARK_HASH, GPU_MODEL, VRAM_GB, COMPUTE_CAP, CUDA_VER,
      );
    });

    it("should return true for active attestation with no age check", async function () {
      expect(await gpuAttestation.isAttestationValid(provider1.address, 0)).to.be.true;
    });

    it("should return true for fresh attestation within max age", async function () {
      expect(await gpuAttestation.isAttestationValid(provider1.address, 86400)).to.be.true;
    });

    it("should return false for expired attestation", async function () {
      // Advance 2 days
      await ethers.provider.send("evm_increaseTime", [172800]);
      await ethers.provider.send("evm_mine", []);

      // Check with 1-day max age
      expect(await gpuAttestation.isAttestationValid(provider1.address, 86400)).to.be.false;
    });

    it("should return false for revoked attestation", async function () {
      await gpuAttestation.connect(provider1).revokeAttestation();
      expect(await gpuAttestation.isAttestationValid(provider1.address, 0)).to.be.false;
    });

    it("should return false for non-existent provider", async function () {
      expect(await gpuAttestation.isAttestationValid(randomUser.address, 0)).to.be.false;
    });
  });

  describe("hasAttestation", function () {
    it("should return false for new address", async function () {
      expect(await gpuAttestation.hasAttestation(randomUser.address)).to.be.false;
    });

    it("should return true after attestation", async function () {
      await gpuAttestation.connect(provider1).submitAttestation(
        BENCHMARK_HASH, GPU_MODEL, VRAM_GB, COMPUTE_CAP, CUDA_VER,
      );
      expect(await gpuAttestation.hasAttestation(provider1.address)).to.be.true;
    });

    it("should return true even after revocation", async function () {
      await gpuAttestation.connect(provider1).submitAttestation(
        BENCHMARK_HASH, GPU_MODEL, VRAM_GB, COMPUTE_CAP, CUDA_VER,
      );
      await gpuAttestation.connect(provider1).revokeAttestation();
      expect(await gpuAttestation.hasAttestation(provider1.address)).to.be.true;
    });
  });

  // ============================================================
  //  Pause
  // ============================================================

  describe("pause / unpause", function () {
    it("should prevent submitAttestation when paused", async function () {
      await gpuAttestation.connect(owner).pause();
      await expect(
        gpuAttestation.connect(provider1).submitAttestation(
          BENCHMARK_HASH, GPU_MODEL, VRAM_GB, COMPUTE_CAP, CUDA_VER,
        ),
      ).to.be.revertedWithCustomError(gpuAttestation, "EnforcedPause");
    });

    it("should prevent updateAttestation when paused", async function () {
      await gpuAttestation.connect(provider1).submitAttestation(
        BENCHMARK_HASH, GPU_MODEL, VRAM_GB, COMPUTE_CAP, CUDA_VER,
      );
      await gpuAttestation.connect(owner).pause();
      await expect(
        gpuAttestation.connect(provider1).updateAttestation(BENCHMARK_HASH_2),
      ).to.be.revertedWithCustomError(gpuAttestation, "EnforcedPause");
    });

    it("should allow revokeAttestation even when paused", async function () {
      await gpuAttestation.connect(provider1).submitAttestation(
        BENCHMARK_HASH, GPU_MODEL, VRAM_GB, COMPUTE_CAP, CUDA_VER,
      );
      await gpuAttestation.connect(owner).pause();
      // revokeAttestation has no whenNotPaused — providers can always exit
      await expect(gpuAttestation.connect(provider1).revokeAttestation())
        .to.emit(gpuAttestation, "AttestationRevoked");
    });

    it("should resume after unpause", async function () {
      await gpuAttestation.connect(owner).pause();
      await gpuAttestation.connect(owner).unpause();
      await expect(
        gpuAttestation.connect(provider1).submitAttestation(
          BENCHMARK_HASH, GPU_MODEL, VRAM_GB, COMPUTE_CAP, CUDA_VER,
        ),
      ).to.emit(gpuAttestation, "AttestationSubmitted");
    });

    it("should only allow owner to pause", async function () {
      await expect(
        gpuAttestation.connect(provider1).pause(),
      ).to.be.revertedWithCustomError(gpuAttestation, "OwnableUnauthorizedAccount");
    });
  });

  // ============================================================
  //  UUPS Upgrade
  // ============================================================

  describe("UUPS upgrade", function () {
    it("should preserve state after upgrade", async function () {
      await gpuAttestation.connect(provider1).submitAttestation(
        BENCHMARK_HASH, GPU_MODEL, VRAM_GB, COMPUTE_CAP, CUDA_VER,
      );

      const Factory = await ethers.getContractFactory("GpuAttestation");
      const upgraded = (await upgrades.upgradeProxy(
        await gpuAttestation.getAddress(),
        Factory,
      )) as unknown as GpuAttestation;

      expect(await upgraded.attestationCount()).to.equal(1);
      const att = await upgraded.getAttestation(provider1.address);
      expect(att.gpuModel).to.equal(GPU_MODEL);
      expect(att.benchmarkHash).to.equal(BENCHMARK_HASH);
    });

    it("should reject upgrade from non-owner", async function () {
      const Factory = await ethers.getContractFactory("GpuAttestation", provider1);
      await expect(
        upgrades.upgradeProxy(await gpuAttestation.getAddress(), Factory),
      ).to.be.revertedWithCustomError(gpuAttestation, "OwnableUnauthorizedAccount");
    });
  });
});
