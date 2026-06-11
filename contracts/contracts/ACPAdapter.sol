// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/metatx/ERC2771ContextUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IACP.sol";
import "./interfaces/IACPHook.sol";

/**
 * @title ACPAdapter
 * @author Nookplot
 * @notice ERC-8183 (Agentic Commerce Protocol) adapter for the Nookplot ecosystem.
 *         Implements the IACP interface with its own lightweight escrow, wired into
 *         the Nookplot infrastructure (AgentRegistry, NookplotForwarder, token allowlist).
 *
 * @dev This contract lives alongside BountyContract — it does NOT delegate to it.
 *      External platforms that speak IACP interact with this contract; internal tools
 *      continue using BountyContract. When ERC-8183 evolves, redeploy this adapter
 *      without touching the core bounty system.
 *
 *      Key design choices:
 *        - Single ERC-20 token per contract (set at initialization, per ERC-8183 spec)
 *        - Evaluator is immutable per-job (set at creation, can be a smart contract)
 *        - Hook system (IACPHook) for extensibility (reputation gating, KYC, etc.)
 *        - claimRefund is NOT hookable (safety: prevents malicious hook blocking refunds)
 *        - Platform fee deducted only on completion, never on refund/rejection
 *        - ERC-2771 gasless transactions via NookplotForwarder
 *        - AgentRegistry integration (fail-open on unreachable registry)
 *        - UUPS upgradeable (same pattern as all Nookplot contracts)
 */
contract ACPAdapter is
    IACP,
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    ERC2771ContextUpgradeable
{
    using SafeERC20 for IERC20;

    // ============================================================
    //                        CUSTOM ERRORS
    // ============================================================

    error ZeroAddress();
    error NotRegisteredAgent();
    error JobNotFound();
    error InvalidStatus();
    error NotClient();
    error NotProvider();
    error NotEvaluator();
    error NotClientOrEvaluator();
    error CannotSelfProvide();
    error DeadlineNotInFuture();
    error DeadlineTooFar();
    error NotExpired();
    error BudgetMismatch();
    error FeeTooHigh();
    error EmptyDeliverable();

    // ============================================================
    //                          ROLES
    // ============================================================

    /// @notice Guardian role — can pause but NOT unpause
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    // ============================================================
    //                       STATE VARIABLES
    // ============================================================

    /// @notice Maps job ID => job data
    mapping(uint256 => Job) private _jobs;

    /// @notice Maps job ID => deliverable CID (not in Job struct to match IACP interface)
    mapping(uint256 => string) private _deliverables;

    /// @notice Next job ID to assign
    uint256 public nextJobId;

    /// @notice Reference to the AgentRegistry contract
    address public agentRegistry;

    /// @notice ERC-20 token used for escrow (single token per contract, per ERC-8183 spec)
    IERC20 public paymentToken;

    /// @notice Platform fee in basis points (e.g., 250 = 2.5%). Max 1000 (10%).
    uint256 public platformFeeBps;

    /// @notice Treasury address where platform fees are sent
    address public treasury;

    /// @notice Maximum platform fee (10%)
    uint256 public constant MAX_FEE_BPS = 1000;

    /// @notice Maximum deadline offset (30 days)
    uint256 public constant MAX_DEADLINE_OFFSET = 30 days;

    /// @dev Storage gap for future upgrades
    uint256[40] private __gap;

    // ============================================================
    //                        INITIALIZER
    // ============================================================

    /// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
    constructor(address trustedForwarder_) ERC2771ContextUpgradeable(trustedForwarder_) {
        _disableInitializers();
    }

    /**
     * @notice Initialize the ACP adapter.
     * @param admin_ Admin address (DEFAULT_ADMIN_ROLE)
     * @param agentRegistry_ Address of the AgentRegistry contract
     * @param treasury_ Address where platform fees are sent
     * @param paymentToken_ ERC-20 token for escrow (address(0) = no token escrow)
     */
    function initialize(
        address admin_,
        address agentRegistry_,
        address treasury_,
        address paymentToken_
    ) external initializer {
        if (admin_ == address(0)) revert ZeroAddress();
        if (agentRegistry_ == address(0)) revert ZeroAddress();
        if (treasury_ == address(0)) revert ZeroAddress();

        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);

        agentRegistry = agentRegistry_;
        treasury = treasury_;
        if (paymentToken_ != address(0)) {
            paymentToken = IERC20(paymentToken_);
        }
    }

    // ============================================================
    //                     JOB LIFECYCLE
    // ============================================================

    /// @inheritdoc IACP
    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external override whenNotPaused returns (uint256 jobId) {
        if (evaluator == address(0)) revert ZeroAddress();
        if (expiredAt <= block.timestamp) revert DeadlineNotInFuture();
        if (expiredAt > block.timestamp + MAX_DEADLINE_OFFSET) revert DeadlineTooFar();

        address sender = _msgSender();
        _requireActiveAgent(sender);
        if (provider == sender) revert CannotSelfProvide();

        jobId = nextJobId++;

        Job storage job = _jobs[jobId];
        job.client = sender;
        job.provider = provider;
        job.evaluator = evaluator;
        job.hook = hook;
        job.description = description;
        job.expiredAt = expiredAt;
        job.status = JobStatus.Open;

        emit JobCreated(jobId, sender, evaluator, expiredAt, description, hook);
    }

    /// @inheritdoc IACP
    function setProvider(uint256 jobId, address provider) external override whenNotPaused {
        Job storage job = _getJob(jobId);
        if (job.status != JobStatus.Open) revert InvalidStatus();

        address sender = _msgSender();
        if (sender != job.client) revert NotClient();
        if (provider == sender) revert CannotSelfProvide();

        _callBeforeHook(job, jobId, IACP.setProvider.selector, abi.encode(provider));

        job.provider = provider;

        emit ProviderSet(jobId, provider);

        _callAfterHook(job, jobId, IACP.setProvider.selector, abi.encode(provider));
    }

    /// @inheritdoc IACP
    function setBudget(uint256 jobId, uint256 amount) external override whenNotPaused {
        Job storage job = _getJob(jobId);
        if (job.status != JobStatus.Open) revert InvalidStatus();

        address sender = _msgSender();
        if (sender != job.client && sender != job.provider) revert NotClientOrEvaluator();

        _callBeforeHook(job, jobId, IACP.setBudget.selector, abi.encode(amount));

        job.budget = amount;

        emit BudgetSet(jobId, amount);

        _callAfterHook(job, jobId, IACP.setBudget.selector, abi.encode(amount));
    }

    /// @inheritdoc IACP
    function fund(uint256 jobId, uint256 expectedBudget) external override whenNotPaused nonReentrant {
        Job storage job = _getJob(jobId);
        if (job.status != JobStatus.Open) revert InvalidStatus();

        address sender = _msgSender();
        if (sender != job.client) revert NotClient();
        if (job.budget != expectedBudget) revert BudgetMismatch();

        _callBeforeHook(job, jobId, IACP.fund.selector, abi.encode(expectedBudget));

        // Transfer tokens from client to this contract
        if (job.budget > 0 && address(paymentToken) != address(0)) {
            paymentToken.safeTransferFrom(sender, address(this), job.budget);
        }

        job.status = JobStatus.Funded;

        emit JobFunded(jobId, sender, job.budget);

        _callAfterHook(job, jobId, IACP.fund.selector, abi.encode(expectedBudget));
    }

    /// @inheritdoc IACP
    function submit(uint256 jobId, string calldata deliverable) external override whenNotPaused {
        if (bytes(deliverable).length == 0) revert EmptyDeliverable();

        Job storage job = _getJob(jobId);
        if (job.status != JobStatus.Funded) revert InvalidStatus();

        address sender = _msgSender();
        if (sender != job.provider) revert NotProvider();
        _requireActiveAgent(sender);

        _callBeforeHook(job, jobId, IACP.submit.selector, abi.encode(deliverable));

        job.status = JobStatus.Submitted;
        _deliverables[jobId] = deliverable;

        emit JobSubmitted(jobId, sender, deliverable);

        _callAfterHook(job, jobId, IACP.submit.selector, abi.encode(deliverable));
    }

    /// @inheritdoc IACP
    function complete(uint256 jobId, bytes32 reason) external override whenNotPaused nonReentrant {
        Job storage job = _getJob(jobId);
        if (job.status != JobStatus.Submitted) revert InvalidStatus();

        address sender = _msgSender();
        if (sender != job.evaluator) revert NotEvaluator();

        _callBeforeHook(job, jobId, IACP.complete.selector, abi.encode(reason));

        job.status = JobStatus.Completed;

        // Release escrow to provider (minus platform fee)
        if (job.budget > 0 && address(paymentToken) != address(0)) {
            uint256 fee = (job.budget * platformFeeBps) / 10000;
            uint256 payout = job.budget - fee;

            if (fee > 0) {
                paymentToken.safeTransfer(treasury, fee);
            }
            paymentToken.safeTransfer(job.provider, payout);

            emit PaymentReleased(jobId, job.provider, payout);
        }

        emit JobCompleted(jobId, sender, reason);

        _callAfterHook(job, jobId, IACP.complete.selector, abi.encode(reason));
    }

    /// @inheritdoc IACP
    function reject(uint256 jobId, bytes32 reason) external override whenNotPaused nonReentrant {
        Job storage job = _getJob(jobId);

        address sender = _msgSender();
        bool hadEscrow = false;

        if (job.status == JobStatus.Open) {
            // Client can reject their own Open job (no escrow held)
            if (sender != job.client) revert NotClient();
        } else if (job.status == JobStatus.Funded || job.status == JobStatus.Submitted) {
            // Evaluator can reject Funded or Submitted jobs (escrow held)
            if (sender != job.evaluator) revert NotEvaluator();
            hadEscrow = true;
        } else {
            revert InvalidStatus();
        }

        _callBeforeHook(job, jobId, IACP.reject.selector, abi.encode(reason));

        job.status = JobStatus.Rejected;

        // Refund client if escrow was held (no fee on rejection)
        if (hadEscrow && job.budget > 0 && address(paymentToken) != address(0)) {
            paymentToken.safeTransfer(job.client, job.budget);
            emit Refunded(jobId, job.client, job.budget);
        }

        emit JobRejected(jobId, sender, reason);

        _callAfterHook(job, jobId, IACP.reject.selector, abi.encode(reason));
    }

    /// @inheritdoc IACP
    /// @dev NOT hookable — malicious hooks must never block refunds
    function claimRefund(uint256 jobId) external override nonReentrant {
        Job storage job = _getJob(jobId);
        if (job.status != JobStatus.Funded && job.status != JobStatus.Submitted) revert InvalidStatus();
        if (block.timestamp < job.expiredAt) revert NotExpired();

        job.status = JobStatus.Expired;

        uint256 refundAmount = job.budget;
        if (refundAmount > 0 && address(paymentToken) != address(0)) {
            paymentToken.safeTransfer(job.client, refundAmount);
        }

        emit Refunded(jobId, job.client, refundAmount);
        emit JobExpired(jobId, _msgSender(), refundAmount);
    }

    // ============================================================
    //                       VIEW METHODS
    // ============================================================

    /// @inheritdoc IACP
    function getJob(uint256 jobId) external view override returns (Job memory) {
        return _jobs[jobId];
    }

    /// @notice Get the deliverable CID for a submitted/completed job.
    function getDeliverable(uint256 jobId) external view returns (string memory) {
        return _deliverables[jobId];
    }

    /// @notice Total number of jobs created.
    function totalJobs() external view returns (uint256) {
        return nextJobId;
    }

    // ============================================================
    //                     ADMIN FUNCTIONS
    // ============================================================

    /// @notice Update the platform fee (admin only).
    function setPlatformFeeBps(uint256 newFeeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        uint256 oldFeeBps = platformFeeBps;
        platformFeeBps = newFeeBps;
        emit PlatformFeeUpdated(oldFeeBps, newFeeBps);
    }

    /// @notice Update the treasury address (admin only).
    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        address oldTreasury = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(oldTreasury, newTreasury);
    }

    /// @notice Pause the contract (admin or guardian).
    function pause() external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, _msgSender()) && !hasRole(GUARDIAN_ROLE, _msgSender())) {
            revert("ACPAdapter: not admin or guardian");
        }
        _pause();
    }

    /// @notice Unpause the contract (admin only — guardian cannot unpause).
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ============================================================
    //                    ADMIN EVENTS (reused)
    // ============================================================

    event PlatformFeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    // ============================================================
    //                     INTERNAL HELPERS
    // ============================================================

    /**
     * @dev Get a job by ID, revert if it doesn't exist.
     *      A job exists if its client is non-zero (set on creation).
     */
    function _getJob(uint256 jobId) internal view returns (Job storage) {
        Job storage job = _jobs[jobId];
        if (job.client == address(0)) revert JobNotFound();
        return job;
    }

    /**
     * @dev Check that an address is a registered, active agent.
     *      Fail-open if AgentRegistry is unreachable — prevents cascading
     *      failure where AgentRegistry downtime bricks the ACP system.
     */
    function _requireActiveAgent(address agent) internal view {
        (bool success, bytes memory data) = agentRegistry.staticcall(
            abi.encodeWithSignature("isActiveAgent(address)", agent)
        );

        // If AgentRegistry is unreachable, allow the operation.
        if (success && data.length >= 32) {
            bool isActive = abi.decode(data, (bool));
            if (!isActive) revert NotRegisteredAgent();
        }
    }

    /**
     * @dev Call the beforeAction hook if one is configured.
     *      Hook can revert to block the action.
     */
    function _callBeforeHook(
        Job storage job,
        uint256 jobId,
        bytes4 selector,
        bytes memory data
    ) internal {
        if (job.hook != address(0)) {
            IACPHook(job.hook).beforeAction(jobId, selector, data);
        }
    }

    /**
     * @dev Call the afterAction hook if one is configured.
     *      Hook should not revert (state already committed), but we don't
     *      swallow reverts — a broken hook should be visible, not silent.
     */
    function _callAfterHook(
        Job storage job,
        uint256 jobId,
        bytes4 selector,
        bytes memory data
    ) internal {
        if (job.hook != address(0)) {
            IACPHook(job.hook).afterAction(jobId, selector, data);
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

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
