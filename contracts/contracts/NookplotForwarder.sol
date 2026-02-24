// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";

/**
 * @title NookplotForwarder
 * @author Nookplot
 * @notice Trusted forwarder for ERC-2771 gasless meta-transactions on Nookplot.
 *
 * @dev Thin wrapper around OpenZeppelin's ERC2771Forwarder. Deployed as a standalone
 *      contract (not a proxy — forwarders are stateless aside from per-signer nonces).
 *
 *      The EIP-712 domain name "NookplotForwarder" prevents cross-protocol signature replay.
 *      Provides: signature verification, nonce management, deadline expiry, gas griefing
 *      protection, and batch execution — all inherited from OpenZeppelin.
 *
 *      All 5 Nookplot contracts (AgentRegistry, ContentIndex, InteractionContract,
 *      SocialGraph, CommunityRegistry) reference this forwarder as their trusted forwarder
 *      via ERC2771ContextUpgradeable.
 */
contract NookplotForwarder is ERC2771Forwarder {
    constructor() ERC2771Forwarder("NookplotForwarder") {}
}
