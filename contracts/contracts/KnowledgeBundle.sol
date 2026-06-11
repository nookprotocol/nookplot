// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/metatx/ERC2771ContextUpgradeable.sol";

/**
 * @dev Minimal typed view of ContentIndex.ContentEntry, used to read the
 *      `author` field for authorship verification. Layout MUST
 *      match `ContentIndex.ContentEntry` in `./ContentIndex.sol:85-92`
 *      exactly — otherwise the abi-decode on the returned struct will
 *      misread the `author` field. Kept local to KnowledgeBundle to avoid
 *      pulling the full ContentIndex contract into the import graph.
 */
interface IContentIndexMinimal {
    enum ContentType { Post, Comment }
    struct ContentEntry {
        address author;
        string community;
        ContentType contentType;
        string parentCid;
        uint256 timestamp;
        bool isActive;
    }
    function getContent(string calldata cid) external view returns (ContentEntry memory);
}

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

    /// Invariant: every contributor must be the
    /// registered author of at least one CID in the bundle.
    error NotContentAuthor(address contributor);

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

        // Authorship cross-reference.
        // Calldata→memory copy (each loop iteration creates a string ref;
        // total cost bounded by MAX_CIDS_PER_CALL = 50).
        {
            string[] memory cidsMem = new string[](cids.length);
            for (uint256 i = 0; i < cids.length; i++) {
                cidsMem[i] = cids[i];
            }
            _validateAuthorship(cidsMem, contributors);
        }

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

        // Re-run authorship check
        // against the bundle's CURRENT content list. Storage→memory copy
        // so _validateAuthorship can take a consistent parameter type.
        {
            uint256 n = bundle.contentCids.length;
            string[] memory cidsMem = new string[](n);
            for (uint256 i = 0; i < n; i++) {
                cidsMem[i] = bundle.contentCids[i];
            }
            _validateAuthorship(cidsMem, contributors);
        }

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

    /**
     * @dev Fetch the author of a
     *      registered CID from ContentIndex. Returns `address(0)` if the
     *      CID is not registered (the citation-only path — see
     *      `ContentIndex.sol:350` which intentionally allows citing
     *      external papers without registering them). Wrapped in
     *      try/catch so an unregistered CID is treated as "no author
     *      claim" rather than reverting the whole authorship check.
     */
    function _getContentAuthorOrZero(string memory cid) internal view returns (address) {
        try IContentIndexMinimal(_contentIndex).getContent(cid) returns (
            IContentIndexMinimal.ContentEntry memory entry
        ) {
            return entry.author;
        } catch {
            return address(0);
        }
    }

    /**
     * @dev Invariant: every contributor in the
     *      weights list MUST be the registered author of at least one CID
     *      in the bundle. Without this check, a bundle creator could list
     *      arbitrary addresses (themselves, sybils, anyone) as contributors
     *      and capture the contributor-share royalties without authoring
     *      any of the content. This enforces the authorship-capture
     *      invariant.
     *
     *      Unregistered CIDs (citation-only entries) contribute nothing —
     *      `_getContentAuthorOrZero` returns address(0) for them, which
     *      never matches a real contributor. Only authors of REGISTERED
     *      content count.
     *
     *      Complexity: O(M) staticcalls to ContentIndex + O(N × M) cheap
     *      address compares in memory. The initial naive O(N × M) staticcalls
     *      cost ~5k gas each — at MAX_CONTRIBUTORS=50, MAX_CIDS=50 it would
     *      push 12.5M gas, exceeding Base's safe execution budget for
     *      `createBundle`. The single-pass author-cache form holds the
     *      same correctness with ~50 staticcalls + 2500 mem compares
     *      (~50x reduction at worst case; ~5x at typical N=5, M=10).
     */
    function _validateAuthorship(
        string[] memory cids,
        ContributorWeight[] calldata contributors
    ) internal view {
        // Single pass over CIDs — one staticcall per CID, cache the author.
        address[] memory authors = new address[](cids.length);
        for (uint256 i = 0; i < cids.length; i++) {
            authors[i] = _getContentAuthorOrZero(cids[i]);
        }
        // For each contributor, check against the cached author set.
        for (uint256 c = 0; c < contributors.length; c++) {
            address contributor = contributors[c].contributor;
            bool matched = false;
            for (uint256 i = 0; i < authors.length; i++) {
                if (authors[i] == contributor) {
                    matched = true;
                    break;
                }
            }
            if (!matched) revert NotContentAuthor(contributor);
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
    //                  OWNERSHIP RENOUNCE GUARD
    // ============================================================

    /// @notice Prevent accidental ownership renouncement — would permanently brick admin functions.
    function renounceOwnership() public pure override {
        revert("Cannot renounce ownership");
    }

    // ============================================================
    //              FORWARDER-PROOF OWNERSHIP GUARDS
    // ============================================================

    /**
     * @dev Guard: use the forwarder-proof ownership pattern in KnowledgeBundle
     *      so admin entrypoints cannot be reached through the trusted
     *      forwarder. Without it, a compromised forwarder could spoof
     *      setContentIndex(maliciousContentIndex), and a malicious
     *      ContentIndex returning the caller as the author of every CID
     *      would let _validateAuthorship pass for a bundle that lists the
     *      caller as the sole 10000-bps contributor — defeating the
     *      authorship invariant without even upgrading the contract.
     *
     *      With this override, every admin path requires a DIRECT
     *      transaction from the owner key (or owner Safe), and the
     *      forwarder cannot synthesize that. Mirrors the same pattern in
     *      CliqueRegistry — keep them in sync if the pattern ever changes.
     */
    function _checkOwner() internal view override {
        if (msg.sender != owner()) {
            revert OwnableUnauthorizedAccount(msg.sender);
        }
    }

    /// @dev Override `transferOwnership` to use raw `msg.sender` for the same reason.
    function transferOwnership(address newOwner) public override {
        require(msg.sender == owner(), "Only owner directly");
        if (newOwner == address(0)) revert ZeroAddress();
        _transferOwnership(newOwner);
    }

    // ============================================================
    //                     UUPS UPGRADE AUTH
    // ============================================================

    /**
     * @dev Uses raw `msg.sender` directly — even if a future
     *      override accidentally re-introduces `_msgSender()` into
     *      `_checkOwner`, the UUPS upgrade path stays forwarder-proof.
     *      Using `onlyOwner` here would route through the
     *      forwarder-aware `_msgSender()`.
     */
    function _authorizeUpgrade(address) internal view override {
        if (msg.sender != owner()) {
            revert OwnableUnauthorizedAccount(msg.sender);
        }
    }
}
