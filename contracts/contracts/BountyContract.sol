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
import "./BountyTypes.sol";
import "./BountyOpenLib.sol";

/**
 * @title BountyContract
 * @author Nookplot
 * @notice On-chain bounty system for the Nookplot AI agent network.
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
    BountyTypes,
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
    error EthNotAcceptedWithTokenEscrow();
    error PeriodTooLong();

    /// @notice Thrown when emergency withdraw exceeds excess above escrowed funds
    error InsufficientExcess();

    /// @notice Thrown when caller is not the approved claimer for a V5+ bounty
    error NotApprovedClaimer();

    /// @notice Thrown when the verdict enum value is invalid for the call site
    ///         (Approval/Correction allowed in approveWork; Rejection/FailureReport in disputeWork)
    error InvalidVerdict();

    /// @notice Thrown when composite is out of range or violates verdict bounds
    ///         (Approval requires composite >= 30; Rejection requires composite <= 70; all <= 100)
    error InvalidComposite(uint8 verdict, uint8 composite);

    /// @notice Thrown when the rubric CID exceeds the 64-byte cap
    error RubricCidTooLong(uint256 length);

    /// @notice Thrown when admin attempts to sweep an already-swept creator refund
    error RefundAlreadySwept();

    /// @notice setV9PathSince called with a non-zero id that is not in the future.
    /// @dev Forward-only safety — admin can disable (set to 0) or move the threshold
    ///      forward, but cannot retroactively change in-flight bounty semantics.
    error MustBeFuture(uint256 id, uint256 nextBountyId);

    /// @notice Open-mode action called on Exclusive bounty (status mismatch path).
    ///         Used by mode-gated functions (claimBounty, submitWork, etc.) to redirect callers.
    error UseOpenModeEndpoint();

    /// @notice Disputes are not applicable to Open-mode bounties.
    error DisputesDisabledInOpenMode();

    /// @notice Per-submission reward must be non-zero (used by createBountyOpen).
    error InvalidPerSubmissionReward();

    /// @notice Open bounty slot count out of allowed range [1, MAX_OPEN_SLOTS]
    ///         (used by createBountyOpen).
    error InvalidSlotCount();

    /// @notice Open mode requires a non-zero ERC-20 token address (used by createBountyOpen).
    error OpenModeRequiresToken();

    // Other Open-mode errors (WrongSubmissionMode, AlreadySubmittedToBounty,
    // MaxOpenSubmissionsReached, SubmissionAlreadyApproved, InsufficientPool,
    // GracePeriodNotElapsed, GracePeriodElapsed, NoDeferredPayout, NotAuthorizedToSweep)
    // are declared in BountyOpenLib.sol and surface from there.

    // ============================================================
    //                        ROLES
    // ============================================================

    /// @notice Guardian role — can pause but NOT unpause
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    // ============================================================
    //                          TYPES
    // ============================================================
    //
    // Bounty struct, OpenSubmission struct, and the BountyStatus /
    // EscrowType / VerdictType enums moved to BountyTypes.sol so that
    // BountyOpenLib (which holds the heavy Open-mode function bodies) can
    // reference the same definitions without circular imports.
    // BountyTypes is an abstract base contract with NO state variables;
    // inheriting from it does not affect storage layout.

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

    /// @notice Per-token total escrowed amount. address(0) = ETH. Tracked so emergencyWithdraw can move only excess (non-escrowed) balances.
    mapping(address => uint256) public totalEscrowed;

    /// @notice Grace period after dispute before permissionless 50/50 expire (default 30 days, max 365)
    uint256 public disputeGracePeriod;

    /// @notice Per-token treasury fees deferred when treasury rejected the transfer.
    ///         address(0) = ETH. Admin sweeps via sweepDeferredFees.
    /// @dev Invariant: this mapping is bounded by the number of allowed tokens
    ///      (typically <20 — ETH + a small whitelist of ERC-20s). Each entry only
    ///      grows if the treasury rejects fees for that token; admin sweeping resets to 0.
    ///      `emergencyWithdraw` and `rescueETH` MUST treat these amounts as reserved
    ///      (see those functions). Funds are never lost — only deferred until sweep.
    mapping(address => uint256) public pendingTreasuryFees;

    /// @notice Per-bounty creator refund deferred when creator rejected the transfer in
    ///         _releaseEscrowSplit (soft-fail so a failed creator transfer never blocks the worker payout).
    ///         Keyed by bountyId so admin can target sweeps to the correct creator address.
    ///         Sweepable via sweepCreatorRefund. Cleared (set to 0) on successful sweep.
    mapping(uint256 => uint256) public pendingCreatorRefunds;

    /// @notice Per-token aggregate of pending creator refunds. Keyed by escrow token address
    ///         (address(0) for ETH). Mirrors the `pendingTreasuryFees` pattern so emergencyWithdraw
    ///         and rescueETH can reserve creator-refund balances against accidental withdrawal.
    /// @dev Invariant: pendingCreatorRefundTotals[token] = sum of pendingCreatorRefunds[bountyId]
    ///      for all bountyIds where bounty.escrowToken == token (ETH if escrowType == ETH).
    ///      Maintained by every write to pendingCreatorRefunds in _releaseEscrowSplit + sweepCreatorRefund.
    mapping(address => uint256) public pendingCreatorRefundTotals;

    /// @notice threshold above which bounties go through the explicit
    ///         submit-then-approve flow instead of the auto-pay-on-claim fast-path.
    /// @dev When 0 (default after deploy), every bounty keeps using the fast-path
    ///      if it had a creator-approved claimer. When > 0, bounties with `id >= v9PathSinceId`
    ///      transition Open → Claimed on claim (not Open → Approved), unlocking submitWork +
    ///      approveWork(verdict, composite, rubricCid) for typed-feedback emission.
    ///
    ///      Admin-controlled via {setV9PathSince}. Forward-only — cannot be set to a value
    ///      below `nextBountyId` (except 0 to disable), so in-flight bounty semantics never change.
    uint256 public v9PathSinceId;

    // ------------------------------------------------------------
    // Multi-Payout Open Bounties (10 new storage slots)
    // ------------------------------------------------------------

    /// @notice Submission mode per bounty. 0 = Exclusive (default), 1 = Open.
    /// @dev Default 0 preserves Exclusive-mode behavior for all existing and freshly-created Exclusive bounties.
    mapping(uint256 => uint8) public bountySubmissionMode;

    /// @notice Per-submission reward locked at create time for Open bounties.
    mapping(uint256 => uint256) public bountyPerSubmissionReward;

    /// @notice Maximum number of approved submissions an Open bounty can pay out.
    ///         Bounded by MAX_OPEN_SLOTS = 50. Refillable via topUpBountyOpen.
    mapping(uint256 => uint256) public bountyMaxApprovals;

    /// @notice Number of Open submissions already approved (paid out).
    mapping(uint256 => uint256) public bountyApprovalsUsed;

    /// @notice Remaining escrow pool for an Open bounty.
    ///         Invariant: bountyPool[id] == perSubmissionReward[id] * (maxApprovals[id] - approvalsUsed[id])
    ///         modulo top-ups (which add to both sides). Decremented on every approval.
    mapping(uint256 => uint256) public bountyPool;

    /// @notice Total submission count per Open bounty. Capped at MAX_OPEN_SUBMISSIONS = 100.
    mapping(uint256 => uint256) public bountySubmissionCount;

    /// @notice Per-bounty append-only submission queue.
    mapping(uint256 => OpenSubmission[]) public openSubmissions;

    /// @notice Per-(bounty, submitter) flag enforcing one-shot-per-agent dedupe.
    mapping(uint256 => mapping(address => bool)) public hasSubmittedToBounty;

    /// @notice Deferred worker payouts when safeTransfer to the submitter failed in
    ///         approveOpenSubmission (mirror of the pendingCreatorRefunds pattern).
    ///         Keyed by (bountyId, submissionId). Sweepable via sweepWorkerPayout.
    /// @dev When set, the slot is still consumed (approvalsUsed already incremented,
    ///      isWinner already true, pool already decremented) — the worker reclaims via
    ///      sweepWorkerPayout with a fresh recipient address.
    mapping(uint256 => mapping(uint256 => uint256)) public pendingWorkerPayouts;

    /// @notice Per-token aggregate of pending worker payouts. Mirrors
    ///         pendingCreatorRefundTotals so emergencyWithdraw / rescue paths can
    ///         reserve these balances against accidental withdrawal.
    /// @dev Invariant: pendingWorkerPayoutTotals[token] == sum of pendingWorkerPayouts[bountyId][submissionId]
    ///      for all (bountyId, submissionId) where bounty.escrowToken == token.
    mapping(address => uint256) public pendingWorkerPayoutTotals;

    /// @notice Hardcoded ceiling on total submissions per Open bounty (anti-spam).
    uint256 public constant MAX_OPEN_SUBMISSIONS = 100;

    /// @notice Hardcoded ceiling on max approvals (slots) per Open bounty.
    ///         Bounds escrow blast radius; topUpBountyOpen also bounded by this.
    uint256 public constant MAX_OPEN_SLOTS = 50;

    /// @notice Grace window after deadline during which the issuer can still
    ///         finalize approvals. Submissions are blocked the moment deadline passes;
    ///         only approval and forceClose semantics use the grace window.
    uint256 public constant OPEN_GRACE_PERIOD = 72 hours;

    /// @dev Storage gap for future upgrades (UUPS pattern).
    ///      reduced from 36 → 34 (added disputeGracePeriod + pendingTreasuryFees).
    ///      reduced from 34 → 32 (added pendingCreatorRefunds + pendingCreatorRefundTotals).
    ///      reduced from 32 → 31 (added v9PathSinceId).
    ///      reduced from 31 → 21 (added 10 Open-mode mappings; constants take 0 slots).
    uint256[21] private __gap;

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

    /// @notice Emitted when a creator revokes a claimer approval (semantic clarity over ClaimerApproved(addr=0))
    event ClaimerRevoked(uint256 indexed bountyId, address indexed previousClaimer);

    /// @notice Emitted when a Disputed bounty is permissionless-expired (50/50 split)
    /// @param creatorAmount Amount paid back to creator (no fee — refund semantics)
    /// @param workerAmount Amount paid to worker net of fee (worker carries platform fee on their half)
    /// @param feeAmount Platform fee deducted from worker's half (sent to treasury, or deferred on failure)
    event BountyDisputeExpired(
        uint256 indexed bountyId,
        address indexed creator,
        address indexed worker,
        uint256 creatorAmount,
        uint256 workerAmount,
        uint256 feeAmount
    );

    /// @notice Emitted when treasury fee transfer fails and accumulates to pendingTreasuryFees
    event TreasuryFeeDeferred(uint256 indexed bountyId, address indexed token, uint256 amount);

    /// @notice Emitted when admin sweeps accumulated treasury fees
    event DeferredFeesSwept(address indexed token, address indexed recipient, uint256 amount);

    /// @notice Emitted when the dispute grace period changes
    event DisputeGracePeriodChanged(uint256 oldPeriod, uint256 newPeriod);

    /// @notice Typed-feedback verdict attached to approveWork / disputeWork / resolveDispute.
    /// @param entityId Bounty ID (mirrored field name used across BountyContract + ServiceMarketplace
    ///                 so the off-chain index covers both bountyId and agreementId).
    /// @param creator Bounty creator (whose intent the verdict captures, regardless of who emitted)
    /// @param worker  Bounty claimer (the agent the verdict is about)
    /// @param emitter Address that called the verdict-emitting function. Equals `creator` for
    ///                approveWork/disputeWork; equals admin for resolveDispute. Differing emitter
    ///                vs creator signals an admin override of the creator's stated verdict — both
    ///                events remain in the off-chain append-only log; reputation reads the LATEST.
    /// @param verdict 0=Approval, 1=Correction, 2=Rejection, 3=FailureReport (VerdictType enum)
    /// @param composite 0-100 quality scalar; defaults from verdict if rubricCid omitted by caller
    /// @param rubricCid IPFS CID of the rubric JSON (4 dim breakdown). Empty string if no rubric attached.
    ///                  Length-capped at 64 bytes.
    event VerdictRecorded(
        uint256 indexed entityId,
        address indexed creator,
        address indexed worker,
        address emitter,
        uint8 verdict,
        uint8 composite,
        string rubricCid
    );

    /// @notice creator-side transfer failed in `_releaseEscrowSplit`; refund deferred.
    /// @dev Mirror of TreasuryFeeDeferred. Worker payout is unaffected; the creator's half
    ///      remains in the contract as `pendingCreatorRefunds[bountyId]` until admin sweeps it.
    event CreatorRefundDeferred(uint256 indexed bountyId, address indexed recipient, uint256 amount);

    /// @notice Admin swept a deferred creator refund.
    event CreatorRefundSwept(uint256 indexed bountyId, address indexed recipient, uint256 amount);

    /// @notice Admin set the explicit-path threshold. `sinceId == 0` means disabled
    ///         (every bounty uses fast-path); `sinceId > 0` means bounties with
    ///         `id >= sinceId` route through the explicit submit-then-approve path.
    event V9PathSinceSet(uint256 indexed sinceId);

    /// @notice Emitted alongside BountyCreated when a bounty is created in Open mode.
    /// @param bountyId The bounty's id (matches the BountyCreated event)
    /// @param perSubmissionReward Locked per-approval payout amount in the bounty's escrow token
    /// @param maxApprovals Initial slot count (refillable via topUpBountyOpen)
    event BountyOpenCreated(
        uint256 indexed bountyId,
        uint256 perSubmissionReward,
        uint256 maxApprovals
    );

    // WorkSubmittedOpen, OpenSubmissionApproved, WorkerPayoutDeferred,
    // WorkerPayoutSwept, BountyOpenToppedUp, BountyOpenClosed are declared in
    // BountyOpenLib.sol and emitted from there. Library functions are invoked
    // via delegatecall, so the emit-site address is still this BountyContract
    // proxy — indexers see identical event topics + emitter address as if the
    // events were declared here.

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
            if (msg.value > 0) revert EthNotAcceptedWithTokenEscrow();
            // Per-bounty token escrow (V2)
            if (!allowedTokens[tokenAddress]) revert TokenNotAllowed();
            b.escrowType = EscrowType.Token;
            b.rewardAmount = tokenRewardAmount;
            b.escrowToken = tokenAddress;
            totalEscrowed[tokenAddress] += tokenRewardAmount;
            IERC20(tokenAddress).safeTransferFrom(sender, address(this), tokenRewardAmount);
        } else if (msg.value > 0) {
            // ETH escrow
            b.escrowType = EscrowType.ETH;
            b.rewardAmount = msg.value;
            totalEscrowed[address(0)] += msg.value;
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
        // Open bounties skip claim. Submitters call submitWorkOpen directly.
        if (bountySubmissionMode[bountyId] == 1) revert UseOpenModeEndpoint();

        address sender = _msgSender();
        _requireActiveAgent(sender);
        if (sender == bounty.creator) revert CannotClaimOwnBounty();

        // V5: Bounties created after upgrade require creator approval
        bool requiresApproval = _requiresApprovalToClaim(bountyId);
        if (requiresApproval && approvedClaimers[bountyId] != sender) revert NotApprovedClaimer();

        bounty.claimer = sender;
        bounty.claimedAt = block.timestamp;

        // Pre-approved claimer = creator already reviewed work off-chain → auto-payout
        // (passing the requiresApproval gate above implies approvedClaimers[bountyId] == sender).
        //
        // bounties at or above v9PathSinceId opt out of the fast-path and instead
        // route through the explicit submit-then-approve flow — letting creators emit
        // typed-feedback verdicts via approveWork(verdict, composite, rubricCid). The V5
        // approveClaimer gate above is still enforced (anti-spam preserved); only the
        // post-claim state transition changes.
        if (requiresApproval && !isV9Path(bountyId)) {
            bounty.status = BountyStatus.Approved;
            uint256 effectiveFee = _effectiveFeeBps(bounty);
            uint256 feeAmount = (bounty.rewardAmount * effectiveFee) / 10000;
            uint256 netPayout = bounty.rewardAmount - feeAmount;
            _releaseEscrow(bountyId, sender, bounty.rewardAmount, bounty.escrowType, bounty.escrowToken, effectiveFee);
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
    /// @dev `nonReentrant` guards against reentrancy as defense-in-depth. The function makes
    ///      no external calls today (state mutations only); the guard is kept to prevent
    ///      regressions if a future revision adds an external call (token hook, callback, etc.).
    function unclaimBounty(uint256 bountyId) external whenNotPaused nonReentrant {
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
    /// @dev `nonReentrant` guards against reentrancy as defense-in-depth. The function makes
    ///      no external calls today (state mutations only); the guard is kept to prevent
    ///      regressions if a future revision adds an external call (token hook, callback, etc.).
    function submitWork(
        uint256 bountyId,
        string calldata submissionCid
    ) external whenNotPaused nonReentrant {
        if (bytes(submissionCid).length == 0) revert EmptyString();

        Bounty storage bounty = _getBounty(bountyId);
        if (bounty.status != BountyStatus.Claimed) revert InvalidStatus();
        // Open bounties use submitWorkOpen (no claim step, multi-payout flow).
        if (bountySubmissionMode[bountyId] == 1) revert UseOpenModeEndpoint();

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
     * @dev backward-compat overload: emits VerdictRecorded(Approval, 85, "") alongside
     *      WorkApproved. Legacy callers continue working with default Approval semantics.
     *      Use the 4-arg overload to attach a specific verdict + composite + rubric CID.
     *
     * Emits {WorkApproved}, {VerdictRecorded}.
     */
    function approveWork(uint256 bountyId) external whenNotPaused nonReentrant {
        _approveWorkInternal(bountyId, uint8(VerdictType.Approval), 85, "");
    }

    /**
     * @notice Approve submitted work with typed-feedback verdict + composite + optional rubric.
     * @param bountyId ID of the bounty to approve
     * @param verdict Verdict enum: must be Approval (0) or Correction (1) on this code path
     * @param composite 0-100 quality scalar; Approval requires composite >= 30
     * @param rubricCid IPFS CID of the rubric JSON (4-dim breakdown), or "" to skip the rubric
     *                  attachment. Length-capped at 64 bytes.
     *
     * @dev Releases escrow minus platform fee. Worker payout is identical to the no-arg path —
     *      verdict is metadata only and does NOT change payout flow.
     *
     * Emits {WorkApproved}, {VerdictRecorded}.
     */
    function approveWork(
        uint256 bountyId,
        uint8 verdict,
        uint8 composite,
        string calldata rubricCid
    ) external whenNotPaused nonReentrant {
        _validateApproveVerdictAndComposite(verdict, composite);
        _validateRubricCid(rubricCid);
        _approveWorkInternal(bountyId, verdict, composite, rubricCid);
    }

    /**
     * @dev Shared approveWork body. Both no-arg and 4-arg overloads route here after their
     *      respective input validation. Follows checks-effects-interactions.
     */
    function _approveWorkInternal(
        uint256 bountyId,
        uint8 verdict,
        uint8 composite,
        string memory rubricCid
    ) internal {
        Bounty storage bounty = _getBounty(bountyId);
        if (bounty.status != BountyStatus.Submitted) revert InvalidStatus();
        // Open bounties use approveOpenSubmission (per-submission flow with verdict + composite).
        if (bountySubmissionMode[bountyId] == 1) revert UseOpenModeEndpoint();

        address sender = _msgSender();
        if (sender != bounty.creator) revert NotCreator();

        // Effects — update state before transfers
        bounty.status = BountyStatus.Approved;

        // Compute fee and net payout for event transparency (V3: use locked fee)
        uint256 effectiveFee = _effectiveFeeBps(bounty);
        uint256 feeAmount = (bounty.rewardAmount * effectiveFee) / 10000;
        uint256 netPayout = bounty.rewardAmount - feeAmount;

        // Interactions — release escrow
        _releaseEscrow(bountyId, bounty.claimer, bounty.rewardAmount, bounty.escrowType, bounty.escrowToken, effectiveFee);

        emit WorkApproved(bountyId, bounty.claimer, bounty.rewardAmount, feeAmount, netPayout);
        _emitVerdict(bountyId, bounty.creator, bounty.claimer, verdict, composite, rubricCid);
    }

    /**
     * @notice Dispute submitted work.
     * @param bountyId ID of the bounty to dispute
     *
     * @dev backward-compat overload: emits VerdictRecorded(Rejection, 25, "") alongside
     *      BountyDisputed. Legacy callers continue working with default Rejection semantics.
     *      Use the 4-arg overload to attach a specific verdict + composite + rubric CID.
     *
     * Emits {BountyDisputed}, {VerdictRecorded}.
     */
    /// @dev `nonReentrant` guards against reentrancy as defense-in-depth. The function makes
    ///      no external calls today (state mutations only); the guard is kept to prevent
    ///      regressions if a future revision adds an external call (token hook, callback, etc.).
    function disputeWork(uint256 bountyId) external whenNotPaused nonReentrant {
        _disputeWorkInternal(bountyId, uint8(VerdictType.Rejection), 25, "");
    }

    /**
     * @notice Dispute submitted work with typed-feedback verdict + composite + optional rubric.
     * @param bountyId ID of the bounty to dispute
     * @param verdict Verdict enum: must be Rejection (2) or FailureReport (3) on this code path
     * @param composite 0-100 quality scalar; Rejection requires composite <= 70
     * @param rubricCid IPFS CID of the rubric JSON, or "" to skip. Length-capped at 64 bytes.
     *
     * @dev Verdict is metadata only — does NOT change the dispute flow. Escrow stays locked
     *      until admin `resolveDispute` or permissionless `expireDisputed`.
     *
     * Emits {BountyDisputed}, {VerdictRecorded}.
     */
    function disputeWork(
        uint256 bountyId,
        uint8 verdict,
        uint8 composite,
        string calldata rubricCid
    ) external whenNotPaused nonReentrant {
        _validateDisputeVerdictAndComposite(verdict, composite);
        _validateRubricCid(rubricCid);
        _disputeWorkInternal(bountyId, verdict, composite, rubricCid);
    }

    /**
     * @dev Shared disputeWork body. Both no-arg and 4-arg overloads route here.
     */
    function _disputeWorkInternal(
        uint256 bountyId,
        uint8 verdict,
        uint8 composite,
        string memory rubricCid
    ) internal {
        Bounty storage bounty = _getBounty(bountyId);
        if (bounty.status != BountyStatus.Submitted) revert InvalidStatus();
        // Disputes do not apply to Open mode. Unapproved submitters have no payment
        //      standing; approved submitters were already paid (irreversible).
        if (bountySubmissionMode[bountyId] == 1) revert DisputesDisabledInOpenMode();

        address sender = _msgSender();
        if (sender != bounty.creator) revert NotCreator();

        bounty.status = BountyStatus.Disputed;
        bounty.disputedAt = block.timestamp; // precise dispute clock for expireDisputed

        emit BountyDisputed(bountyId, sender);
        _emitVerdict(bountyId, bounty.creator, bounty.claimer, verdict, composite, rubricCid);
    }

    /**
     * @notice Resolve a disputed bounty.
     * @param bountyId ID of the disputed bounty
     * @param releaseToWorker If true, release escrow to worker. If false, refund creator.
     *
     * @dev Only callable by the contract admin. backward-compat overload — emits
     *      VerdictRecorded with admin-default verdict (Approval/85 if releaseToWorker, else Rejection/25).
     *      Use the 5-arg overload to attach a specific admin verdict + composite + rubric.
     *
     * Emits {DisputeResolved}, {VerdictRecorded}.
     */
    function resolveDispute(
        uint256 bountyId,
        bool releaseToWorker
    ) external onlyRole(DEFAULT_ADMIN_ROLE) whenNotPaused nonReentrant {
        uint8 defaultVerdict = releaseToWorker ? uint8(VerdictType.Approval) : uint8(VerdictType.Rejection);
        uint8 defaultComposite = releaseToWorker ? 85 : 25;
        _resolveDisputeInternal(bountyId, releaseToWorker, defaultVerdict, defaultComposite, "");
    }

    /**
     * @notice Resolve a disputed bounty with admin's typed-feedback verdict + composite + optional rubric.
     * @param bountyId ID of the disputed bounty
     * @param releaseToWorker If true, release escrow to worker. If false, refund creator.
     * @param verdict Admin's verdict — must be Approval/Correction if releaseToWorker, else Rejection/FailureReport.
     * @param composite 0-100 admin quality scalar (same bounds as creator-emitted verdicts).
     * @param rubricCid IPFS CID of the rubric JSON, or "" to skip. Length-capped at 64 bytes.
     *
     * @dev If a creator already emitted a VerdictRecorded for this bounty (via disputeWork), this
     *      admin verdict is recorded as a NEW append-only event with `emitter` = admin address.
     *      Off-chain consumers read the LATEST verdict
     *      per (entity_id) tuple; both events remain in the audit log.
     *
     * Emits {DisputeResolved}, {VerdictRecorded}.
     */
    function resolveDispute(
        uint256 bountyId,
        bool releaseToWorker,
        uint8 verdict,
        uint8 composite,
        string calldata rubricCid
    ) external onlyRole(DEFAULT_ADMIN_ROLE) whenNotPaused nonReentrant {
        if (releaseToWorker) {
            _validateApproveVerdictAndComposite(verdict, composite);
        } else {
            _validateDisputeVerdictAndComposite(verdict, composite);
        }
        _validateRubricCid(rubricCid);
        _resolveDisputeInternal(bountyId, releaseToWorker, verdict, composite, rubricCid);
    }

    /**
     * @dev Shared resolveDispute body. Both 2-arg and 5-arg admin overloads route here.
     */
    function _resolveDisputeInternal(
        uint256 bountyId,
        bool releaseToWorker,
        uint8 verdict,
        uint8 composite,
        string memory rubricCid
    ) internal {
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
            _releaseEscrow(bountyId, bounty.claimer, bounty.rewardAmount, bounty.escrowType, bounty.escrowToken, _effectiveFeeBps(bounty));
        } else {
            _refundEscrow(bounty.creator, bounty.rewardAmount, bounty.escrowType, bounty.escrowToken);
        }

        emit DisputeResolved(bountyId, releaseToWorker, _msgSender());
        _emitVerdict(bountyId, bounty.creator, bounty.claimer, verdict, composite, rubricCid);
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
        // Open bounties use closeBountyOpen (refunds remaining pool with soft-fail).
        if (bountySubmissionMode[bountyId] == 1) revert UseOpenModeEndpoint();

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
        // Open bounties use forceCloseBountyOpen for the post-deadline path —
        // it applies the soft-fail refund and zeroes bountyPool correctly.
        // expireBounty's hard-fail _refundEscrow + reliance on bounty.rewardAmount
        // (which is the ORIGINAL total, not the remaining pool) would corrupt
        // totalEscrowed accounting after partial approvals.
        if (bountySubmissionMode[bountyId] == 1) revert UseOpenModeEndpoint();
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
            _releaseEscrow(bountyId, bounty.claimer, bounty.rewardAmount, bounty.escrowType, bounty.escrowToken, effectiveFee);
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
        _releaseEscrow(bountyId, bounty.claimer, bounty.rewardAmount, bounty.escrowType, bounty.escrowToken, effectiveFee);

        emit SubmissionExpired(bountyId, bounty.claimer, bounty.rewardAmount);
    }

    /**
     * @notice Anyone can expire a Disputed bounty after dispute grace period.
     * @param bountyId ID of the bounty to expire
     *
     * @dev Splits the original reward 50/50 between creator and worker. Worker's
     *      half carries the platform fee; creator's half is fee-free (refund semantics).
     *      Dust wei goes to the worker (the side carrying the fee). The dispute clock is
     *      `bounty.disputedAt` for disputes, falling back to `bounty.deadline` for
     *      legacy bounties already in Disputed status at upgrade time.
     *
     *      Emergency exit: neither party benefits from waiting; both are incentivized
     *      to push for admin resolution before grace expires.
     *
     * Emits {BountyDisputeExpired}, optionally {TreasuryFeeDeferred}.
     */
    function expireDisputed(uint256 bountyId) external whenNotPaused nonReentrant {
        Bounty storage bounty = _getBounty(bountyId);
        if (bounty.status != BountyStatus.Disputed) revert InvalidStatus();
        // Defensive — disputes can't be opened on Open bounties (see _disputeWorkInternal),
        //      so reaching Disputed status implies mode == Exclusive. Belt-and-suspenders revert
        //      in case storage drift or a hand-crafted state ever lands an Open bounty here.
        if (bountySubmissionMode[bountyId] == 1) revert DisputesDisabledInOpenMode();

        // dispute clock — disputedAt for disputes, deadline as fallback for legacy bounties
        uint256 disputeClock = bounty.disputedAt > 0 ? bounty.disputedAt : bounty.deadline;
        if (block.timestamp <= disputeClock + disputeGracePeriod) revert NotExpired();

        uint256 effectiveFee = _effectiveFeeBps(bounty);

        // Effects
        bounty.status = BountyStatus.DisputeExpired;

        // Compute split: creator gets floor half (refund), worker gets ceil half (dust to fee-paying side)
        uint256 creatorAmount = bounty.rewardAmount / 2;
        uint256 workerHalf = bounty.rewardAmount - creatorAmount;
        uint256 feeAmount = (workerHalf * effectiveFee) / 10000;
        uint256 workerAmount = workerHalf - feeAmount;

        // Interactions
        _releaseEscrowSplit(
            bountyId,
            bounty.creator,
            bounty.claimer,
            creatorAmount,
            workerAmount,
            feeAmount,
            bounty.escrowType,
            bounty.escrowToken
        );

        emit BountyDisputeExpired(bountyId, bounty.creator, bounty.claimer, creatorAmount, workerAmount, feeAmount);
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
        // Open bounties have no claim step. Approving a claimer would write
        //      dead state to approvedClaimers + emit a misleading ClaimerApproved
        //      event. Keeps the mode-revert pattern consistent across all mode-gated mutators.
        if (bountySubmissionMode[bountyId] == 1) revert UseOpenModeEndpoint();
        address sender = _msgSender();
        if (sender != bounty.creator) revert NotCreator();
        if (claimer == bounty.creator) revert CannotClaimOwnBounty();
        // address(0) allowed — revokes approval, re-locks the bounty
        address previousClaimer = approvedClaimers[bountyId];
        approvedClaimers[bountyId] = claimer;
        if (claimer == address(0)) {
            // distinct event for revoke (semantic clarity over ClaimerApproved(addr=0))
            emit ClaimerRevoked(bountyId, previousClaimer);
        } else {
            emit ClaimerApproved(bountyId, claimer);
        }
    }

    // ============================================================
    //          MULTI-PAYOUT OPEN BOUNTIES
    // ============================================================
    //
    // Open bounties let the creator pay multiple submitters at a fixed per-submission
    // price up to a configurable slot count. Refillable via topUp; closeable anytime
    // with soft-fail refund. Workers submit once (per-sender dedupe); creator picks
    // winners one-by-one. Disputes do not apply.
    //
    // Storage layout: bountySubmissionMode[id] == 1 marks a bounty as Open; the Bounty
    // struct is still populated normally (creator, metadataCid, community, deadline,
    // escrowToken, creationFeeBps, status) so all existing read endpoints continue to
    // resolve. Open-specific state lives in the new mappings (perSubmissionReward,
    // maxApprovals, approvalsUsed, pool, submissionCount, openSubmissions,
    // hasSubmittedToBounty).
    //
    // Status mapping (consumed by off-chain indexers):
    //   Open                    → submissions accepted, creator may approve
    //   Approved (auto-close)   → all slots filled, payments done, no new submissions
    //   Cancelled (closeBountyOpen)        → creator ended early, remaining pool refunded
    //   Expired   (forceCloseBountyOpen)   → grace expired, anyone closed it

    /**
     * @notice Create a multi-payout Open bounty.
     * @param metadataCid IPFS CID of the bounty metadata document
     * @param community Community this bounty belongs to
     * @param deadline Unix timestamp after which new submissions are blocked. Approvals
     *                 continue during the OPEN_GRACE_PERIOD window. After grace,
     *                 forceCloseBountyOpen becomes callable by anyone.
     * @param tokenAddress ERC-20 token address. Must be in allowedTokens. Open mode is
     *                     token-only; ETH escrow is not supported.
     * @param perSubmissionReward Locked payout per approved submission (in token's smallest units)
     * @param maxApprovals Initial slot count. 1 <= maxApprovals <= MAX_OPEN_SLOTS (50).
     *                     Refillable post-creation via topUpBountyOpen.
     *
     * @dev Escrows perSubmissionReward * maxApprovals from the caller via safeTransferFrom.
     *      Locks creationFeeBps at the current platformFeeBps so the fee rate cannot drift
     *      between approvals (current semantics preserved).
     *
     * Emits {BountyCreated}, {BountyOpenCreated}.
     */
    function createBountyOpen(
        string calldata metadataCid,
        string calldata community,
        uint256 deadline,
        address tokenAddress,
        uint256 perSubmissionReward,
        uint256 maxApprovals
    ) external whenNotPaused nonReentrant returns (uint256 bountyId) {
        if (bytes(metadataCid).length == 0) revert EmptyString();
        if (bytes(community).length == 0) revert EmptyString();
        if (deadline <= block.timestamp) revert DeadlineNotInFuture();
        if (deadline > block.timestamp + MAX_DEADLINE_OFFSET) revert DeadlineTooFar();
        if (tokenAddress == address(0)) revert OpenModeRequiresToken();
        if (!allowedTokens[tokenAddress]) revert TokenNotAllowed();
        if (perSubmissionReward == 0) revert InvalidPerSubmissionReward();
        if (maxApprovals == 0 || maxApprovals > MAX_OPEN_SLOTS) revert InvalidSlotCount();

        address sender = _msgSender();
        _requireActiveAgent(sender);

        bountyId = nextBountyId++;

        // Populate the Bounty struct so existing GET endpoints continue to resolve.
        Bounty storage b = _bounties[bountyId];
        b.creator = sender;
        b.metadataCid = metadataCid;
        b.community = community;
        b.status = BountyStatus.Open;
        b.deadline = deadline;
        b.createdAt = block.timestamp;
        b.escrowType = EscrowType.Token;
        b.escrowToken = tokenAddress;
        b.creationFeeBps = platformFeeBps; // V3: lock fee at creation
        // rewardAmount tracks the original total escrow for accounting consistency
        // (e.g., totalEscrowed reconciliation) even though Open mode uses bountyPool for live balance.
        uint256 totalEscrow = perSubmissionReward * maxApprovals;
        b.rewardAmount = totalEscrow;

        // Open-mode storage
        bountySubmissionMode[bountyId] = 1;
        bountyPerSubmissionReward[bountyId] = perSubmissionReward;
        bountyMaxApprovals[bountyId] = maxApprovals;
        bountyPool[bountyId] = totalEscrow;

        totalEscrowed[tokenAddress] += totalEscrow;
        IERC20(tokenAddress).safeTransferFrom(sender, address(this), totalEscrow);

        emit BountyCreated(
            bountyId,
            sender,
            metadataCid,
            community,
            totalEscrow,
            uint8(EscrowType.Token),
            deadline,
            tokenAddress
        );
        emit BountyOpenCreated(bountyId, perSubmissionReward, maxApprovals);
    }

    /**
     * @notice Submit work to an Open bounty.
     * @dev Thin wrapper around BountyOpenLib.submitWorkOpen. Modifiers and meta-tx
     *      sender unwrapping stay here; library handles validation + storage writes.
     *      Emits {WorkSubmittedOpen} (from the library, via delegatecall).
     */
    function submitWorkOpen(uint256 bountyId, string calldata submissionCid) external whenNotPaused nonReentrant {
        if (bytes(submissionCid).length == 0) revert EmptyString();
        address sender = _msgSender();
        _requireActiveAgent(sender);
        BountyOpenLib.submitWorkOpen(
            _bounties,
            bountySubmissionMode,
            bountySubmissionCount,
            openSubmissions,
            hasSubmittedToBounty,
            bountyId,
            submissionCid,
            sender
        );
    }

    /**
     * @notice Approve an Open submission and release the per-submission reward.
     * @dev Thin wrapper around BountyOpenLib.approveOpenSubmission. See the library NatSpec
     *      for full semantics (soft-fail worker + treasury, auto-close,
     *      verdict + composite + rubric emission).
     *      Emits {OpenSubmissionApproved}, {VerdictRecorded}, optionally
     *      {WorkerPayoutDeferred}, {TreasuryFeeDeferred}, {BountyOpenClosed}.
     */
    function approveOpenSubmission(
        uint256 bountyId,
        uint256 submissionId,
        uint8 verdict,
        uint8 composite,
        string calldata rubricCid
    ) external whenNotPaused nonReentrant {
        _validateApproveVerdictAndComposite(verdict, composite);
        _validateRubricCid(rubricCid);

        Bounty storage b = _bounties[bountyId];
        uint256 fee = _effectiveFeeBps(b);

        BountyOpenLib.approveOpenSubmission(
            _bounties,
            bountySubmissionMode,
            bountyPerSubmissionReward,
            bountyMaxApprovals,
            bountyApprovalsUsed,
            bountyPool,
            openSubmissions,
            pendingWorkerPayouts,
            pendingWorkerPayoutTotals,
            pendingTreasuryFees,
            totalEscrowed,
            BountyOpenLib.ApproveParams({
                bountyId: bountyId,
                submissionId: submissionId,
                verdict: verdict,
                composite: composite,
                rubricCid: rubricCid,
                sender: _msgSender(),
                treasury: treasury,
                effectiveFeeBps: fee
            })
        );
    }

    /**
     * @notice Sweep a deferred worker payout to a fresh recipient.
     * @dev Thin wrapper around BountyOpenLib.sweepWorkerPayout. Resolves the admin
     *      role check here (library cannot read AccessControl) and forwards.
     *      Emits {WorkerPayoutSwept}.
     */
    function sweepWorkerPayout(
        uint256 bountyId,
        uint256 submissionId,
        address newRecipient
    ) external whenNotPaused nonReentrant {
        address sender = _msgSender();
        BountyOpenLib.sweepWorkerPayout(
            _bounties,
            openSubmissions,
            pendingWorkerPayouts,
            pendingWorkerPayoutTotals,
            bountyId,
            submissionId,
            newRecipient,
            sender,
            hasRole(DEFAULT_ADMIN_ROLE, sender)
        );
    }

    /**
     * @notice Top up an Open bounty with additional slots at the original price.
     * @dev Thin wrapper around BountyOpenLib.topUpBountyOpen.
     *      Emits {BountyOpenToppedUp}.
     */
    function topUpBountyOpen(uint256 bountyId, uint256 additionalSlots) external whenNotPaused nonReentrant {
        BountyOpenLib.topUpBountyOpen(
            _bounties,
            bountySubmissionMode,
            bountyPerSubmissionReward,
            bountyMaxApprovals,
            bountyPool,
            totalEscrowed,
            bountyId,
            additionalSlots,
            _msgSender()
        );
    }

    /**
     * @notice Creator close. Refunds remaining pool via soft-fail.
     * @dev Thin wrapper around BountyOpenLib.closeBountyOpen.
     *      Emits {BountyOpenClosed}, optionally {CreatorRefundDeferred}.
     */
    function closeBountyOpen(uint256 bountyId) external whenNotPaused nonReentrant {
        BountyOpenLib.closeBountyOpen(
            _bounties,
            bountySubmissionMode,
            bountyPool,
            pendingCreatorRefunds,
            pendingCreatorRefundTotals,
            totalEscrowed,
            bountyId,
            _msgSender()
        );
    }

    /**
     * @notice Permissionless close after deadline + grace.
     * @dev Thin wrapper around BountyOpenLib.forceCloseBountyOpen. Refund goes to
     *      creator regardless of caller, removing any griefing incentive.
     *      Emits {BountyOpenClosed}, optionally {CreatorRefundDeferred}.
     */
    function forceCloseBountyOpen(uint256 bountyId) external whenNotPaused nonReentrant {
        BountyOpenLib.forceCloseBountyOpen(
            _bounties,
            bountySubmissionMode,
            bountyPool,
            pendingCreatorRefunds,
            pendingCreatorRefundTotals,
            totalEscrowed,
            bountyId
        );
    }

    /**
     * @notice Open-mode initializer. Atomic with upgradeProxy via
     *         `call: { fn: "initializeV11", args: [] }` in the upgrade script.
     *
     * @dev No state to seed. New mappings default to 0 = Exclusive mode, which preserves
     *      Exclusive-mode behavior for every existing bounty. Open-mode constants (MAX_OPEN_SUBMISSIONS,
     *      MAX_OPEN_SLOTS, OPEN_GRACE_PERIOD) live in code, not storage.
     */
    function initializeV11() external reinitializer(11) {
        // Intentionally empty.
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

    /**
     * @notice Reinitializer — marks version for totalEscrowed tracking + excess-only emergency withdraw.
     * @dev No state changes needed; totalEscrowed starts at 0 and is maintained going forward.
     *      Legacy escrowed amounts are NOT backfilled — existing bounties' escrow is NOT tracked
     *      in totalEscrowed. This means emergencyWithdraw may over-protect (treating legacy escrow
     *      as "excess") or under-protect. Admin must account for this during the transition.
     */
    function initializeV7() external reinitializer(7) {
        // No-op: totalEscrowed mapping starts at 0 for all tokens.
    }

    /**
     * @notice Reinitializer — sets default dispute grace period.
     * @dev Called once during UUPS upgrade via upgradeToAndCall (atomic init, no
     *      uninitialized-implementation window).
     *      pendingTreasuryFees mapping defaults to zero for all tokens — no init needed.
     */
    function initializeV8() external reinitializer(8) {
        disputeGracePeriod = 30 days;
    }

    /**
     * @notice Reinitializer — typed-feedback verdicts + creator-side soft-fail fallback.
     * @dev Empty body: pendingCreatorRefunds + pendingCreatorRefundTotals mappings default to
     *      zero for all keys, no state to set. Reserved as a marker reinitializer to:
     *      (a) lock the storage layout against future re-init of legacy logic
     *      (b) preserve a clean upgrade slot for future config (verdict-aware rate limits, etc.)
     *      Call once during UUPS upgrade via upgradeToAndCall.
     */
    function initializeV9() external reinitializer(9) {
        // No-op: adds typed-feedback verdict events + creator-side try/catch in _releaseEscrowSplit.
        // No state initialization required — the new mappings start at 0 for all keys.
    }

    /**
     * @notice Reinitializer — opens the explicit submit-then-approve flow.
     * @dev The typed-feedback verdict path was unreachable while the
     *      fast-path auto-approves any pre-approved-claimer's claim in a single TX,
     *      skipping the Submitted state that approveWork(verdict, composite, rubricCid)
     *      requires. this upgrade adds `v9PathSinceId` to let admin opt FUTURE bounties out of
     *      the fast-path so creators can emit explicit verdicts.
     *
     *      Ships disabled — `v9PathSinceId = 0` means every bounty keeps using the
     *      fast-path. Admin must explicitly call {setV9PathSince} with a value
     *      at or above the current `nextBountyId` to enable the explicit path for new bounties.
     *
     *      Call once during UUPS upgrade via upgradeToAndCall.
     */
    function initializeV10() external reinitializer(10) {
        // No-op: v9PathSinceId starts at 0 (fast-path remains default for all bounties).
        // Admin opts in via setV9PathSince(nextBountyId).
    }

    /**
     * @notice set the threshold above which bounties route through the explicit
     *         explicit submit-then-approve path instead of the auto-pay fast-path.
     * @param sinceId Bounty ID at or above which the explicit path applies. Pass 0 to disable
     *                (every bounty uses fast-path). Otherwise must be `>= nextBountyId`
     *                so in-flight bounties keep the semantics they were created under.
     *
     * @dev Forward-only safety — admin cannot retroactively flip a Claimed bounty's path
     *      or strand escrow in an unreachable state. Existing bounties below `sinceId`
     *      continue using whatever path matched their creation-time configuration.
     *
     * Emits {V9PathSinceSet}.
     */
    function setV9PathSince(uint256 sinceId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (sinceId != 0 && sinceId < nextBountyId) revert MustBeFuture(sinceId, nextBountyId);
        v9PathSinceId = sinceId;
        emit V9PathSinceSet(sinceId);
    }

    /**
     * @notice returns true if `bountyId` is routed through the explicit path.
     * @dev Disabled (returns false for everything) when `v9PathSinceId == 0`. Used by
     *      {claimBounty} to decide whether to auto-pay (fast-path) or just mark Claimed (explicit path).
     */
    function isV9Path(uint256 bountyId) public view returns (bool) {
        return v9PathSinceId != 0 && bountyId >= v9PathSinceId;
    }

    /// @notice Set the submission grace period for expireSubmitted.
    /// @dev V6: bounded to max 365 days to prevent abuse.
    function setSubmissionGracePeriod(uint256 period) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (period > 365 days) revert PeriodTooLong();
        submissionGracePeriod = period;
    }

    /// @notice Set the dispute grace period for expireDisputed.
    /// @dev Bounded to max 365 days. Emits change event for indexer tracking.
    function setDisputeGracePeriod(uint256 period) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (period > 365 days) revert PeriodTooLong();
        uint256 oldPeriod = disputeGracePeriod;
        disputeGracePeriod = period;
        emit DisputeGracePeriodChanged(oldPeriod, period);
    }

    /**
     * @notice Admin sweeps treasury fees that failed to transfer at payout time.
     * @param token Token address (address(0) for ETH)
     * @param recipient Address to send the swept fees to (cannot be address(0))
     *
     * @dev Pattern: zero out mapping before transfer (CEI) to prevent re-entry sweep.
     *      nonReentrant for defense-in-depth.
     *
     * Emits {DeferredFeesSwept}.
     */
    function sweepDeferredFees(address token, address recipient) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        uint256 amount = pendingTreasuryFees[token];
        if (amount == 0) revert ZeroAmount();
        pendingTreasuryFees[token] = 0; // Effects before interactions

        if (token == address(0)) {
            (bool success, ) = recipient.call{value: amount}("");
            if (!success) revert EthTransferFailed();
        } else {
            IERC20(token).safeTransfer(recipient, amount);
        }

        emit DeferredFeesSwept(token, recipient, amount);
    }

    /**
     * @notice Admin sweeps a deferred creator refund (creator-refund recovery path).
     * @param bountyId Bounty ID whose creator-half could not be transferred during expireDisputed
     * @param recipient Address to send the swept refund to (cannot be address(0); typically the
     *                  bounty creator's working address, but admin may redirect on case-by-case basis)
     *
     * @dev Pattern: zero out per-bounty mapping AND per-token aggregate before transfer (CEI).
     *      The token type is recovered from the bounty's stored escrow type/token.
     *      nonReentrant for defense-in-depth.
     *
     * Emits {CreatorRefundSwept}.
     */
    function sweepCreatorRefund(uint256 bountyId, address recipient) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        uint256 amount = pendingCreatorRefunds[bountyId];
        if (amount == 0) revert RefundAlreadySwept();

        Bounty storage bounty = _bounties[bountyId];
        EscrowType escrow = bounty.escrowType;
        address escrowToken = bounty.escrowToken;

        // Effects: clear per-bounty + per-token aggregate before transfer
        pendingCreatorRefunds[bountyId] = 0;
        if (escrow == EscrowType.ETH) {
            pendingCreatorRefundTotals[address(0)] -= amount;
        } else if (escrow == EscrowType.Token) {
            IERC20 tokenForAggregate = escrowToken != address(0) ? IERC20(escrowToken) : paymentToken;
            pendingCreatorRefundTotals[address(tokenForAggregate)] -= amount;
        }

        // Interactions
        if (escrow == EscrowType.ETH) {
            (bool success, ) = recipient.call{value: amount}("");
            if (!success) revert EthTransferFailed();
        } else if (escrow == EscrowType.Token) {
            IERC20 token = escrowToken != address(0) ? IERC20(escrowToken) : paymentToken;
            token.safeTransfer(recipient, amount);
        }

        emit CreatorRefundSwept(bountyId, recipient, amount);
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
        address sender = _msgSender();
        if (!hasRole(DEFAULT_ADMIN_ROLE, sender) && !hasRole(GUARDIAN_ROLE, sender)) {
            revert AccessControlUnauthorizedAccount(sender, GUARDIAN_ROLE);
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

    /// @notice Withdraw stuck ERC-20 tokens. excess-only for escrowed tokens.
    /// @dev pendingTreasuryFees is also reserved (sitting in contract balance, owed to treasury via sweep).
    ///      pendingCreatorRefundTotals is also reserved (owed to creators via sweepCreatorRefund).
    ///      pendingWorkerPayoutTotals is also reserved (owed to workers via sweepWorkerPayout).
    function emergencyWithdraw(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 balance = IERC20(token).balanceOf(address(this));
        // reserve = active escrow + deferred treasury fees + deferred creator refunds + deferred worker payouts
        uint256 reserved = totalEscrowed[token]
            + pendingTreasuryFees[token]
            + pendingCreatorRefundTotals[token]
            + pendingWorkerPayoutTotals[token];
        uint256 excess = balance > reserved ? balance - reserved : 0;
        if (amount > excess) revert InsufficientExcess();
        IERC20(token).safeTransfer(to, amount);
        emit EmergencyWithdraw(token, to, amount);
    }

    /// @notice Rescue stuck ETH. excess-only for escrowed ETH.
    /// @dev pendingTreasuryFees[address(0)] is also reserved.
    ///      pendingCreatorRefundTotals[address(0)] is also reserved.
    ///      pendingWorkerPayoutTotals[address(0)] is also reserved (Open mode is token-only,
    ///           so this is always 0 for ETH today — defense-in-depth for any future ETH support).
    function rescueETH(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 ethBalance = address(this).balance;
        // reserve = active escrow + deferred treasury fees + deferred creator refunds + deferred worker payouts
        uint256 reserved = totalEscrowed[address(0)]
            + pendingTreasuryFees[address(0)]
            + pendingCreatorRefundTotals[address(0)]
            + pendingWorkerPayoutTotals[address(0)];
        uint256 excess = ethBalance > reserved ? ethBalance - reserved : 0;
        if (amount > excess) revert InsufficientExcess();
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

    // ============================================================
    //                    VERDICT HELPERS
    // ============================================================

    /**
     * @dev Returns the verdict-implied default composite when a caller omits the rubric.
     *      85 / 65 / 25 / 10 across Approval / Correction / Rejection / FailureReport.
     *      These constants are a cross-contract invariant for off-chain scoring.
     */
    function _defaultComposite(uint8 verdict) internal pure returns (uint8) {
        if (verdict == uint8(VerdictType.Approval)) return 85;
        if (verdict == uint8(VerdictType.Correction)) return 65;
        if (verdict == uint8(VerdictType.Rejection)) return 25;
        if (verdict == uint8(VerdictType.FailureReport)) return 10;
        return 0; // unreachable when caller validated verdict first
    }

    /**
     * @dev Validates that the verdict + composite are appropriate for an approve-path call
     *      (approveWork or admin resolveDispute with releaseToWorker == true).
     *      Guard: approval requires composite >= 30 so a paying verdict cannot be paired
     *      with a failing quality score.
     */
    function _validateApproveVerdictAndComposite(uint8 verdict, uint8 composite) internal pure {
        if (verdict != uint8(VerdictType.Approval) && verdict != uint8(VerdictType.Correction)) {
            revert InvalidVerdict();
        }
        if (composite > 100) revert InvalidComposite(verdict, composite);
        if (verdict == uint8(VerdictType.Approval) && composite < 30) {
            revert InvalidComposite(verdict, composite);
        }
    }

    /**
     * @dev Validates that the verdict + composite are appropriate for a dispute-path call
     *      (disputeWork or admin resolveDispute with releaseToWorker == false).
     *      Rejection requires composite <= 70 (symmetric clamp).
     */
    function _validateDisputeVerdictAndComposite(uint8 verdict, uint8 composite) internal pure {
        if (verdict != uint8(VerdictType.Rejection) && verdict != uint8(VerdictType.FailureReport)) {
            revert InvalidVerdict();
        }
        if (composite > 100) revert InvalidComposite(verdict, composite);
        if (verdict == uint8(VerdictType.Rejection) && composite > 70) {
            revert InvalidComposite(verdict, composite);
        }
    }

    /**
     * @dev caps rubric CID length at 64 bytes (covers Qm... CIDv0 and bafy... CIDv1).
     *      Empty string is permitted (caller skipped the rubric entirely).
     */
    function _validateRubricCid(string memory rubricCid) internal pure {
        uint256 len = bytes(rubricCid).length;
        if (len > 64) revert RubricCidTooLong(len);
    }

    /**
     * @dev Emits the canonical typed-feedback event. Single emission point so off-chain
     *      consumers see a consistent shape regardless of which call site (approveWork / disputeWork /
     *      resolveDispute) recorded the verdict. The `emitter` field disambiguates creator
     *      vs admin authorship for the off-chain verdict index.
     */
    function _emitVerdict(
        uint256 entityId,
        address creator,
        address worker,
        uint8 verdict,
        uint8 composite,
        string memory rubricCid
    ) internal {
        emit VerdictRecorded(entityId, creator, worker, _msgSender(), verdict, composite, rubricCid);
    }

    /**
     * @dev Release escrow to the worker (minus platform fee to treasury).
     *      Follows checks-effects-interactions — caller must update state BEFORE calling.
     * @param bountyId included for TreasuryFeeDeferred event correlation.
     * @param tokenAddr Per-bounty token address. If address(0), falls back to global paymentToken
     *                  (backward compat for in-flight bounties at upgrade time).
     * @param feeBps Fee in basis points to apply (V3: passed from bounty's locked fee)
     *
     * @dev changes:
     *      1. Worker is paid BEFORE the treasury fee (was: fee first, then worker).
     *      2. Treasury fee transfer is wrapped — if treasury rejects, the fee accumulates
     *         to pendingTreasuryFees[token] for admin sweep instead of reverting the worker
     *         payout. ERC-20 path uses raw IERC20.transfer inside try/catch (SafeERC20.safeTransfer
     *         reverts internally and cannot be caught).
     */
    function _releaseEscrow(
        uint256 bountyId,
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
            totalEscrowed[address(0)] -= amount;
            // pay worker first
            (bool paySuccess, ) = recipient.call{value: payout}("");
            if (!paySuccess) revert EthTransferFailed();
            if (fee > 0) {
                // deferred-fallback on treasury rejection (don't revert worker payout)
                (bool feeSuccess, ) = treasury.call{value: fee}("");
                if (!feeSuccess) {
                    pendingTreasuryFees[address(0)] += fee;
                    emit TreasuryFeeDeferred(bountyId, address(0), fee);
                }
            }
        } else if (escrow == EscrowType.Token) {
            IERC20 token = tokenAddr != address(0) ? IERC20(tokenAddr) : paymentToken;
            totalEscrowed[address(token)] -= amount;
            // worker payout MUST succeed — keep safeTransfer (reverts on failure)
            token.safeTransfer(recipient, payout);
            if (fee > 0) {
                // raw transfer in try/catch so we can fall back without reverting
                try token.transfer(treasury, fee) returns (bool ok) {
                    if (!ok) {
                        pendingTreasuryFees[address(token)] += fee;
                        emit TreasuryFeeDeferred(bountyId, address(token), fee);
                    }
                } catch {
                    pendingTreasuryFees[address(token)] += fee;
                    emit TreasuryFeeDeferred(bountyId, address(token), fee);
                }
            }
        }
    }

    /**
     * @dev Two-recipient escrow release for dispute-expired bounties.
     *      Splits the original reward between creator (refund half, no fee) and worker
     *      (payout half net of fee). Total transferred = creatorAmount + workerAmount + feeAmount
     *      = bounty.rewardAmount (invariant verified by callers via the split formula).
     *
     *      Dust-wei semantics: callers compute `creatorAmount = rewardAmount / 2` (floor) and
     *      `workerHalf = rewardAmount - creatorAmount` (ceil — worker side carries the +1 wei
     *      on odd amounts as documented compensation for paying the platform fee).
     *
     *      Treasury fee uses raw IERC20.transfer in try/catch (NOT SafeERC20 — that reverts
     *      internally and try/catch can't catch it). On failure or `transfer` returning false,
     *      the fee accumulates to `pendingTreasuryFees[token]` for admin sweep.
     *
     *      the creator's transfer is soft-fail so that an unreceivable creator address
     *      (e.g., a token that blocks the recipient) cannot revert the whole `expireDisputed`
     *      and block the worker's half. the contract wraps creator transfers in try/catch (ETH
     *      via low-level .call returning success bool with no revert; ERC-20 via raw transfer
     *      in try/catch matching the treasury-fee pattern). On failure: creator's half
     *      accumulates to `pendingCreatorRefunds[bountyId]` (sweepable via sweepCreatorRefund)
     *      and `pendingCreatorRefundTotals[token]` (reserved against accidental withdrawal via
     *      emergencyWithdraw). Worker payout proceeds normally and is never blocked by an
     *      unreceivable creator address.
     */
    function _releaseEscrowSplit(
        uint256 bountyId,
        address creatorRecipient,
        address workerRecipient,
        uint256 creatorAmount,
        uint256 workerAmount,
        uint256 feeAmount,
        EscrowType escrow,
        address tokenAddr
    ) internal {
        if (escrow == EscrowType.None) return;
        uint256 totalAmount = creatorAmount + workerAmount + feeAmount;
        if (totalAmount == 0) return;

        if (escrow == EscrowType.ETH) {
            totalEscrowed[address(0)] -= totalAmount;
            if (creatorAmount > 0) {
                // creator-side soft-fail via low-level .call (no revert).
                (bool creatorSuccess, ) = creatorRecipient.call{value: creatorAmount}("");
                if (!creatorSuccess) {
                    pendingCreatorRefunds[bountyId] += creatorAmount;
                    pendingCreatorRefundTotals[address(0)] += creatorAmount;
                    emit CreatorRefundDeferred(bountyId, creatorRecipient, creatorAmount);
                }
            }
            if (workerAmount > 0) {
                (bool workerSuccess, ) = workerRecipient.call{value: workerAmount}("");
                if (!workerSuccess) revert EthTransferFailed();
            }
            if (feeAmount > 0) {
                (bool feeSuccess, ) = treasury.call{value: feeAmount}("");
                if (!feeSuccess) {
                    pendingTreasuryFees[address(0)] += feeAmount;
                    emit TreasuryFeeDeferred(bountyId, address(0), feeAmount);
                }
            }
        } else if (escrow == EscrowType.Token) {
            IERC20 token = tokenAddr != address(0) ? IERC20(tokenAddr) : paymentToken;
            totalEscrowed[address(token)] -= totalAmount;
            if (creatorAmount > 0) {
                // creator-side soft-fail via raw transfer in try/catch (matches
                // treasury-fee pattern). SafeERC20.safeTransfer can't be used here because
                // it reverts internally and try/catch cannot intercept.
                try token.transfer(creatorRecipient, creatorAmount) returns (bool ok) {
                    if (!ok) {
                        pendingCreatorRefunds[bountyId] += creatorAmount;
                        pendingCreatorRefundTotals[address(token)] += creatorAmount;
                        emit CreatorRefundDeferred(bountyId, creatorRecipient, creatorAmount);
                    }
                } catch {
                    pendingCreatorRefunds[bountyId] += creatorAmount;
                    pendingCreatorRefundTotals[address(token)] += creatorAmount;
                    emit CreatorRefundDeferred(bountyId, creatorRecipient, creatorAmount);
                }
            }
            if (workerAmount > 0) {
                token.safeTransfer(workerRecipient, workerAmount);
            }
            if (feeAmount > 0) {
                try token.transfer(treasury, feeAmount) returns (bool ok) {
                    if (!ok) {
                        pendingTreasuryFees[address(token)] += feeAmount;
                        emit TreasuryFeeDeferred(bountyId, address(token), feeAmount);
                    }
                } catch {
                    pendingTreasuryFees[address(token)] += feeAmount;
                    emit TreasuryFeeDeferred(bountyId, address(token), feeAmount);
                }
            }
        }
    }

    /**
     * @dev helper: returns true if the bounty requires creator approval before claim.
     *      Encapsulates the V5 active+threshold check used by claimBounty (and any future
     *      call sites that need to query approval semantics).
     */
    function _requiresApprovalToClaim(uint256 bountyId) internal view returns (bool) {
        return v5Active && bountyId >= approvedClaimerSinceId;
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
            totalEscrowed[address(0)] -= amount;
            (bool success, ) = recipient.call{value: amount}("");
            if (!success) revert EthTransferFailed();
        } else if (escrow == EscrowType.Token) {
            // V2: use per-bounty token; fallback to global paymentToken for pre-upgrade bounties
            IERC20 token = tokenAddr != address(0) ? IERC20(tokenAddr) : paymentToken;
            totalEscrowed[address(token)] -= amount;
            token.safeTransfer(recipient, amount);
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
    //                  OWNERSHIP RENOUNCE GUARD
    // ============================================================

    /// @notice Prevent accidental ownership renouncement — would permanently brick admin functions.
    function renounceOwnership() public pure override {
        revert("Cannot renounce ownership");
    }

    // ============================================================
    //                     UUPS UPGRADE AUTH
    // ============================================================

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
