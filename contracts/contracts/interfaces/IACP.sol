// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IACP — Agentic Commerce Protocol (ERC-8183)
 * @notice Standard interface for agent-to-agent job escrow.
 *
 * @dev State machine: Open → Funded → Submitted → Completed | Rejected | Expired
 *
 *      Three roles per job:
 *        - Client:    creates, funds, can reject when Open
 *        - Provider:  submits deliverables, receives payment
 *        - Evaluator: immutable per-job, attests completion or rejection
 *
 *      Based on the ERC-8183 Draft (2026-02-25). Interface may evolve as the
 *      standard progresses through review.
 */
interface IACP {
    // ============================================================
    //                          ENUMS
    // ============================================================

    enum JobStatus {
        Open,       // 0 — Created, not yet funded
        Funded,     // 1 — Client deposited escrow
        Submitted,  // 2 — Provider submitted deliverables
        Completed,  // 3 — Evaluator approved (escrow released to provider)
        Rejected,   // 4 — Evaluator or client rejected
        Expired     // 5 — Past deadline, refund claimable
    }

    // ============================================================
    //                          STRUCTS
    // ============================================================

    struct Job {
        address client;
        address provider;
        address evaluator;
        address hook;
        string description;     // IPFS CID or on-chain description
        uint256 budget;
        uint256 expiredAt;
        JobStatus status;
    }

    // ============================================================
    //                          EVENTS
    // ============================================================

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address evaluator,
        uint256 expiredAt,
        string description,
        address hook
    );

    event ProviderSet(uint256 indexed jobId, address indexed provider);

    event BudgetSet(uint256 indexed jobId, uint256 amount);

    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);

    event JobSubmitted(uint256 indexed jobId, address indexed provider, string deliverable);

    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);

    event JobRejected(uint256 indexed jobId, address indexed caller, bytes32 reason);

    event JobExpired(uint256 indexed jobId, address indexed caller, uint256 refundAmount);

    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);

    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);

    // ============================================================
    //                       CORE METHODS
    // ============================================================

    /**
     * @notice Create a new job.
     * @param provider  Initial provider (address(0) = unassigned, set later via setProvider)
     * @param evaluator Immutable evaluator address (can be a smart contract)
     * @param expiredAt Unix timestamp after which the job can be expired
     * @param description IPFS CID or description string
     * @param hook Address of an IACPHook contract (address(0) = no hooks)
     * @return jobId The ID of the newly created job
     */
    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external returns (uint256 jobId);

    /**
     * @notice Assign or change the provider (client only, Open status only).
     * @param jobId Job to update
     * @param provider New provider address
     */
    function setProvider(uint256 jobId, address provider) external;

    /**
     * @notice Set or update the budget (client or provider, Open status only).
     * @param jobId Job to update
     * @param amount New budget amount in token units
     */
    function setBudget(uint256 jobId, uint256 amount) external;

    /**
     * @notice Fund the job escrow (client only, Open → Funded).
     * @param jobId Job to fund
     * @param expectedBudget Must match current budget (front-run protection)
     */
    function fund(uint256 jobId, uint256 expectedBudget) external;

    /**
     * @notice Submit deliverables (provider only, Funded → Submitted).
     * @param jobId Job to submit work for
     * @param deliverable IPFS CID of the deliverable
     */
    function submit(uint256 jobId, string calldata deliverable) external;

    /**
     * @notice Approve completion (evaluator only, Submitted → Completed).
     * @param jobId Job to complete
     * @param reason Attestation reason (bytes32 for audit trail)
     */
    function complete(uint256 jobId, bytes32 reason) external;

    /**
     * @notice Reject a job.
     *         - Client can reject when Open
     *         - Evaluator can reject when Funded or Submitted
     * @param jobId Job to reject
     * @param reason Rejection reason
     */
    function reject(uint256 jobId, bytes32 reason) external;

    /**
     * @notice Claim refund after expiry (anyone, Funded/Submitted → Expired).
     * @param jobId Job to expire and refund
     */
    function claimRefund(uint256 jobId) external;

    // ============================================================
    //                        VIEW METHODS
    // ============================================================

    /**
     * @notice Get full job details.
     * @param jobId Job ID
     * @return job The Job struct
     */
    function getJob(uint256 jobId) external view returns (Job memory job);
}
