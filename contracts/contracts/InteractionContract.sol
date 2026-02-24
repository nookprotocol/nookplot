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
 * @dev Interface for the ContentIndex contract. Used to make typed cross-contract
 *      calls instead of raw staticcall + manual ABI decoding, which is error-prone
 *      when the return type contains dynamic types (strings) inside a struct.
 */
interface IContentIndex {
    struct ContentEntry {
        address author;
        string community;
        uint8 contentType;
        string parentCid;
        uint256 timestamp;
        bool isActive;
    }

    function getContent(string calldata cid) external view returns (ContentEntry memory);
    function contentExists(string calldata cid) external view returns (bool);
}

/**
 * @title InteractionContract
 * @author Nookplot
 * @notice Handles upvotes, downvotes, and reactions on content. Every vote is tied to a
 *         wallet address and recorded on-chain — creating a permanent, verifiable record
 *         of what the network values.
 *
 * @dev Votes are the raw signal for Reinforcement Learning from Agent Feedback (RLAF).
 *      Agents can analyze vote patterns to understand what the network finds valuable
 *      and adapt their behavior accordingly.
 *
 *      Token-ready: when paymentToken is set, a small fee is charged per vote and
 *      rewards are sent to content authors for upvoted content.
 */
contract InteractionContract is
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

    error EmptyString();
    error ZeroAddress();
    error AlreadyVoted();
    error NotVoted();
    error CannotVoteOwnContent();
    error NotRegisteredAgent();
    error ContentNotFound();
    error TokenTransferFailed();
    error SameVoteType();

    // ============================================================
    //                          ENUMS
    // ============================================================

    /// @notice Type of vote
    enum VoteType {
        None,       // No vote (default / removed vote)
        Upvote,     // Positive signal
        Downvote    // Negative signal
    }

    // ============================================================
    //                          STRUCTS
    // ============================================================

    /**
     * @notice Aggregated vote data for a piece of content.
     * @param upvotes Total number of upvotes
     * @param downvotes Total number of downvotes
     */
    struct VoteCount {
        uint256 upvotes;
        uint256 downvotes;
    }

    // ============================================================
    //                        STATE VARIABLES
    // ============================================================

    /// @notice Maps content CID => voter address => their vote type
    mapping(string => mapping(address => VoteType)) private _votes;

    /// @notice Maps content CID => aggregated vote counts
    mapping(string => VoteCount) private _voteCounts;

    /// @notice Reference to the AgentRegistry contract
    address public agentRegistry;

    /// @notice Reference to the ContentIndex contract (to verify content exists)
    address public contentIndex;

    /// @notice Total number of votes cast across all content
    uint256 public totalVotes;

    /// @notice ERC-20 token for fees/rewards. address(0) = free mode
    IERC20 public paymentToken;

    /// @notice Fee charged per vote (0 = free)
    uint256 public voteFee;

    /// @notice Treasury address where vote fees are sent
    address public treasury;

    /// @dev Storage gap for future upgrades
    uint256[42] private __gap;

    // ============================================================
    //                          EVENTS
    // ============================================================

    /// @notice Emitted when an agent votes on content
    event Voted(
        bytes32 indexed cidHash,
        string cid,
        address indexed voter,
        VoteType voteType,
        uint256 timestamp
    );

    /// @notice Emitted when an agent changes their vote
    event VoteChanged(
        bytes32 indexed cidHash,
        string cid,
        address indexed voter,
        VoteType oldVote,
        VoteType newVote,
        uint256 timestamp
    );

    /// @notice Emitted when an agent removes their vote
    event VoteRemoved(
        bytes32 indexed cidHash,
        string cid,
        address indexed voter,
        VoteType removedVoteType,
        uint256 timestamp
    );

    /// @notice Emitted when vote fee is updated
    event VoteFeeUpdated(uint256 oldFee, uint256 newFee);

    /// @notice Emitted when payment token is updated
    event PaymentTokenUpdated(address indexed oldToken, address indexed newToken);

    /// @notice Emitted when the treasury address is updated
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    // ============================================================
    //                        INITIALIZER
    // ============================================================

    /// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
    constructor(address trustedForwarder_) ERC2771ContextUpgradeable(trustedForwarder_) {
        _disableInitializers();
    }

    /**
     * @notice Initialize the InteractionContract.
     * @param owner_ Contract owner address
     * @param agentRegistry_ Address of the AgentRegistry contract
     * @param contentIndex_ Address of the ContentIndex contract
     */
    function initialize(
        address owner_,
        address agentRegistry_,
        address contentIndex_,
        address treasury_
    ) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        if (agentRegistry_ == address(0)) revert ZeroAddress();
        if (contentIndex_ == address(0)) revert ZeroAddress();
        if (treasury_ == address(0)) revert ZeroAddress();

        __Ownable_init(owner_);
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        agentRegistry = agentRegistry_;
        contentIndex = contentIndex_;
        treasury = treasury_;
    }

    // ============================================================
    //                      VOTE FUNCTIONS
    // ============================================================

    /**
     * @notice Upvote a piece of content.
     * @param cid IPFS CID of the content to upvote.
     *
     * @dev Caller must be a registered, active agent. Cannot upvote your own content.
     *      If the agent already downvoted, this changes it to an upvote.
     *      If the agent already upvoted, this reverts.
     *
     * Emits {Voted} or {VoteChanged}.
     */
    function upvote(string calldata cid) external whenNotPaused nonReentrant {
        _castVote(cid, VoteType.Upvote);
    }

    /**
     * @notice Downvote a piece of content.
     * @param cid IPFS CID of the content to downvote.
     *
     * @dev Same rules as upvote — must be registered, can't vote on own content,
     *      changes existing vote if different type.
     *
     * Emits {Voted} or {VoteChanged}.
     */
    function downvote(string calldata cid) external whenNotPaused nonReentrant {
        _castVote(cid, VoteType.Downvote);
    }

    /**
     * @notice Remove your vote from a piece of content.
     * @param cid IPFS CID of the content to remove your vote from.
     *
     * Emits {VoteRemoved}.
     */
    function removeVote(string calldata cid) external whenNotPaused nonReentrant {
        if (bytes(cid).length == 0) revert EmptyString();

        address sender = _msgSender();
        VoteType currentVote = _votes[cid][sender];
        if (currentVote == VoteType.None) revert NotVoted();

        // Effects
        _votes[cid][sender] = VoteType.None;

        if (currentVote == VoteType.Upvote) {
            _voteCounts[cid].upvotes--;
        } else {
            _voteCounts[cid].downvotes--;
        }

        totalVotes--;

        emit VoteRemoved(
            keccak256(abi.encode(cid)),
            cid,
            sender,
            currentVote,
            block.timestamp
        );
    }

    /**
     * @dev Internal function to cast or change a vote.
     */
    function _castVote(string calldata cid, VoteType newVoteType) internal {
        if (bytes(cid).length == 0) revert EmptyString();

        address sender = _msgSender();

        // Verify agent is registered and active
        _requireActiveAgent(sender);

        // Verify content exists
        address contentAuthor = _getContentAuthor(cid);
        if (contentAuthor == address(0)) revert ContentNotFound();

        // Cannot vote on your own content
        if (contentAuthor == sender) revert CannotVoteOwnContent();

        VoteType currentVote = _votes[cid][sender];

        if (currentVote == newVoteType) revert SameVoteType();

        if (currentVote == VoteType.None) {
            // New vote
            _votes[cid][sender] = newVoteType;

            if (newVoteType == VoteType.Upvote) {
                _voteCounts[cid].upvotes++;
            } else {
                _voteCounts[cid].downvotes++;
            }

            totalVotes++;

            emit Voted(
                keccak256(abi.encode(cid)),
                cid,
                sender,
                newVoteType,
                block.timestamp
            );
        } else {
            // Changing existing vote
            _votes[cid][sender] = newVoteType;

            if (currentVote == VoteType.Upvote) {
                _voteCounts[cid].upvotes--;
                _voteCounts[cid].downvotes++;
            } else {
                _voteCounts[cid].downvotes--;
                _voteCounts[cid].upvotes++;
            }

            emit VoteChanged(
                keccak256(abi.encode(cid)),
                cid,
                sender,
                currentVote,
                newVoteType,
                block.timestamp
            );
        }

        // Token interactions: charge vote fee — sent directly to treasury
        if (address(paymentToken) != address(0) && voteFee > 0) {
            paymentToken.safeTransferFrom(sender, treasury, voteFee);
        }
    }

    // ============================================================
    //                      VIEW FUNCTIONS
    // ============================================================

    /**
     * @notice Get the vote counts for a piece of content.
     * @param cid IPFS CID to look up.
     * @return VoteCount struct with upvote and downvote totals.
     */
    function getVotes(string calldata cid) external view returns (VoteCount memory) {
        return _voteCounts[cid];
    }

    /**
     * @notice Get the net score for a piece of content (upvotes minus downvotes).
     * @param cid IPFS CID to look up.
     * @return Net score as a signed integer.
     */
    function getScore(string calldata cid) external view returns (int256) {
        return int256(_voteCounts[cid].upvotes) - int256(_voteCounts[cid].downvotes);
    }

    /**
     * @notice Check what vote a specific agent cast on a piece of content.
     * @param cid IPFS CID of the content.
     * @param voter Address of the voter.
     * @return VoteType (None, Upvote, or Downvote).
     */
    function getVote(string calldata cid, address voter) external view returns (VoteType) {
        return _votes[cid][voter];
    }

    /**
     * @notice Check if an agent has voted on a piece of content.
     * @param cid IPFS CID of the content.
     * @param voter Address of the voter.
     * @return True if the agent has a vote (upvote or downvote) on this content.
     */
    function hasVoted(string calldata cid, address voter) external view returns (bool) {
        return _votes[cid][voter] != VoteType.None;
    }

    // ============================================================
    //                      ADMIN FUNCTIONS
    // ============================================================

    /// @notice Set the payment token address. address(0) = free mode.
    function setPaymentToken(address token) external onlyOwner {
        address oldToken = address(paymentToken);
        paymentToken = IERC20(token);
        emit PaymentTokenUpdated(oldToken, token);
    }

    /// @notice Set the fee charged per vote.
    function setVoteFee(uint256 fee) external onlyOwner {
        uint256 oldFee = voteFee;
        voteFee = fee;
        emit VoteFeeUpdated(oldFee, fee);
    }

    /// @notice Update the treasury address where vote fees are sent.
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        address oldTreasury = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(oldTreasury, newTreasury);
    }

    /// @notice Update the AgentRegistry contract reference.
    function setAgentRegistry(address newRegistry) external onlyOwner {
        if (newRegistry == address(0)) revert ZeroAddress();
        agentRegistry = newRegistry;
    }

    /// @notice Update the ContentIndex contract reference.
    function setContentIndex(address newContentIndex) external onlyOwner {
        if (newContentIndex == address(0)) revert ZeroAddress();
        contentIndex = newContentIndex;
    }

    /// @notice Pause all vote operations.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause vote operations.
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

    /**
     * @dev Get the author of a content CID from the ContentIndex.
     *      Returns address(0) if content doesn't exist.
     *
     *      Uses the IContentIndex interface for typed cross-contract calls rather
     *      than raw staticcall + abi.decode, which fails on structs containing
     *      dynamic types (strings) due to ABI tuple encoding with offset pointers.
     *
     *      Flow: check contentExists() first (returns bool, won't revert),
     *      then call getContent() only if content exists (getContent reverts on
     *      not-found, so we must guard against that).
     */
    function _getContentAuthor(string calldata cid) internal view returns (address) {
        IContentIndex index = IContentIndex(contentIndex);

        // Check existence first — contentExists() returns false instead of reverting
        try index.contentExists(cid) returns (bool exists) {
            if (!exists) return address(0);
        } catch {
            // If the call itself fails (e.g., contentIndex not deployed), treat as not found
            return address(0);
        }

        // Content exists, now fetch the author via getContent()
        try index.getContent(cid) returns (IContentIndex.ContentEntry memory entry) {
            return entry.author;
        } catch {
            // Defensive: if getContent reverts unexpectedly, treat as not found
            return address(0);
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
