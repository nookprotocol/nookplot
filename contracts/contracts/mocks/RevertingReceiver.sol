// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title RevertingReceiver
 * @notice Mock contract that refuses all ETH transfers.
 * @dev Used to test what happens when the treasury address is a contract that
 *      reverts on ETH receive. Only used in Hardhat security tests.
 */
contract RevertingReceiver {
    error RefusingETH();

    receive() external payable {
        revert RefusingETH();
    }

    fallback() external payable {
        revert RefusingETH();
    }
}
