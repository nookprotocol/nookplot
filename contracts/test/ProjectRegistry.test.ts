import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { AgentRegistry, ProjectRegistry, MockERC20, NookplotForwarder } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("ProjectRegistry", function () {
  let registry: AgentRegistry;
  let projectRegistry: ProjectRegistry;
  let forwarder: NookplotForwarder;
  let token: MockERC20;
  let owner: SignerWithAddress;
  let treasury: SignerWithAddress;
  let agentA: SignerWithAddress;
  let agentB: SignerWithAddress;
  let agentC: SignerWithAddress;
  let nonAgent: SignerWithAddress;

  const DID_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const META_CID = "QmProjectMetadataCidForTesting1234567890123456";
  const META_CID_2 = "QmUpdatedProjectMetadataCid67890123456789012345";
  const PROJECT_ID = "my-agent-sdk";
  const PROJECT_ID_2 = "defi-toolkit";
  const COMMIT_HASH = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
  const COMMIT_HASH_2 = "1111111111222222222233333333334444444444";

  beforeEach(async function () {
    [owner, treasury, agentA, agentB, agentC, nonAgent] = await ethers.getSigners();

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

    // Deploy ProjectRegistry
    const ProjectFactory = await ethers.getContractFactory("ProjectRegistry");
    projectRegistry = (await upgrades.deployProxy(
      ProjectFactory,
      [owner.address, await registry.getAddress(), treasury.address],
      {
        kind: "uups",
        constructorArgs: [forwarderAddress],
        unsafeAllow: ["constructor", "state-variable-immutable"],
      }
    )) as unknown as ProjectRegistry;
    await projectRegistry.waitForDeployment();

    // Register agents A, B, C
    await registry.connect(agentA)["register(string)"](DID_CID);
    await registry.connect(agentB)["register(string)"](DID_CID);
    await registry.connect(agentC)["register(string)"](DID_CID);
  });

  // ============================================================
  //                     INITIALIZATION
  // ============================================================

  describe("Initialization", function () {
    it("should set the owner correctly", async function () {
      expect(await projectRegistry.owner()).to.equal(owner.address);
    });

    it("should set the agentRegistry correctly", async function () {
      expect(await projectRegistry.agentRegistry()).to.equal(await registry.getAddress());
    });

    it("should set the treasury correctly", async function () {
      expect(await projectRegistry.treasury()).to.equal(treasury.address);
    });

    it("should start with zero projects", async function () {
      expect(await projectRegistry.totalProjects()).to.equal(0);
    });

    it("should start in free mode", async function () {
      expect(await projectRegistry.paymentToken()).to.equal(ethers.ZeroAddress);
    });

    it("should start with zero creation fee", async function () {
      expect(await projectRegistry.creationFee()).to.equal(0);
    });

    it("should not be paused initially", async function () {
      expect(await projectRegistry.paused()).to.be.false;
    });

    it("should revert if initialized with zero owner", async function () {
      const Factory = await ethers.getContractFactory("ProjectRegistry");
      await expect(
        upgrades.deployProxy(Factory, [ethers.ZeroAddress, await registry.getAddress(), treasury.address], {
          kind: "uups",
          constructorArgs: [await forwarder.getAddress()],
          unsafeAllow: ["constructor", "state-variable-immutable"],
        })
      ).to.be.revertedWithCustomError(projectRegistry, "ZeroAddress");
    });

    it("should revert if initialized with zero agentRegistry", async function () {
      const Factory = await ethers.getContractFactory("ProjectRegistry");
      await expect(
        upgrades.deployProxy(Factory, [owner.address, ethers.ZeroAddress, treasury.address], {
          kind: "uups",
          constructorArgs: [await forwarder.getAddress()],
          unsafeAllow: ["constructor", "state-variable-immutable"],
        })
      ).to.be.revertedWithCustomError(projectRegistry, "ZeroAddress");
    });

    it("should revert if initialized with zero treasury", async function () {
      const Factory = await ethers.getContractFactory("ProjectRegistry");
      await expect(
        upgrades.deployProxy(Factory, [owner.address, await registry.getAddress(), ethers.ZeroAddress], {
          kind: "uups",
          constructorArgs: [await forwarder.getAddress()],
          unsafeAllow: ["constructor", "state-variable-immutable"],
        })
      ).to.be.revertedWithCustomError(projectRegistry, "ZeroAddress");
    });
  });

  // ============================================================
  //                   PROJECT CREATION
  // ============================================================

  describe("Project Creation", function () {
    it("should create a project successfully", async function () {
      await expect(projectRegistry.connect(agentA).createProject(PROJECT_ID, META_CID))
        .to.emit(projectRegistry, "ProjectCreated");
    });

    it("should emit CollaboratorAdded for creator", async function () {
      await expect(projectRegistry.connect(agentA).createProject(PROJECT_ID, META_CID))
        .to.emit(projectRegistry, "CollaboratorAdded");
    });

    it("should store project data correctly", async function () {
      await projectRegistry.connect(agentA).createProject(PROJECT_ID, META_CID);
      const info = await projectRegistry.getProject(PROJECT_ID);
      expect(info.creator).to.equal(agentA.address);
      expect(info.metadataCid).to.equal(META_CID);
      expect(info.isActive).to.be.true;
      expect(info.collaboratorCount).to.equal(1);
      expect(info.versionCount).to.equal(0);
    });

    it("should increment totalProjects", async function () {
      await projectRegistry.connect(agentA).createProject(PROJECT_ID, META_CID);
      expect(await projectRegistry.totalProjects()).to.equal(1);

      await projectRegistry.connect(agentB).createProject(PROJECT_ID_2, META_CID);
      expect(await projectRegistry.totalProjects()).to.equal(2);
    });

    it("should set creator as Admin collaborator", async function () {
      await projectRegistry.connect(agentA).createProject(PROJECT_ID, META_CID);
      expect(await projectRegistry.isCollaborator(PROJECT_ID, agentA.address)).to.be.true;
      expect(await projectRegistry.getCollaboratorRole(PROJECT_ID, agentA.address)).to.equal(3); // Admin
    });

    it("should revert with duplicate project ID", async function () {
      await projectRegistry.connect(agentA).createProject(PROJECT_ID, META_CID);
      await expect(
        projectRegistry.connect(agentB).createProject(PROJECT_ID, META_CID)
      ).to.be.revertedWithCustomError(projectRegistry, "ProjectAlreadyExists");
    });

    it("should revert with empty metadata CID", async function () {
      await expect(
        projectRegistry.connect(agentA).createProject(PROJECT_ID, "")
      ).to.be.revertedWithCustomError(projectRegistry, "EmptyString");
    });

    it("should revert when caller is not a registered agent", async function () {
      await expect(
        projectRegistry.connect(nonAgent).createProject(PROJECT_ID, META_CID)
      ).to.be.revertedWithCustomError(projectRegistry, "NotRegisteredAgent");
    });

    it("should revert when paused", async function () {
      await projectRegistry.connect(owner).pause();
      await expect(
        projectRegistry.connect(agentA).createProject(PROJECT_ID, META_CID)
      ).to.be.revertedWithCustomError(projectRegistry, "EnforcedPause");
    });
  });

  // ============================================================
  //                 PROJECT ID VALIDATION
  // ============================================================

  describe("Project ID Validation", function () {
    it("should accept valid project IDs", async function () {
      await projectRegistry.connect(agentA).createProject("my-project", META_CID);
      expect(await projectRegistry.projectExists("my-project")).to.be.true;
    });

    it("should accept IDs with numbers", async function () {
      await projectRegistry.connect(agentA).createProject("sdk-v2-2025", META_CID);
      expect(await projectRegistry.projectExists("sdk-v2-2025")).to.be.true;
    });

    it("should accept single character IDs", async function () {
      await projectRegistry.connect(agentA).createProject("x", META_CID);
      expect(await projectRegistry.projectExists("x")).to.be.true;
    });

    it("should accept IDs at max length", async function () {
      const maxId = "a".repeat(100);
      await projectRegistry.connect(agentA).createProject(maxId, META_CID);
      expect(await projectRegistry.projectExists(maxId)).to.be.true;
    });

    it("should reject empty project ID", async function () {
      await expect(
        projectRegistry.connect(agentA).createProject("", META_CID)
      ).to.be.revertedWithCustomError(projectRegistry, "InvalidProjectId");
    });

    it("should reject ID with spaces", async function () {
      await expect(
        projectRegistry.connect(agentA).createProject("my project", META_CID)
      ).to.be.revertedWithCustomError(projectRegistry, "InvalidProjectId");
    });

    it("should reject ID with underscores", async function () {
      await expect(
        projectRegistry.connect(agentA).createProject("my_project", META_CID)
      ).to.be.revertedWithCustomError(projectRegistry, "InvalidProjectId");
    });

    it("should reject ID with special characters", async function () {
      await expect(
        projectRegistry.connect(agentA).createProject("my@project!", META_CID)
      ).to.be.revertedWithCustomError(projectRegistry, "InvalidProjectId");
    });

    it("should reject ID exceeding max length", async function () {
      const longId = "a".repeat(101);
      await expect(
        projectRegistry.connect(agentA).createProject(longId, META_CID)
      ).to.be.revertedWithCustomError(projectRegistry, "InvalidProjectId");
    });
  });

  // ============================================================
  //                   PROJECT UPDATES
  // ============================================================

  describe("Project Updates", function () {
    beforeEach(async function () {
      await projectRegistry.connect(agentA).createProject(PROJECT_ID, META_CID);
    });

    it("should update metadata by creator", async function () {
      await expect(projectRegistry.connect(agentA).updateProject(PROJECT_ID, META_CID_2))
        .to.emit(projectRegistry, "ProjectUpdated");

      const info = await projectRegistry.getProject(PROJECT_ID);
      expect(info.metadataCid).to.equal(META_CID_2);
    });

    it("should update metadata by Admin collaborator", async function () {
      await projectRegistry.connect(agentA).addCollaborator(PROJECT_ID, agentB.address, 3); // Admin
      await projectRegistry.connect(agentB).updateProject(PROJECT_ID, META_CID_2);

      const info = await projectRegistry.getProject(PROJECT_ID);
      expect(info.metadataCid).to.equal(META_CID_2);
    });

    it("should update the updatedAt timestamp", async function () {
      const before = (await projectRegistry.getProject(PROJECT_ID)).updatedAt;
      await projectRegistry.connect(agentA).updateProject(PROJECT_ID, META_CID_2);
      const after = (await projectRegistry.getProject(PROJECT_ID)).updatedAt;
      expect(after).to.be.gte(before);
    });

    it("should revert update by non-admin", async function () {
      await projectRegistry.connect(agentA).addCollaborator(PROJECT_ID, agentB.address, 2); // Contributor
      await expect(
        projectRegistry.connect(agentB).updateProject(PROJECT_ID, META_CID_2)
      ).to.be.revertedWithCustomError(projectRegistry, "NotAdmin");
    });

    it("should revert update by non-collaborator", async function () {
      await expect(
        projectRegistry.connect(agentB).updateProject(PROJECT_ID, META_CID_2)
      ).to.be.revertedWithCustomError(projectRegistry, "NotAdmin");
    });

    it("should revert with empty metadata CID", async function () {
      await expect(
        projectRegistry.connect(agentA).updateProject(PROJECT_ID, "")
      ).to.be.revertedWithCustomError(projectRegistry, "EmptyString");
    });

    it("should revert for non-existing project", async function () {
      await expect(
        projectRegistry.connect(agentA).updateProject("nonexistent", META_CID_2)
      ).to.be.revertedWithCustomError(projectRegistry, "ProjectNotFound");
    });

    it("should revert for deactivated project", async function () {
      await projectRegistry.connect(agentA).deactivateProject(PROJECT_ID);
      await expect(
        projectRegistry.connect(agentA).updateProject(PROJECT_ID, META_CID_2)
      ).to.be.revertedWithCustomError(projectRegistry, "ProjectNotActive");
    });
  });

  // ============================================================
  //                COLLABORATOR MANAGEMENT
  // ============================================================

  describe("Collaborator Management", function () {
    beforeEach(async function () {
      await projectRegistry.connect(agentA).createProject(PROJECT_ID, META_CID);
    });

    it("should add a Viewer collaborator", async function () {
      await expect(projectRegistry.connect(agentA).addCollaborator(PROJECT_ID, agentB.address, 1))
        .to.emit(projectRegistry, "CollaboratorAdded");

      expect(await projectRegistry.isCollaborator(PROJECT_ID, agentB.address)).to.be.true;
      expect(await projectRegistry.getCollaboratorRole(PROJECT_ID, agentB.address)).to.equal(1);
    });

    it("should add a Contributor collaborator", async function () {
      await projectRegistry.connect(agentA).addCollaborator(PROJECT_ID, agentB.address, 2);
      expect(await projectRegistry.getCollaboratorRole(PROJECT_ID, agentB.address)).to.equal(2);
    });

    it("should add an Admin collaborator", async function () {
      await projectRegistry.connect(agentA).addCollaborator(PROJECT_ID, agentB.address, 3);
      expect(await projectRegistry.getCollaboratorRole(PROJECT_ID, agentB.address)).to.equal(3);
    });

    it("should increment collaborator count", async function () {
      await projectRegistry.connect(agentA).addCollaborator(PROJECT_ID, agentB.address, 2);
      const info = await projectRegistry.getProject(PROJECT_ID);
      expect(info.collaboratorCount).to.equal(2);
    });

    it("should allow Admin collaborator to add others", async function () {
      await projectRegistry.connect(agentA).addCollaborator(PROJECT_ID, agentB.address, 3); // Admin
      await projectRegistry.connect(agentB).addCollaborator(PROJECT_ID, agentC.address, 2); // B adds C
      expect(await projectRegistry.isCollaborator(PROJECT_ID, agentC.address)).to.be.true;
    });

    it("should revert adding by Contributor", async function () {
      await projectRegistry.connect(agentA).addCollaborator(PROJECT_ID, agentB.address, 2); // Contributor
      await expect(
        projectRegistry.connect(agentB).addCollaborator(PROJECT_ID, agentC.address, 1)
      ).to.be.revertedWithCustomError(projectRegistry, "NotAdmin");
    });

    it("should revert adding by Viewer", async function () {
      await projectRegistry.connect(agentA).addCollaborator(PROJECT_ID, agentB.address, 1); // Viewer
      await expect(
        projectRegistry.connect(agentB).addCollaborator(PROJECT_ID, agentC.address, 1)
      ).to.be.revertedWithCustomError(projectRegistry, "NotAdmin");
    });

    it("should revert adding already-existing collaborator", async function () {
      await projectRegistry.connect(agentA).addCollaborator(PROJECT_ID, agentB.address, 2);
      await expect(
        projectRegistry.connect(agentA).addCollaborator(PROJECT_ID, agentB.address, 1)
      ).to.be.revertedWithCustomError(projectRegistry, "AlreadyCollaborator");
    });

    it("should revert adding zero address", async function () {
      await expect(
        projectRegistry.connect(agentA).addCollaborator(PROJECT_ID, ethers.ZeroAddress, 2)
      ).to.be.revertedWithCustomError(projectRegistry, "ZeroAddress");
    });

    it("should revert adding non-registered agent", async function () {
      await expect(
        projectRegistry.connect(agentA).addCollaborator(PROJECT_ID, nonAgent.address, 2)
      ).to.be.revertedWithCustomError(projectRegistry, "NotRegisteredAgent");
    });

    it("should revert adding with invalid role 0", async function () {
      await expect(
        projectRegistry.connect(agentA).addCollaborator(PROJECT_ID, agentB.address, 0)
      ).to.be.revertedWithCustomError(projectRegistry, "InvalidRole");
    });

    it("should revert adding with invalid role 4", async function () {
      await expect(
        projectRegistry.connect(agentA).addCollaborator(PROJECT_ID, agentB.address, 4)
      ).to.be.revertedWithCustomError(projectRegistry, "InvalidRole");
    });

    it("should enforce max collaborator cap", async function () {
      const signers = await ethers.getSigners();
      // Register 49 more agents and add as collaborators (agentA is already #1)
      for (let i = 6; i < 55; i++) {
        await registry.connect(signers[i])["register(string)"](DID_CID);
        await projectRegistry.connect(agentA).addCollaborator(PROJECT_ID, signers[i].address, 2);
      }
      // Now at 50 collaborators. Adding one more should fail.
      const extra = signers[55];
      await registry.connect(extra)["register(string)"](DID_CID);
      await expect(
        projectRegistry.connect(agentA).addCollaborator(PROJECT_ID, extra.address, 2)
      ).to.be.revertedWithCustomError(projectRegistry, "TooManyCollaborators");
    });
  });

  // ============================================================
  //                COLLABORATOR REMOVAL
  // ============================================================

  describe("Collaborator Removal", function () {
    beforeEach(async function () {
      await projectRegistry.connect(agentA).createProject(PROJECT_ID, META_CID);
      await projectRegistry.connect(agentA).addCollaborator(PROJECT_ID, agentB.address, 2);
    });

    it("should remove a collaborator", async function () {
      await expect(projectRegistry.connect(agentA).removeCollaborator(PROJECT_ID, agentB.address))
        .to.emit(projectRegistry, "CollaboratorRemoved");

      expect(await projectRegistry.isCollaborator(PROJECT_ID, agentB.address)).to.be.false;
      expect(await projectRegistry.getCollaboratorRole(PROJECT_ID, agentB.address)).to.equal(0);
    });

    it("should decrement collaborator count", async function () {
      await projectRegistry.connect(agentA).removeCollaborator(PROJECT_ID, agentB.address);
      const info = await projectRegistry.getProject(PROJECT_ID);
      expect(info.collaboratorCount).to.equal(1);
    });

    it("should allow Admin to remove collaborators", async function () {
      await projectRegistry.connect(agentA).addCollaborator(PROJECT_ID, agentC.address, 3); // Admin
      await projectRegistry.connect(agentC).removeCollaborator(PROJECT_ID, agentB.address);
      expect(await projectRegistry.isCollaborator(PROJECT_ID, agentB.address)).to.be.false;
    });

    it("should revert removing the creator", async function () {
      await expect(
        projectRegistry.connect(agentA).removeCollaborator(PROJECT_ID, agentA.address)
      ).to.be.revertedWithCustomError(projectRegistry, "CannotRemoveCreator");
    });

    it("should revert removing non-collaborator", async function () {
      await expect(
        projectRegistry.connect(agentA).removeCollaborator(PROJECT_ID, agentC.address)
      ).to.be.revertedWithCustomError(projectRegistry, "ProjectNotFound");
    });

    it("should revert removal by non-admin", async function () {
      await expect(
        projectRegistry.connect(agentB).removeCollaborator(PROJECT_ID, agentB.address)
      ).to.be.revertedWithCustomError(projectRegistry, "NotAdmin");
    });
  });

  // ============================================================
  //                   VERSION SNAPSHOTS
  // ============================================================

  describe("Version Snapshots", function () {
    beforeEach(async function () {
      await projectRegistry.connect(agentA).createProject(PROJECT_ID, META_CID);
    });

    it("should snapshot a version by creator", async function () {
      await expect(projectRegistry.connect(agentA).snapshotVersion(PROJECT_ID, COMMIT_HASH, META_CID))
        .to.emit(projectRegistry, "VersionSnapshot");
    });

    it("should increment version count", async function () {
      await projectRegistry.connect(agentA).snapshotVersion(PROJECT_ID, COMMIT_HASH, META_CID);
      const info = await projectRegistry.getProject(PROJECT_ID);
      expect(info.versionCount).to.equal(1);

      await projectRegistry.connect(agentA).snapshotVersion(PROJECT_ID, COMMIT_HASH_2, META_CID);
      const info2 = await projectRegistry.getProject(PROJECT_ID);
      expect(info2.versionCount).to.equal(2);
    });

    it("should allow Contributor to snapshot", async function () {
      await projectRegistry.connect(agentA).addCollaborator(PROJECT_ID, agentB.address, 2); // Contributor
      await expect(
        projectRegistry.connect(agentB).snapshotVersion(PROJECT_ID, COMMIT_HASH, META_CID)
      ).to.emit(projectRegistry, "VersionSnapshot");
    });

    it("should allow Admin to snapshot", async function () {
      await projectRegistry.connect(agentA).addCollaborator(PROJECT_ID, agentB.address, 3); // Admin
      await expect(
        projectRegistry.connect(agentB).snapshotVersion(PROJECT_ID, COMMIT_HASH, META_CID)
      ).to.emit(projectRegistry, "VersionSnapshot");
    });

    it("should deny Viewer from snapshotting", async function () {
      await projectRegistry.connect(agentA).addCollaborator(PROJECT_ID, agentB.address, 1); // Viewer
      await expect(
        projectRegistry.connect(agentB).snapshotVersion(PROJECT_ID, COMMIT_HASH, META_CID)
      ).to.be.revertedWithCustomError(projectRegistry, "InsufficientRole");
    });

    it("should deny non-collaborator from snapshotting", async function () {
      await expect(
        projectRegistry.connect(agentB).snapshotVersion(PROJECT_ID, COMMIT_HASH, META_CID)
      ).to.be.revertedWithCustomError(projectRegistry, "InsufficientRole");
    });

    it("should accept empty metadataCid for snapshot", async function () {
      await expect(
        projectRegistry.connect(agentA).snapshotVersion(PROJECT_ID, COMMIT_HASH, "")
      ).to.emit(projectRegistry, "VersionSnapshot");
    });

    it("should revert with invalid commit hash (too short)", async function () {
      await expect(
        projectRegistry.connect(agentA).snapshotVersion(PROJECT_ID, "abc123", META_CID)
      ).to.be.revertedWithCustomError(projectRegistry, "InvalidCommitHash");
    });

    it("should revert with invalid commit hash (too long)", async function () {
      await expect(
        projectRegistry.connect(agentA).snapshotVersion(PROJECT_ID, COMMIT_HASH + "ff", META_CID)
      ).to.be.revertedWithCustomError(projectRegistry, "InvalidCommitHash");
    });

    it("should revert with invalid commit hash (non-hex chars)", async function () {
      await expect(
        projectRegistry.connect(agentA).snapshotVersion(PROJECT_ID, "g".repeat(40), META_CID)
      ).to.be.revertedWithCustomError(projectRegistry, "InvalidCommitHash");
    });

    it("should accept uppercase hex in commit hash", async function () {
      const uppercaseHash = "A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0";
      await expect(
        projectRegistry.connect(agentA).snapshotVersion(PROJECT_ID, uppercaseHash, META_CID)
      ).to.emit(projectRegistry, "VersionSnapshot");
    });

    it("should revert snapshot on deactivated project", async function () {
      await projectRegistry.connect(agentA).deactivateProject(PROJECT_ID);
      await expect(
        projectRegistry.connect(agentA).snapshotVersion(PROJECT_ID, COMMIT_HASH, META_CID)
      ).to.be.revertedWithCustomError(projectRegistry, "ProjectNotActive");
    });
  });

  // ============================================================
  //                    DEACTIVATION
  // ============================================================

  describe("Deactivation / Reactivation", function () {
    beforeEach(async function () {
      await projectRegistry.connect(agentA).createProject(PROJECT_ID, META_CID);
    });

    it("should deactivate a project by creator", async function () {
      await expect(projectRegistry.connect(agentA).deactivateProject(PROJECT_ID))
        .to.emit(projectRegistry, "ProjectDeactivated");

      expect(await projectRegistry.isProjectActive(PROJECT_ID)).to.be.false;
    });

    it("should revert deactivation by non-creator", async function () {
      await expect(
        projectRegistry.connect(agentB).deactivateProject(PROJECT_ID)
      ).to.be.revertedWithCustomError(projectRegistry, "NotCreator");
    });

    it("should revert deactivation by Admin collaborator (only creator)", async function () {
      await projectRegistry.connect(agentA).addCollaborator(PROJECT_ID, agentB.address, 3);
      await expect(
        projectRegistry.connect(agentB).deactivateProject(PROJECT_ID)
      ).to.be.revertedWithCustomError(projectRegistry, "NotCreator");
    });

    it("should force-deactivate by admin (owner)", async function () {
      await expect(projectRegistry.connect(owner).forceDeactivate(PROJECT_ID))
        .to.emit(projectRegistry, "ProjectDeactivated");

      expect(await projectRegistry.isProjectActive(PROJECT_ID)).to.be.false;
    });

    it("should force-reactivate by admin (owner)", async function () {
      await projectRegistry.connect(agentA).deactivateProject(PROJECT_ID);
      await expect(projectRegistry.connect(owner).forceReactivate(PROJECT_ID))
        .to.emit(projectRegistry, "ProjectReactivated");

      expect(await projectRegistry.isProjectActive(PROJECT_ID)).to.be.true;
    });

    it("should revert force-deactivate by non-admin", async function () {
      await expect(
        projectRegistry.connect(agentA).forceDeactivate(PROJECT_ID)
      ).to.be.revertedWithCustomError(projectRegistry, "OwnableUnauthorizedAccount");
    });

    it("should revert force-reactivate by non-admin", async function () {
      await expect(
        projectRegistry.connect(agentA).forceReactivate(PROJECT_ID)
      ).to.be.revertedWithCustomError(projectRegistry, "OwnableUnauthorizedAccount");
    });

    it("should revert deactivating non-existent project", async function () {
      await expect(
        projectRegistry.connect(agentA).deactivateProject("nonexistent")
      ).to.be.revertedWithCustomError(projectRegistry, "ProjectNotFound");
    });
  });

  // ============================================================
  //                      VIEW FUNCTIONS
  // ============================================================

  describe("View Functions", function () {
    it("projectExists returns true for existing project", async function () {
      await projectRegistry.connect(agentA).createProject(PROJECT_ID, META_CID);
      expect(await projectRegistry.projectExists(PROJECT_ID)).to.be.true;
    });

    it("projectExists returns false for non-existing project", async function () {
      expect(await projectRegistry.projectExists("nonexistent")).to.be.false;
    });

    it("isProjectActive returns true for active project", async function () {
      await projectRegistry.connect(agentA).createProject(PROJECT_ID, META_CID);
      expect(await projectRegistry.isProjectActive(PROJECT_ID)).to.be.true;
    });

    it("isProjectActive returns false for deactivated project", async function () {
      await projectRegistry.connect(agentA).createProject(PROJECT_ID, META_CID);
      await projectRegistry.connect(agentA).deactivateProject(PROJECT_ID);
      expect(await projectRegistry.isProjectActive(PROJECT_ID)).to.be.false;
    });

    it("isProjectActive returns false for non-existing project", async function () {
      expect(await projectRegistry.isProjectActive("nonexistent")).to.be.false;
    });

    it("getProject reverts for non-existing project", async function () {
      await expect(
        projectRegistry.getProject("nonexistent")
      ).to.be.revertedWithCustomError(projectRegistry, "ProjectNotFound");
    });

    it("isCollaborator returns false for non-collaborator", async function () {
      await projectRegistry.connect(agentA).createProject(PROJECT_ID, META_CID);
      expect(await projectRegistry.isCollaborator(PROJECT_ID, agentB.address)).to.be.false;
    });

    it("getCollaboratorRole returns 0 for non-collaborator", async function () {
      await projectRegistry.connect(agentA).createProject(PROJECT_ID, META_CID);
      expect(await projectRegistry.getCollaboratorRole(PROJECT_ID, agentB.address)).to.equal(0);
    });
  });

  // ============================================================
  //                      TOKEN MODE
  // ============================================================

  describe("Token Mode", function () {
    beforeEach(async function () {
      const TokenFactory = await ethers.getContractFactory("MockERC20");
      token = (await TokenFactory.deploy("NookplotToken", "NOOK")) as unknown as MockERC20;
      await token.waitForDeployment();
    });

    it("should charge creation fee when token is set", async function () {
      const fee = ethers.parseEther("10");
      await projectRegistry.connect(owner).setPaymentToken(await token.getAddress());
      await projectRegistry.connect(owner).setCreationFee(fee);

      // Mint tokens to agentA and approve
      await token.mint(agentA.address, ethers.parseEther("100"));
      await token.connect(agentA).approve(await projectRegistry.getAddress(), fee);

      await projectRegistry.connect(agentA).createProject(PROJECT_ID, META_CID);

      // Treasury should have received the fee
      expect(await token.balanceOf(treasury.address)).to.equal(fee);
    });

    it("should revert creation without token approval", async function () {
      const fee = ethers.parseEther("10");
      await projectRegistry.connect(owner).setPaymentToken(await token.getAddress());
      await projectRegistry.connect(owner).setCreationFee(fee);

      await token.mint(agentA.address, ethers.parseEther("100"));
      // No approval

      await expect(
        projectRegistry.connect(agentA).createProject(PROJECT_ID, META_CID)
      ).to.be.reverted;
    });

    it("should allow free creation when token set but fee is zero", async function () {
      await projectRegistry.connect(owner).setPaymentToken(await token.getAddress());
      // creationFee stays at 0

      await projectRegistry.connect(agentA).createProject(PROJECT_ID, META_CID);
      expect(await projectRegistry.projectExists(PROJECT_ID)).to.be.true;
    });
  });

  // ============================================================
  //                    ADMIN FUNCTIONS
  // ============================================================

  describe("Admin Functions", function () {
    it("should set payment token", async function () {
      const TokenFactory = await ethers.getContractFactory("MockERC20");
      const t = await TokenFactory.deploy("NookplotToken", "NOOK");
      await projectRegistry.connect(owner).setPaymentToken(await t.getAddress());
      expect(await projectRegistry.paymentToken()).to.equal(await t.getAddress());
    });

    it("should set creation fee", async function () {
      const fee = ethers.parseEther("5");
      await projectRegistry.connect(owner).setCreationFee(fee);
      expect(await projectRegistry.creationFee()).to.equal(fee);
    });

    it("should set treasury", async function () {
      await projectRegistry.connect(owner).setTreasury(agentA.address);
      expect(await projectRegistry.treasury()).to.equal(agentA.address);
    });

    it("should revert setting zero address for treasury", async function () {
      await expect(
        projectRegistry.connect(owner).setTreasury(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(projectRegistry, "ZeroAddress");
    });

    it("should set agent registry", async function () {
      await projectRegistry.connect(owner).setAgentRegistry(agentA.address);
      expect(await projectRegistry.agentRegistry()).to.equal(agentA.address);
    });

    it("should revert setting zero address for agent registry", async function () {
      await expect(
        projectRegistry.connect(owner).setAgentRegistry(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(projectRegistry, "ZeroAddress");
    });

    it("should pause and unpause", async function () {
      await projectRegistry.connect(owner).pause();
      expect(await projectRegistry.paused()).to.be.true;

      await projectRegistry.connect(owner).unpause();
      expect(await projectRegistry.paused()).to.be.false;
    });

    it("should revert admin calls from non-owner", async function () {
      await expect(
        projectRegistry.connect(agentA).setPaymentToken(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(projectRegistry, "OwnableUnauthorizedAccount");

      await expect(
        projectRegistry.connect(agentA).setCreationFee(0)
      ).to.be.revertedWithCustomError(projectRegistry, "OwnableUnauthorizedAccount");

      await expect(
        projectRegistry.connect(agentA).setTreasury(agentA.address)
      ).to.be.revertedWithCustomError(projectRegistry, "OwnableUnauthorizedAccount");

      await expect(
        projectRegistry.connect(agentA).pause()
      ).to.be.revertedWithCustomError(projectRegistry, "OwnableUnauthorizedAccount");
    });

    it("should emit PaymentTokenUpdated", async function () {
      const TokenFactory = await ethers.getContractFactory("MockERC20");
      const t = await TokenFactory.deploy("NookplotToken", "NOOK");
      await expect(projectRegistry.connect(owner).setPaymentToken(await t.getAddress()))
        .to.emit(projectRegistry, "PaymentTokenUpdated");
    });

    it("should emit CreationFeeUpdated", async function () {
      await expect(projectRegistry.connect(owner).setCreationFee(100))
        .to.emit(projectRegistry, "CreationFeeUpdated");
    });

    it("should emit TreasuryUpdated", async function () {
      await expect(projectRegistry.connect(owner).setTreasury(agentA.address))
        .to.emit(projectRegistry, "TreasuryUpdated");
    });

    it("should emit AgentRegistryUpdated", async function () {
      await expect(projectRegistry.connect(owner).setAgentRegistry(agentA.address))
        .to.emit(projectRegistry, "AgentRegistryUpdated");
    });
  });

  // ============================================================
  //              META-TRANSACTIONS (ERC-2771)
  // ============================================================

  describe("Meta-Transactions (ERC-2771)", function () {
    let relayer: SignerWithAddress;

    beforeEach(async function () {
      const signers = await ethers.getSigners();
      relayer = signers[6];
    });

    it("should report the correct trusted forwarder", async function () {
      const forwarderAddress = await forwarder.getAddress();
      expect(await projectRegistry.isTrustedForwarder(forwarderAddress)).to.be.true;
      expect(await projectRegistry.isTrustedForwarder(relayer.address)).to.be.false;
    });

    it("should allow project creation via meta-transaction", async function () {
      const metaProjectId = "meta-test";

      const nonce = await forwarder.nonces(agentA.address);
      const block = await ethers.provider.getBlock("latest");
      const deadline = block!.timestamp + 3600;
      const data = projectRegistry.interface.encodeFunctionData("createProject", [metaProjectId, META_CID]);

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
        to: await projectRegistry.getAddress(),
        value: 0n,
        gas: 500000n,
        nonce,
        deadline,
        data,
      };
      const signature = await agentA.signTypedData(domain, types, value);

      // Relayer submits the meta-transaction
      await forwarder.connect(relayer).execute({ ...value, signature });

      // Verify project was created with agentA as creator
      expect(await projectRegistry.projectExists(metaProjectId)).to.be.true;
      const info = await projectRegistry.getProject(metaProjectId);
      expect(info.creator).to.equal(agentA.address);
      expect(info.metadataCid).to.equal(META_CID);
      expect(info.isActive).to.be.true;
      expect(info.collaboratorCount).to.equal(1);
      expect(await projectRegistry.isCollaborator(metaProjectId, agentA.address)).to.be.true;
    });

    it("direct calls still work (backward compatibility)", async function () {
      const directId = "direct-call";

      await projectRegistry.connect(agentA).createProject(directId, META_CID);

      expect(await projectRegistry.projectExists(directId)).to.be.true;
      const info = await projectRegistry.getProject(directId);
      expect(info.creator).to.equal(agentA.address);
      expect(info.isActive).to.be.true;
    });
  });

  // ============================================================
  //                     UUPS UPGRADE
  // ============================================================

  describe("UUPS Upgrade", function () {
    it("should revert upgrade by non-owner", async function () {
      const Factory = await ethers.getContractFactory("ProjectRegistry", agentA);
      await expect(
        upgrades.upgradeProxy(await projectRegistry.getAddress(), Factory, {
          constructorArgs: [await forwarder.getAddress()],
          unsafeAllow: ["constructor", "state-variable-immutable"],
        })
      ).to.be.revertedWithCustomError(projectRegistry, "OwnableUnauthorizedAccount");
    });
  });
});
