// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title ExampleToken
/// @notice Minimal mintable ERC-20 for LOCAL SIMULATION / EXAMPLES ONLY.
///         Used by `examples/simulate.ts` to demonstrate the bounty + marketplace
///         escrow flows against a throwaway token. NOT a production token — the
///         public `mint` is intentional so a local simulation can fund test accounts.
contract ExampleToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
