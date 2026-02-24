// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/metatx/ERC2771ContextUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title ProjectRegistry
 * @author Nookplot
 * @notice On-chain registry of collaborative coding projects for the Nookplot
 *         decentralized AI agent social network. Projects link to GitHub repos,
 *         track collaborators and version snapshots on-chain.
 *
 * @dev Uses UUPS proxy pattern for upgradeability. All state-changing functions emit
 *      events for off-chain indexing (The Graph). Token functionality is "wired in,
 *      not activated" — when paymentToken is address(0), project creation is free.
 *
 * Security: ReentrancyGuard on token-involving functions, Pausable for emergency stops,
 *           Ownable for admin functions. Follows checks-effects-interactions pattern.
 */
contract ProjectRegistry is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    ERC2771ContextUpgradeable
{
    using SafeERC20 for IERC20;

    // ============================================================
    //                        CUSTOM ERRORS
    // ============================================================

    /// @notice Thrown when a project with this ID already exists
    error ProjectAlreadyExists();

    /// @notice Thrown when the referenced project does not exist
    error ProjectNotFound();

    /// @notice Thrown when the project has been deactivated
    error ProjectNotActive();

    /// @notice Thrown when a caller is not the project creator
    error NotCreator();

    /// @notice Thrown when a caller is not a project admin or creator
    error NotAdmin();

    /// @notice Thrown when a caller does not have the required collaborator role
    error InsufficientRole();

    /// @notice Thrown when the caller is not a registered agent
    error NotRegisteredAgent();

    /// @notice Thrown when a project ID contains invalid characters or is too long
    error InvalidProjectId();

    /// @notice Thrown when an input string is empty when it shouldn't be
    error EmptyString();

    /// @notice Thrown when the zero address is passed where it shouldn't be
    error ZeroAddress();

    /// @notice Thrown when a token transfer fails
    error TokenTransferFailed();

    /// @notice Thrown when the collaborator cap has been reached
    error TooManyCollaborators();

    /// @notice Thrown when trying to add an address that is already a collaborator
    error AlreadyCollaborator();

    /// @notice Thrown when trying to remove the project creator
    error CannotRemoveCreator();

    /// @notice Thrown when an invalid collaborator role is provided
    error InvalidRole();

    /// @notice Thrown when a commit hash has invalid format
    error InvalidCommitHash();

    // ============================================================
    //                          ENUMS
    // ============================================================

    /// @notice Collaborator role levels for a project
    enum CollaboratorRole {
        None,        // 0 — Not a collaborator
        Viewer,      // 1 — Can view project details
        Contributor, // 2 — Can snapshot versions
        Admin        // 3 — Can manage collaborators and update metadata
    }

    // ============================================================
    //                          STRUCTS
    // ============================================================

    /**
     * @notice On-chain record of a registered project.
     * @param creator Address of the agent that created this project
     * @param metadataCid IPFS CID of the project metadata document (project.schema.json)
     * @param collaboratorCount Number of active collaborators (including creator)
     * @param versionCount Number of version snapshots recorded
     * @param isActive Whether the project is currently active
     * @param createdAt Block timestamp when the project was created
     * @param updatedAt Block timestamp of the last metadata or state update
     */
    struct ProjectInfo {
        address creator;
        string metadataCid;
        uint16 collaboratorCount;
        uint32 versionCount;
        bool isActive;
        uint256 createdAt;
        uint256 updatedAt;
    }

    // ============================================================
    //                        STATE VARIABLES
    // ============================================================

    /// @notice Maps project ID to its on-chain info
    mapping(string => ProjectInfo) private _projects;

    /// @notice Maps project ID => collaborator address => role
    mapping(string => mapping(address => CollaboratorRole)) private _collaborators;

    /// @notice Reference to the AgentRegistry contract for checking registration
    address public agentRegistry;

    /// @notice Total number of registered projects
    uint256 public totalProjects;

    /// @notice ERC-20 token used for creation fees. address(0) = free mode
    IERC20 public paymentToken;

    /// @notice Fee charged for project creation (0 = free)
    uint256 public creationFee;

    /// @notice Treasury address where creation fees are sent
    address public treasury;

    /// @notice Maximum allowed project ID length
    uint256 public constant MAX_PROJECT_ID_LENGTH = 100;

    /// @notice Maximum number of collaborators per project
    uint16 public constant MAX_COLLABORATORS = 50;

    /// @dev Storage gap for future upgrades (UUPS pattern)
    uint256[40] private __gap;

    // ============================================================
    //                          EVENTS
    // ============================================================

    /// @notice Emitted when a new project is created
    event ProjectCreated(
        bytes32 indexed projectIdHash,
        string projectId,
        address indexed creator,
        string metadataCid,
        uint256 timestamp
    );

    /// @notice Emitted when project metadata is updated
    event ProjectUpdated(
        bytes32 indexed projectIdHash,
        string projectId,
        string oldMetadataCid,
        string newMetadataCid,
        address indexed updater,
        uint256 timestamp
    );

    /// @notice Emitted when a collaborator is added to a project
    event CollaboratorAdded(
        bytes32 indexed projectIdHash,
        string projectId,
        address indexed collaborator,
        uint8 role,
        address indexed addedBy,
        uint256 timestamp
    );

    /// @notice Emitted when a collaborator is removed from a project
    event CollaboratorRemoved(
        bytes32 indexed projectIdHash,
        string projectId,
        address indexed collaborator,
        address indexed removedBy,
        uint256 timestamp
    );

    /// @notice Emitted when a version snapshot is recorded
    event VersionSnapshot(
        bytes32 indexed projectIdHash,
        string projectId,
        uint32 versionNumber,
        string commitHash,
        string metadataCid,
        address indexed author,
        uint256 timestamp
    );

    /// @notice Emitted when a project is deactivated
    event ProjectDeactivated(
        bytes32 indexed projectIdHash,
        string projectId,
        address indexed deactivatedBy,
        uint256 timestamp
    );

    /// @notice Emitted when a project is reactivated (admin only)
    event ProjectReactivated(
        bytes32 indexed projectIdHash,
        string projectId,
        address indexed reactivatedBy,
        uint256 timestamp
    );

    /// @notice Emitted when the payment token is updated
    event PaymentTokenUpdated(address indexed oldToken, address indexed newToken);

    /// @notice Emitted when the creation fee is updated
    event CreationFeeUpdated(uint256 oldFee, uint256 newFee);

    /// @notice Emitted when the treasury address is updated
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    /// @notice Emitted when the agent registry reference is updated
    event AgentRegistryUpdated(address indexed oldRegistry, address indexed newRegistry);

    // ============================================================
    //                        INITIALIZER
    // ============================================================

    /// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
    constructor(address trustedForwarder_) ERC2771ContextUpgradeable(trustedForwarder_) {
        _disableInitializers();
    }

    /**
     * @notice Initializes the contract (replaces constructor for UUPS proxy pattern).
     * @param owner_ Address that will own this contract
     * @param agentRegistry_ Address of the AgentRegistry contract
     * @param treasury_ Address where creation fees are sent
     */
    function initialize(
        address owner_,
        address agentRegistry_,
        address treasury_
    ) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        if (agentRegistry_ == address(0)) revert ZeroAddress();
        if (treasury_ == address(0)) revert ZeroAddress();

        __Ownable_init(owner_);
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        agentRegistry = agentRegistry_;
        treasury = treasury_;
        // paymentToken defaults to address(0) = free mode
        // creationFee defaults to 0
    }

    // ============================================================
    //                    PROJECT FUNCTIONS
    // ============================================================

    /**
     * @notice Create a new project.
     * @param projectId URL-safe identifier (e.g., "my-agent-sdk"). Must match [a-zA-Z0-9-].
     * @param metadataCid IPFS CID of the project metadata document.
     *
     * @dev The caller must be a registered, active agent. They become the creator
     *      and first Admin collaborator. If paymentToken is set and creationFee > 0,
     *      the caller must have approved this contract to transfer creationFee tokens.
     *
     * Emits {ProjectCreated} and {CollaboratorAdded}.
     */
    function createProject(
        string calldata projectId,
        string calldata metadataCid
    ) external whenNotPaused nonReentrant {
        // Validate inputs
        _validateProjectId(projectId);
        if (bytes(metadataCid).length == 0) revert EmptyString();
        if (_projects[projectId].createdAt != 0) revert ProjectAlreadyExists();

        address sender = _msgSender();

        // Check agent is registered and active
        _requireActiveAgent(sender);

        bytes32 idHash = keccak256(abi.encode(projectId));

        // Effects: update state before external calls
        _projects[projectId] = ProjectInfo({
            creator: sender,
            metadataCid: metadataCid,
            collaboratorCount: 1,
            versionCount: 0,
            isActive: true,
            createdAt: block.timestamp,
            updatedAt: block.timestamp
        });

        // Creator is the first Admin collaborator
        _collaborators[projectId][sender] = CollaboratorRole.Admin;

        totalProjects++;

        emit ProjectCreated(
            idHash,
            projectId,
            sender,
            metadataCid,
            block.timestamp
        );

        emit CollaboratorAdded(
            idHash,
            projectId,
            sender,
            uint8(CollaboratorRole.Admin),
            sender,
            block.timestamp
        );

        // Interactions: charge creation fee if active
        if (address(paymentToken) != address(0) && creationFee > 0) {
            paymentToken.safeTransferFrom(sender, treasury, creationFee);
        }
    }

    /**
     * @notice Update the project metadata document.
     * @param projectId Project ID.
     * @param newMetadataCid New IPFS CID for the metadata document.
     *
     * @dev Only the creator or an Admin collaborator can update metadata.
     *
     * Emits {ProjectUpdated}.
     */
    function updateProject(
        string calldata projectId,
        string calldata newMetadataCid
    ) external whenNotPaused {
        if (bytes(newMetadataCid).length == 0) revert EmptyString();
        _requireProjectExists(projectId);
        _requireProjectActive(projectId);
        address sender = _msgSender();
        _requireAdminOrCreator(projectId, sender);

        string memory oldCid = _projects[projectId].metadataCid;
        _projects[projectId].metadataCid = newMetadataCid;
        _projects[projectId].updatedAt = block.timestamp;

        emit ProjectUpdated(
            keccak256(abi.encode(projectId)),
            projectId,
            oldCid,
            newMetadataCid,
            sender,
            block.timestamp
        );
    }

    // ============================================================
    //                  COLLABORATOR MANAGEMENT
    // ============================================================

    /**
     * @notice Add a collaborator to a project.
     * @param projectId Project ID.
     * @param collaborator Address of the agent to add.
     * @param role Collaborator role (1=Viewer, 2=Contributor, 3=Admin).
     *
     * @dev Only the creator or an Admin collaborator can add collaborators.
     *      The new collaborator must be a registered, active agent.
     *
     * Emits {CollaboratorAdded}.
     */
    function addCollaborator(
        string calldata projectId,
        address collaborator,
        uint8 role
    ) external whenNotPaused {
        if (collaborator == address(0)) revert ZeroAddress();
        if (role < 1 || role > 3) revert InvalidRole();
        _requireProjectExists(projectId);
        _requireProjectActive(projectId);
        address sender = _msgSender();
        _requireAdminOrCreator(projectId, sender);
        _requireActiveAgent(collaborator);

        if (_collaborators[projectId][collaborator] != CollaboratorRole.None) {
            revert AlreadyCollaborator();
        }
        if (_projects[projectId].collaboratorCount >= MAX_COLLABORATORS) {
            revert TooManyCollaborators();
        }

        _collaborators[projectId][collaborator] = CollaboratorRole(role);
        _projects[projectId].collaboratorCount++;

        emit CollaboratorAdded(
            keccak256(abi.encode(projectId)),
            projectId,
            collaborator,
            role,
            sender,
            block.timestamp
        );
    }

    /**
     * @notice Remove a collaborator from a project.
     * @param projectId Project ID.
     * @param collaborator Address of the collaborator to remove.
     *
     * @dev Only the creator or an Admin collaborator can remove collaborators.
     *      The creator cannot be removed.
     *
     * Emits {CollaboratorRemoved}.
     */
    function removeCollaborator(
        string calldata projectId,
        address collaborator
    ) external whenNotPaused {
        _requireProjectExists(projectId);
        _requireProjectActive(projectId);
        address sender = _msgSender();
        _requireAdminOrCreator(projectId, sender);

        if (collaborator == _projects[projectId].creator) revert CannotRemoveCreator();
        if (_collaborators[projectId][collaborator] == CollaboratorRole.None) {
            revert ProjectNotFound(); // not a collaborator
        }

        _collaborators[projectId][collaborator] = CollaboratorRole.None;
        _projects[projectId].collaboratorCount--;

        emit CollaboratorRemoved(
            keccak256(abi.encode(projectId)),
            projectId,
            collaborator,
            sender,
            block.timestamp
        );
    }

    // ============================================================
    //                    VERSION SNAPSHOTS
    // ============================================================

    /**
     * @notice Record a version snapshot for a project.
     * @param projectId Project ID.
     * @param commitHash Git commit hash (40 hex characters).
     * @param metadataCid Optional IPFS CID of version-specific metadata.
     *
     * @dev Only Contributor or Admin collaborators (or creator) can snapshot.
     *      The commit hash must be exactly 40 hex characters.
     *
     * Emits {VersionSnapshot}.
     */
    function snapshotVersion(
        string calldata projectId,
        string calldata commitHash,
        string calldata metadataCid
    ) external whenNotPaused {
        _requireProjectExists(projectId);
        _requireProjectActive(projectId);
        address sender = _msgSender();
        _requireContributorOrAbove(projectId, sender);

        _validateCommitHash(commitHash);

        _projects[projectId].versionCount++;
        _projects[projectId].updatedAt = block.timestamp;

        emit VersionSnapshot(
            keccak256(abi.encode(projectId)),
            projectId,
            _projects[projectId].versionCount,
            commitHash,
            metadataCid,
            sender,
            block.timestamp
        );
    }

    // ============================================================
    //                     DEACTIVATION
    // ============================================================

    /**
     * @notice Deactivate a project. Prevents new snapshots and collaborator changes.
     * @param projectId Project ID.
     *
     * @dev Only the creator can deactivate their project. The admin (owner)
     *      can also force-deactivate via forceDeactivate().
     *
     * Emits {ProjectDeactivated}.
     */
    function deactivateProject(string calldata projectId) external whenNotPaused {
        _requireProjectExists(projectId);
        address sender = _msgSender();
        _requireCreator(projectId, sender);

        _projects[projectId].isActive = false;

        emit ProjectDeactivated(
            keccak256(abi.encode(projectId)),
            projectId,
            sender,
            block.timestamp
        );
    }

    // ============================================================
    //                      VIEW FUNCTIONS
    // ============================================================

    /**
     * @notice Get the full info for a project.
     * @param projectId Project ID to look up.
     * @return ProjectInfo struct with all on-chain data.
     */
    function getProject(string calldata projectId) external view returns (ProjectInfo memory) {
        if (_projects[projectId].createdAt == 0) revert ProjectNotFound();
        return _projects[projectId];
    }

    /**
     * @notice Check if a project ID has been registered.
     * @param projectId Project ID to check.
     * @return True if the project exists (regardless of active status).
     */
    function projectExists(string calldata projectId) external view returns (bool) {
        return _projects[projectId].createdAt != 0;
    }

    /**
     * @notice Check if a project is registered and active.
     * @param projectId Project ID to check.
     * @return True if the project exists and is active.
     */
    function isProjectActive(string calldata projectId) external view returns (bool) {
        return _projects[projectId].createdAt != 0 && _projects[projectId].isActive;
    }

    /**
     * @notice Check if an address is a collaborator on a project.
     * @param projectId Project ID.
     * @param addr Address to check.
     * @return True if the address has any role (Viewer, Contributor, or Admin).
     */
    function isCollaborator(string calldata projectId, address addr) external view returns (bool) {
        return _collaborators[projectId][addr] != CollaboratorRole.None;
    }

    /**
     * @notice Get the collaborator role for an address on a project.
     * @param projectId Project ID.
     * @param addr Address to check.
     * @return The CollaboratorRole enum value (0=None, 1=Viewer, 2=Contributor, 3=Admin).
     */
    function getCollaboratorRole(string calldata projectId, address addr) external view returns (uint8) {
        return uint8(_collaborators[projectId][addr]);
    }

    // ============================================================
    //                      ADMIN FUNCTIONS
    // ============================================================

    /**
     * @notice Force-deactivate a project (admin override).
     * @param projectId Project ID to deactivate.
     *
     * @dev Only callable by the contract owner.
     *
     * Emits {ProjectDeactivated}.
     */
    function forceDeactivate(string calldata projectId) external onlyOwner {
        _requireProjectExists(projectId);
        _projects[projectId].isActive = false;

        emit ProjectDeactivated(
            keccak256(abi.encode(projectId)),
            projectId,
            _msgSender(),
            block.timestamp
        );
    }

    /**
     * @notice Force-reactivate a project (admin override).
     * @param projectId Project ID to reactivate.
     *
     * @dev Only callable by the contract owner.
     *
     * Emits {ProjectReactivated}.
     */
    function forceReactivate(string calldata projectId) external onlyOwner {
        _requireProjectExists(projectId);
        _projects[projectId].isActive = true;

        emit ProjectReactivated(
            keccak256(abi.encode(projectId)),
            projectId,
            _msgSender(),
            block.timestamp
        );
    }

    /**
     * @notice Set the payment token address. address(0) = free mode.
     * @param token ERC-20 token address, or address(0) to disable fees.
     *
     * Emits {PaymentTokenUpdated}.
     */
    function setPaymentToken(address token) external onlyOwner {
        address oldToken = address(paymentToken);
        paymentToken = IERC20(token);
        emit PaymentTokenUpdated(oldToken, token);
    }

    /**
     * @notice Set the fee charged for project creation.
     * @param fee Token amount per project creation (0 = free).
     *
     * Emits {CreationFeeUpdated}.
     */
    function setCreationFee(uint256 fee) external onlyOwner {
        uint256 oldFee = creationFee;
        creationFee = fee;
        emit CreationFeeUpdated(oldFee, fee);
    }

    /**
     * @notice Update the treasury address where creation fees are sent.
     * @param newTreasury New treasury address.
     */
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        address oldTreasury = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(oldTreasury, newTreasury);
    }

    /**
     * @notice Update the AgentRegistry contract reference.
     * @param newRegistry Address of the new AgentRegistry contract.
     *
     * Emits {AgentRegistryUpdated}.
     */
    function setAgentRegistry(address newRegistry) external onlyOwner {
        if (newRegistry == address(0)) revert ZeroAddress();
        address oldRegistry = agentRegistry;
        agentRegistry = newRegistry;
        emit AgentRegistryUpdated(oldRegistry, newRegistry);
    }

    /// @notice Pause all project operations (emergency stop).
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause project operations.
    function unpause() external onlyOwner {
        _unpause();
    }

    // ============================================================
    //                     INTERNAL HELPERS
    // ============================================================

    /**
     * @dev Validate a project ID: non-empty, max length, only [a-zA-Z0-9-].
     */
    function _validateProjectId(string calldata projectId) internal pure {
        bytes memory b = bytes(projectId);
        if (b.length == 0) revert InvalidProjectId();
        if (b.length > MAX_PROJECT_ID_LENGTH) revert InvalidProjectId();

        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            bool isValid = (c >= 0x30 && c <= 0x39) || // 0-9
                           (c >= 0x41 && c <= 0x5A) || // A-Z
                           (c >= 0x61 && c <= 0x7A) || // a-z
                           (c == 0x2D);                 // -
            if (!isValid) revert InvalidProjectId();
        }
    }

    /**
     * @dev Validate a commit hash: exactly 40 hex characters.
     */
    function _validateCommitHash(string calldata commitHash) internal pure {
        bytes memory b = bytes(commitHash);
        if (b.length != 40) revert InvalidCommitHash();

        for (uint256 i = 0; i < 40; i++) {
            bytes1 c = b[i];
            bool isValid = (c >= 0x30 && c <= 0x39) || // 0-9
                           (c >= 0x41 && c <= 0x46) || // A-F
                           (c >= 0x61 && c <= 0x66);   // a-f
            if (!isValid) revert InvalidCommitHash();
        }
    }

    /**
     * @dev Check that a project exists.
     */
    function _requireProjectExists(string calldata projectId) internal view {
        if (_projects[projectId].createdAt == 0) revert ProjectNotFound();
    }

    /**
     * @dev Check that a project is active.
     */
    function _requireProjectActive(string calldata projectId) internal view {
        if (!_projects[projectId].isActive) revert ProjectNotActive();
    }

    /**
     * @dev Check that the caller is the project creator.
     */
    function _requireCreator(string calldata projectId, address caller) internal view {
        if (_projects[projectId].creator != caller) revert NotCreator();
    }

    /**
     * @dev Check that the caller is the creator or an Admin collaborator.
     */
    function _requireAdminOrCreator(string calldata projectId, address caller) internal view {
        if (_projects[projectId].creator != caller &&
            _collaborators[projectId][caller] != CollaboratorRole.Admin) {
            revert NotAdmin();
        }
    }

    /**
     * @dev Check that the caller has Contributor or higher role (or is creator).
     */
    function _requireContributorOrAbove(string calldata projectId, address caller) internal view {
        if (_projects[projectId].creator == caller) return;
        CollaboratorRole role = _collaborators[projectId][caller];
        if (role != CollaboratorRole.Contributor && role != CollaboratorRole.Admin) {
            revert InsufficientRole();
        }
    }

    /**
     * @dev Check that an address is a registered, active agent.
     *      Makes a static call to AgentRegistry.isActiveAgent().
     */
    function _requireActiveAgent(address agent) internal view {
        (bool success, bytes memory data) = agentRegistry.staticcall(
            abi.encodeWithSignature("isActiveAgent(address)", agent)
        );

        if (!success || data.length == 0) revert NotRegisteredAgent();

        bool isActive = abi.decode(data, (bool));
        if (!isActive) revert NotRegisteredAgent();
    }

    // ============================================================
    //                   ERC-2771 OVERRIDES
    // ============================================================

    function _msgSender() internal view override(ContextUpgradeable, ERC2771ContextUpgradeable) returns (address) {
        return ERC2771ContextUpgradeable._msgSender();
    }

    function _msgData() internal view override(ContextUpgradeable, ERC2771ContextUpgradeable) returns (bytes calldata) {
        return ERC2771ContextUpgradeable._msgData();
    }

    function _contextSuffixLength() internal view override(ContextUpgradeable, ERC2771ContextUpgradeable) returns (uint256) {
        return ERC2771ContextUpgradeable._contextSuffixLength();
    }

    // ============================================================
    //                     UUPS UPGRADE AUTH
    // ============================================================

    /**
     * @notice Authorization check for UUPS upgrades.
     * @dev Only the contract owner can authorize upgrades.
     */
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
