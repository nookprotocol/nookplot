// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title BountyTypes
 * @notice Shared type definitions for BountyContract.sol and BountyOpenLib.sol.
 *
 * @dev Extracted from BountyContract.sol so that BountyOpenLib (the Open-mode
 *      multi-payout Open-mode library) can reference the same Bounty struct
 *      and enums without circular imports.
 *
 *      Abstract contract with NO state variables — inheriting from it does
 *      NOT change BountyContract's storage layout. OpenZeppelin upgrades
 *      storage-layout validator checks state variables, not type definitions,
 *      so the Open-mode upgrade remains storage-safe.
 */
abstract contract BountyTypes {
    /// @notice Status of a bounty through its lifecycle.
    enum BountyStatus {
        Open,           // 0 — Created, waiting for claimer
        Claimed,        // 1 — An agent has claimed it
        Submitted,      // 2 — Work has been submitted
        Approved,       // 3 — Creator approved the work
        Disputed,       // 4 — Creator disputed the submission
        Cancelled,      // 5 — Creator cancelled (or dispute resolved against worker)
        Expired,        // 6 — Past deadline without completion
        DisputeExpired  // 7 — emergency 50/50 split after dispute grace period
    }

    /// @notice Type of escrow held for a bounty.
    enum EscrowType {
        None,   // 0 — Reputation-only bounty (no financial reward)
        ETH,    // 1 — ETH held in contract
        Token   // 2 — ERC-20 token held in contract
    }

    /// @notice Typed-feedback verdict attached to approve/dispute/resolve calls.
    enum VerdictType {
        Approval,       // 0 — Work meets expectations; default state, full payout
        Correction,     // 1 — Work meets expectations with notes; full payout
        Rejection,      // 2 — Work does NOT meet expectations; escrow locked
        FailureReport   // 3 — Work attempted but objectively failed; escrow locked
    }

    /// @notice On-chain record of a bounty. Layout is FROZEN across versions.
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
        address escrowToken; // V2: per-bounty token address
        uint256 creationFeeBps; // V3: fee locked at creation
        uint256 disputedAt; // precise dispute clock
    }

    /// @notice One submission in an Open-mode bounty's queue.
    struct OpenSubmission {
        address submitter;
        string submissionCid;
        uint64 submittedAt;
        bool isWinner;
    }
}
