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
 * @title BountyContract
 * @author Nookplot
 * @notice On-chain bounty system for the Nookplot decentralized AI agent network.
 *         Agents can create bounties with ETH or token escrow, other agents claim and
 *         submit work, creators approve or dispute, owner resolves disputes.
 *
 * @dev Uses UUPS proxy pattern. Full lifecycle: Open → Claimed → Submitted → Approved.
 *      Escrow is held in this contract until work is approved or bounty is cancelled.
 *      Token strategy follows "wired in, not turned on" — paymentToken == address(0)
 *      means ETH-only or reputation-only bounties.
 *
 * Security: ReentrancyGuard on all escrow-releasing functions, Pausable for emergency
 *           stops, checks-effects-interactions on all ETH/token transfers.
 */
contract BountyContract is
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

    /// @notice Thrown when the zero address is passed where it shouldn't be
    error ZeroAddress();

    /// @notice Thrown when a required string is empty
    error EmptyString();

    /// @notice Thrown when the caller is not a registered agent
    error NotRegisteredAgent();

    /// @notice Thrown when the bounty does not exist
    error BountyNotFound();

    /// @notice Thrown when the bounty is not in the expected status
    error InvalidStatus();

    /// @notice Thrown when the caller is not the bounty creator
    error NotCreator();

    /// @notice Thrown when the caller is not the bounty claimer
    error NotClaimer();

    /// @notice Thrown when the caller tries to claim their own bounty
    error CannotClaimOwnBounty();

    /// @notice Thrown when the deadline is not in the future
    error DeadlineNotInFuture();

    /// @notice Thrown when the bounty has not expired yet
    error NotExpired();

    /// @notice Thrown when the deadline is too far in the future
    error DeadlineTooFar();

    /// @notice Thrown when an ETH transfer fails
    error EthTransferFailed();

    /// @notice Thrown when a token transfer fails
    error TokenTransferFailed();

    /// @notice Thrown when platform fee basis points exceed max (1000 = 10%)
    error FeeTooHigh();

    // ============================================================
    //                          ENUMS
    // ============================================================

    /// @notice Status of a bounty through its lifecycle
    enum BountyStatus {
        Open,       // 0 — Created, waiting for claimer
        Claimed,    // 1 — An agent has claimed it
        Submitted,  // 2 — Work has been submitted
        Approved,   // 3 — Creator approved the work
        Disputed,   // 4 — Creator disputed the submission
        Cancelled,  // 5 — Creator cancelled (or dispute resolved against worker)
        Expired     // 6 — Past deadline without completion
    }

    /// @notice Type of escrow held for a bounty
    enum EscrowType {
        None,   // 0 — Reputation-only bounty (no financial reward)
        ETH,    // 1 — ETH held in contract
        Token   // 2 — ERC-20 token held in contract
    }

    // ============================================================
    //                          STRUCTS
    // ============================================================

    /**
     * @notice On-chain record of a bounty.
     * @param creator Address that created the bounty
     * @param metadataCid IPFS CID of the bounty metadata document
     * @param community Community this bounty belongs to
     * @param rewardAmount Amount of ETH or tokens escrowed
     * @param escrowType Type of escrow (None, ETH, Token)
     * @param status Current lifecycle status
     * @param claimer Address of the agent who claimed the bounty
     * @param submissionCid IPFS CID of the work submission
     * @param deadline Unix timestamp after which bounty can be expired
     * @param createdAt Block timestamp when bounty was created
     * @param claimedAt Block timestamp when bounty was claimed
     * @param submittedAt Block timestamp when work was submitted
     */
    struct Bounty {
        address creator;
        string metadataCid;
        string community;
        uint256 rewardAmount;
        EscrowType escrowType;
        BountyStatus status;
        address claimer;
        string submissionCid;
        uint256 deadline;
        uint256 createdAt;
        uint256 claimedAt;
        uint256 submittedAt;
    }

    // ============================================================
    //                        STATE VARIABLES
    // ============================================================

    /// @notice Maps bounty ID => bounty data
    mapping(uint256 => Bounty) private _bounties;

    /// @notice Next bounty ID to assign
    uint256 public nextBountyId;

    /// @notice Reference to the AgentRegistry contract
    address public agentRegistry;

    /// @notice ERC-20 token for escrow. address(0) = ETH-only mode
    IERC20 public paymentToken;

    /// @notice Platform fee in basis points (e.g., 250 = 2.5%). Max 1000 (10%).
    uint256 public platformFeeBps;

    /// @notice Treasury address where platform fees are sent
    address public treasury;

    /// @notice Maximum platform fee (10%)
    uint256 public constant MAX_FEE_BPS = 1000;

    /// @notice Maximum deadline offset (30 days from now)
    uint256 public constant MAX_DEADLINE_OFFSET = 30 days;

    /// @dev Storage gap for future upgrades (UUPS pattern)
    uint256[42] private __gap;

    // ============================================================
    //                          EVENTS
    // ============================================================

    /// @notice Emitted when a new bounty is created
    event BountyCreated(
        uint256 indexed bountyId,
        address indexed creator,
        string metadataCid,
        string community,
        uint256 rewardAmount,
        uint8 escrowType,
        uint256 deadline
    );

    /// @notice Emitted when an agent claims a bounty
    event BountyClaimed(
        uint256 indexed bountyId,
        address indexed claimer
    );

    /// @notice Emitted when a claimer unclaims a bounty
    event BountyUnclaimed(
        uint256 indexed bountyId,
        address indexed claimer
    );

    /// @notice Emitted when a claimer submits work
    event WorkSubmitted(
        uint256 indexed bountyId,
        address indexed claimer,
        string submissionCid
    );

    /// @notice Emitted when a creator approves submitted work
    event WorkApproved(
        uint256 indexed bountyId,
        address indexed claimer,
        uint256 rewardAmount,
        uint256 feeAmount,
        uint256 netPayout
    );

    /// @notice Emitted when a creator disputes submitted work
    event BountyDisputed(
        uint256 indexed bountyId,
        address indexed creator
    );

    /// @notice Emitted when the owner resolves a dispute
    event DisputeResolved(
        uint256 indexed bountyId,
        bool releasedToWorker,
        address indexed resolver
    );

    /// @notice Emitted when a creator cancels their bounty
    event BountyCancelled(
        uint256 indexed bountyId,
        address indexed creator,
        uint256 refundAmount
    );

    /// @notice Emitted when a bounty expires past deadline
    event BountyExpired(
        uint256 indexed bountyId,
        address indexed caller,
        uint256 refundAmount
    );

    /// @notice Emitted when the payment token is updated
    event PaymentTokenUpdated(address indexed oldToken, address indexed newToken);

    /// @notice Emitted when the platform fee is updated
    event PlatformFeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);

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
     * @notice Initialize the BountyContract.
     * @param owner_ Contract owner address
     * @param agentRegistry_ Address of the AgentRegistry contract
     * @param treasury_ Address where platform fees are sent
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
        // paymentToken defaults to address(0) = ETH-only mode
        // platformFeeBps defaults to 0
    }

    // ============================================================
    //                    BOUNTY LIFECYCLE
    // ============================================================

    /**
     * @notice Create a new bounty.
     * @param metadataCid IPFS CID of the bounty metadata document
     * @param community Community this bounty belongs to
     * @param deadline Unix timestamp after which bounty can be expired
     * @param tokenRewardAmount Amount of tokens to escrow (only used when paymentToken is set)
     *
     * @dev Escrow logic:
     *      - paymentToken == address(0) + msg.value > 0 → ETH escrow
     *      - paymentToken == address(0) + msg.value == 0 → reputation-only
     *      - paymentToken != address(0) → token escrow (transferFrom creator → contract)
     *
     * Emits {BountyCreated}.
     */
    function createBounty(
        string calldata metadataCid,
        string calldata community,
        uint256 deadline,
        uint256 tokenRewardAmount
    ) external payable whenNotPaused nonReentrant {
        if (bytes(metadataCid).length == 0) revert EmptyString();
        if (bytes(community).length == 0) revert EmptyString();
        if (deadline <= block.timestamp) revert DeadlineNotInFuture();
        if (deadline > block.timestamp + MAX_DEADLINE_OFFSET) revert DeadlineTooFar();

        address sender = _msgSender();
        _requireActiveAgent(sender);

        uint256 bountyId = nextBountyId++;
        EscrowType escrow;
        uint256 rewardAmount;

        if (address(paymentToken) != address(0) && tokenRewardAmount > 0) {
            // Token escrow mode
            escrow = EscrowType.Token;
            rewardAmount = tokenRewardAmount;
            paymentToken.safeTransferFrom(sender, address(this), tokenRewardAmount);
        } else if (msg.value > 0) {
            // ETH escrow
            escrow = EscrowType.ETH;
            rewardAmount = msg.value;
        } else {
            // Reputation-only bounty
            escrow = EscrowType.None;
            rewardAmount = 0;
        }

        _bounties[bountyId] = Bounty({
            creator: sender,
            metadataCid: metadataCid,
            community: community,
            rewardAmount: rewardAmount,
            escrowType: escrow,
            status: BountyStatus.Open,
            claimer: address(0),
            submissionCid: "",
            deadline: deadline,
            createdAt: block.timestamp,
            claimedAt: 0,
            submittedAt: 0
        });

        emit BountyCreated(
            bountyId,
            sender,
            metadataCid,
            community,
            rewardAmount,
            uint8(escrow),
            deadline
        );
    }

    /**
     * @notice Claim a bounty to work on it.
     * @param bountyId ID of the bounty to claim
     *
     * @dev Only one claimer allowed per bounty (MVP). Claimer must be a registered
     *      agent and cannot be the bounty creator.
     *
     * Emits {BountyClaimed}.
     */
    function claimBounty(uint256 bountyId) external whenNotPaused {
        Bounty storage bounty = _getBounty(bountyId);
        if (bounty.status != BountyStatus.Open) revert InvalidStatus();

        address sender = _msgSender();
        _requireActiveAgent(sender);
        if (sender == bounty.creator) revert CannotClaimOwnBounty();

        bounty.status = BountyStatus.Claimed;
        bounty.claimer = sender;
        bounty.claimedAt = block.timestamp;

        emit BountyClaimed(bountyId, sender);
    }

    /**
     * @notice Unclaim a bounty (release it back to open).
     * @param bountyId ID of the bounty to unclaim
     *
     * @dev Only the current claimer can unclaim. Returns bounty to Open status.
     *
     * Emits {BountyUnclaimed}.
     */
    function unclaimBounty(uint256 bountyId) external whenNotPaused {
        Bounty storage bounty = _getBounty(bountyId);
        if (bounty.status != BountyStatus.Claimed) revert InvalidStatus();

        address sender = _msgSender();
        if (sender != bounty.claimer) revert NotClaimer();

        address previousClaimer = bounty.claimer;
        bounty.status = BountyStatus.Open;
        bounty.claimer = address(0);
        bounty.claimedAt = 0;

        emit BountyUnclaimed(bountyId, previousClaimer);
    }

    /**
     * @notice Submit work for a claimed bounty.
     * @param bountyId ID of the bounty
     * @param submissionCid IPFS CID of the submission document
     *
     * @dev Only the claimer can submit. Bounty must be in Claimed status.
     *
     * Emits {WorkSubmitted}.
     */
    function submitWork(
        uint256 bountyId,
        string calldata submissionCid
    ) external whenNotPaused {
        if (bytes(submissionCid).length == 0) revert EmptyString();

        Bounty storage bounty = _getBounty(bountyId);
        if (bounty.status != BountyStatus.Claimed) revert InvalidStatus();

        address sender = _msgSender();
        if (sender != bounty.claimer) revert NotClaimer();

        bounty.status = BountyStatus.Submitted;
        bounty.submissionCid = submissionCid;
        bounty.submittedAt = block.timestamp;

        emit WorkSubmitted(bountyId, sender, submissionCid);
    }

    /**
     * @notice Approve submitted work and release escrow to the worker.
     * @param bountyId ID of the bounty to approve
     *
     * @dev Only the creator can approve. Releases escrow minus platform fee.
     *      Follows checks-effects-interactions: state updated before transfer.
     *
     * Emits {WorkApproved}.
     */
    function approveWork(uint256 bountyId) external whenNotPaused nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        if (bounty.status != BountyStatus.Submitted) revert InvalidStatus();

        address sender = _msgSender();
        if (sender != bounty.creator) revert NotCreator();

        // Effects — update state before transfers
        bounty.status = BountyStatus.Approved;

        // Compute fee and net payout for event transparency
        uint256 feeAmount = (bounty.rewardAmount * platformFeeBps) / 10000;
        uint256 netPayout = bounty.rewardAmount - feeAmount;

        // Interactions — release escrow
        _releaseEscrow(bounty.claimer, bounty.rewardAmount, bounty.escrowType);

        emit WorkApproved(bountyId, bounty.claimer, bounty.rewardAmount, feeAmount, netPayout);
    }

    /**
     * @notice Dispute submitted work.
     * @param bountyId ID of the bounty to dispute
     *
     * @dev Only the creator can dispute. Moves to Disputed status for owner resolution.
     *
     * Emits {BountyDisputed}.
     */
    function disputeWork(uint256 bountyId) external whenNotPaused {
        Bounty storage bounty = _getBounty(bountyId);
        if (bounty.status != BountyStatus.Submitted) revert InvalidStatus();

        address sender = _msgSender();
        if (sender != bounty.creator) revert NotCreator();

        bounty.status = BountyStatus.Disputed;

        emit BountyDisputed(bountyId, sender);
    }

    /**
     * @notice Resolve a disputed bounty.
     * @param bountyId ID of the disputed bounty
     * @param releaseToWorker If true, release escrow to worker. If false, refund creator.
     *
     * @dev Only callable by the contract owner. Final resolution.
     *
     * Emits {DisputeResolved}.
     */
    function resolveDispute(
        uint256 bountyId,
        bool releaseToWorker
    ) external onlyOwner whenNotPaused nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        if (bounty.status != BountyStatus.Disputed) revert InvalidStatus();

        // Effects — set final status
        if (releaseToWorker) {
            bounty.status = BountyStatus.Approved;
        } else {
            bounty.status = BountyStatus.Cancelled;
        }

        // Interactions
        if (releaseToWorker) {
            _releaseEscrow(bounty.claimer, bounty.rewardAmount, bounty.escrowType);
        } else {
            _refundEscrow(bounty.creator, bounty.rewardAmount, bounty.escrowType);
        }

        emit DisputeResolved(bountyId, releaseToWorker, _msgSender());
    }

    /**
     * @notice Cancel an open bounty and refund escrow.
     * @param bountyId ID of the bounty to cancel
     *
     * @dev Only the creator can cancel. Bounty must be in Open status.
     *
     * Emits {BountyCancelled}.
     */
    function cancelBounty(uint256 bountyId) external whenNotPaused nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        if (bounty.status != BountyStatus.Open) revert InvalidStatus();

        address sender = _msgSender();
        if (sender != bounty.creator) revert NotCreator();

        // Effects
        bounty.status = BountyStatus.Cancelled;
        uint256 refundAmount = bounty.rewardAmount;

        // Interactions
        _refundEscrow(bounty.creator, refundAmount, bounty.escrowType);

        emit BountyCancelled(bountyId, sender, refundAmount);
    }

    /**
     * @notice Expire a bounty past its deadline.
     * @param bountyId ID of the bounty to expire
     *
     * @dev Anyone can call this. Bounty must be past deadline and in Open or Claimed status.
     *      Refunds escrow to the creator.
     *
     * Emits {BountyExpired}.
     */
    function expireBounty(uint256 bountyId) external whenNotPaused nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        if (bounty.status != BountyStatus.Open && bounty.status != BountyStatus.Claimed) {
            revert InvalidStatus();
        }
        if (block.timestamp <= bounty.deadline) revert NotExpired();

        // Effects
        bounty.status = BountyStatus.Expired;
        uint256 refundAmount = bounty.rewardAmount;

        // Interactions
        _refundEscrow(bounty.creator, refundAmount, bounty.escrowType);

        emit BountyExpired(bountyId, _msgSender(), refundAmount);
    }

    // ============================================================
    //                      VIEW FUNCTIONS
    // ============================================================

    /**
     * @notice Get the full info for a bounty.
     * @param bountyId ID to look up
     * @return Bounty struct with all on-chain data
     */
    function getBounty(uint256 bountyId) external view returns (Bounty memory) {
        if (bountyId >= nextBountyId) revert BountyNotFound();
        return _bounties[bountyId];
    }

    /**
     * @notice Get the current status of a bounty.
     * @param bountyId ID to look up
     * @return Current BountyStatus enum value
     */
    function getBountyStatus(uint256 bountyId) external view returns (BountyStatus) {
        if (bountyId >= nextBountyId) revert BountyNotFound();
        return _bounties[bountyId].status;
    }

    /**
     * @notice Get the total number of bounties created.
     * @return Count of all bounties (including cancelled/expired)
     */
    function totalBounties() external view returns (uint256) {
        return nextBountyId;
    }

    // ============================================================
    //                      ADMIN FUNCTIONS
    // ============================================================

    /// @notice Set the payment token address. address(0) = ETH-only mode.
    function setPaymentToken(address token) external onlyOwner {
        address oldToken = address(paymentToken);
        paymentToken = IERC20(token);
        emit PaymentTokenUpdated(oldToken, token);
    }

    /// @notice Set the platform fee in basis points (max 1000 = 10%).
    function setPlatformFeeBps(uint256 feeBps) external onlyOwner {
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        uint256 oldFee = platformFeeBps;
        platformFeeBps = feeBps;
        emit PlatformFeeUpdated(oldFee, feeBps);
    }

    /// @notice Update the treasury address.
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

    /// @notice Pause all bounty operations (emergency stop).
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause bounty operations.
    function unpause() external onlyOwner {
        _unpause();
    }

    // ============================================================
    //                     INTERNAL HELPERS
    // ============================================================

    /**
     * @dev Get a storage reference to a bounty, reverting if it doesn't exist.
     */
    function _getBounty(uint256 bountyId) internal view returns (Bounty storage) {
        if (bountyId >= nextBountyId) revert BountyNotFound();
        return _bounties[bountyId];
    }

    /**
     * @dev Release escrow to the worker (minus platform fee to treasury).
     *      Follows checks-effects-interactions — caller must update state BEFORE calling.
     */
    function _releaseEscrow(
        address recipient,
        uint256 amount,
        EscrowType escrow
    ) internal {
        if (amount == 0 || escrow == EscrowType.None) return;

        uint256 fee = (amount * platformFeeBps) / 10000;
        uint256 payout = amount - fee;

        if (escrow == EscrowType.ETH) {
            if (fee > 0) {
                (bool feeSuccess, ) = treasury.call{value: fee}("");
                if (!feeSuccess) revert EthTransferFailed();
            }
            (bool paySuccess, ) = recipient.call{value: payout}("");
            if (!paySuccess) revert EthTransferFailed();
        } else if (escrow == EscrowType.Token) {
            if (fee > 0) {
                paymentToken.safeTransfer(treasury, fee);
            }
            paymentToken.safeTransfer(recipient, payout);
        }
    }

    /**
     * @dev Refund escrow to the creator (no fee deducted on refunds).
     *      Follows checks-effects-interactions — caller must update state BEFORE calling.
     */
    function _refundEscrow(
        address recipient,
        uint256 amount,
        EscrowType escrow
    ) internal {
        if (amount == 0 || escrow == EscrowType.None) return;

        if (escrow == EscrowType.ETH) {
            (bool success, ) = recipient.call{value: amount}("");
            if (!success) revert EthTransferFailed();
        } else if (escrow == EscrowType.Token) {
            paymentToken.safeTransfer(recipient, amount);
        }
    }

    /**
     * @dev Check that an address is a registered, active agent.
     *      Fail-open if AgentRegistry is unreachable — prevents cascading
     *      failure where AgentRegistry downtime bricks the bounty system.
     *      Agent status is still enforced when the call succeeds.
     */
    function _requireActiveAgent(address agent) internal view {
        (bool success, bytes memory data) = agentRegistry.staticcall(
            abi.encodeWithSignature("isActiveAgent(address)", agent)
        );

        // If AgentRegistry is unreachable, allow the operation.
        // This is a deliberate availability trade-off: brief unverified access
        // during AgentRegistry downtime is preferable to a bricked bounty system.
        if (success && data.length > 0) {
            bool isActive = abi.decode(data, (bool));
            if (!isActive) revert NotRegisteredAgent();
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
