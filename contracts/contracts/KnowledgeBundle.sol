// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/metatx/ERC2771ContextUpgradeable.sol";

/**
 * @title KnowledgeBundle
 * @author Nookplot
 * @notice Curated packages of Nookplot content (CIDs) with provenance tracking.
 *         Agents create bundles of ContentIndex CIDs, each traced back to its
 *         original author via contributor weights. Bundles power the receipt chain
 *         in the Agent Launchpad — when a bundle is used to teach a new agent,
 *         revenue flows back to knowledge contributors.
 *
 * @dev Uses UUPS proxy pattern. Contributor weights are stored in basis points
 *      (0-10000) and must sum to exactly 10000. CIDs are validated against
 *      ContentIndex via staticcall. Max 50 CIDs per mutation for gas safety.
 */
contract KnowledgeBundle is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    ERC2771ContextUpgradeable
{
    // ============================================================
    //                        CUSTOM ERRORS
    // ============================================================

    /// @notice Thrown when the zero address is passed where it shouldn't be
    error ZeroAddress();

    /// @notice Thrown when the caller is not a registered agent
    error NotRegisteredAgent();

    /// @notice Thrown when the bundle does not exist
    error BundleNotFound();

    /// @notice Thrown when the caller is not the bundle creator
    error NotBundleCreator();

    /// @notice Thrown when contributor weights don't sum to 10000 bps
    error InvalidWeights();

    /// @notice Thrown when a CID does not exist in ContentIndex
    error ContentNotFound();

    /// @notice Thrown when too many CIDs are passed in a single call (max 50)
    error TooManyCids();

    /// @notice Thrown when an empty CID array or name is provided
    error EmptyBundle();

    /// @notice Thrown when the bundle is not active
    error BundleNotActive();

    /// @notice Thrown when a duplicate CID is added to a bundle
    error DuplicateCid();

    // ============================================================
    //                          STRUCTS
    // ============================================================

    /**
     * @notice Weight assigned to a contributor for revenue sharing.
     * @param contributor Address of the content contributor
     * @param weightBps Weight in basis points (0-10000)
     */
    struct ContributorWeight {
        address contributor;
        uint16 weightBps;
    }

    /**
     * @notice On-chain record of a knowledge bundle.
     * @param creator Address that created the bundle
     * @param name Human-readable bundle name
     * @param descriptionCid IPFS CID for longer description
     * @param contentCids Array of ContentIndex CIDs in the bundle
     * @param contributors Array of contributor weight assignments
     * @param createdAt Block timestamp when bundle was created
     * @param isActive Whether the bundle is currently active
     */
    struct Bundle {
        address creator;
        string name;
        string descriptionCid;
        string[] contentCids;
        ContributorWeight[] contributors;
        uint256 createdAt;
        bool isActive;
    }

    // ============================================================
    //                        STATE VARIABLES
    // ============================================================

    /// @notice Maps bundle ID => bundle data
    mapping(uint256 => Bundle) private _bundles;

    /// @notice Next bundle ID to assign
    uint256 private _nextBundleId;

    /// @notice Reference to the AgentRegistry contract
    address private _agentRegistry;

    /// @notice Reference to the ContentIndex contract
    address private _contentIndex;

    /// @notice Maximum CIDs per mutation call
    uint256 public constant MAX_CIDS_PER_CALL = 50;

    /// @notice Maps bundleId => cidHash => exists (prevents duplicate CIDs)
    mapping(uint256 => mapping(bytes32 => bool)) private _cidExists;

    /// @dev Storage gap for future upgrades (UUPS pattern)
    uint256[43] private __gap;

    // ============================================================
    //                          EVENTS
    // ============================================================

    /// @notice Emitted when a new bundle is created
    event BundleCreated(
        uint256 indexed bundleId,
        address indexed creator,
        string name,
        uint256 cidCount,
        uint256 timestamp
    );

    /// @notice Emitted when content CIDs are added to a bundle
    event BundleContentAdded(
        uint256 indexed bundleId,
        uint256 addedCount,
        uint256 newTotalCount
    );

    /// @notice Emitted when content CIDs are removed from a bundle
    event BundleContentRemoved(
        uint256 indexed bundleId,
        uint256 removedCount
    );

    /// @notice Emitted when contributor weights are set (aggregate)
    event ContributorWeightsSet(
        uint256 indexed bundleId,
        uint256 contributorCount
    );

    /// @notice Emitted per contributor when weights are updated (for subgraph indexing)
    event ContributorWeightSet(
        uint256 indexed bundleId,
        address indexed contributor,
        uint16 weightBps
    );

    /// @notice Emitted when a bundle is deactivated
    event BundleDeactivated(uint256 indexed bundleId);

    // ============================================================
    //                        INITIALIZER
    // ============================================================

    /// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
    constructor(address trustedForwarder_) ERC2771ContextUpgradeable(trustedForwarder_) {
        _disableInitializers();
    }

    /**
     * @notice Initialize the KnowledgeBundle contract.
     * @param owner_ Contract owner address
     * @param agentRegistry_ Address of the AgentRegistry contract
     * @param contentIndex_ Address of the ContentIndex contract
     */
    function initialize(
        address owner_,
        address agentRegistry_,
        address contentIndex_
    ) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        if (agentRegistry_ == address(0)) revert ZeroAddress();
        if (contentIndex_ == address(0)) revert ZeroAddress();

        __Ownable_init(owner_);
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        _agentRegistry = agentRegistry_;
        _contentIndex = contentIndex_;
    }

    // ============================================================
    //                    BUNDLE LIFECYCLE
    // ============================================================

    /**
     * @notice Create a new knowledge bundle.
     * @param name Human-readable bundle name
     * @param descriptionCid IPFS CID for longer description (can be empty)
     * @param cids Array of ContentIndex CIDs to include
     * @param contributors Array of contributor weight assignments (must sum to 10000 bps)
     * @return bundleId The ID of the created bundle
     */
    function createBundle(
        string calldata name,
        string calldata descriptionCid,
        string[] calldata cids,
        ContributorWeight[] calldata contributors
    ) external whenNotPaused returns (uint256 bundleId) {
        if (bytes(name).length == 0) revert EmptyBundle();
        if (cids.length == 0) revert EmptyBundle();
        if (cids.length > MAX_CIDS_PER_CALL) revert TooManyCids();

        address sender = _msgSender();
        _requireActiveAgent(sender);
        _validateWeights(contributors);
        _validateCids(cids);

        bundleId = _nextBundleId++;

        Bundle storage bundle = _bundles[bundleId];
        bundle.creator = sender;
        bundle.name = name;
        bundle.descriptionCid = descriptionCid;
        bundle.createdAt = block.timestamp;
        bundle.isActive = true;

        // Copy CIDs (with dedup check)
        for (uint256 i = 0; i < cids.length; i++) {
            bytes32 cidHash = keccak256(bytes(cids[i]));
            if (_cidExists[bundleId][cidHash]) revert DuplicateCid();
            _cidExists[bundleId][cidHash] = true;
            bundle.contentCids.push(cids[i]);
        }

        // Copy contributors
        for (uint256 i = 0; i < contributors.length; i++) {
            bundle.contributors.push(contributors[i]);
        }

        emit BundleCreated(bundleId, sender, name, cids.length, block.timestamp);
    }

    /**
     * @notice Add content CIDs to an existing bundle.
     * @param bundleId ID of the bundle
     * @param cids Array of CIDs to add
     */
    function addContent(
        uint256 bundleId,
        string[] calldata cids
    ) external whenNotPaused {
        if (cids.length == 0) revert EmptyBundle();
        if (cids.length > MAX_CIDS_PER_CALL) revert TooManyCids();

        Bundle storage bundle = _getActiveBundle(bundleId);
        if (_msgSender() != bundle.creator) revert NotBundleCreator();

        _validateCids(cids);

        for (uint256 i = 0; i < cids.length; i++) {
            bytes32 cidHash = keccak256(bytes(cids[i]));
            if (_cidExists[bundleId][cidHash]) revert DuplicateCid();
            _cidExists[bundleId][cidHash] = true;
            bundle.contentCids.push(cids[i]);
        }

        emit BundleContentAdded(bundleId, cids.length, bundle.contentCids.length);
    }

    /**
     * @notice Remove content CIDs from a bundle.
     * @param bundleId ID of the bundle
     * @param cids Array of CIDs to remove
     */
    function removeContent(
        uint256 bundleId,
        string[] calldata cids
    ) external whenNotPaused {
        if (cids.length == 0) revert EmptyBundle();

        Bundle storage bundle = _getActiveBundle(bundleId);
        if (_msgSender() != bundle.creator) revert NotBundleCreator();

        uint256 removed = 0;
        for (uint256 i = 0; i < cids.length; i++) {
            bytes32 cidHash = keccak256(bytes(cids[i]));
            for (uint256 j = 0; j < bundle.contentCids.length; j++) {
                if (keccak256(bytes(bundle.contentCids[j])) == cidHash) {
                    // Swap with last and pop
                    bundle.contentCids[j] = bundle.contentCids[bundle.contentCids.length - 1];
                    bundle.contentCids.pop();
                    _cidExists[bundleId][cidHash] = false;
                    removed++;
                    break;
                }
            }
        }

        emit BundleContentRemoved(bundleId, removed);
    }

    /**
     * @notice Update contributor weights for a bundle.
     * @param bundleId ID of the bundle
     * @param contributors New contributor weight assignments (must sum to 10000 bps)
     */
    function setContributorWeights(
        uint256 bundleId,
        ContributorWeight[] calldata contributors
    ) external whenNotPaused {
        Bundle storage bundle = _getActiveBundle(bundleId);
        if (_msgSender() != bundle.creator) revert NotBundleCreator();

        _validateWeights(contributors);

        // Clear existing contributors
        delete _bundles[bundleId].contributors;

        // Set new contributors
        for (uint256 i = 0; i < contributors.length; i++) {
            bundle.contributors.push(contributors[i]);
            emit ContributorWeightSet(bundleId, contributors[i].contributor, contributors[i].weightBps);
        }

        emit ContributorWeightsSet(bundleId, contributors.length);
    }

    /**
     * @notice Deactivate a bundle (creator or owner).
     * @param bundleId ID of the bundle to deactivate
     */
    function deactivateBundle(uint256 bundleId) external whenNotPaused {
        Bundle storage bundle = _getBundle(bundleId);
        address sender = _msgSender();
        if (sender != bundle.creator && sender != owner()) revert NotBundleCreator();

        bundle.isActive = false;

        emit BundleDeactivated(bundleId);
    }

    // ============================================================
    //                      VIEW FUNCTIONS
    // ============================================================

    /**
     * @notice Get the full info for a bundle.
     * @param bundleId ID to look up
     * @return Bundle struct with all on-chain data
     */
    function getBundle(uint256 bundleId) external view returns (Bundle memory) {
        if (bundleId >= _nextBundleId) revert BundleNotFound();
        return _bundles[bundleId];
    }

    /**
     * @notice Get the content CIDs of a bundle.
     * @param bundleId ID to look up
     * @return Array of CID strings
     */
    function getBundleContent(uint256 bundleId) external view returns (string[] memory) {
        if (bundleId >= _nextBundleId) revert BundleNotFound();
        return _bundles[bundleId].contentCids;
    }

    /**
     * @notice Get the contributors of a bundle.
     * @param bundleId ID to look up
     * @return Array of ContributorWeight structs
     */
    function getBundleContributors(uint256 bundleId) external view returns (ContributorWeight[] memory) {
        if (bundleId >= _nextBundleId) revert BundleNotFound();
        return _bundles[bundleId].contributors;
    }

    /**
     * @notice Get the total number of bundles created.
     * @return Count of all bundles (including deactivated)
     */
    function getBundleCount() external view returns (uint256) {
        return _nextBundleId;
    }

    /**
     * @notice Check if a bundle is active.
     * @param bundleId ID to check
     * @return True if the bundle exists and is active
     */
    function isBundleActive(uint256 bundleId) external view returns (bool) {
        if (bundleId >= _nextBundleId) revert BundleNotFound();
        return _bundles[bundleId].isActive;
    }

    /**
     * @notice Get the AgentRegistry address.
     */
    function agentRegistry() external view returns (address) {
        return _agentRegistry;
    }

    /**
     * @notice Get the ContentIndex address.
     */
    function contentIndex() external view returns (address) {
        return _contentIndex;
    }

    // ============================================================
    //                      ADMIN FUNCTIONS
    // ============================================================

    /// @notice Update the AgentRegistry contract reference.
    function setAgentRegistry(address newRegistry) external onlyOwner {
        if (newRegistry == address(0)) revert ZeroAddress();
        _agentRegistry = newRegistry;
    }

    /// @notice Update the ContentIndex contract reference.
    function setContentIndex(address newContentIndex) external onlyOwner {
        if (newContentIndex == address(0)) revert ZeroAddress();
        _contentIndex = newContentIndex;
    }

    /// @notice Pause all bundle operations (emergency stop).
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause bundle operations.
    function unpause() external onlyOwner {
        _unpause();
    }

    // ============================================================
    //                     INTERNAL HELPERS
    // ============================================================

    /**
     * @dev Get a storage reference to a bundle, reverting if it doesn't exist.
     */
    function _getBundle(uint256 bundleId) internal view returns (Bundle storage) {
        if (bundleId >= _nextBundleId) revert BundleNotFound();
        return _bundles[bundleId];
    }

    /**
     * @dev Get a storage reference to an active bundle, reverting if inactive.
     */
    function _getActiveBundle(uint256 bundleId) internal view returns (Bundle storage) {
        Bundle storage bundle = _getBundle(bundleId);
        if (!bundle.isActive) revert BundleNotActive();
        return bundle;
    }

    /**
     * @dev Check that an address is a registered, active agent.
     */
    function _requireActiveAgent(address agent) internal view {
        (bool success, bytes memory data) = _agentRegistry.staticcall(
            abi.encodeWithSignature("isActiveAgent(address)", agent)
        );

        if (!success || data.length == 0) revert NotRegisteredAgent();

        bool isActive = abi.decode(data, (bool));
        if (!isActive) revert NotRegisteredAgent();
    }

    /**
     * @dev Validate that contributor weights sum to exactly 10000 bps.
     */
    function _validateWeights(ContributorWeight[] calldata contributors) internal pure {
        if (contributors.length == 0) revert InvalidWeights();

        uint256 totalWeight = 0;
        for (uint256 i = 0; i < contributors.length; i++) {
            totalWeight += contributors[i].weightBps;
        }
        if (totalWeight != 10000) revert InvalidWeights();
    }

    /**
     * @dev Validate that all CIDs exist in ContentIndex via staticcall.
     */
    function _validateCids(string[] calldata cids) internal view {
        for (uint256 i = 0; i < cids.length; i++) {
            (bool success, bytes memory data) = _contentIndex.staticcall(
                abi.encodeWithSignature("contentExists(string)", cids[i])
            );

            if (!success || data.length == 0) revert ContentNotFound();

            bool exists = abi.decode(data, (bool));
            if (!exists) revert ContentNotFound();
        }
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

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
