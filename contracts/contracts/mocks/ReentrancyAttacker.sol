// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ReentrancyAttacker
 * @notice Mock contract for testing reentrancy guards on escrow-releasing functions.
 * @dev Attempts to re-enter `target` with stored calldata when it receives ETH.
 *      Used exclusively in Hardhat security tests — never deployed to any network.
 */
contract ReentrancyAttacker {
    address public target;
    bytes public attackData;
    bool public attackAttempted;
    bool public attackSucceeded;

    constructor(address _target) {
        target = _target;
    }

    /// @notice Store the calldata to replay during re-entry
    function setAttackData(bytes calldata data) external {
        attackData = data;
    }

    /// @notice Generic execute — lets this contract act as an agent (register, claim, etc.)
    function execute(address to, bytes calldata data) external payable returns (bytes memory) {
        (bool success, bytes memory result) = to.call{value: msg.value}(data);
        require(success, "ReentrancyAttacker: execute failed");
        return result;
    }

    /// @notice When ETH arrives, attempt to re-enter target with stored calldata (once)
    receive() external payable {
        if (!attackAttempted && attackData.length > 0) {
            attackAttempted = true;
            (bool success, ) = target.call(attackData);
            if (success) {
                attackSucceeded = true;
            }
        }
    }
}
