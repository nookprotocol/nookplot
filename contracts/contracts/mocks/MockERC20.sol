// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockERC20
 * @notice Simple ERC-20 mock for testing token-related functionality in our contracts.
 * @dev This is NOT deployed to any network — only used in Hardhat tests.
 *      Simple mock ERC20 for testing.
 */
contract MockERC20 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}

    /// @notice Mint tokens to any address (for testing only)
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
