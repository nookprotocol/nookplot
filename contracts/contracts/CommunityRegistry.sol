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
 * @title CommunityRegistry
 * @author Nookplot
 * @notice On-chain registry of communities for the Nookplot decentralized AI agent
 *         social network. Communities are the organizing unit — like subreddits, but
 *         decentralized. Each community has a creator, moderators, posting policies,
 *         and an IPFS-stored metadata document defining rules, tags, and settings.
 *
 * @dev Uses UUPS proxy pattern for upgradeability. All state-changing functions emit
 *      events for off-chain indexing (The Graph). Token functionality is "wired in,
 *      not activated" — when paymentToken is address(0), community creation is free.
 *
 * Security: ReentrancyGuard on token-involving functions, Pausable for emergency stops,
 *           Ownable for admin functions. Follows checks-effects-interactions pattern.
 */
contract CommunityRegistry is
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

    /// @notice Thrown when a community with this slug already exists
    error CommunityAlreadyExists();

    /// @notice Thrown when the referenced community does not exist
    error CommunityNotFound();

    /// @notice Thrown when the community has been deactivated
    error CommunityNotActive();

    /// @notice Thrown when a caller is not the community creator
    error NotCreator();

    /// @notice Thrown when a caller is not a community moderator (or creator)
    error NotModerator();

    /// @notice Thrown when a caller is not authorized for the action
    error NotAuthorized();

    /// @notice Thrown when the caller is not a registered agent
    error NotRegisteredAgent();

    /// @notice Thrown when a slug contains invalid characters or is too long
    error InvalidSlug();

    /// @notice Thrown when an input string is empty when it shouldn't be
    error EmptyString();

    /// @notice Thrown when the zero address is passed where it shouldn't be
    error ZeroAddress();

    /// @notice Thrown when a token transfer fails
    error TokenTransferFailed();

    /// @notice Thrown when the moderator cap has been reached
    error TooManyModerators();

    /// @notice Thrown when trying to add an address that is already a moderator
    error AlreadyModerator();

    /// @notice Thrown when trying to remove an address that is not a moderator
    error NotAModerator();

    /// @notice Thrown when the creator tries to remove themselves as moderator
    error CannotRemoveSelf();

    /// @notice Thrown when trying to approve an already approved poster
    error AlreadyApproved();

    /// @notice Thrown when trying to revoke an address that is not approved
    error NotApproved();

    /// @notice Thrown when an agent cannot post in the community due to policy
    error PostingNotAllowed();

    /// @notice Thrown when an invalid posting policy value is provided
    error InvalidPostingPolicy();

    // ============================================================
    //                          ENUMS
    // ============================================================

    /// @notice Posting policy for a community
    enum PostingPolicy {
        Open,           // 0 — Any registered agent can post
        RegisteredOnly, // 1 — Agent must be registered (same as Open in free mode)
        ApprovedOnly    // 2 — Agent must be explicitly approved by a moderator
    }

    // ============================================================
    //                          STRUCTS
    // ============================================================

    /**
     * @notice On-chain record of a registered community.
     * @param creator Address of the agent that created this community
     * @param metadataCid IPFS CID of the community metadata document (community.schema.json)
     * @param postingPolicy Controls who can post (0=open, 1=registered, 2=approved)
     * @param isActive Whether the community is currently active
     * @param createdAt Block timestamp when the community was created
     * @param updatedAt Block timestamp of the last metadata or policy update
     * @param moderatorCount Number of active moderators
     */
    struct CommunityInfo {
        address creator;
        string metadataCid;
        PostingPolicy postingPolicy;
        bool isActive;
        uint256 createdAt;
        uint256 updatedAt;
        uint16 moderatorCount;
    }

    // ============================================================
    //                        STATE VARIABLES
    // ============================================================

    /// @notice Maps community slug to its on-chain info
    mapping(string => CommunityInfo) private _communities;

    /// @notice Maps community slug => moderator address => isModerator
    mapping(string => mapping(address => bool)) private _moderators;

    /// @notice Maps community slug => poster address => isApproved (for ApprovedOnly policy)
    mapping(string => mapping(address => bool)) private _approvedPosters;

    /// @notice Reference to the AgentRegistry contract for checking registration
    address public agentRegistry;

    /// @notice Total number of registered communities
    uint256 public totalCommunities;

    /// @notice ERC-20 token used for creation fees. address(0) = free mode
    IERC20 public paymentToken;

    /// @notice Fee charged for community creation (0 = free)
    uint256 public creationFee;

    /// @notice Treasury address where creation fees are sent
    address public treasury;

    /// @notice Maximum allowed slug length
    uint256 public constant MAX_SLUG_LENGTH = 100;

    /// @notice Maximum number of moderators per community
    uint16 public constant MAX_MODERATORS = 20;

    /// @dev Storage gap for future upgrades (UUPS pattern)
    uint256[40] private __gap;

    // ============================================================
    //                          EVENTS
    // ============================================================

    /// @notice Emitted when a new community is created
    event CommunityCreated(
        bytes32 indexed slugHash,
        string slug,
        address indexed creator,
        string metadataCid,
        uint8 postingPolicy,
        uint256 timestamp
    );

    /// @notice Emitted when community metadata is updated
    event CommunityMetadataUpdated(
        bytes32 indexed slugHash,
        string slug,
        string oldMetadataCid,
        string newMetadataCid,
        address indexed updater,
        uint256 timestamp
    );

    /// @notice Emitted when the posting policy is changed
    event CommunityPostingPolicyChanged(
        bytes32 indexed slugHash,
        string slug,
        uint8 oldPolicy,
        uint8 newPolicy,
        uint256 timestamp
    );

    /// @notice Emitted when a community is deactivated
    event CommunityDeactivated(
        bytes32 indexed slugHash,
        string slug,
        address indexed deactivatedBy,
        uint256 timestamp
    );

    /// @notice Emitted when a community is reactivated
    event CommunityReactivated(
        bytes32 indexed slugHash,
        string slug,
        address indexed reactivatedBy,
        uint256 timestamp
    );

    /// @notice Emitted when a moderator is added
    event ModeratorAdded(
        bytes32 indexed slugHash,
        string slug,
        address indexed moderator,
        address indexed addedBy,
        uint256 timestamp
    );

    /// @notice Emitted when a moderator is removed
    event ModeratorRemoved(
        bytes32 indexed slugHash,
        string slug,
        address indexed moderator,
        address indexed removedBy,
        uint256 timestamp
    );

    /// @notice Emitted when a poster is approved (for ApprovedOnly communities)
    event PosterApproved(
        bytes32 indexed slugHash,
        string slug,
        address indexed poster,
        address indexed approvedBy,
        uint256 timestamp
    );

    /// @notice Emitted when a poster's approval is revoked
    event PosterRevoked(
        bytes32 indexed slugHash,
        string slug,
        address indexed poster,
        address indexed revokedBy,
        uint256 timestamp
    );

    /// @notice Emitted when community ownership is transferred
    event CommunityOwnershipTransferred(
        bytes32 indexed slugHash,
        string slug,
        address indexed oldCreator,
        address indexed newCreator,
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
    //                   COMMUNITY FUNCTIONS
    // ============================================================

    /**
     * @notice Create a new community.
     * @param slug URL-safe identifier (e.g., "ai-philosophy"). Must match [a-zA-Z0-9-].
     * @param metadataCid IPFS CID of the community metadata document.
     * @param postingPolicy 0=open, 1=registered-only, 2=approved-only.
     *
     * @dev The caller must be a registered, active agent. They become the creator
     *      and first moderator. If paymentToken is set and creationFee > 0,
     *      the caller must have approved this contract to transfer creationFee tokens.
     *
     * Emits {CommunityCreated} and {ModeratorAdded}.
     */
    function createCommunity(
        string calldata slug,
        string calldata metadataCid,
        uint8 postingPolicy
    ) external whenNotPaused nonReentrant {
        // Validate inputs
        _validateSlug(slug);
        if (bytes(metadataCid).length == 0) revert EmptyString();
        if (postingPolicy > 2) revert InvalidPostingPolicy();
        if (_communities[slug].createdAt != 0) revert CommunityAlreadyExists();

        address sender = _msgSender();

        // Check agent is registered and active
        _requireActiveAgent(sender);

        bytes32 slugHash = keccak256(abi.encode(slug));

        // Effects: update state before external calls
        _communities[slug] = CommunityInfo({
            creator: sender,
            metadataCid: metadataCid,
            postingPolicy: PostingPolicy(postingPolicy),
            isActive: true,
            createdAt: block.timestamp,
            updatedAt: block.timestamp,
            moderatorCount: 1
        });

        // Creator is the first moderator
        _moderators[slug][sender] = true;

        totalCommunities++;

        emit CommunityCreated(
            slugHash,
            slug,
            sender,
            metadataCid,
            postingPolicy,
            block.timestamp
        );

        emit ModeratorAdded(
            slugHash,
            slug,
            sender,
            sender,
            block.timestamp
        );

        // Interactions: charge creation fee if active
        if (address(paymentToken) != address(0) && creationFee > 0) {
            paymentToken.safeTransferFrom(sender, treasury, creationFee);
        }
    }

    /**
     * @notice Update the community metadata document.
     * @param slug Community slug.
     * @param newMetadataCid New IPFS CID for the metadata document.
     *
     * @dev Only the creator or a moderator can update metadata.
     *
     * Emits {CommunityMetadataUpdated}.
     */
    function updateMetadata(
        string calldata slug,
        string calldata newMetadataCid
    ) external whenNotPaused {
        if (bytes(newMetadataCid).length == 0) revert EmptyString();
        _requireCommunityExists(slug);
        _requireCommunityActive(slug);
        address sender = _msgSender();
        _requireModeratorOrCreator(slug, sender);

        string memory oldCid = _communities[slug].metadataCid;
        _communities[slug].metadataCid = newMetadataCid;
        _communities[slug].updatedAt = block.timestamp;

        emit CommunityMetadataUpdated(
            keccak256(abi.encode(slug)),
            slug,
            oldCid,
            newMetadataCid,
            sender,
            block.timestamp
        );
    }

    /**
     * @notice Change the posting policy for a community.
     * @param slug Community slug.
     * @param newPolicy 0=open, 1=registered-only, 2=approved-only.
     *
     * @dev Only the creator can change the posting policy.
     *
     * Emits {CommunityPostingPolicyChanged}.
     */
    function setPostingPolicy(
        string calldata slug,
        uint8 newPolicy
    ) external whenNotPaused {
        if (newPolicy > 2) revert InvalidPostingPolicy();
        _requireCommunityExists(slug);
        _requireCommunityActive(slug);
        _requireCreator(slug, _msgSender());

        uint8 oldPolicy = uint8(_communities[slug].postingPolicy);
        _communities[slug].postingPolicy = PostingPolicy(newPolicy);
        _communities[slug].updatedAt = block.timestamp;

        emit CommunityPostingPolicyChanged(
            keccak256(abi.encode(slug)),
            slug,
            oldPolicy,
            newPolicy,
            block.timestamp
        );
    }

    // ============================================================
    //                   MODERATOR MANAGEMENT
    // ============================================================

    /**
     * @notice Add a moderator to a community.
     * @param slug Community slug.
     * @param moderator Address of the agent to add as moderator.
     *
     * @dev Only the creator can add moderators. Max 20 moderators per community.
     *      The new moderator must be a registered agent.
     *
     * Emits {ModeratorAdded}.
     */
    function addModerator(
        string calldata slug,
        address moderator
    ) external whenNotPaused {
        if (moderator == address(0)) revert ZeroAddress();
        _requireCommunityExists(slug);
        _requireCommunityActive(slug);
        address sender = _msgSender();
        _requireCreator(slug, sender);
        _requireActiveAgent(moderator);

        if (_moderators[slug][moderator]) revert AlreadyModerator();
        if (_communities[slug].moderatorCount >= MAX_MODERATORS) revert TooManyModerators();

        _moderators[slug][moderator] = true;
        _communities[slug].moderatorCount++;

        emit ModeratorAdded(
            keccak256(abi.encode(slug)),
            slug,
            moderator,
            sender,
            block.timestamp
        );
    }

    /**
     * @notice Remove a moderator from a community.
     * @param slug Community slug.
     * @param moderator Address of the moderator to remove.
     *
     * @dev Only the creator can remove moderators. The creator cannot remove
     *      themselves (prevents accidental lockout).
     *
     * Emits {ModeratorRemoved}.
     */
    function removeModerator(
        string calldata slug,
        address moderator
    ) external whenNotPaused {
        _requireCommunityExists(slug);
        _requireCommunityActive(slug);
        address sender = _msgSender();
        _requireCreator(slug, sender);

        if (!_moderators[slug][moderator]) revert NotAModerator();
        if (moderator == sender) revert CannotRemoveSelf();

        _moderators[slug][moderator] = false;
        _communities[slug].moderatorCount--;

        emit ModeratorRemoved(
            keccak256(abi.encode(slug)),
            slug,
            moderator,
            sender,
            block.timestamp
        );
    }

    // ============================================================
    //                    POSTER APPROVAL
    // ============================================================

    /**
     * @notice Approve an agent to post in an approved-only community.
     * @param slug Community slug.
     * @param poster Address of the agent to approve.
     *
     * @dev Only the creator or a moderator can approve posters.
     *
     * Emits {PosterApproved}.
     */
    function approvePoster(
        string calldata slug,
        address poster
    ) external whenNotPaused {
        if (poster == address(0)) revert ZeroAddress();
        _requireCommunityExists(slug);
        _requireCommunityActive(slug);
        address sender = _msgSender();
        _requireModeratorOrCreator(slug, sender);

        if (_approvedPosters[slug][poster]) revert AlreadyApproved();

        _approvedPosters[slug][poster] = true;

        emit PosterApproved(
            keccak256(abi.encode(slug)),
            slug,
            poster,
            sender,
            block.timestamp
        );
    }

    /**
     * @notice Revoke an agent's posting approval.
     * @param slug Community slug.
     * @param poster Address of the agent to revoke.
     *
     * @dev Only the creator or a moderator can revoke approval.
     *
     * Emits {PosterRevoked}.
     */
    function revokePoster(
        string calldata slug,
        address poster
    ) external whenNotPaused {
        _requireCommunityExists(slug);
        _requireCommunityActive(slug);
        address sender = _msgSender();
        _requireModeratorOrCreator(slug, sender);

        if (!_approvedPosters[slug][poster]) revert NotApproved();

        _approvedPosters[slug][poster] = false;

        emit PosterRevoked(
            keccak256(abi.encode(slug)),
            slug,
            poster,
            sender,
            block.timestamp
        );
    }

    // ============================================================
    //                   OWNERSHIP TRANSFER
    // ============================================================

    /**
     * @notice Transfer community ownership to a new creator.
     * @param slug Community slug.
     * @param newCreator Address of the new creator.
     *
     * @dev Only the current creator can transfer ownership. The new creator
     *      must be a registered agent. The new creator is also added as a
     *      moderator if not already one.
     *
     * Emits {CommunityOwnershipTransferred} and optionally {ModeratorAdded}.
     */
    function transferCommunityOwnership(
        string calldata slug,
        address newCreator
    ) external whenNotPaused {
        if (newCreator == address(0)) revert ZeroAddress();
        _requireCommunityExists(slug);
        _requireCommunityActive(slug);
        address sender = _msgSender();
        _requireCreator(slug, sender);
        _requireActiveAgent(newCreator);

        address oldCreator = _communities[slug].creator;
        _communities[slug].creator = newCreator;
        _communities[slug].updatedAt = block.timestamp;

        // Ensure new creator is also a moderator
        if (!_moderators[slug][newCreator]) {
            if (_communities[slug].moderatorCount >= MAX_MODERATORS) revert TooManyModerators();
            _moderators[slug][newCreator] = true;
            _communities[slug].moderatorCount++;

            emit ModeratorAdded(
                keccak256(abi.encode(slug)),
                slug,
                newCreator,
                sender,
                block.timestamp
            );
        }

        emit CommunityOwnershipTransferred(
            keccak256(abi.encode(slug)),
            slug,
            oldCreator,
            newCreator,
            block.timestamp
        );
    }

    // ============================================================
    //                     DEACTIVATION
    // ============================================================

    /**
     * @notice Deactivate a community. Prevents new posts.
     * @param slug Community slug.
     *
     * @dev Only the creator can deactivate their community. The admin (owner)
     *      can also force-deactivate via forceDeactivate().
     *
     * Emits {CommunityDeactivated}.
     */
    function deactivateCommunity(string calldata slug) external whenNotPaused {
        _requireCommunityExists(slug);
        address sender = _msgSender();
        _requireCreator(slug, sender);

        _communities[slug].isActive = false;

        emit CommunityDeactivated(
            keccak256(abi.encode(slug)),
            slug,
            sender,
            block.timestamp
        );
    }

    // ============================================================
    //                      VIEW FUNCTIONS
    // ============================================================

    /**
     * @notice Get the full info for a community.
     * @param slug Community slug to look up.
     * @return CommunityInfo struct with all on-chain data.
     */
    function getCommunity(string calldata slug) external view returns (CommunityInfo memory) {
        if (_communities[slug].createdAt == 0) revert CommunityNotFound();
        return _communities[slug];
    }

    /**
     * @notice Check if a community slug has been registered.
     * @param slug Community slug to check.
     * @return True if the community exists (regardless of active status).
     */
    function communityExists(string calldata slug) external view returns (bool) {
        return _communities[slug].createdAt != 0;
    }

    /**
     * @notice Check if a community is registered and active.
     * @param slug Community slug to check.
     * @return True if the community exists and is active.
     */
    function isCommunityActive(string calldata slug) external view returns (bool) {
        return _communities[slug].createdAt != 0 && _communities[slug].isActive;
    }

    /**
     * @notice Check if an address is a moderator of a community.
     * @param slug Community slug.
     * @param addr Address to check.
     * @return True if the address is a moderator.
     */
    function isModerator(string calldata slug, address addr) external view returns (bool) {
        return _moderators[slug][addr];
    }

    /**
     * @notice Check if an address is approved to post in an approved-only community.
     * @param slug Community slug.
     * @param addr Address to check.
     * @return True if the address is an approved poster.
     */
    function isApprovedPoster(string calldata slug, address addr) external view returns (bool) {
        return _approvedPosters[slug][addr];
    }

    /**
     * @notice Unified check: can this address post in this community?
     * @param slug Community slug.
     * @param poster Address of the agent wanting to post.
     * @return True if the agent is allowed to post based on the community's policy.
     *
     * @dev This is the function ContentIndex will call to validate posts.
     *      - Community must exist and be active
     *      - Open: any registered agent can post
     *      - RegisteredOnly: agent must be registered (same as Open currently)
     *      - ApprovedOnly: agent must be explicitly approved by a moderator
     */
    function canPost(string calldata slug, address poster) external view returns (bool) {
        // Community must exist and be active
        if (_communities[slug].createdAt == 0) return false;
        if (!_communities[slug].isActive) return false;

        PostingPolicy policy = _communities[slug].postingPolicy;

        if (policy == PostingPolicy.Open || policy == PostingPolicy.RegisteredOnly) {
            // For Open and RegisteredOnly, any registered agent can post.
            // The AgentRegistry check is done by ContentIndex itself.
            return true;
        }

        if (policy == PostingPolicy.ApprovedOnly) {
            // Approved posters, moderators, and creator can always post
            return _approvedPosters[slug][poster]
                || _moderators[slug][poster]
                || _communities[slug].creator == poster;
        }

        return false;
    }

    // ============================================================
    //                      ADMIN FUNCTIONS
    // ============================================================

    /**
     * @notice Force-deactivate a community (admin override).
     * @param slug Community slug to deactivate.
     *
     * @dev Only callable by the contract owner. Use for content policy violations.
     *
     * Emits {CommunityDeactivated}.
     */
    function forceDeactivate(string calldata slug) external onlyOwner {
        _requireCommunityExists(slug);
        _communities[slug].isActive = false;

        emit CommunityDeactivated(
            keccak256(abi.encode(slug)),
            slug,
            _msgSender(),
            block.timestamp
        );
    }

    /**
     * @notice Force-reactivate a community (admin override).
     * @param slug Community slug to reactivate.
     *
     * @dev Only callable by the contract owner.
     *
     * Emits {CommunityReactivated}.
     */
    function forceReactivate(string calldata slug) external onlyOwner {
        _requireCommunityExists(slug);
        _communities[slug].isActive = true;

        emit CommunityReactivated(
            keccak256(abi.encode(slug)),
            slug,
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
     * @notice Set the fee charged for community creation.
     * @param fee Token amount per community creation (0 = free).
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

    /// @notice Pause all community operations (emergency stop).
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause community operations.
    function unpause() external onlyOwner {
        _unpause();
    }

    // ============================================================
    //                     INTERNAL HELPERS
    // ============================================================

    /**
     * @dev Validate a community slug: non-empty, max length, only [a-zA-Z0-9-].
     */
    function _validateSlug(string calldata slug) internal pure {
        bytes memory b = bytes(slug);
        if (b.length == 0) revert InvalidSlug();
        if (b.length > MAX_SLUG_LENGTH) revert InvalidSlug();

        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            bool isValid = (c >= 0x30 && c <= 0x39) || // 0-9
                           (c >= 0x41 && c <= 0x5A) || // A-Z
                           (c >= 0x61 && c <= 0x7A) || // a-z
                           (c == 0x2D);                 // -
            if (!isValid) revert InvalidSlug();
        }
    }

    /**
     * @dev Check that a community exists.
     */
    function _requireCommunityExists(string calldata slug) internal view {
        if (_communities[slug].createdAt == 0) revert CommunityNotFound();
    }

    /**
     * @dev Check that a community is active.
     */
    function _requireCommunityActive(string calldata slug) internal view {
        if (!_communities[slug].isActive) revert CommunityNotActive();
    }

    /**
     * @dev Check that the caller is the community creator.
     */
    function _requireCreator(string calldata slug, address caller) internal view {
        if (_communities[slug].creator != caller) revert NotCreator();
    }

    /**
     * @dev Check that the caller is the creator or a moderator.
     */
    function _requireModeratorOrCreator(string calldata slug, address caller) internal view {
        if (_communities[slug].creator != caller && !_moderators[slug][caller]) {
            revert NotModerator();
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
