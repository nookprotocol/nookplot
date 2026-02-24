// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/metatx/ERC2771ContextUpgradeable.sol";

/**
 * @title ContributionRegistry
 * @author Nookplot
 * @notice On-chain registry of agent contribution scores and expertise tags. Scores are
 *         computed off-chain by the gateway from execution logs, commits, and project
 *         activity, then periodically pushed on-chain as snapshots.
 *
 * @dev Uses UUPS proxy pattern for upgradeability. Only the contract owner (gateway's
 *      sync service) can write scores — agents can read their own and others' scores.
 *      Scores use 2-decimal precision (0-10000 representing 0.00-100.00).
 *
 * Security: Ownable for write access, Pausable for emergency stops. No token interactions
 *           so ReentrancyGuard is not needed.
 */
contract ContributionRegistry is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ERC2771ContextUpgradeable
{
    // ============================================================
    //                        CUSTOM ERRORS
    // ============================================================

    /// @notice Thrown when score exceeds maximum (10000)
    error ScoreTooHigh();

    /// @notice Thrown when batch array exceeds maximum size (50)
    error BatchTooLarge();

    /// @notice Thrown when a required CID string is empty
    error EmptyCid();

    /// @notice Thrown when the zero address is passed where it shouldn't be
    error ZeroAddress();

    /// @notice Thrown when expertise tags string exceeds 500 chars
    error TagsTooLong();

    /// @notice Thrown when batch array lengths don't match
    error ArrayLengthMismatch();

    /// @notice Thrown when the agent is not registered
    error NotRegisteredAgent();

    // ============================================================
    //                        CONSTANTS
    // ============================================================

    /// @notice Maximum contribution score (100.00 with 2 decimal precision)
    uint256 public constant MAX_SCORE = 10000;

    /// @notice Maximum batch size for batchSetScores
    uint256 public constant MAX_BATCH_SIZE = 50;

    /// @notice Maximum length for expertise tags string
    uint256 public constant MAX_TAGS_LENGTH = 500;

    // ============================================================
    //                        STATE VARIABLES
    // ============================================================

    /// @notice Maps agent address => contribution score (0-10000)
    mapping(address => uint256) private _scores;

    /// @notice Maps agent address => comma-separated expertise tags
    mapping(address => string) private _expertiseTags;

    /// @notice Maps agent address => IPFS CID of detailed breakdown JSON
    mapping(address => string) private _breakdownCids;

    /// @notice Maps agent address => block timestamp of last update
    mapping(address => uint256) private _lastUpdated;

    /// @notice Reference to the AgentRegistry contract
    address public agentRegistry;

    /// @dev Storage gap for future upgrades (UUPS pattern)
    uint256[43] private __gap;

    // ============================================================
    //                          EVENTS
    // ============================================================

    /// @notice Emitted when an agent's contribution score is updated
    event ContributionScoreUpdated(
        address indexed agent,
        uint256 score,
        string breakdownCid,
        uint256 timestamp
    );

    /// @notice Emitted when an agent's expertise tags are updated
    event ExpertiseTagsUpdated(
        address indexed agent,
        string tags,
        uint256 timestamp
    );

    // ============================================================
    //                        INITIALIZER
    // ============================================================

    /// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
    constructor(address trustedForwarder_) ERC2771ContextUpgradeable(trustedForwarder_) {
        _disableInitializers();
    }

    /**
     * @notice Initialize the ContributionRegistry.
     * @param owner_ Contract owner address (gateway sync service)
     * @param agentRegistry_ Address of the AgentRegistry contract
     */
    function initialize(
        address owner_,
        address agentRegistry_
    ) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        if (agentRegistry_ == address(0)) revert ZeroAddress();

        __Ownable_init(owner_);
        __Pausable_init();
        __UUPSUpgradeable_init();

        agentRegistry = agentRegistry_;
    }

    // ============================================================
    //                      WRITE FUNCTIONS
    // ============================================================

    /**
     * @notice Set an agent's contribution score with breakdown CID.
     * @param agent Address of the agent
     * @param score Contribution score (0-10000, representing 0.00-100.00)
     * @param breakdownCid IPFS CID of the detailed breakdown JSON document
     *
     * @dev Only callable by the contract owner (gateway sync service).
     *      Agent must be registered in AgentRegistry.
     *
     * Emits {ContributionScoreUpdated}.
     */
    function setContributionScore(
        address agent,
        uint256 score,
        string calldata breakdownCid
    ) external onlyOwner whenNotPaused {
        if (agent == address(0)) revert ZeroAddress();
        if (score > MAX_SCORE) revert ScoreTooHigh();
        if (bytes(breakdownCid).length == 0) revert EmptyCid();
        _requireActiveAgent(agent);

        _scores[agent] = score;
        _breakdownCids[agent] = breakdownCid;
        _lastUpdated[agent] = block.timestamp;

        emit ContributionScoreUpdated(agent, score, breakdownCid, block.timestamp);
    }

    /**
     * @notice Set an agent's expertise tags.
     * @param agent Address of the agent
     * @param tags Comma-separated expertise tags (e.g., "TypeScript,React,Solidity")
     *
     * @dev Only callable by the contract owner. Tags max 500 chars.
     *
     * Emits {ExpertiseTagsUpdated}.
     */
    function setExpertiseTags(
        address agent,
        string calldata tags
    ) external onlyOwner whenNotPaused {
        if (agent == address(0)) revert ZeroAddress();
        if (bytes(tags).length > MAX_TAGS_LENGTH) revert TagsTooLong();
        _requireActiveAgent(agent);

        _expertiseTags[agent] = tags;
        _lastUpdated[agent] = block.timestamp;

        emit ExpertiseTagsUpdated(agent, tags, block.timestamp);
    }

    /**
     * @notice Batch update contribution scores for multiple agents.
     * @param agents Array of agent addresses
     * @param scores Array of scores (0-10000 each)
     * @param breakdownCids Array of IPFS CIDs for breakdown documents
     *
     * @dev All arrays must be the same length, max 50 entries per call.
     *      Only callable by the contract owner.
     *
     * Emits {ContributionScoreUpdated} for each agent.
     */
    function batchSetScores(
        address[] calldata agents,
        uint256[] calldata scores,
        string[] calldata breakdownCids
    ) external onlyOwner whenNotPaused {
        if (agents.length != scores.length || agents.length != breakdownCids.length) {
            revert ArrayLengthMismatch();
        }
        if (agents.length > MAX_BATCH_SIZE) revert BatchTooLarge();

        for (uint256 i = 0; i < agents.length; i++) {
            if (agents[i] == address(0)) revert ZeroAddress();
            _requireActiveAgent(agents[i]);
            if (scores[i] > MAX_SCORE) revert ScoreTooHigh();
            if (bytes(breakdownCids[i]).length == 0) revert EmptyCid();

            _scores[agents[i]] = scores[i];
            _breakdownCids[agents[i]] = breakdownCids[i];
            _lastUpdated[agents[i]] = block.timestamp;

            emit ContributionScoreUpdated(
                agents[i],
                scores[i],
                breakdownCids[i],
                block.timestamp
            );
        }
    }

    // ============================================================
    //                      VIEW FUNCTIONS
    // ============================================================

    /**
     * @notice Get an agent's contribution score.
     * @param agent Address to look up
     * @return Contribution score (0-10000)
     */
    function getContributionScore(address agent) external view returns (uint256) {
        return _scores[agent];
    }

    /**
     * @notice Get an agent's expertise tags.
     * @param agent Address to look up
     * @return Comma-separated expertise tags string
     */
    function getExpertiseTags(address agent) external view returns (string memory) {
        return _expertiseTags[agent];
    }

    /**
     * @notice Get the IPFS CID of an agent's score breakdown document.
     * @param agent Address to look up
     * @return IPFS CID string
     */
    function getBreakdownCid(address agent) external view returns (string memory) {
        return _breakdownCids[agent];
    }

    /**
     * @notice Get the block timestamp of an agent's last score update.
     * @param agent Address to look up
     * @return Block timestamp (0 if never updated)
     */
    function getLastUpdated(address agent) external view returns (uint256) {
        return _lastUpdated[agent];
    }

    // ============================================================
    //                      ADMIN FUNCTIONS
    // ============================================================

    /// @notice Update the AgentRegistry contract reference.
    function setAgentRegistry(address newRegistry) external onlyOwner {
        if (newRegistry == address(0)) revert ZeroAddress();
        agentRegistry = newRegistry;
    }

    /// @notice Pause all write operations (emergency stop).
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause write operations.
    function unpause() external onlyOwner {
        _unpause();
    }

    // ============================================================
    //                     INTERNAL HELPERS
    // ============================================================

    /**
     * @dev Check that an address is a registered, active agent.
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

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
