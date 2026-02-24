// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/metatx/ERC2771ContextUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IKnowledgeBundle.sol";

/**
 * @title AgentFactory
 * @author Nookplot
 * @notice Agent deployment system for the Nookplot network. Anyone (human or
 *         agent) can deploy a new AI agent by binding it to a knowledge bundle
 *         and a soul.md identity document. Deployment fees are distributed to
 *         knowledge contributors via the receipt chain.
 *
 * @dev Uses UUPS proxy pattern. Agents can spawn child agents, forming a
 *      hierarchical spawn tree. Fee distribution uses configurable basis
 *      points (contributor, treasury, credit pool, curator shares).
 *      Token strategy follows "wired in, not turned on" — paymentToken ==
 *      address(0) means free mode, set to token address to activate fees.
 */
contract AgentFactory is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    ERC2771ContextUpgradeable
{
    using SafeERC20 for IERC20;
    // ============================================================
    //                        CUSTOM ERRORS
    // ============================================================

    error ZeroAddress();
    error NotRegisteredAgent();
    error BundleNotActive();
    error TokenTransferFailed();
    error DeploymentNotFound();
    error NotDeployedAgent();
    error InvalidFeeShares();
    error AgentAlreadyDeployed();
    error EmptySoulCid();
    error TooManyContributors();

    // ============================================================
    //                          STRUCTS
    // ============================================================

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

    // ============================================================
    //                        STATE VARIABLES
    // ============================================================

    mapping(uint256 => DeploymentInfo) private _deployments;
    mapping(address => uint256[]) private _deploymentsByCreator;
    mapping(uint256 => uint256[]) private _deploymentsByBundle;
    mapping(address => uint256) private _agentDeploymentId;
    mapping(address => bool) private _hasDeployment;
    mapping(address => address[]) private _parentChildren;
    mapping(address => address) private _childParent;

    uint256 private _nextDeploymentId;

    IERC20 public paymentToken;
    address public treasury;
    address public creditPool;
    address private _agentRegistry;
    address private _knowledgeBundle;

    uint16 public contributorShareBps;
    uint16 public treasuryShareBps;
    uint16 public creditShareBps;
    uint16 public curatorShareBps;

    uint256 public constant MAX_CONTRIBUTORS = 50;

    address public cliqueRegistry;

    /// @dev Storage gap for future upgrades (UUPS pattern)
    uint256[35] private __gap;

    // ============================================================
    //                          EVENTS
    // ============================================================

    event AgentDeployed(
        uint256 indexed deploymentId,
        address indexed creator,
        address indexed agentAddress,
        uint256 bundleId,
        string soulCid,
        uint256 deploymentFee,
        uint256 timestamp
    );

    event AgentSpawned(
        uint256 indexed deploymentId,
        address indexed parentAgent,
        address indexed childAgent,
        uint256 bundleId,
        string soulCid,
        uint256 timestamp
    );

    event FeeDistributed(
        uint256 indexed deploymentId,
        uint256 contributorPayout,
        uint256 treasuryPayout,
        uint256 creditPayout,
        uint256 curatorPayout
    );

    event ContributorPaid(
        uint256 indexed deploymentId,
        address indexed contributor,
        uint256 amount
    );

    event SoulUpdated(
        uint256 indexed deploymentId,
        address indexed agentAddress,
        string oldSoulCid,
        string newSoulCid
    );

    event FeeSharesUpdated(
        uint16 contributorShareBps,
        uint16 treasuryShareBps,
        uint16 creditShareBps,
        uint16 curatorShareBps
    );

    // ============================================================
    //                        INITIALIZER
    // ============================================================

    /// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
    constructor(address trustedForwarder_) ERC2771ContextUpgradeable(trustedForwarder_) {
        _disableInitializers();
    }

    function initialize(
        address owner_,
        address agentRegistry_,
        address knowledgeBundle_,
        address treasury_,
        address creditPool_
    ) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        if (agentRegistry_ == address(0)) revert ZeroAddress();
        if (knowledgeBundle_ == address(0)) revert ZeroAddress();
        if (treasury_ == address(0)) revert ZeroAddress();
        if (creditPool_ == address(0)) revert ZeroAddress();

        __Ownable_init(owner_);
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        _agentRegistry = agentRegistry_;
        _knowledgeBundle = knowledgeBundle_;
        treasury = treasury_;
        creditPool = creditPool_;
    }

    // ============================================================
    //                    DEPLOYMENT LIFECYCLE
    // ============================================================

    function deployAgent(
        uint256 bundleId,
        address agentAddress,
        string calldata soulCid,
        uint256 deploymentFee
    ) external whenNotPaused nonReentrant returns (uint256 deploymentId) {
        if (agentAddress == address(0)) revert ZeroAddress();
        if (bytes(soulCid).length == 0) revert EmptySoulCid();
        _requireActiveAgent(agentAddress);
        _requireActiveBundle(bundleId);
        if (_hasDeployment[agentAddress]) revert AgentAlreadyDeployed();

        deploymentId = _nextDeploymentId++;
        address sender = _msgSender();

        _recordDeployment(deploymentId, sender, agentAddress, bundleId, soulCid, deploymentFee, address(0));

        if (address(paymentToken) != address(0) && deploymentFee > 0) {
            paymentToken.safeTransferFrom(sender, address(this), deploymentFee);
            _distributeFees(deploymentId, deploymentFee, bundleId);
        }

        emit AgentDeployed(deploymentId, sender, agentAddress, bundleId, soulCid, deploymentFee, block.timestamp);
    }

    function spawnAgent(
        uint256 bundleId,
        address childAddress,
        string calldata soulCid,
        uint256 deploymentFee
    ) external whenNotPaused nonReentrant returns (uint256 deploymentId) {
        if (childAddress == address(0)) revert ZeroAddress();
        if (bytes(soulCid).length == 0) revert EmptySoulCid();

        address parent = _msgSender();
        _requireActiveAgent(parent);
        _requireActiveAgent(childAddress);
        _requireActiveBundle(bundleId);
        if (_hasDeployment[childAddress]) revert AgentAlreadyDeployed();

        deploymentId = _nextDeploymentId++;

        _recordDeployment(deploymentId, parent, childAddress, bundleId, soulCid, deploymentFee, parent);

        // Update spawn tree
        _parentChildren[parent].push(childAddress);
        _childParent[childAddress] = parent;

        if (address(paymentToken) != address(0) && deploymentFee > 0) {
            paymentToken.safeTransferFrom(parent, address(this), deploymentFee);
            _distributeFees(deploymentId, deploymentFee, bundleId);
        }

        emit AgentSpawned(deploymentId, parent, childAddress, bundleId, soulCid, block.timestamp);
    }

    function updateSoul(
        uint256 deploymentId,
        string calldata newSoulCid
    ) external whenNotPaused {
        if (bytes(newSoulCid).length == 0) revert EmptySoulCid();
        if (deploymentId >= _nextDeploymentId) revert DeploymentNotFound();

        DeploymentInfo storage deployment = _deployments[deploymentId];
        if (_msgSender() != deployment.agentAddress) revert NotDeployedAgent();

        string memory oldSoulCid = deployment.soulCid;
        deployment.soulCid = newSoulCid;

        emit SoulUpdated(deploymentId, deployment.agentAddress, oldSoulCid, newSoulCid);
    }

    /**
     * @notice Deploy an agent on behalf of a creator. Only callable by the
     *         CliqueRegistry contract for collective spawns.
     */
    function deployAgentFor(
        address creator,
        uint256 bundleId,
        address agentAddress,
        string calldata soulCid,
        uint256 deploymentFee
    ) external whenNotPaused nonReentrant returns (uint256 deploymentId) {
        if (_msgSender() != cliqueRegistry) revert NotRegisteredAgent();
        if (agentAddress == address(0)) revert ZeroAddress();
        if (bytes(soulCid).length == 0) revert EmptySoulCid();
        _requireActiveAgent(agentAddress);
        _requireActiveBundle(bundleId);
        if (_hasDeployment[agentAddress]) revert AgentAlreadyDeployed();

        deploymentId = _nextDeploymentId++;

        _recordDeployment(deploymentId, creator, agentAddress, bundleId, soulCid, deploymentFee, address(0));

        if (address(paymentToken) != address(0) && deploymentFee > 0) {
            paymentToken.safeTransferFrom(creator, address(this), deploymentFee);
            _distributeFees(deploymentId, deploymentFee, bundleId);
        }

        emit AgentDeployed(deploymentId, creator, agentAddress, bundleId, soulCid, deploymentFee, block.timestamp);
    }

    // ============================================================
    //                      VIEW FUNCTIONS
    // ============================================================

    function getDeployment(uint256 deploymentId) external view returns (DeploymentInfo memory) {
        if (deploymentId >= _nextDeploymentId) revert DeploymentNotFound();
        return _deployments[deploymentId];
    }

    function getDeploymentsByCreator(address creator) external view returns (uint256[] memory) {
        return _deploymentsByCreator[creator];
    }

    function getDeploymentsByBundle(uint256 bundleId) external view returns (uint256[] memory) {
        return _deploymentsByBundle[bundleId];
    }

    function getSpawnChildren(address parent) external view returns (address[] memory) {
        return _parentChildren[parent];
    }

    function getSpawnParent(address child) external view returns (address) {
        return _childParent[child];
    }

    function getDeploymentCount() external view returns (uint256) {
        return _nextDeploymentId;
    }

    function getSoulCid(address agentAddress) external view returns (string memory) {
        if (!_hasDeployment[agentAddress]) revert DeploymentNotFound();
        return _deployments[_agentDeploymentId[agentAddress]].soulCid;
    }

    function getAgentDeploymentId(address agentAddress) external view returns (uint256) {
        if (!_hasDeployment[agentAddress]) revert DeploymentNotFound();
        return _agentDeploymentId[agentAddress];
    }

    function agentRegistry() external view returns (address) {
        return _agentRegistry;
    }

    function knowledgeBundleContract() external view returns (address) {
        return _knowledgeBundle;
    }

    // ============================================================
    //                      ADMIN FUNCTIONS
    // ============================================================

    /**
     * @notice Update fee distribution shares. Must sum to 10000 bps (100%)
     *         or all be zero (disables fee splitting — revenue stays in caller).
     * @dev When total == 0, _distributeToContributors and _distributeFees become no-ops.
     *      This is intentional for free-mode operation (paymentToken == address(0)).
     */
    function setFeeShares(
        uint16 contributorBps,
        uint16 treasuryBps,
        uint16 creditBps,
        uint16 curatorBps
    ) external onlyOwner {
        uint256 total = uint256(contributorBps) + treasuryBps + creditBps + curatorBps;
        if (total != 10000 && total != 0) revert InvalidFeeShares();

        contributorShareBps = contributorBps;
        treasuryShareBps = treasuryBps;
        creditShareBps = creditBps;
        curatorShareBps = curatorBps;

        emit FeeSharesUpdated(contributorBps, treasuryBps, creditBps, curatorBps);
    }

    function setPaymentToken(address token) external onlyOwner {
        paymentToken = IERC20(token);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = newTreasury;
    }

    function setCreditPool(address newCreditPool) external onlyOwner {
        if (newCreditPool == address(0)) revert ZeroAddress();
        creditPool = newCreditPool;
    }

    function setCliqueRegistry(address newCliqueRegistry) external onlyOwner {
        if (newCliqueRegistry == address(0)) revert ZeroAddress();
        cliqueRegistry = newCliqueRegistry;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ============================================================
    //                     INTERNAL HELPERS
    // ============================================================

    function _recordDeployment(
        uint256 deploymentId,
        address creator,
        address agentAddress,
        uint256 bundleId,
        string calldata soulCid,
        uint256 deploymentFee,
        address parentAgent
    ) internal {
        _deployments[deploymentId] = DeploymentInfo({
            creator: creator,
            agentAddress: agentAddress,
            bundleId: bundleId,
            soulCid: soulCid,
            deploymentFee: deploymentFee,
            contributorPayout: 0,
            treasuryPayout: 0,
            creditPayout: 0,
            curatorPayout: 0,
            parentAgent: parentAgent,
            createdAt: block.timestamp
        });

        _deploymentsByCreator[creator].push(deploymentId);
        _deploymentsByBundle[bundleId].push(deploymentId);
        _agentDeploymentId[agentAddress] = deploymentId;
        _hasDeployment[agentAddress] = true;
    }

    function _distributeFees(
        uint256 deploymentId,
        uint256 totalFee,
        uint256 bundleId
    ) internal {
        uint256 contribAmount = (totalFee * contributorShareBps) / 10000;
        uint256 treasuryAmount = (totalFee * treasuryShareBps) / 10000;
        uint256 creditAmount = (totalFee * creditShareBps) / 10000;
        // Curator gets the remainder to avoid rounding dust
        uint256 curatorAmount = totalFee - contribAmount - treasuryAmount - creditAmount;

        // Store payout info
        DeploymentInfo storage d = _deployments[deploymentId];
        d.contributorPayout = contribAmount;
        d.treasuryPayout = treasuryAmount;
        d.creditPayout = creditAmount;
        d.curatorPayout = curatorAmount;

        // Distribute to contributors
        if (contribAmount > 0) {
            _distributeToContributors(deploymentId, contribAmount, bundleId);
        }

        // Transfer treasury share
        if (treasuryAmount > 0) {
            paymentToken.safeTransfer(treasury, treasuryAmount);
        }

        // Transfer credit pool share
        if (creditAmount > 0) {
            paymentToken.safeTransfer(creditPool, creditAmount);
        }

        // Transfer curator share (to bundle creator)
        if (curatorAmount > 0) {
            _transferCuratorShare(curatorAmount, bundleId);
        }

        emit FeeDistributed(deploymentId, contribAmount, treasuryAmount, creditAmount, curatorAmount);
    }

    function _distributeToContributors(
        uint256 deploymentId,
        uint256 contribAmount,
        uint256 bundleId
    ) internal {
        IKnowledgeBundle.ContributorWeight[] memory contributors;
        try IKnowledgeBundle(_knowledgeBundle).getBundleContributors(bundleId) returns (
            IKnowledgeBundle.ContributorWeight[] memory result
        ) {
            contributors = result;
        } catch {
            // Failed to get contributors — send entire amount to treasury
            paymentToken.safeTransfer(treasury, contribAmount);
            return;
        }

        if (contributors.length == 0) return;
        if (contributors.length > MAX_CONTRIBUTORS) revert TooManyContributors();

        uint256 distributed = 0;
        for (uint256 i = 0; i < contributors.length; i++) {
            uint256 share = (contribAmount * contributors[i].weightBps) / 10000;
            if (share > 0) {
                // Wrap individual transfers in try/catch — if one fails, send to treasury
                try this.transferOnBehalf(contributors[i].contributor, share) {
                    distributed += share;
                    emit ContributorPaid(deploymentId, contributors[i].contributor, share);
                } catch {
                    paymentToken.safeTransfer(treasury, share);
                    distributed += share;
                }
            }
        }

        // Dust goes to first contributor
        if (distributed < contribAmount) {
            paymentToken.safeTransfer(contributors[0].contributor, contribAmount - distributed);
        }
    }

    function _transferCuratorShare(uint256 amount, uint256 bundleId) internal {
        try IKnowledgeBundle(_knowledgeBundle).getBundle(bundleId) returns (
            IKnowledgeBundle.Bundle memory bundle
        ) {
            if (bundle.creator != address(0)) {
                paymentToken.safeTransfer(bundle.creator, amount);
            }
        } catch {
            // Failed to get bundle — send to treasury
            paymentToken.safeTransfer(treasury, amount);
        }
    }

    /**
     * @dev External wrapper around safeTransfer so it can be called via
     *      `try this.transferOnBehalf(...)` to catch individual transfer failures.
     *      Only callable by this contract itself.
     */
    function transferOnBehalf(address to, uint256 amount) external {
        require(msg.sender == address(this), "Only self");
        paymentToken.safeTransfer(to, amount);
    }

    function _requireActiveAgent(address agent) internal view {
        (bool success, bytes memory data) = _agentRegistry.staticcall(
            abi.encodeWithSignature("isActiveAgent(address)", agent)
        );
        if (!success || data.length == 0) revert NotRegisteredAgent();
        bool isActive = abi.decode(data, (bool));
        if (!isActive) revert NotRegisteredAgent();
    }

    function _requireActiveBundle(uint256 bundleId) internal view {
        (bool success, bytes memory data) = _knowledgeBundle.staticcall(
            abi.encodeWithSignature("isBundleActive(uint256)", bundleId)
        );
        if (!success || data.length == 0) revert BundleNotActive();
        bool isActive = abi.decode(data, (bool));
        if (!isActive) revert BundleNotActive();
    }

    // ============================================================
    //                   ERC-2771 OVERRIDES
    // ============================================================

    function _msgSender() internal view override(ContextUpgradeable, ERC2771ContextUpgradeable) returns (address) {
        return ERC2771ContextUpgradeable._msgSender();
    }

    function _msgData() internal view override(ContextUpgradeable, ERC2771ContextUpgradeable) returns (bytes calldata) {
        return ERC2771ContextUpgradeable._msgData();
    }

    function _contextSuffixLength() internal view override(ContextUpgradeable, ERC2771ContextUpgradeable) returns (uint256) {
        return ERC2771ContextUpgradeable._contextSuffixLength();
    }

    // ============================================================
    //                     UUPS UPGRADE AUTH
    // ============================================================

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
