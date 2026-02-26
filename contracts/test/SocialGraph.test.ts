import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { AgentRegistry, SocialGraph, NookplotForwarder } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("SocialGraph", function () {
  let registry: AgentRegistry;
  let socialGraph: SocialGraph;
  let forwarder: NookplotForwarder;
  let owner: SignerWithAddress;
  let treasury: SignerWithAddress;
  let agentA: SignerWithAddress;
  let agentB: SignerWithAddress;
  let agentC: SignerWithAddress;
  let nonAgent: SignerWithAddress;

  const DID_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";

  beforeEach(async function () {
    [owner, treasury, agentA, agentB, agentC, nonAgent] =
      await ethers.getSigners();

    // Deploy NookplotForwarder first
    const ForwarderFactory = await ethers.getContractFactory("NookplotForwarder");
    forwarder = (await ForwarderFactory.deploy()) as unknown as NookplotForwarder;
    await forwarder.waitForDeployment();
    const forwarderAddress = await forwarder.getAddress();

    // Deploy AgentRegistry
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

    // Deploy SocialGraph
    const SocialGraphFactory = await ethers.getContractFactory("SocialGraph");
    socialGraph = (await upgrades.deployProxy(
      SocialGraphFactory,
      [owner.address, await registry.getAddress()],
      {
        kind: "uups",
        constructorArgs: [forwarderAddress],
        unsafeAllow: ["constructor", "state-variable-immutable"],
      }
    )) as unknown as SocialGraph;
    await socialGraph.waitForDeployment();

    // Register agents
    await registry.connect(agentA).register(DID_CID);
    await registry.connect(agentB).register(DID_CID);
    await registry.connect(agentC).register(DID_CID);
  });

  // ============================================================
  //                     INITIALIZATION
  // ============================================================

  describe("Initialization", function () {
    it("should set owner correctly", async function () {
      expect(await socialGraph.owner()).to.equal(owner.address);
    });

    it("should set agentRegistry correctly", async function () {
      expect(await socialGraph.agentRegistry()).to.equal(
        await registry.getAddress()
      );
    });

    it("should start in free mode", async function () {
      expect(await socialGraph.paymentToken()).to.equal(ethers.ZeroAddress);
    });

    it("should start with zero attestation stake", async function () {
      expect(await socialGraph.attestationStake()).to.equal(0);
    });
  });

  // ============================================================
  //                     FOLLOW
  // ============================================================

  describe("Follow", function () {
    it("should follow an agent successfully", async function () {
      await expect(socialGraph.connect(agentA).follow(agentB.address))
        .to.emit(socialGraph, "Followed");
    });

    it("should update following and follower counts", async function () {
      await socialGraph.connect(agentA).follow(agentB.address);

      expect(await socialGraph.followingCount(agentA.address)).to.equal(1);
      expect(await socialGraph.followerCount(agentB.address)).to.equal(1);
    });

    it("should report following status correctly", async function () {
      await socialGraph.connect(agentA).follow(agentB.address);

      expect(
        await socialGraph.isFollowing(agentA.address, agentB.address)
      ).to.be.true;
      expect(
        await socialGraph.isFollowing(agentB.address, agentA.address)
      ).to.be.false; // Not reciprocal
    });

    it("should allow following multiple agents", async function () {
      await socialGraph.connect(agentA).follow(agentB.address);
      await socialGraph.connect(agentA).follow(agentC.address);

      expect(await socialGraph.followingCount(agentA.address)).to.equal(2);
    });

    it("should allow mutual follows", async function () {
      await socialGraph.connect(agentA).follow(agentB.address);
      await socialGraph.connect(agentB).follow(agentA.address);

      expect(
        await socialGraph.isFollowing(agentA.address, agentB.address)
      ).to.be.true;
      expect(
        await socialGraph.isFollowing(agentB.address, agentA.address)
      ).to.be.true;
    });

    it("should revert when following self", async function () {
      await expect(
        socialGraph.connect(agentA).follow(agentA.address)
      ).to.be.revertedWithCustomError(socialGraph, "CannotFollowSelf");
    });

    it("should revert when already following", async function () {
      await socialGraph.connect(agentA).follow(agentB.address);
      await expect(
        socialGraph.connect(agentA).follow(agentB.address)
      ).to.be.revertedWithCustomError(socialGraph, "AlreadyFollowing");
    });

    it("should revert when follower is not registered", async function () {
      await expect(
        socialGraph.connect(nonAgent).follow(agentB.address)
      ).to.be.revertedWithCustomError(socialGraph, "NotRegisteredAgent");
    });

    it("should revert when target is not registered", async function () {
      await expect(
        socialGraph.connect(agentA).follow(nonAgent.address)
      ).to.be.revertedWithCustomError(socialGraph, "NotRegisteredAgent");
    });

    it("should revert when paused", async function () {
      await socialGraph.connect(owner).pause();
      await expect(
        socialGraph.connect(agentA).follow(agentB.address)
      ).to.be.revertedWithCustomError(socialGraph, "EnforcedPause");
    });
  });

  // ============================================================
  //                     UNFOLLOW
  // ============================================================

  describe("Unfollow", function () {
    beforeEach(async function () {
      await socialGraph.connect(agentA).follow(agentB.address);
    });

    it("should unfollow successfully", async function () {
      await expect(socialGraph.connect(agentA).unfollow(agentB.address))
        .to.emit(socialGraph, "Unfollowed");
    });

    it("should decrement counts", async function () {
      await socialGraph.connect(agentA).unfollow(agentB.address);

      expect(await socialGraph.followingCount(agentA.address)).to.equal(0);
      expect(await socialGraph.followerCount(agentB.address)).to.equal(0);
    });

    it("should update following status", async function () {
      await socialGraph.connect(agentA).unfollow(agentB.address);
      expect(
        await socialGraph.isFollowing(agentA.address, agentB.address)
      ).to.be.false;
    });

    it("should revert when not following", async function () {
      await expect(
        socialGraph.connect(agentA).unfollow(agentC.address)
      ).to.be.revertedWithCustomError(socialGraph, "NotFollowing");
    });

    it("should allow re-following after unfollow", async function () {
      await socialGraph.connect(agentA).unfollow(agentB.address);
      await socialGraph.connect(agentA).follow(agentB.address);

      expect(
        await socialGraph.isFollowing(agentA.address, agentB.address)
      ).to.be.true;
    });
  });

  // ============================================================
  //                     BLOCK
  // ============================================================

  describe("Block", function () {
    it("should block an agent", async function () {
      await expect(socialGraph.connect(agentA).blockAgent(agentB.address))
        .to.emit(socialGraph, "Blocked");

      expect(
        await socialGraph.isBlocked(agentA.address, agentB.address)
      ).to.be.true;
    });

    it("should automatically unfollow when blocking a followed agent", async function () {
      await socialGraph.connect(agentA).follow(agentB.address);
      expect(await socialGraph.followingCount(agentA.address)).to.equal(1);

      await socialGraph.connect(agentA).blockAgent(agentB.address);

      expect(
        await socialGraph.isFollowing(agentA.address, agentB.address)
      ).to.be.false;
      expect(await socialGraph.followingCount(agentA.address)).to.equal(0);
      expect(await socialGraph.followerCount(agentB.address)).to.equal(0);
    });

    it("should revert when blocking self", async function () {
      await expect(
        socialGraph.connect(agentA).blockAgent(agentA.address)
      ).to.be.revertedWithCustomError(socialGraph, "CannotBlockSelf");
    });

    it("should revert when already blocked", async function () {
      await socialGraph.connect(agentA).blockAgent(agentB.address);
      await expect(
        socialGraph.connect(agentA).blockAgent(agentB.address)
      ).to.be.revertedWithCustomError(socialGraph, "AlreadyBlocked");
    });
  });

  // ============================================================
  //                     UNBLOCK
  // ============================================================

  describe("Unblock", function () {
    beforeEach(async function () {
      await socialGraph.connect(agentA).blockAgent(agentB.address);
    });

    it("should unblock an agent", async function () {
      await expect(socialGraph.connect(agentA).unblockAgent(agentB.address))
        .to.emit(socialGraph, "Unblocked");

      expect(
        await socialGraph.isBlocked(agentA.address, agentB.address)
      ).to.be.false;
    });

    it("should revert when not blocked", async function () {
      await expect(
        socialGraph.connect(agentA).unblockAgent(agentC.address)
      ).to.be.revertedWithCustomError(socialGraph, "NotBlocked");
    });
  });

  // ============================================================
  //                     ATTESTATION
  // ============================================================

  describe("Attestation", function () {
    it("should create an attestation", async function () {
      await expect(
        socialGraph.connect(agentA).attest(agentB.address, "quality-content")
      ).to.emit(socialGraph, "AttestationCreated");
    });

    it("should store attestation data correctly", async function () {
      await socialGraph
        .connect(agentA)
        .attest(agentB.address, "domain-expert");

      const attestation = await socialGraph.getAttestation(
        agentA.address,
        agentB.address
      );
      expect(attestation.attester).to.equal(agentA.address);
      expect(attestation.subject).to.equal(agentB.address);
      expect(attestation.reason).to.equal("domain-expert");
      expect(attestation.stakedAmount).to.equal(0);
      expect(attestation.timestamp).to.be.greaterThan(0);
    });

    it("should increment attestation counts", async function () {
      await socialGraph
        .connect(agentA)
        .attest(agentB.address, "quality-content");

      expect(await socialGraph.attestationCount(agentB.address)).to.equal(1);
      expect(await socialGraph.attestationsGivenCount(agentA.address)).to.equal(
        1
      );
    });

    it("should allow multiple agents to attest for the same subject", async function () {
      await socialGraph
        .connect(agentA)
        .attest(agentB.address, "quality-content");
      await socialGraph
        .connect(agentC)
        .attest(agentB.address, "helpful-agent");

      expect(await socialGraph.attestationCount(agentB.address)).to.equal(2);
    });

    it("should report attestation status correctly", async function () {
      await socialGraph
        .connect(agentA)
        .attest(agentB.address, "quality-content");

      expect(
        await socialGraph.hasAttested(agentA.address, agentB.address)
      ).to.be.true;
      expect(
        await socialGraph.hasAttested(agentB.address, agentA.address)
      ).to.be.false;
    });

    it("should revert when attesting self", async function () {
      await expect(
        socialGraph.connect(agentA).attest(agentA.address, "self-attest")
      ).to.be.revertedWithCustomError(socialGraph, "CannotAttestSelf");
    });

    it("should revert when already attested", async function () {
      await socialGraph
        .connect(agentA)
        .attest(agentB.address, "quality-content");
      await expect(
        socialGraph.connect(agentA).attest(agentB.address, "different-reason")
      ).to.be.revertedWithCustomError(socialGraph, "AlreadyAttested");
    });

    it("should revert when attester is not registered", async function () {
      await expect(
        socialGraph.connect(nonAgent).attest(agentB.address, "fake")
      ).to.be.revertedWithCustomError(socialGraph, "NotRegisteredAgent");
    });

    it("should revert when subject is not registered", async function () {
      await expect(
        socialGraph.connect(agentA).attest(nonAgent.address, "bad")
      ).to.be.revertedWithCustomError(socialGraph, "NotRegisteredAgent");
    });

    it("should revert with very long reason (gas griefing prevention)", async function () {
      const longReason = "a".repeat(201);
      await expect(
        socialGraph.connect(agentA).attest(agentB.address, longReason)
      ).to.be.reverted;
    });
  });

  // ============================================================
  //                   REVOKE ATTESTATION
  // ============================================================

  describe("Revoke Attestation", function () {
    beforeEach(async function () {
      await socialGraph
        .connect(agentA)
        .attest(agentB.address, "quality-content");
    });

    it("should revoke attestation successfully", async function () {
      await expect(
        socialGraph.connect(agentA).revokeAttestation(agentB.address)
      ).to.emit(socialGraph, "AttestationRevoked");
    });

    it("should decrement attestation counts", async function () {
      await socialGraph.connect(agentA).revokeAttestation(agentB.address);

      expect(await socialGraph.attestationCount(agentB.address)).to.equal(0);
      expect(await socialGraph.attestationsGivenCount(agentA.address)).to.equal(
        0
      );
    });

    it("should clear attestation data", async function () {
      await socialGraph.connect(agentA).revokeAttestation(agentB.address);

      expect(
        await socialGraph.hasAttested(agentA.address, agentB.address)
      ).to.be.false;
    });

    it("should revert when no attestation exists", async function () {
      await expect(
        socialGraph.connect(agentA).revokeAttestation(agentC.address)
      ).to.be.revertedWithCustomError(socialGraph, "NotAttested");
    });

    it("should allow re-attesting after revocation", async function () {
      await socialGraph.connect(agentA).revokeAttestation(agentB.address);
      await socialGraph.connect(agentA).attest(agentB.address, "new-reason");

      expect(
        await socialGraph.hasAttested(agentA.address, agentB.address)
      ).to.be.true;
    });
  });

  // ============================================================
  //                     ADMIN FUNCTIONS
  // ============================================================

  describe("Admin Functions", function () {
    it("should update payment token", async function () {
      const addr = "0x0000000000000000000000000000000000000001";
      await expect(socialGraph.connect(owner).setPaymentToken(addr))
        .to.emit(socialGraph, "PaymentTokenUpdated");
    });

    it("should update attestation stake", async function () {
      await expect(socialGraph.connect(owner).setAttestationStake(1000))
        .to.emit(socialGraph, "AttestationStakeUpdated")
        .withArgs(0, 1000);
    });

    it("should update agent registry", async function () {
      await socialGraph.connect(owner).setAgentRegistry(agentB.address);
      expect(await socialGraph.agentRegistry()).to.equal(agentB.address);
    });

    it("should revert zero address for registry", async function () {
      await expect(
        socialGraph.connect(owner).setAgentRegistry(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(socialGraph, "ZeroAddress");
    });

    it("should pause and unpause", async function () {
      await socialGraph.connect(owner).pause();
      expect(await socialGraph.paused()).to.be.true;

      await socialGraph.connect(owner).unpause();
      expect(await socialGraph.paused()).to.be.false;
    });

    it("should revert admin calls from non-owner", async function () {
      await expect(
        socialGraph.connect(agentA).setAttestationStake(100)
      ).to.be.revertedWithCustomError(socialGraph, "OwnableUnauthorizedAccount");
    });
  });

  // ============================================================
  //              META-TRANSACTIONS (ERC-2771)
  // ============================================================

  describe("Meta-Transactions (ERC-2771)", function () {
    let relayer: SignerWithAddress;

    beforeEach(async function () {
      // Use the treasury signer as the relayer (a neutral third party)
      relayer = treasury;
    });

    it("should report the correct trusted forwarder", async function () {
      const forwarderAddress = await forwarder.getAddress();
      expect(await socialGraph.isTrustedForwarder(forwarderAddress)).to.be.true;
      // A random address should not be trusted
      expect(await socialGraph.isTrustedForwarder(nonAgent.address)).to.be.false;
    });

    it("should allow following via meta-transaction", async function () {
      const nonce = await forwarder.nonces(agentA.address);
      const block = await ethers.provider.getBlock("latest");
      const deadline = block!.timestamp + 3600;
      const data = socialGraph.interface.encodeFunctionData("follow", [agentB.address]);

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
      const value = {
        from: agentA.address,
        to: await socialGraph.getAddress(),
        value: 0n,
        gas: 500000n,
        nonce,
        deadline,
        data,
      };
      const signature = await agentA.signTypedData(domain, types, value);

      await forwarder.connect(relayer).execute({ ...value, signature });

      // Verify the follow was recorded as if agentA did it directly
      expect(
        await socialGraph.isFollowing(agentA.address, agentB.address)
      ).to.be.true;
      expect(await socialGraph.followingCount(agentA.address)).to.equal(1);
      expect(await socialGraph.followerCount(agentB.address)).to.equal(1);
    });

    it("should allow attestation via meta-transaction", async function () {
      const nonce = await forwarder.nonces(agentA.address);
      const block = await ethers.provider.getBlock("latest");
      const deadline = block!.timestamp + 3600;
      const data = socialGraph.interface.encodeFunctionData("attest", [
        agentB.address,
        "quality-content",
      ]);

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
      const value = {
        from: agentA.address,
        to: await socialGraph.getAddress(),
        value: 0n,
        gas: 500000n,
        nonce,
        deadline,
        data,
      };
      const signature = await agentA.signTypedData(domain, types, value);

      await forwarder.connect(relayer).execute({ ...value, signature });

      // Verify the attestation was recorded as if agentA did it directly
      expect(
        await socialGraph.hasAttested(agentA.address, agentB.address)
      ).to.be.true;
      expect(await socialGraph.attestationCount(agentB.address)).to.equal(1);
      expect(await socialGraph.attestationsGivenCount(agentA.address)).to.equal(1);

      const attestation = await socialGraph.getAttestation(
        agentA.address,
        agentB.address
      );
      expect(attestation.attester).to.equal(agentA.address);
      expect(attestation.subject).to.equal(agentB.address);
      expect(attestation.reason).to.equal("quality-content");
    });

    it("direct calls still work (backward compatibility)", async function () {
      // A regular follow without meta-transaction should still work
      await socialGraph.connect(agentA).follow(agentB.address);

      expect(
        await socialGraph.isFollowing(agentA.address, agentB.address)
      ).to.be.true;
      expect(await socialGraph.followingCount(agentA.address)).to.equal(1);
      expect(await socialGraph.followerCount(agentB.address)).to.equal(1);
    });
  });

  // ============================================================
  //                        HELPERS
  // ============================================================

  async function getBlockTimestamp(): Promise<number> {
    const block = await ethers.provider.getBlock("latest");
    return block!.timestamp;
  }
});
