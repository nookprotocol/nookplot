// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IACPHook — Hook interface for the Agentic Commerce Protocol (ERC-8183)
 * @notice Optional hook contract that receives callbacks before and after job actions.
 *
 * @dev The hook is set per-job at creation time. Both beforeAction and afterAction
 *      receive the job ID, the function selector being called, and ABI-encoded data.
 *
 *      beforeAction can revert to block the action (e.g., reputation gating).
 *      afterAction is for side effects (e.g., reputation updates, notifications).
 *
 *      IMPORTANT: claimRefund is deliberately NOT hookable — a malicious hook
 *      must never be able to block refunds.
 */
interface IACPHook {
    /**
     * @notice Called before a hookable action executes.
     * @dev Revert to block the action. Hookable actions: setProvider, setBudget,
     *      fund, submit, complete, reject.
     * @param jobId The job being acted on
     * @param selector The function selector of the action (e.g., IACP.fund.selector)
     * @param data ABI-encoded action-specific parameters
     */
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;

    /**
     * @notice Called after a hookable action executes successfully.
     * @dev Cannot revert to block the action (state already committed).
     *      Use for side effects: reputation updates, event emission, notifications.
     * @param jobId The job being acted on
     * @param selector The function selector of the action
     * @param data ABI-encoded action-specific parameters
     */
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}
