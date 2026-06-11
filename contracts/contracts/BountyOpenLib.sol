// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./BountyTypes.sol";

/**
 * @title BountyOpenLib
 * @notice Multi-payout Open bounties — heavy function bodies extracted
 *         from BountyContract.sol to fit under the EIP-170 24,576-byte limit.
 *
 * @dev External library — functions are deployed at the library's own address
 *      and invoked via delegatecall. delegatecall preserves storage, msg.sender,
 *      and event emission context, so library logic operates on the calling
 *      contract's storage and events appear at the calling contract's address.
 *
 *      Because libraries cannot have their own state, all storage references
 *      used by library functions are passed in as parameters. We pass mappings
 *      directly (not via a wrapper struct) to avoid changing the BountyContract
 *      storage layout — wrapper structs of mappings would put fields at offsets
 *      relative to the struct slot, breaking the Open-mode upgrade.
 *
 *      Modifiers (whenNotPaused, nonReentrant) and meta-tx sender unwrapping
 *      (_msgSender) stay on the BountyContract wrapper functions.
 *
 *      All errors and events declared here mirror those declared in
 *      BountyContract.sol so existing off-chain indexers and ABIs keep working.
 */
library BountyOpenLib {
    using SafeERC20 for IERC20;

    // ============================================================
    //                        ERRORS
    // ============================================================

    error ZeroAddress();
    error InvalidStatus();
    error NotCreator();
    error NotExpired();
    error BountyNotFound();
    error CannotClaimOwnBounty();
    error WrongSubmissionMode();
    error AlreadySubmittedToBounty();
    error MaxOpenSubmissionsReached();
    error InvalidSlotCount();
    error SubmissionAlreadyApproved();
    error InsufficientPool();
    error GracePeriodNotElapsed();
    error GracePeriodElapsed();
    error NoDeferredPayout();
    error NotAuthorizedToSweep();

    // ============================================================
    //                        EVENTS
    // ============================================================

    event WorkSubmittedOpen(
        uint256 indexed bountyId,
        address indexed submitter,
        uint256 submissionId,
        string submissionCid
    );

    event OpenSubmissionApproved(
        uint256 indexed bountyId,
        uint256 submissionId,
        address indexed submitter,
        uint256 rewardPaid
    );

    event WorkerPayoutDeferred(
        uint256 indexed bountyId,
        uint256 submissionId,
        address indexed submitter,
        uint256 amount
    );

    event WorkerPayoutSwept(
        uint256 indexed bountyId,
        uint256 submissionId,
        address indexed recipient,
        uint256 amount
    );

    event BountyOpenToppedUp(
        uint256 indexed bountyId,
        uint256 addedSlots,
        uint256 newMaxApprovals
    );

    event BountyOpenClosed(
        uint256 indexed bountyId,
        uint256 refundedAmount,
        string reason
    );

    event CreatorRefundDeferred(uint256 indexed bountyId, address indexed recipient, uint256 amount);
    event TreasuryFeeDeferred(uint256 indexed bountyId, address indexed token, uint256 amount);

    event VerdictRecorded(
        uint256 indexed entityId,
        address indexed creator,
        address indexed worker,
        address emitter,
        uint8 verdict,
        uint8 composite,
        string rubricCid
    );

    // ============================================================
    //                        CONSTANTS
    // ============================================================

    uint256 internal constant MAX_OPEN_SUBMISSIONS = 100;
    uint256 internal constant MAX_OPEN_SLOTS = 50;
    uint256 internal constant OPEN_GRACE_PERIOD = 72 hours;

    // ============================================================
    //                  PARAMETER STRUCTS
    // ============================================================
    //
    // Open-mode approve has 8 value params (bountyId, submissionId, verdict, composite,
    // rubricCid, sender, treasury, effectiveFeeBps) plus 6 storage refs. Packing
    // the value params into a memory struct keeps the function signature readable
    // without changing storage layout (memory structs are passed by value).

    struct ApproveParams {
        uint256 bountyId;
        uint256 submissionId;
        uint8 verdict;
        uint8 composite;
        string rubricCid;
        address sender;
        address treasury;
        uint256 effectiveFeeBps;
    }
    // Storage refs are passed individually (not packed into a struct of pointers)
    // because Solidity doesn't allow memory structs with `storage` fields and a
    // storage struct would change BountyContract's storage layout.

    // ============================================================
    //                  EXTERNAL ENTRY POINTS
    // ============================================================

    /**
     * @dev Open-mode submit-work to an Open bounty.
     */
    function submitWorkOpen(
        mapping(uint256 => BountyTypes.Bounty) storage bounties,
        mapping(uint256 => uint8) storage submissionMode,
        mapping(uint256 => uint256) storage submissionCount,
        mapping(uint256 => BountyTypes.OpenSubmission[]) storage submissions,
        mapping(uint256 => mapping(address => bool)) storage hasSubmitted,
        uint256 bountyId,
        string calldata submissionCid,
        address sender
    ) external {
        BountyTypes.Bounty storage bounty = bounties[bountyId];
        if (bounty.creator == address(0)) revert BountyNotFound();
        if (submissionMode[bountyId] != 1) revert WrongSubmissionMode();
        if (bounty.status != BountyTypes.BountyStatus.Open) revert InvalidStatus();
        if (block.timestamp > bounty.deadline) revert NotExpired();
        if (sender == bounty.creator) revert CannotClaimOwnBounty();
        if (hasSubmitted[bountyId][sender]) revert AlreadySubmittedToBounty();
        if (submissionCount[bountyId] >= MAX_OPEN_SUBMISSIONS) revert MaxOpenSubmissionsReached();

        uint256 submissionId = submissions[bountyId].length;
        submissions[bountyId].push(BountyTypes.OpenSubmission({
            submitter: sender,
            submissionCid: submissionCid,
            submittedAt: uint64(block.timestamp),
            isWinner: false
        }));
        submissionCount[bountyId] += 1;
        hasSubmitted[bountyId][sender] = true;

        emit WorkSubmittedOpen(bountyId, sender, submissionId, submissionCid);
    }

    /**
     * @dev Open-mode approve-open-submission. Storage refs split across two helper
     *      groups; value params bundled in ApproveParams to dodge stack-too-deep.
     */
    function approveOpenSubmission(
        mapping(uint256 => BountyTypes.Bounty) storage bounties,
        mapping(uint256 => uint8) storage submissionMode,
        mapping(uint256 => uint256) storage perSubmissionReward,
        mapping(uint256 => uint256) storage maxApprovals,
        mapping(uint256 => uint256) storage approvalsUsed,
        mapping(uint256 => uint256) storage pool,
        mapping(uint256 => BountyTypes.OpenSubmission[]) storage submissions,
        mapping(uint256 => mapping(uint256 => uint256)) storage pendingWorkerPayouts,
        mapping(address => uint256) storage pendingWorkerPayoutTotals,
        mapping(address => uint256) storage pendingTreasuryFees,
        mapping(address => uint256) storage totalEscrowed,
        ApproveParams calldata p
    ) external {
        BountyTypes.Bounty storage bounty = bounties[p.bountyId];
        if (bounty.creator == address(0)) revert BountyNotFound();
        if (submissionMode[p.bountyId] != 1) revert WrongSubmissionMode();
        if (bounty.status != BountyTypes.BountyStatus.Open) revert InvalidStatus();
        if (block.timestamp > bounty.deadline + OPEN_GRACE_PERIOD) revert GracePeriodElapsed();
        if (p.sender != bounty.creator) revert NotCreator();
        if (p.submissionId >= submissions[p.bountyId].length) revert BountyNotFound();

        BountyTypes.OpenSubmission storage sub = submissions[p.bountyId][p.submissionId];
        if (sub.isWinner) revert SubmissionAlreadyApproved();

        uint256 perSubReward = perSubmissionReward[p.bountyId];
        if (pool[p.bountyId] < perSubReward) revert InsufficientPool();

        uint256 feeAmount = (perSubReward * p.effectiveFeeBps) / 10000;
        uint256 netPayout = perSubReward - feeAmount;

        // Effects (CEI)
        sub.isWinner = true;
        pool[p.bountyId] -= perSubReward;
        approvalsUsed[p.bountyId] += 1;
        IERC20 token = IERC20(bounty.escrowToken);
        totalEscrowed[address(token)] -= perSubReward;

        address submitter = sub.submitter;

        // Worker payout — soft-fail. Track outcome so OpenSubmissionApproved
        // can emit rewardPaid=0 when the payout was deferred (avoids misleading
        // indexers into recording a payment that hasn't actually landed).
        bool payoutSucceeded;
        try token.transfer(submitter, netPayout) returns (bool ok) {
            if (ok) {
                payoutSucceeded = true;
            } else {
                pendingWorkerPayouts[p.bountyId][p.submissionId] = netPayout;
                pendingWorkerPayoutTotals[address(token)] += netPayout;
                emit WorkerPayoutDeferred(p.bountyId, p.submissionId, submitter, netPayout);
            }
        } catch {
            pendingWorkerPayouts[p.bountyId][p.submissionId] = netPayout;
            pendingWorkerPayoutTotals[address(token)] += netPayout;
            emit WorkerPayoutDeferred(p.bountyId, p.submissionId, submitter, netPayout);
        }

        // Treasury fee — soft-fail pattern
        if (feeAmount > 0) {
            try token.transfer(p.treasury, feeAmount) returns (bool ok2) {
                if (!ok2) {
                    pendingTreasuryFees[address(token)] += feeAmount;
                    emit TreasuryFeeDeferred(p.bountyId, address(token), feeAmount);
                }
            } catch {
                pendingTreasuryFees[address(token)] += feeAmount;
                emit TreasuryFeeDeferred(p.bountyId, address(token), feeAmount);
            }
        }

        // Emit OpenSubmissionApproved BEFORE BountyOpenClosed so log-index order matches
        // logical order: an off-chain handler for OpenSubmissionApproved decrements
        // pool_remaining by per_submission_reward; if BountyOpenClosed (which zeroes
        // pool_remaining) ran first, the subsequent decrement would underflow.
        // rewardPaid reflects actual payout: netPayout on success, 0 on deferral.
        emit OpenSubmissionApproved(p.bountyId, p.submissionId, submitter, payoutSucceeded ? netPayout : 0);
        emit VerdictRecorded(p.bountyId, bounty.creator, submitter, p.sender, p.verdict, p.composite, p.rubricCid);

        // Auto-close when slots exhausted (emitted LAST so off-chain consumers settle
        // the approval first, then transition the bounty to closed).
        if (approvalsUsed[p.bountyId] == maxApprovals[p.bountyId]) {
            bounty.status = BountyTypes.BountyStatus.Approved;
            emit BountyOpenClosed(p.bountyId, 0, "slots_exhausted");
        }
    }

    /**
     * @dev Open-mode sweep deferred worker payout. Caller passes isAdmin (from
     *      contract's AccessControl) since the library can't read roles directly.
     */
    function sweepWorkerPayout(
        mapping(uint256 => BountyTypes.Bounty) storage bounties,
        mapping(uint256 => BountyTypes.OpenSubmission[]) storage submissions,
        mapping(uint256 => mapping(uint256 => uint256)) storage pendingWorkerPayouts,
        mapping(address => uint256) storage pendingWorkerPayoutTotals,
        uint256 bountyId,
        uint256 submissionId,
        address newRecipient,
        address sender,
        bool isAdmin
    ) external {
        if (newRecipient == address(0)) revert ZeroAddress();
        uint256 amount = pendingWorkerPayouts[bountyId][submissionId];
        if (amount == 0) revert NoDeferredPayout();

        BountyTypes.OpenSubmission storage sub = submissions[bountyId][submissionId];
        bool isOriginalSubmitter = sender == sub.submitter;
        if (!isOriginalSubmitter && !isAdmin) revert NotAuthorizedToSweep();

        BountyTypes.Bounty storage bounty = bounties[bountyId];
        IERC20 token = IERC20(bounty.escrowToken);

        pendingWorkerPayouts[bountyId][submissionId] = 0;
        pendingWorkerPayoutTotals[address(token)] -= amount;

        token.safeTransfer(newRecipient, amount);

        emit WorkerPayoutSwept(bountyId, submissionId, newRecipient, amount);
    }

    /**
     * @dev Open-mode top-up Open bounty with additional slots at the same price.
     */
    function topUpBountyOpen(
        mapping(uint256 => BountyTypes.Bounty) storage bounties,
        mapping(uint256 => uint8) storage submissionMode,
        mapping(uint256 => uint256) storage perSubmissionReward,
        mapping(uint256 => uint256) storage maxApprovals,
        mapping(uint256 => uint256) storage pool,
        mapping(address => uint256) storage totalEscrowed,
        uint256 bountyId,
        uint256 additionalSlots,
        address sender
    ) external {
        if (additionalSlots == 0) revert InvalidSlotCount();

        BountyTypes.Bounty storage bounty = bounties[bountyId];
        if (bounty.creator == address(0)) revert BountyNotFound();
        if (submissionMode[bountyId] != 1) revert WrongSubmissionMode();
        if (bounty.status != BountyTypes.BountyStatus.Open) revert InvalidStatus();
        if (block.timestamp > bounty.deadline) revert NotExpired();
        if (sender != bounty.creator) revert NotCreator();

        uint256 newMaxApprovals = maxApprovals[bountyId] + additionalSlots;
        if (newMaxApprovals > MAX_OPEN_SLOTS) revert InvalidSlotCount();

        uint256 perSubReward = perSubmissionReward[bountyId];
        uint256 addedEscrow = perSubReward * additionalSlots;

        maxApprovals[bountyId] = newMaxApprovals;
        pool[bountyId] += addedEscrow;
        bounty.rewardAmount += addedEscrow;
        totalEscrowed[bounty.escrowToken] += addedEscrow;

        IERC20(bounty.escrowToken).safeTransferFrom(sender, address(this), addedEscrow);

        emit BountyOpenToppedUp(bountyId, additionalSlots, newMaxApprovals);
    }

    /**
     * @dev Creator-initiated close. Sets status = Cancelled then refunds.
     */
    function closeBountyOpen(
        mapping(uint256 => BountyTypes.Bounty) storage bounties,
        mapping(uint256 => uint8) storage submissionMode,
        mapping(uint256 => uint256) storage pool,
        mapping(uint256 => uint256) storage pendingCreatorRefunds,
        mapping(address => uint256) storage pendingCreatorRefundTotals,
        mapping(address => uint256) storage totalEscrowed,
        uint256 bountyId,
        address sender
    ) external {
        BountyTypes.Bounty storage bounty = bounties[bountyId];
        if (bounty.creator == address(0)) revert BountyNotFound();
        if (submissionMode[bountyId] != 1) revert WrongSubmissionMode();
        if (bounty.status != BountyTypes.BountyStatus.Open) revert InvalidStatus();
        if (sender != bounty.creator) revert NotCreator();

        bounty.status = BountyTypes.BountyStatus.Cancelled;
        _refundOpenPool(bounty, pool, pendingCreatorRefunds, pendingCreatorRefundTotals, totalEscrowed, bountyId, "creator_close");
    }

    /**
     * @dev Permissionless close after deadline + grace.
     */
    function forceCloseBountyOpen(
        mapping(uint256 => BountyTypes.Bounty) storage bounties,
        mapping(uint256 => uint8) storage submissionMode,
        mapping(uint256 => uint256) storage pool,
        mapping(uint256 => uint256) storage pendingCreatorRefunds,
        mapping(address => uint256) storage pendingCreatorRefundTotals,
        mapping(address => uint256) storage totalEscrowed,
        uint256 bountyId
    ) external {
        BountyTypes.Bounty storage bounty = bounties[bountyId];
        if (bounty.creator == address(0)) revert BountyNotFound();
        if (submissionMode[bountyId] != 1) revert WrongSubmissionMode();
        if (bounty.status != BountyTypes.BountyStatus.Open) revert InvalidStatus();
        if (block.timestamp <= bounty.deadline + OPEN_GRACE_PERIOD) revert GracePeriodNotElapsed();

        bounty.status = BountyTypes.BountyStatus.Expired;
        _refundOpenPool(bounty, pool, pendingCreatorRefunds, pendingCreatorRefundTotals, totalEscrowed, bountyId, "grace_expired");
    }

    /**
     * @dev Shared refund body. Soft-fails the creator transfer so a failed creator
     *      transfer never blocks the refund.
     */
    function _refundOpenPool(
        BountyTypes.Bounty storage bounty,
        mapping(uint256 => uint256) storage pool,
        mapping(uint256 => uint256) storage pendingCreatorRefunds,
        mapping(address => uint256) storage pendingCreatorRefundTotals,
        mapping(address => uint256) storage totalEscrowed,
        uint256 bountyId,
        string memory reason
    ) internal {
        uint256 refundAmount = pool[bountyId];

        if (refundAmount > 0) {
            pool[bountyId] = 0;
            IERC20 token = IERC20(bounty.escrowToken);
            totalEscrowed[address(token)] -= refundAmount;

            try token.transfer(bounty.creator, refundAmount) returns (bool ok) {
                if (!ok) {
                    pendingCreatorRefunds[bountyId] += refundAmount;
                    pendingCreatorRefundTotals[address(token)] += refundAmount;
                    emit CreatorRefundDeferred(bountyId, bounty.creator, refundAmount);
                }
            } catch {
                pendingCreatorRefunds[bountyId] += refundAmount;
                pendingCreatorRefundTotals[address(token)] += refundAmount;
                emit CreatorRefundDeferred(bountyId, bounty.creator, refundAmount);
            }
        }

        emit BountyOpenClosed(bountyId, refundAmount, reason);
    }
}
