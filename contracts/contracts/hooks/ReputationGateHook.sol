// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IACPHook.sol";
import "../interfaces/IACP.sol";

/**
 * @title ReputationGateHook
 * @author Nookplot
 * @notice Example IACPHook that gates ACP job actions based on agent reputation.
 *
 * @dev This hook can be attached to any ACP job at creation time. It enforces:
 *      - Only providers with sufficient reputation can submit work
 *      - Only evaluators above a threshold can complete/reject jobs
 *
 *      Reputation is read from an external registry (e.g., ERC-8004 ReputationRegistry
 *      or any contract implementing the getReputation interface).
 *
 *      This is a reference implementation — production deployments should tune
 *      thresholds and add more granular checks per use case.
 */
contract ReputationGateHook is IACPHook {
    /// @notice Reputation registry contract (must implement getReputation)
    address public immutable reputationRegistry;

    /// @notice Minimum reputation score required (scaled by 1e18)
    uint256 public immutable minReputation;

    /// @notice The ACP adapter contract this hook is authorized for
    address public immutable acpAdapter;

    error InsufficientReputation(address agent, uint256 score, uint256 required);
    error UnauthorizedCaller();

    constructor(address reputationRegistry_, uint256 minReputation_, address acpAdapter_) {
        reputationRegistry = reputationRegistry_;
        minReputation = minReputation_;
        acpAdapter = acpAdapter_;
    }

    /// @inheritdoc IACPHook
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata /* data */) external view override {
        if (msg.sender != acpAdapter) revert UnauthorizedCaller();

        // Gate provider submissions — ensure provider meets reputation threshold
        if (selector == IACP.submit.selector) {
            // The provider calling submit is msg.sender of the ACP adapter,
            // but we need the actual provider. Read it from the job.
            IACP.Job memory job = IACP(acpAdapter).getJob(jobId);
            _requireReputation(job.provider);
        }

        // Gate evaluator actions — ensure evaluator meets reputation threshold
        if (selector == IACP.complete.selector || selector == IACP.reject.selector) {
            IACP.Job memory job = IACP(acpAdapter).getJob(jobId);
            _requireReputation(job.evaluator);
        }
    }

    /// @inheritdoc IACPHook
    function afterAction(uint256, bytes4, bytes calldata) external pure override {
        // No post-action side effects in this implementation.
        // A production hook could update reputation here (e.g., increment
        // provider score on completion, decrement on rejection).
    }

    /**
     * @dev Check that an agent meets the minimum reputation threshold.
     *      Fail-open if the reputation registry is unreachable.
     */
    function _requireReputation(address agent) internal view {
        (bool success, bytes memory result) = reputationRegistry.staticcall(
            abi.encodeWithSignature("getReputation(address)", agent)
        );

        if (success && result.length >= 32) {
            uint256 score = abi.decode(result, (uint256));
            if (score < minReputation) {
                revert InsufficientReputation(agent, score, minReputation);
            }
        }
        // Fail-open: if registry is unreachable, allow the action
    }
}
