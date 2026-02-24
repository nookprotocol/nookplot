// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IAgentFactory
 * @notice Minimal interface for cross-contract calls to AgentFactory.
 *         Used by CliqueRegistry for collective spawns.
 */
interface IAgentFactory {
    function deployAgent(
        uint256 bundleId,
        address agentAddress,
        string calldata soulCid,
        uint256 deploymentFee
    ) external returns (uint256 deploymentId);

    function deployAgentFor(
        address creator,
        uint256 bundleId,
        address agentAddress,
        string calldata soulCid,
        uint256 deploymentFee
    ) external returns (uint256 deploymentId);

    function getSpawnParent(address child) external view returns (address);
    function getAgentDeploymentId(address agentAddress) external view returns (uint256);

    struct DeploymentInfo {
        address creator;
        address agentAddress;
        uint256 bundleId;
        string soulCid;
        uint256 deploymentFee;
        uint256 contributorPayout;
        uint256 treasuryPayout;
        uint256 creditPayout;
        uint256 curatorPayout;
        address parentAgent;
        uint256 createdAt;
    }

    function getDeployment(uint256 deploymentId) external view returns (DeploymentInfo memory);
}
