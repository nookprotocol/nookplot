import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { AgentRegistry, MockERC20, NookplotForwarder } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("AgentRegistry", function () {
  let registry: AgentRegistry;
  let token: MockERC20;
  let forwarder: NookplotForwarder;
  let owner: SignerWithAddress;
  let treasury: SignerWithAddress;
  let agentA: SignerWithAddress;
  let agentB: SignerWithAddress;
  let nonAgent: SignerWithAddress;

  const DID_CID_A = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const DID_CID_B = "QmZoW9382L1bpNUhPCsBH2LrXceBHg7D3hZxieyU6RYpBa";
  const DID_CID_UPDATED = "QmUpdatedDidDocumentCidForTestingPurposes12345";

  beforeEach(async function () {
    [owner, treasury, agentA, agentB, nonAgent] = await ethers.getSigners();

    // Deploy NookplotForwarder (standalone, not proxied)
    const ForwarderFactory = await ethers.getContractFactory("NookplotForwarder");
    forwarder = (await ForwarderFactory.deploy()) as unknown as NookplotForwarder;
    await forwarder.waitForDeployment();

    const forwarderAddress = await forwarder.getAddress();

    // Deploy AgentRegistry via UUPS proxy with trusted forwarder
    const AgentRegistryFactory = await ethers.getContractFactory("AgentRegistry");
    registry = (await upgrades.deployProxy(
      AgentRegistryFactory,
      [owner.address, treasury.address],
      {
        kind: "uups",
        constructorArgs: [forwarderAddress],
        unsafeAllow: ["constructor", "state-variable-immutable"],
      }
    )) as unknown as AgentRegistry;
    await registry.waitForDeployment();

  });

  // ============================================================
  //                     INITIALIZATION
  // ============================================================

  describe("Initialization", function () {
    it("should have correct owner", async function () {
      expect(await registry.owner()).to.equal(owner.address);
    });

    it("should set the treasury correctly", async function () {
      expect(await registry.treasury()).to.equal(treasury.address);
    });

    it("should start with zero agents", async function () {
      expect(await registry.totalAgents()).to.equal(0);
    });

    it("should start in free mode (no payment token)", async function () {
      expect(await registry.paymentToken()).to.equal(ethers.ZeroAddress);
    });

    it("should start with zero registration stake", async function () {
      expect(await registry.registrationStake()).to.equal(0);
    });

    it("should not be paused initially", async function () {
      expect(await registry.paused()).to.be.false;
    });

    it("should revert if initialized with zero owner", async function () {
      const forwarderAddress = await forwarder.getAddress();
      const Factory = await ethers.getContractFactory("AgentRegistry");
      await expect(
        upgrades.deployProxy(Factory, [ethers.ZeroAddress, treasury.address], {
          kind: "uups",
          constructorArgs: [forwarderAddress],
          unsafeAllow: ["constructor", "state-variable-immutable"],
        })
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("should revert if initialized with zero treasury", async function () {
      const forwarderAddress = await forwarder.getAddress();
      const Factory = await ethers.getContractFactory("AgentRegistry");
      await expect(
        upgrades.deployProxy(Factory, [owner.address, ethers.ZeroAddress], {
          kind: "uups",
          constructorArgs: [forwarderAddress],
          unsafeAllow: ["constructor", "state-variable-immutable"],
        })
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });
  });

  // ============================================================
  //                     REGISTRATION
  // ============================================================

  describe("Registration", function () {
    it("should register an agent successfully", async function () {
      const tx = await registry.connect(agentA).register(DID_CID_A);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      await expect(tx)
        .to.emit(registry, "AgentRegistered")
        .withArgs(agentA.address, DID_CID_A, block!.timestamp);
    });

    it("should increment totalAgents on registration", async function () {
      await registry.connect(agentA).register(DID_CID_A);
      expect(await registry.totalAgents()).to.equal(1);

      await registry.connect(agentB).register(DID_CID_B);
      expect(await registry.totalAgents()).to.equal(2);
    });

    it("should store agent data correctly", async function () {
      await registry.connect(agentA).register(DID_CID_A);
      const agent = await registry.getAgent(agentA.address);

      expect(agent.didCid).to.equal(DID_CID_A);
      expect(agent.isVerified).to.be.false;
      expect(agent.isActive).to.be.true;
      expect(agent.stakedAmount).to.equal(0);
      expect(agent.registeredAt).to.be.greaterThan(0);
      expect(agent.updatedAt).to.equal(agent.registeredAt);
    });

    it("should revert when registering with empty DID CID", async function () {
      await expect(
        registry.connect(agentA).register("")
      ).to.be.revertedWithCustomError(registry, "EmptyString");
    });

    it("should revert when registering twice", async function () {
      await registry.connect(agentA).register(DID_CID_A);
      await expect(
        registry.connect(agentA).register(DID_CID_B)
      ).to.be.revertedWithCustomError(registry, "AlreadyRegistered");
    });

    it("should revert when paused", async function () {
      await registry.connect(owner).pause();
      await expect(
        registry.connect(agentA).register(DID_CID_A)
      ).to.be.revertedWithCustomError(registry, "EnforcedPause");
    });
  });

  // ============================================================
  //                     UPDATE DID
  // ============================================================

  describe("Update DID", function () {
    beforeEach(async function () {
      await registry.connect(agentA).register(DID_CID_A);
    });

    it("should update DID successfully", async function () {
      await expect(registry.connect(agentA).updateDid(DID_CID_UPDATED))
        .to.emit(registry, "AgentUpdated");

      const agent = await registry.getAgent(agentA.address);
      expect(agent.didCid).to.equal(DID_CID_UPDATED);
    });

    it("should update the updatedAt timestamp", async function () {
      const agentBefore = await registry.getAgent(agentA.address);

      // Mine a block to ensure different timestamp
      await ethers.provider.send("evm_mine", []);

      await registry.connect(agentA).updateDid(DID_CID_UPDATED);
      const agentAfter = await registry.getAgent(agentA.address);

      expect(agentAfter.updatedAt).to.be.greaterThanOrEqual(agentBefore.updatedAt);
    });

    it("should revert when updating with empty CID", async function () {
      await expect(
        registry.connect(agentA).updateDid("")
      ).to.be.revertedWithCustomError(registry, "EmptyString");
    });

    it("should revert when caller is not registered", async function () {
      await expect(
        registry.connect(nonAgent).updateDid(DID_CID_UPDATED)
      ).to.be.revertedWithCustomError(registry, "NotRegistered");
    });

    it("should revert when agent is deactivated", async function () {
      await registry.connect(owner).deactivateAgent(agentA.address);
      await expect(
        registry.connect(agentA).updateDid(DID_CID_UPDATED)
      ).to.be.revertedWithCustomError(registry, "NotAuthorized");
    });
  });

  // ============================================================
  //                     VIEW FUNCTIONS
  // ============================================================

  describe("View Functions", function () {
    beforeEach(async function () {
      await registry.connect(agentA).register(DID_CID_A);
    });

    it("isRegistered returns true for registered agents", async function () {
      expect(await registry.isRegistered(agentA.address)).to.be.true;
    });

    it("isRegistered returns false for non-registered addresses", async function () {
      expect(await registry.isRegistered(nonAgent.address)).to.be.false;
    });

    it("isActiveAgent returns true for active registered agents", async function () {
      expect(await registry.isActiveAgent(agentA.address)).to.be.true;
    });

    it("isActiveAgent returns false for deactivated agents", async function () {
      await registry.connect(owner).deactivateAgent(agentA.address);
      expect(await registry.isActiveAgent(agentA.address)).to.be.false;
    });

    it("isActiveAgent returns false for non-registered addresses", async function () {
      expect(await registry.isActiveAgent(nonAgent.address)).to.be.false;
    });

    it("isVerified returns false for unverified agents", async function () {
      expect(await registry.isVerified(agentA.address)).to.be.false;
    });

    it("getDidCid returns the correct CID", async function () {
      expect(await registry.getDidCid(agentA.address)).to.equal(DID_CID_A);
    });

    it("getDidCid reverts for non-registered agents", async function () {
      await expect(
        registry.getDidCid(nonAgent.address)
      ).to.be.revertedWithCustomError(registry, "NotRegistered");
    });

    it("getAgent reverts for non-registered agents", async function () {
      await expect(
        registry.getAgent(nonAgent.address)
      ).to.be.revertedWithCustomError(registry, "NotRegistered");
    });

    it("getStake returns 0 for agents in free mode", async function () {
      expect(await registry.getStake(agentA.address)).to.equal(0);
    });
  });

  // ============================================================
  //                     ADMIN FUNCTIONS
  // ============================================================

  describe("Admin Functions", function () {
    beforeEach(async function () {
      await registry.connect(agentA).register(DID_CID_A);
    });

    describe("setVerified", function () {
      it("should set verification status", async function () {
        await expect(registry.connect(owner).setVerified(agentA.address, true))
          .to.emit(registry, "AgentVerificationChanged");

        expect(await registry.isVerified(agentA.address)).to.be.true;
      });

      it("should unset verification status", async function () {
        await registry.connect(owner).setVerified(agentA.address, true);
        await registry.connect(owner).setVerified(agentA.address, false);
        expect(await registry.isVerified(agentA.address)).to.be.false;
      });

      it("should revert when called by non-owner", async function () {
        await expect(
          registry.connect(agentA).setVerified(agentA.address, true)
        ).to.be.revertedWithCustomError(
          registry, "OwnableUnauthorizedAccount"
        ).withArgs(agentA.address);
      });

      it("should revert for non-registered agents", async function () {
        await expect(
          registry.connect(owner).setVerified(nonAgent.address, true)
        ).to.be.revertedWithCustomError(registry, "NotRegistered");
      });
    });

    describe("deactivateAgent", function () {
      it("should deactivate an agent", async function () {
        await expect(registry.connect(owner).deactivateAgent(agentA.address))
          .to.emit(registry, "AgentDeactivated");

        expect(await registry.isActiveAgent(agentA.address)).to.be.false;
      });

      it("should revert when called by non-owner", async function () {
        await expect(
          registry.connect(agentA).deactivateAgent(agentA.address)
        ).to.be.revertedWithCustomError(
          registry, "OwnableUnauthorizedAccount"
        ).withArgs(agentA.address);
      });
    });

    describe("reactivateAgent", function () {
      it("should reactivate a deactivated agent", async function () {
        await registry.connect(owner).deactivateAgent(agentA.address);
        await expect(registry.connect(owner).reactivateAgent(agentA.address))
          .to.emit(registry, "AgentReactivated");

        expect(await registry.isActiveAgent(agentA.address)).to.be.true;
      });
    });

    describe("setPaymentToken", function () {
      it("should set the payment token", async function () {
        const tokenAddr = "0x0000000000000000000000000000000000000001";
        await expect(registry.connect(owner).setPaymentToken(tokenAddr))
          .to.emit(registry, "PaymentTokenUpdated")
          .withArgs(ethers.ZeroAddress, tokenAddr);
      });

      it("should revert when called by non-owner", async function () {
        await expect(
          registry.connect(agentA).setPaymentToken(ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(
          registry, "OwnableUnauthorizedAccount"
        ).withArgs(agentA.address);
      });
    });

    describe("setRegistrationStake", function () {
      it("should set the registration stake", async function () {
        await expect(registry.connect(owner).setRegistrationStake(1000))
          .to.emit(registry, "RegistrationStakeUpdated")
          .withArgs(0, 1000);
      });
    });

    describe("setTreasury", function () {
      it("should update the treasury address", async function () {
        await registry.connect(owner).setTreasury(agentB.address);
        expect(await registry.treasury()).to.equal(agentB.address);
      });

      it("should revert with zero address", async function () {
        await expect(
          registry.connect(owner).setTreasury(ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(registry, "ZeroAddress");
      });
    });

    describe("Pause/Unpause", function () {
      it("should pause and unpause", async function () {
        await registry.connect(owner).pause();
        expect(await registry.paused()).to.be.true;

        await registry.connect(owner).unpause();
        expect(await registry.paused()).to.be.false;
      });

      it("should prevent registration when paused", async function () {
        await registry.connect(owner).pause();
        await expect(
          registry.connect(agentB).register(DID_CID_B)
        ).to.be.revertedWithCustomError(registry, "EnforcedPause");
      });
    });
  });

  // ============================================================
  //                     TOKEN STAKING
  // ============================================================

  describe("Token Staking", function () {
    let tokenAddress: string;

    beforeEach(async function () {
      // Deploy a mock ERC-20 token for testing
      // In production, this would be the payment token
      const TokenFactory = await ethers.getContractFactory("MockERC20");
      token = (await TokenFactory.deploy("Mock NOOKPLOT", "MNOOK")) as unknown as MockERC20;
      await token.waitForDeployment();
      tokenAddress = await token.getAddress();

      // Mint tokens to agents for testing
      await token.mint(agentA.address, ethers.parseEther("10000"));
      await token.mint(agentB.address, ethers.parseEther("10000"));

      // Set payment token on registry
      await registry.connect(owner).setPaymentToken(tokenAddress);
    });

    it("should require stake on registration when stake is set", async function () {
      const stakeAmount = ethers.parseEther("100");
      await registry.connect(owner).setRegistrationStake(stakeAmount);

      // Approve tokens
      await token.connect(agentA).approve(await registry.getAddress(), stakeAmount);

      // Register
      await registry.connect(agentA).register(DID_CID_A);

      // Check stake was recorded
      expect(await registry.getStake(agentA.address)).to.equal(stakeAmount);

      // Check tokens were transferred
      const agentBalance = await token.balanceOf(agentA.address);
      expect(agentBalance).to.equal(ethers.parseEther("9900")); // 10000 - 100
    });

    it("should allow additional staking", async function () {
      await registry.connect(agentA).register(DID_CID_A);

      const stakeAmount = ethers.parseEther("50");
      await token.connect(agentA).approve(await registry.getAddress(), stakeAmount);

      await expect(registry.connect(agentA).stake(stakeAmount))
        .to.emit(registry, "AgentStaked")
        .withArgs(agentA.address, stakeAmount, stakeAmount);

      expect(await registry.getStake(agentA.address)).to.equal(stakeAmount);
    });

    it("should allow unstaking", async function () {
      await registry.connect(agentA).register(DID_CID_A);

      const stakeAmount = ethers.parseEther("100");
      await token.connect(agentA).approve(await registry.getAddress(), stakeAmount);
      await registry.connect(agentA).stake(stakeAmount);

      await expect(registry.connect(agentA).unstake(stakeAmount))
        .to.emit(registry, "AgentUnstaked");

      expect(await registry.getStake(agentA.address)).to.equal(0);
    });

    it("should prevent unstaking below registration minimum", async function () {
      const stakeAmount = ethers.parseEther("100");
      await registry.connect(owner).setRegistrationStake(stakeAmount);
      await token.connect(agentA).approve(await registry.getAddress(), ethers.parseEther("200"));

      await registry.connect(agentA).register(DID_CID_A);
      await registry.connect(agentA).stake(ethers.parseEther("100")); // Total: 200

      // Try to unstake below minimum (100 required, trying to leave only 50)
      await expect(
        registry.connect(agentA).unstake(ethers.parseEther("150"))
      ).to.be.revertedWithCustomError(registry, "InsufficientStake");
    });

    it("should allow slasher to slash stakes", async function () {
      await registry.connect(agentA).register(DID_CID_A);

      const stakeAmount = ethers.parseEther("100");
      await token.connect(agentA).approve(await registry.getAddress(), stakeAmount);
      await registry.connect(agentA).stake(stakeAmount);

      const slashAmount = ethers.parseEther("50");
      await expect(registry.connect(owner).slashAgent(agentA.address, slashAmount))
        .to.emit(registry, "AgentSlashed");

      // Verify stake was reduced
      expect(await registry.getStake(agentA.address)).to.equal(ethers.parseEther("50"));

      // Verify treasury received slashed tokens
      expect(await token.balanceOf(treasury.address)).to.equal(slashAmount);
    });

    it("should cap slash amount to actual stake", async function () {
      await registry.connect(agentA).register(DID_CID_A);

      const stakeAmount = ethers.parseEther("50");
      await token.connect(agentA).approve(await registry.getAddress(), stakeAmount);
      await registry.connect(agentA).stake(stakeAmount);

      // Try to slash more than staked
      await registry.connect(owner).slashAgent(agentA.address, ethers.parseEther("100"));

      // Should have slashed only the actual stake
      expect(await registry.getStake(agentA.address)).to.equal(0);
      expect(await token.balanceOf(treasury.address)).to.equal(stakeAmount);
    });

    it("should revert stake with zero amount", async function () {
      await registry.connect(agentA).register(DID_CID_A);
      await expect(
        registry.connect(agentA).stake(0)
      ).to.be.revertedWithCustomError(registry, "InsufficientStake");
    });

    it("should revert staking when no token set", async function () {
      await registry.connect(owner).setPaymentToken(ethers.ZeroAddress);
      await registry.connect(agentA).register(DID_CID_A);
      await expect(
        registry.connect(agentA).stake(100)
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });
  });

  // ============================================================
  //              META-TRANSACTIONS (ERC-2771)
  // ============================================================

  describe("Meta-Transactions (ERC-2771)", function () {
    it("should report the correct trusted forwarder", async function () {
      const forwarderAddress = await forwarder.getAddress();

      // trustedForwarder() should return the deployed forwarder address
      expect(await registry.trustedForwarder()).to.equal(forwarderAddress);

      // isTrustedForwarder() should return true for the correct address
      expect(await registry.isTrustedForwarder(forwarderAddress)).to.be.true;

      // isTrustedForwarder() should return false for a random address
      expect(await registry.isTrustedForwarder(agentA.address)).to.be.false;
    });

    it("should allow registration via meta-transaction", async function () {
      const nonce = await forwarder.nonces(agentA.address);
      const block = await ethers.provider.getBlock("latest");
      const deadline = block!.timestamp + 3600;

      // Encode the register function call
      const data = registry.interface.encodeFunctionData("register(string)", [DID_CID_A]);

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
        to: await registry.getAddress(),
        value: 0n,
        gas: 500000n,
        nonce,
        deadline,
        data,
      };
      const signature = await agentA.signTypedData(domain, types, value);

      // Submit via relayer (owner pays gas)
      await forwarder.connect(owner).execute({ ...value, signature });

      // Verify agent is registered as agentA (not owner)
      expect(await registry.isRegistered(agentA.address)).to.be.true;
      expect(await registry.isRegistered(owner.address)).to.be.false;

      const agent = await registry.getAgent(agentA.address);
      expect(agent.didCid).to.equal(DID_CID_A);
      expect(agent.isActive).to.be.true;
      expect(await registry.totalAgents()).to.equal(1);
    });

    it("direct calls still work (backward compatibility)", async function () {
      // Regular direct registration should still work alongside meta-tx support
      await registry.connect(agentA).register(DID_CID_A);

      expect(await registry.isRegistered(agentA.address)).to.be.true;
      const agent = await registry.getAgent(agentA.address);
      expect(agent.didCid).to.equal(DID_CID_A);
    });

    it("should reject expired meta-transaction", async function () {
      const nonce = await forwarder.nonces(agentA.address);
      // Deadline in the past
      const block = await ethers.provider.getBlock("latest");
      const deadline = block!.timestamp - 3600;

      const data = registry.interface.encodeFunctionData("register(string)", [DID_CID_A]);

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
        to: await registry.getAddress(),
        value: 0n,
        gas: 500000n,
        nonce,
        deadline,
        data,
      };
      const signature = await agentA.signTypedData(domain, types, value);

      // Should revert with expired deadline
      await expect(
        forwarder.connect(owner).execute({ ...value, signature })
      ).to.be.revertedWithCustomError(forwarder, "ERC2771ForwarderExpiredRequest");
    });

    it("should reject replayed meta-transaction", async function () {
      const nonce = await forwarder.nonces(agentA.address);
      const block = await ethers.provider.getBlock("latest");
      const deadline = block!.timestamp + 3600;

      const data = registry.interface.encodeFunctionData("register(string)", [DID_CID_A]);

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
        to: await registry.getAddress(),
        value: 0n,
        gas: 500000n,
        nonce,
        deadline,
        data,
      };
      const signature = await agentA.signTypedData(domain, types, value);

      // First submission succeeds
      await forwarder.connect(owner).execute({ ...value, signature });
      expect(await registry.isRegistered(agentA.address)).to.be.true;

      // Second submission with same signature should fail (nonce already used)
      await expect(
        forwarder.connect(owner).execute({ ...value, signature })
      ).to.be.revertedWithCustomError(forwarder, "ERC2771ForwarderInvalidSigner");
    });
  });

  // ============================================================
  //                     AGENT TYPE
  // ============================================================

  describe("Agent Type", function () {
    it("should register with agentType = 1 (Human)", async function () {
      const tx = await registry.connect(agentA)["register(string,uint8)"](DID_CID_A, 1);
      await expect(tx).to.emit(registry, "AgentTypeSet").withArgs(agentA.address, 1);
      expect(await registry.getAgentType(agentA.address)).to.equal(1);
    });

    it("should register with agentType = 2 (Agent)", async function () {
      const tx = await registry.connect(agentA)["register(string,uint8)"](DID_CID_A, 2);
      await expect(tx).to.emit(registry, "AgentTypeSet").withArgs(agentA.address, 2);
      expect(await registry.getAgentType(agentA.address)).to.equal(2);
    });

    it("register(didCid) defaults to agentType = 0 (Unspecified)", async function () {
      await registry.connect(agentA).register(DID_CID_A);
      expect(await registry.getAgentType(agentA.address)).to.equal(0);
    });

    it("should revert when registering with agentType = 0", async function () {
      await expect(
        registry.connect(agentA)["register(string,uint8)"](DID_CID_A, 0)
      ).to.be.revertedWithCustomError(registry, "InvalidAgentType");
    });

    it("should revert when registering with agentType > 2", async function () {
      await expect(
        registry.connect(agentA)["register(string,uint8)"](DID_CID_A, 3)
      ).to.be.revertedWithCustomError(registry, "InvalidAgentType");

      await expect(
        registry.connect(agentA)["register(string,uint8)"](DID_CID_A, 255)
      ).to.be.revertedWithCustomError(registry, "InvalidAgentType");
    });

    it("should emit both AgentRegistered and AgentTypeSet on typed registration", async function () {
      const tx = await registry.connect(agentA)["register(string,uint8)"](DID_CID_A, 1);
      await expect(tx).to.emit(registry, "AgentRegistered");
      await expect(tx).to.emit(registry, "AgentTypeSet").withArgs(agentA.address, 1);
    });

    it("should still store agent data correctly on typed registration", async function () {
      await registry.connect(agentA)["register(string,uint8)"](DID_CID_A, 2);
      const agent = await registry.getAgent(agentA.address);
      expect(agent.didCid).to.equal(DID_CID_A);
      expect(agent.isActive).to.be.true;
      expect(agent.isVerified).to.be.false;
      expect(await registry.totalAgents()).to.equal(1);
    });

    it("getAgentType returns 0 for unregistered addresses", async function () {
      expect(await registry.getAgentType(nonAgent.address)).to.equal(0);
    });

    describe("setAgentType (admin)", function () {
      beforeEach(async function () {
        await registry.connect(agentA).register(DID_CID_A);
      });

      it("should allow admin to set agent type", async function () {
        const tx = await registry.connect(owner).setAgentType(agentA.address, 1);
        await expect(tx).to.emit(registry, "AgentTypeSet").withArgs(agentA.address, 1);
        expect(await registry.getAgentType(agentA.address)).to.equal(1);
      });

      it("should allow admin to change agent type", async function () {
        await registry.connect(owner).setAgentType(agentA.address, 1);
        await registry.connect(owner).setAgentType(agentA.address, 2);
        expect(await registry.getAgentType(agentA.address)).to.equal(2);
      });

      it("should revert when called by non-owner", async function () {
        await expect(
          registry.connect(agentA).setAgentType(agentA.address, 1)
        ).to.be.revertedWithCustomError(
          registry, "OwnableUnauthorizedAccount"
        ).withArgs(agentA.address);
      });

      it("should revert for non-registered agents", async function () {
        await expect(
          registry.connect(owner).setAgentType(nonAgent.address, 1)
        ).to.be.revertedWithCustomError(registry, "NotRegistered");
      });

      it("should revert for invalid type values", async function () {
        await expect(
          registry.connect(owner).setAgentType(agentA.address, 0)
        ).to.be.revertedWithCustomError(registry, "InvalidAgentType");

        await expect(
          registry.connect(owner).setAgentType(agentA.address, 3)
        ).to.be.revertedWithCustomError(registry, "InvalidAgentType");
      });
    });
  });

  // ============================================================
  //                  OWNER-ONLY ACCESS CONTROL
  // ============================================================

  describe("Owner-only admin functions", function () {
    beforeEach(async function () {
      await registry.connect(agentA).register(DID_CID_A);
    });

    it("owner can call setVerified", async function () {
      await expect(
        registry.connect(owner).setVerified(agentA.address, true)
      ).to.emit(registry, "AgentVerificationChanged");
    });

    it("owner can call deactivateAgent", async function () {
      await expect(
        registry.connect(owner).deactivateAgent(agentA.address)
      ).to.emit(registry, "AgentDeactivated");
    });

    it("owner can call reactivateAgent", async function () {
      await registry.connect(owner).deactivateAgent(agentA.address);
      await expect(
        registry.connect(owner).reactivateAgent(agentA.address)
      ).to.emit(registry, "AgentReactivated");
    });

    it("owner can call setPaymentToken", async function () {
      const tokenAddr = "0x0000000000000000000000000000000000000001";
      await expect(
        registry.connect(owner).setPaymentToken(tokenAddr)
      ).to.emit(registry, "PaymentTokenUpdated");
    });

    it("owner can call setRegistrationStake", async function () {
      await expect(
        registry.connect(owner).setRegistrationStake(500)
      ).to.emit(registry, "RegistrationStakeUpdated");
    });

    it("owner can call setTreasury", async function () {
      await registry.connect(owner).setTreasury(agentB.address);
      expect(await registry.treasury()).to.equal(agentB.address);
    });

    it("owner can call setAgentType", async function () {
      await expect(
        registry.connect(owner).setAgentType(agentA.address, 2)
      ).to.emit(registry, "AgentTypeSet");
    });

    it("owner can pause", async function () {
      await registry.connect(owner).pause();
      expect(await registry.paused()).to.be.true;
    });

    it("owner can unpause", async function () {
      await registry.connect(owner).pause();
      await registry.connect(owner).unpause();
      expect(await registry.paused()).to.be.false;
    });

    it("non-owner reverts on setVerified", async function () {
      await expect(
        registry.connect(nonAgent).setVerified(agentA.address, true)
      ).to.be.revertedWithCustomError(
        registry, "OwnableUnauthorizedAccount"
      ).withArgs(nonAgent.address);
    });

    it("non-owner reverts on deactivateAgent", async function () {
      await expect(
        registry.connect(nonAgent).deactivateAgent(agentA.address)
      ).to.be.revertedWithCustomError(
        registry, "OwnableUnauthorizedAccount"
      ).withArgs(nonAgent.address);
    });

    it("non-owner reverts on reactivateAgent", async function () {
      await registry.connect(owner).deactivateAgent(agentA.address);
      await expect(
        registry.connect(nonAgent).reactivateAgent(agentA.address)
      ).to.be.revertedWithCustomError(
        registry, "OwnableUnauthorizedAccount"
      ).withArgs(nonAgent.address);
    });

    it("non-owner reverts on setPaymentToken", async function () {
      await expect(
        registry.connect(nonAgent).setPaymentToken(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(
        registry, "OwnableUnauthorizedAccount"
      ).withArgs(nonAgent.address);
    });

    it("non-owner reverts on setRegistrationStake", async function () {
      await expect(
        registry.connect(nonAgent).setRegistrationStake(100)
      ).to.be.revertedWithCustomError(
        registry, "OwnableUnauthorizedAccount"
      ).withArgs(nonAgent.address);
    });

    it("non-owner reverts on setTreasury", async function () {
      await expect(
        registry.connect(nonAgent).setTreasury(agentB.address)
      ).to.be.revertedWithCustomError(
        registry, "OwnableUnauthorizedAccount"
      ).withArgs(nonAgent.address);
    });

    it("non-owner reverts on setAgentType", async function () {
      await expect(
        registry.connect(nonAgent).setAgentType(agentA.address, 1)
      ).to.be.revertedWithCustomError(
        registry, "OwnableUnauthorizedAccount"
      ).withArgs(nonAgent.address);
    });

    it("non-owner reverts on pause", async function () {
      await expect(
        registry.connect(nonAgent).pause()
      ).to.be.revertedWithCustomError(
        registry, "OwnableUnauthorizedAccount"
      ).withArgs(nonAgent.address);
    });

    it("non-owner reverts on unpause", async function () {
      await registry.connect(owner).pause();
      await expect(
        registry.connect(nonAgent).unpause()
      ).to.be.revertedWithCustomError(
        registry, "OwnableUnauthorizedAccount"
      ).withArgs(nonAgent.address);
    });
  });

  // ============================================================
  //                  SLASH (OWNER-ONLY)
  // ============================================================

  describe("Slash (owner-only)", function () {
    let tokenAddress: string;

    beforeEach(async function () {
      // Deploy mock token and set up staking
      const TokenFactory = await ethers.getContractFactory("MockERC20");
      token = (await TokenFactory.deploy("Mock NOOKPLOT", "MNOOK")) as unknown as MockERC20;
      await token.waitForDeployment();
      tokenAddress = await token.getAddress();

      await token.mint(agentA.address, ethers.parseEther("10000"));
      await registry.connect(owner).setPaymentToken(tokenAddress);

      // Register agent and stake
      await registry.connect(agentA).register(DID_CID_A);
      const stakeAmount = ethers.parseEther("100");
      await token.connect(agentA).approve(await registry.getAddress(), stakeAmount);
      await registry.connect(agentA).stake(stakeAmount);
    });

    it("owner can slash agent stakes", async function () {
      const slashAmount = ethers.parseEther("30");
      await expect(
        registry.connect(owner).slashAgent(agentA.address, slashAmount)
      ).to.emit(registry, "AgentSlashed");

      expect(await registry.getStake(agentA.address)).to.equal(ethers.parseEther("70"));
      expect(await token.balanceOf(treasury.address)).to.equal(slashAmount);
    });

    it("non-owner cannot slash", async function () {
      await expect(
        registry.connect(nonAgent).slashAgent(agentA.address, ethers.parseEther("10"))
      ).to.be.revertedWithCustomError(
        registry, "OwnableUnauthorizedAccount"
      ).withArgs(nonAgent.address);
    });
  });

  // ============================================================
  //                  EMERGENCY WITHDRAW
  // ============================================================

  describe("Emergency withdraw", function () {
    let tokenAddress: string;

    beforeEach(async function () {
      // Deploy mock token and send some to the registry (simulating stuck tokens)
      const TokenFactory = await ethers.getContractFactory("MockERC20");
      token = (await TokenFactory.deploy("Mock NOOKPLOT", "MNOOK")) as unknown as MockERC20;
      await token.waitForDeployment();
      tokenAddress = await token.getAddress();

      // Mint tokens directly to the registry to simulate stuck tokens
      await token.mint(await registry.getAddress(), ethers.parseEther("500"));
    });

    it("owner can emergency withdraw tokens", async function () {
      const withdrawAmount = ethers.parseEther("200");
      await expect(
        registry.connect(owner).emergencyWithdraw(tokenAddress, treasury.address, withdrawAmount)
      ).to.emit(registry, "EmergencyWithdraw")
        .withArgs(tokenAddress, treasury.address, withdrawAmount);

      expect(await token.balanceOf(treasury.address)).to.equal(withdrawAmount);
      expect(await token.balanceOf(await registry.getAddress())).to.equal(ethers.parseEther("300"));
    });

    it("owner can withdraw full balance", async function () {
      const fullAmount = ethers.parseEther("500");
      await registry.connect(owner).emergencyWithdraw(tokenAddress, treasury.address, fullAmount);
      expect(await token.balanceOf(treasury.address)).to.equal(fullAmount);
      expect(await token.balanceOf(await registry.getAddress())).to.equal(0);
    });

    it("non-owner cannot emergency withdraw", async function () {
      await expect(
        registry.connect(nonAgent).emergencyWithdraw(tokenAddress, treasury.address, ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(
        registry, "OwnableUnauthorizedAccount"
      ).withArgs(nonAgent.address);
    });

    it("reverts with zero amount", async function () {
      await expect(
        registry.connect(owner).emergencyWithdraw(tokenAddress, treasury.address, 0)
      ).to.be.revertedWithCustomError(registry, "ZeroAmountWithdraw");
    });

    it("reverts with zero recipient address", async function () {
      await expect(
        registry.connect(owner).emergencyWithdraw(tokenAddress, ethers.ZeroAddress, ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
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
