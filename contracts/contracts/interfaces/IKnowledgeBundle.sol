// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IKnowledgeBundle
 * @notice Minimal interface for cross-contract calls to KnowledgeBundle.
 *         Replaces raw staticcall + assembly ABI decoding with typed returns.
 */
interface IKnowledgeBundle {
    struct ContributorWeight {
        address contributor;
        uint16 weightBps;
    }

    struct Bundle {
        address creator;
        string name;
        string descriptionCid;
        string[] contentCids;
        ContributorWeight[] contributors;
        uint256 createdAt;
        bool isActive;
    }

    function getBundle(uint256 bundleId) external view returns (Bundle memory);
    function getBundleContributors(uint256 bundleId) external view returns (ContributorWeight[] memory);
    function isBundleActive(uint256 bundleId) external view returns (bool);
}
