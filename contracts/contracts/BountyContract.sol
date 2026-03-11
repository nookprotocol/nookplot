// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
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
    AccessControlUpgradeable,
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

    /// @notice Thrown when the provided token is not in the allowedTokens whitelist
    error TokenNotAllowed();

    /// @notice Thrown when emergency withdraw amount is zero
    error ZeroAmount();

    /// @notice Thrown when caller is not the approved claimer for a V5+ bounty
    error NotApprovedClaimer();

    // ============================================================
    //                        ROLES
    // ============================================================

    /// @notice Guardian role — can pause but NOT unpause
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

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
     * @param escrowToken Address of the ERC-20 token used for escrow (V2: per-bounty token choice)
     * @param creationFeeBps Platform fee locked at creation time (V3: fee lock-in)
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
        address escrowToken; // V2: per-bounty token address (USDC, NOOK, etc.)
        uint256 creationFeeBps; // V3: fee locked at creation time
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

    /// @notice Whitelist of ERC-20 tokens allowed for escrow (V2)
    mapping(address => bool) public allowedTokens;

    /// @notice Maximum platform fee (10%)
    uint256 public constant MAX_FEE_BPS = 1000;

    /// @notice Maximum deadline offset (30 days from now)
    uint256 public constant MAX_DEADLINE_OFFSET = 30 days;

    /// @notice Grace period after deadline for submitted bounties before permissionless expiry (V3)
    uint256 public submissionGracePeriod;

    /// @notice Maps bountyId => creator-approved claimer address (V5)
    mapping(uint256 => address) public approvedClaimers;

    /// @notice Bounty IDs >= this value require approveClaimer before claimBounty (V5).
    ///         Default 0 means "V5 not initialized" — use type(uint256).max semantics
    ///         checked via the v5Active flag below.
    uint256 public approvedClaimerSinceId;

    /// @notice True after initializeV5() has been called — enables claimer approval enforcement
    bool public v5Active;

    /// @dev Storage gap for future upgrades (UUPS pattern)
    uint256[37] private __gap;

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
        uint256 deadline,
        address tokenAddress
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

    /// @notice Emitted when a token's allowed status is updated (V2)
    event AllowedTokenUpdated(address indexed token, bool allowed);

    /// @notice Emitted when the owner force-resolves a stuck bounty (V3)
    event ForceResolved(uint256 indexed bountyId, bool releasedToWorker, address indexed resolver);

    /// @notice Emitted when a submitted bounty expires after grace period (V3)
    event SubmissionExpired(uint256 indexed bountyId, address indexed worker, uint256 rewardAmount);

    /// @notice Emitted when a bounty creator approves a claimer (V5)
    event ClaimerApproved(uint256 indexed bountyId, address indexed claimer);

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
     * @notice Create a new bounty with per-bounty token choice.
     * @param metadataCid IPFS CID of the bounty metadata document
     * @param community Community this bounty belongs to
     * @param deadline Unix timestamp after which bounty can be expired
     * @param tokenRewardAmount Amount of tokens to escrow (in token's smallest units)
     * @param tokenAddress Address of the ERC-20 token for escrow (must be in allowedTokens).
     *                     Pass address(0) for ETH escrow or reputation-only bounties.
     *
     * @dev Escrow logic (V2 — per-bounty token choice):
     *      - tokenAddress != address(0) + tokenRewardAmount > 0 → token escrow (must be whitelisted)
     *      - tokenAddress == address(0) + msg.value > 0 → ETH escrow
     *      - tokenAddress == address(0) + msg.value == 0 → reputation-only
     *
     * Emits {BountyCreated}.
     */
    function createBounty(
        string calldata metadataCid,
        string calldata community,
        uint256 deadline,
        uint256 tokenRewardAmount,
        address tokenAddress
    ) external payable whenNotPaused nonReentrant {
        if (bytes(metadataCid).length == 0) revert EmptyString();
        if (bytes(community).length == 0) revert EmptyString();
        if (deadline <= block.timestamp) revert DeadlineNotInFuture();
        if (deadline > block.timestamp + MAX_DEADLINE_OFFSET) revert DeadlineTooFar();

        address sender = _msgSender();
        _requireActiveAgent(sender);

        uint256 bountyId = nextBountyId++;

        // Write directly to storage to avoid "stack too deep" with struct literal
        Bounty storage b = _bounties[bountyId];
        b.creator = sender;
        b.metadataCid = metadataCid;
        b.community = community;
        b.status = BountyStatus.Open;
        b.deadline = deadline;
        b.createdAt = block.timestamp;

        b.creationFeeBps = platformFeeBps; // V3: lock fee at creation time

        if (tokenAddress != address(0) && tokenRewardAmount > 0) {
            // V6: reject ETH sent with token escrow to prevent stuck ETH
            if (msg.value > 0) revert("ETH not accepted with token escrow");
            // Per-bounty token escrow (V2)
            if (!allowedTokens[tokenAddress]) revert TokenNotAllowed();
            b.escrowType = EscrowType.Token;
            b.rewardAmount = tokenRewardAmount;
            b.escrowToken = tokenAddress;
            IERC20(tokenAddress).safeTransferFrom(sender, address(this), tokenRewardAmount);
        } else if (msg.value > 0) {
            // ETH escrow
            b.escrowType = EscrowType.ETH;
            b.rewardAmount = msg.value;
        }
        // else: defaults are EscrowType.None (0), rewardAmount 0, escrowToken address(0)

        emit BountyCreated(
            bountyId,
            sender,
            metadataCid,
            community,
            b.rewardAmount,
            uint8(b.escrowType),
            deadline,
            b.escrowToken
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
    function claimBounty(uint256 bountyId) external whenNotPaused nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        if (bounty.status != BountyStatus.Open) revert InvalidStatus();

        address sender = _msgSender();
        _requireActiveAgent(sender);
        if (sender == bounty.creator) revert CannotClaimOwnBounty();

        // V5: Bounties created after upgrade require creator approval
        if (v5Active && bountyId >= approvedClaimerSinceId) {
            if (approvedClaimers[bountyId] != sender) revert NotApprovedClaimer();
        }

        bounty.claimer = sender;
        bounty.claimedAt = block.timestamp;

        // V7: Pre-approved claimer = creator already reviewed work off-chain → auto-payout
        // Require same V5 threshold to prevent auto-payout on pre-V5 bounties
        if (v5Active && bountyId >= approvedClaimerSinceId && approvedClaimers[bountyId] == sender) {
            bounty.status = BountyStatus.Approved;
            uint256 effectiveFee = _effectiveFeeBps(bounty);
            uint256 feeAmount = (bounty.rewardAmount * effectiveFee) / 10000;
            uint256 netPayout = bounty.rewardAmount - feeAmount;
            _releaseEscrow(sender, bounty.rewardAmount, bounty.escrowType, bounty.escrowToken, effectiveFee);
            emit BountyClaimed(bountyId, sender);
            emit WorkApproved(bountyId, sender, bounty.rewardAmount, feeAmount, netPayout);
        } else {
            bounty.status = BountyStatus.Claimed;
            emit BountyClaimed(bountyId, sender);
        }
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

        // Compute fee and net payout for event transparency (V3: use locked fee)
        uint256 effectiveFee = _effectiveFeeBps(bounty);
        uint256 feeAmount = (bounty.rewardAmount * effectiveFee) / 10000;
        uint256 netPayout = bounty.rewardAmount - feeAmount;

        // Interactions — release escrow
        _releaseEscrow(bounty.claimer, bounty.rewardAmount, bounty.escrowType, bounty.escrowToken, effectiveFee);

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
    ) external onlyRole(DEFAULT_ADMIN_ROLE) whenNotPaused nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        if (bounty.status != BountyStatus.Disputed) revert InvalidStatus();

        // Effects — set final status
        if (releaseToWorker) {
            bounty.status = BountyStatus.Approved;
        } else {
            bounty.status = BountyStatus.Cancelled;
        }

        // Interactions (V3: use locked fee)
        if (releaseToWorker) {
            _releaseEscrow(bounty.claimer, bounty.rewardAmount, bounty.escrowType, bounty.escrowToken, _effectiveFeeBps(bounty));
        } else {
            _refundEscrow(bounty.creator, bounty.rewardAmount, bounty.escrowType, bounty.escrowToken);
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
        _refundEscrow(bounty.creator, refundAmount, bounty.escrowType, bounty.escrowToken);

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
        _refundEscrow(bounty.creator, refundAmount, bounty.escrowType, bounty.escrowToken);

        emit BountyExpired(bountyId, _msgSender(), refundAmount);
    }

    /**
     * @notice Owner force-resolves a stuck Submitted or Disputed bounty.
     * @param bountyId ID of the bounty to resolve
     * @param releaseToWorker If true, release escrow to worker (minus fee). If false, refund creator.
     *
     * @dev No grace period — owner can act immediately on any stuck bounty.
     *      Emergency escape hatch for when creators ghost.
     *
     * Emits {ForceResolved}.
     */
    function ownerForceResolve(
        uint256 bountyId,
        bool releaseToWorker
    ) external onlyRole(DEFAULT_ADMIN_ROLE) whenNotPaused nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        if (bounty.status != BountyStatus.Submitted && bounty.status != BountyStatus.Disputed) {
            revert InvalidStatus();
        }

        uint256 effectiveFee = _effectiveFeeBps(bounty);

        if (releaseToWorker) {
            bounty.status = BountyStatus.Approved;
            _releaseEscrow(bounty.claimer, bounty.rewardAmount, bounty.escrowType, bounty.escrowToken, effectiveFee);
        } else {
            bounty.status = BountyStatus.Cancelled;
            _refundEscrow(bounty.creator, bounty.rewardAmount, bounty.escrowType, bounty.escrowToken);
        }

        emit ForceResolved(bountyId, releaseToWorker, _msgSender());
    }

    /**
     * @notice Anyone can expire a Submitted bounty after deadline + grace period.
     * @param bountyId ID of the bounty to expire
     *
     * @dev Defaults to releasing escrow to worker (they submitted work, creator abandoned).
     *      Worker gets paid minus platform fee. This is fair — the creator had
     *      `deadline + submissionGracePeriod` to approve or dispute.
     *
     * Emits {SubmissionExpired}.
     */
    function expireSubmitted(uint256 bountyId) external whenNotPaused nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        if (bounty.status != BountyStatus.Submitted) revert InvalidStatus();
        if (block.timestamp <= bounty.deadline + submissionGracePeriod) revert NotExpired();

        uint256 effectiveFee = _effectiveFeeBps(bounty);

        bounty.status = BountyStatus.Approved;
        _releaseEscrow(bounty.claimer, bounty.rewardAmount, bounty.escrowType, bounty.escrowToken, effectiveFee);

        emit SubmissionExpired(bountyId, bounty.claimer, bounty.rewardAmount);
    }

    /**
     * @notice Approve a specific agent to claim a bounty (V5).
     * @param bountyId ID of the bounty
     * @param claimer Address of the agent approved to claim. Pass address(0) to revoke.
     *
     * @dev Only the bounty creator can call. Bounty must be Open.
     *      For V5+ bounties, claimBounty() will revert unless the caller matches
     *      the approved claimer set here.
     *
     *      Idempotent: calling with the same claimer overwrites the previous approval.
     *      Passing address(0) revokes approval and re-locks the bounty until a new
     *      claimer is approved.
     *      Approval persists through unclaim (unclaim resets status to Open but does
     *      NOT clear approvedClaimers), so the approved agent can re-claim.
     *
     * Emits {ClaimerApproved}.
     */
    function approveClaimer(uint256 bountyId, address claimer) external whenNotPaused {
        Bounty storage bounty = _getBounty(bountyId);
        if (bounty.status != BountyStatus.Open) revert InvalidStatus();
        address sender = _msgSender();
        if (sender != bounty.creator) revert NotCreator();
        if (claimer == bounty.creator) revert CannotClaimOwnBounty();
        // address(0) allowed — revokes approval, re-locks the bounty
        approvedClaimers[bountyId] = claimer;
        emit ClaimerApproved(bountyId, claimer);
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

    /**
     * @notice Get the approved claimer for a bounty (V5).
     * @param bountyId ID to look up
     * @return Address of the approved claimer, or address(0) if none
     */
    function getApprovedClaimer(uint256 bountyId) external view returns (address) {
        if (bountyId >= nextBountyId) revert BountyNotFound();
        return approvedClaimers[bountyId];
    }

    // ============================================================
    //                      ADMIN FUNCTIONS
    // ============================================================

    /// @notice Set the payment token address. address(0) = ETH-only mode.
    /// @dev Legacy V1 function — kept for backward compatibility. New bounties use per-bounty token choice.
    function setPaymentToken(address token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        address oldToken = address(paymentToken);
        paymentToken = IERC20(token);
        emit PaymentTokenUpdated(oldToken, token);
    }

    /// @notice Add or remove a token from the allowed escrow token whitelist.
    /// @param token ERC-20 token address to update
    /// @param allowed Whether the token is allowed for escrow
    function setAllowedToken(address token, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        allowedTokens[token] = allowed;
        emit AllowedTokenUpdated(token, allowed);
    }

    /**
     * @notice V2 reinitializer — sets up the allowed token whitelist.
     * @param usdc_ USDC token address
     * @param nook_ NOOK token address
     * @dev Called once during UUPS upgrade via upgradeProxy call option.
     */
    function initializeV2(address usdc_, address nook_) external reinitializer(2) {
        if (usdc_ != address(0)) allowedTokens[usdc_] = true;
        if (nook_ != address(0)) allowedTokens[nook_] = true;
    }

    /**
     * @notice V3 reinitializer — sets default submission grace period.
     * @dev Called once during UUPS upgrade via upgradeToAndCall.
     */
    function initializeV3() external reinitializer(3) {
        submissionGracePeriod = 14 days;
    }

    /**
     * @notice V4 reinitializer — migrates from Ownable to AccessControl.
     * @param admin_ Multi-sig address that gets DEFAULT_ADMIN_ROLE
     * @param guardian_ Security EOA that gets GUARDIAN_ROLE (pause only)
     */
    function initializeV4(address admin_, address guardian_) external reinitializer(4) {
        if (admin_ == address(0)) revert ZeroAddress();
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        if (guardian_ != address(0)) _grantRole(GUARDIAN_ROLE, guardian_);
        _transferOwnership(address(0));
    }

    /**
     * @notice V5 reinitializer — sets the approved claimer enforcement threshold.
     * @dev All bounties with ID >= nextBountyId at upgrade time will require
     *      approveClaimer() before claimBounty(). Pre-V5 bounties are grandfathered.
     */
    function initializeV5() external reinitializer(5) {
        approvedClaimerSinceId = nextBountyId;
        v5Active = true;
    }

    /**
     * @notice V6 reinitializer — marks version for ETH-rejection and grace period bounds.
     * @dev No state changes needed; logic changes are in createBounty() and setSubmissionGracePeriod().
     */
    function initializeV6() external reinitializer(6) {
        // No-op: V6 adds ETH-with-token revert + grace period max bound.
    }

    /// @notice Set the submission grace period for expireSubmitted.
    /// @dev V6: bounded to max 365 days to prevent abuse.
    function setSubmissionGracePeriod(uint256 period) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(period <= 365 days, "Period too long");
        submissionGracePeriod = period;
    }

    /// @notice Set the platform fee in basis points (max 1000 = 10%).
    function setPlatformFeeBps(uint256 feeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        uint256 oldFee = platformFeeBps;
        platformFeeBps = feeBps;
        emit PlatformFeeUpdated(oldFee, feeBps);
    }

    /// @notice Update the treasury address.
    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        address oldTreasury = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(oldTreasury, newTreasury);
    }

    /// @notice Update the AgentRegistry contract reference.
    function setAgentRegistry(address newRegistry) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newRegistry == address(0)) revert ZeroAddress();
        agentRegistry = newRegistry;
    }

    /// @notice Pause all bounty operations (emergency stop).
    function pause() external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender) && !hasRole(GUARDIAN_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, GUARDIAN_ROLE);
        }
        _pause();
    }

    /// @notice Unpause bounty operations.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ============================================================
    //                   EMERGENCY WITHDRAW
    // ============================================================

    event EmergencyWithdraw(address indexed token, address indexed to, uint256 amount);
    event EmergencyETHWithdraw(address indexed to, uint256 amount);

    /// @notice Withdraw stuck ERC-20 tokens sent to this contract by mistake.
    function emergencyWithdraw(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(to, amount);
        emit EmergencyWithdraw(token, to, amount);
    }

    /// @notice Rescue stuck ETH sent to this contract by mistake.
    function rescueETH(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        (bool success, ) = to.call{value: amount}("");
        if (!success) revert EthTransferFailed();
        emit EmergencyETHWithdraw(to, amount);
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
     * @dev Returns the effective fee for a bounty. Pre-V3 bounties (creationFeeBps == 0)
     *      fall back to the current global platformFeeBps for backward compatibility.
     */
    function _effectiveFeeBps(Bounty storage b) internal view returns (uint256) {
        return b.creationFeeBps > 0 ? b.creationFeeBps : platformFeeBps;
    }

    /**
     * @dev Release escrow to the worker (minus platform fee to treasury).
     *      Follows checks-effects-interactions — caller must update state BEFORE calling.
     * @param tokenAddr Per-bounty token address. If address(0), falls back to global paymentToken
     *                  (backward compat for in-flight bounties at upgrade time).
     * @param feeBps Fee in basis points to apply (V3: passed from bounty's locked fee)
     */
    function _releaseEscrow(
        address recipient,
        uint256 amount,
        EscrowType escrow,
        address tokenAddr,
        uint256 feeBps
    ) internal {
        if (amount == 0 || escrow == EscrowType.None) return;

        uint256 fee = (amount * feeBps) / 10000;
        uint256 payout = amount - fee;

        if (escrow == EscrowType.ETH) {
            if (fee > 0) {
                (bool feeSuccess, ) = treasury.call{value: fee}("");
                if (!feeSuccess) revert EthTransferFailed();
            }
            (bool paySuccess, ) = recipient.call{value: payout}("");
            if (!paySuccess) revert EthTransferFailed();
        } else if (escrow == EscrowType.Token) {
            // V2: use per-bounty token; fallback to global paymentToken for pre-upgrade bounties
            IERC20 token = tokenAddr != address(0) ? IERC20(tokenAddr) : paymentToken;
            if (fee > 0) {
                token.safeTransfer(treasury, fee);
            }
            token.safeTransfer(recipient, payout);
        }
    }

    /**
     * @dev Refund escrow to the creator (no fee deducted on refunds).
     *      Follows checks-effects-interactions — caller must update state BEFORE calling.
     * @param tokenAddr Per-bounty token address. If address(0), falls back to global paymentToken.
     */
    function _refundEscrow(
        address recipient,
        uint256 amount,
        EscrowType escrow,
        address tokenAddr
    ) internal {
        if (amount == 0 || escrow == EscrowType.None) return;

        if (escrow == EscrowType.ETH) {
            (bool success, ) = recipient.call{value: amount}("");
            if (!success) revert EthTransferFailed();
        } else if (escrow == EscrowType.Token) {
            // V2: use per-bounty token; fallback to global paymentToken for pre-upgrade bounties
            IERC20 token = tokenAddr != address(0) ? IERC20(tokenAddr) : paymentToken;
            token.safeTransfer(recipient, amount);
        }
    }

    // Validates agent is active on-chain; fails open if registry is unreachable.
    function _requireActiveAgent(address agent) internal view {
        (bool success, bytes memory data) = agentRegistry.staticcall(
            abi.encodeWithSignature("isActiveAgent(address)", agent)
        );

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

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
