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
import "./interfaces/IAgentFactory.sol";

/**
 * @title RevenueRouter
 * @author Nookplot
 * @notice Receipt chain that routes deployed agents' earnings back to knowledge
 *         contributors. When Agent X earns from bounties or services, a portion
 *         flows back through the spawn tree to every contributor whose knowledge
 *         built Agent X.
 *
 * @dev Uses pull-based (claim) pattern. Revenue is split into owner, receipt
 *      chain, and treasury portions. The receipt chain portion walks the spawn
 *      tree up to maxChainDepth generations, with each generation's share
 *      decaying by decayFactorBps. Per-generation shares are split among
 *      bundle contributors by weight.
 */
contract RevenueRouter is
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
    error InvalidShares();
    error NothingToClaim();
    error ZeroAmount();
    error EthTransferFailed();
    error TokenTransferFailed();
    error AgentNotDeployed();
    error UseDistributeRevenueToken();

    // ============================================================
    //                          STRUCTS
    // ============================================================

    struct ShareConfig {
        uint16 ownerBps;
        uint16 receiptChainBps;
        uint16 treasuryBps;
        uint256 bundleId;
        bool isSet;
    }

    struct RevenueEvent {
        address agent;
        string source;
        uint256 amount;
        bool isEth;
        uint256 ownerAmount;
        uint256 receiptChainAmount;
        uint256 treasuryAmount;
        uint256 timestamp;
    }

    // ============================================================
    //                        STATE VARIABLES
    // ============================================================

    mapping(address => ShareConfig) private _shareConfigs;
    mapping(address => uint256) private _claimableBalances;
    mapping(address => uint256) private _claimableEthBalances;
    mapping(uint256 => RevenueEvent) private _revenueEvents;
    mapping(address => uint256[]) private _agentRevenueEventIds;

    uint256 private _nextEventId;
    uint256 private _totalDistributed;
    uint256 private _totalClaimed;
    mapping(address => uint256) private _agentTotalDistributed;
    mapping(address => uint256) private _addressTotalClaimed;

    address private _agentFactory;
    address private _knowledgeBundle;
    address private _agentRegistry;

    IERC20 public paymentToken;
    address public treasury;

    uint16 public defaultOwnerBps;
    uint16 public defaultReceiptChainBps;
    uint16 public defaultTreasuryBps;

    uint16 public decayFactorBps;
    uint8 public maxChainDepth;

    /// @dev Storage gap for future upgrades (UUPS pattern)
    uint256[30] private __gap;

    // ============================================================
    //                          EVENTS
    // ============================================================

    event RevenueDistributed(
        uint256 indexed eventId,
        address indexed agent,
        string source,
        uint256 amount,
        bool isEth,
        uint256 ownerAmount,
        uint256 receiptChainAmount,
        uint256 treasuryAmount,
        uint256 timestamp
    );

    event ContributorCredited(
        uint256 indexed eventId,
        address indexed contributor,
        uint256 amount,
        uint8 generation
    );

    event EarningsClaimed(
        address indexed claimant,
        uint256 amount,
        bool isEth
    );

    event ShareConfigSet(
        address indexed agent,
        uint16 ownerBps,
        uint16 receiptChainBps,
        uint16 treasuryBps,
        uint256 bundleId
    );

    event DecayFactorUpdated(uint16 oldDecayBps, uint16 newDecayBps);
    event MaxChainDepthUpdated(uint8 oldDepth, uint8 newDepth);

    // ============================================================
    //                        INITIALIZER
    // ============================================================

    /// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
    constructor(address trustedForwarder_) ERC2771ContextUpgradeable(trustedForwarder_) {
        _disableInitializers();
    }

    function initialize(
        address owner_,
        address agentFactory_,
        address knowledgeBundle_,
        address agentRegistry_,
        address treasury_
    ) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        if (agentFactory_ == address(0)) revert ZeroAddress();
        if (knowledgeBundle_ == address(0)) revert ZeroAddress();
        if (agentRegistry_ == address(0)) revert ZeroAddress();
        if (treasury_ == address(0)) revert ZeroAddress();

        __Ownable_init(owner_);
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        _agentFactory = agentFactory_;
        _knowledgeBundle = knowledgeBundle_;
        _agentRegistry = agentRegistry_;
        treasury = treasury_;

        // Defaults: 50% owner, 40% receipt chain, 10% treasury
        defaultOwnerBps = 5000;
        defaultReceiptChainBps = 4000;
        defaultTreasuryBps = 1000;

        // Receipt chain defaults: 50% decay per generation, max 5 generations
        decayFactorBps = 5000;
        maxChainDepth = 5;
    }

    // ============================================================
    //                    REVENUE DISTRIBUTION
    // ============================================================

    /**
     * @notice Distribute revenue earned by an agent. Accepts ETH (msg.value)
     *         or tokens (must be pre-approved). Splits into owner/receiptChain/treasury.
     * @param agent The agent whose earnings are being distributed
     * @param source Description of the revenue source (e.g., "bounty", "service")
     */
    function distributeRevenue(
        address agent,
        string calldata source
    ) external payable whenNotPaused nonReentrant {
        // When paymentToken is set, callers must use distributeRevenueToken() instead
        if (address(paymentToken) != address(0)) revert UseDistributeRevenueToken();
        if (msg.value == 0) revert ZeroAmount();

        _distribute(agent, source, msg.value, true);
    }

    /**
     * @notice Distribute a specific token amount for an agent.
     *         Caller must have approved this contract for at least `amount`.
     * @param agent The agent whose earnings are being distributed
     * @param source Description of the revenue source
     * @param amount Token amount to distribute
     */
    function distributeRevenueToken(
        address agent,
        string calldata source,
        uint256 amount
    ) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (address(paymentToken) == address(0)) revert ZeroAmount();

        paymentToken.safeTransferFrom(_msgSender(), address(this), amount);

        _distribute(agent, source, amount, false);
    }

    // ============================================================
    //                      CLAIM EARNINGS
    // ============================================================

    /**
     * @notice Claim accumulated token earnings.
     */
    function claim() external nonReentrant {
        address claimant = _msgSender();
        uint256 amount = _claimableBalances[claimant];
        if (amount == 0) revert NothingToClaim();

        _claimableBalances[claimant] = 0;
        _totalClaimed += amount;
        _addressTotalClaimed[claimant] += amount;

        paymentToken.safeTransfer(claimant, amount);

        emit EarningsClaimed(claimant, amount, false);
    }

    /**
     * @notice Claim accumulated ETH earnings.
     */
    function claimEth() external nonReentrant {
        address claimant = _msgSender();
        uint256 amount = _claimableEthBalances[claimant];
        if (amount == 0) revert NothingToClaim();

        _claimableEthBalances[claimant] = 0;
        _totalClaimed += amount;
        _addressTotalClaimed[claimant] += amount;

        (bool success, ) = claimant.call{value: amount}("");
        if (!success) revert EthTransferFailed();

        emit EarningsClaimed(claimant, amount, true);
    }

    // ============================================================
    //                    SHARE CONFIGURATION
    // ============================================================

    /**
     * @notice Set revenue share configuration for an agent.
     *         Only the agent itself or the contract owner can set this.
     * @param agent The agent address
     * @param ownerBps Basis points for the agent owner
     * @param receiptChainBps Basis points for the receipt chain
     * @param treasuryBps Basis points for the treasury
     * @param bundleId The knowledge bundle ID used for contributor lookups
     */
    function setShareConfig(
        address agent,
        uint16 ownerBps,
        uint16 receiptChainBps,
        uint16 treasuryBps,
        uint256 bundleId
    ) external whenNotPaused {
        address sender = _msgSender();
        if (sender != agent && sender != owner()) revert InvalidShares();

        uint256 total = uint256(ownerBps) + receiptChainBps + treasuryBps;
        if (total != 10000) revert InvalidShares();

        _shareConfigs[agent] = ShareConfig({
            ownerBps: ownerBps,
            receiptChainBps: receiptChainBps,
            treasuryBps: treasuryBps,
            bundleId: bundleId,
            isSet: true
        });

        emit ShareConfigSet(agent, ownerBps, receiptChainBps, treasuryBps, bundleId);
    }

    // ============================================================
    //                      VIEW FUNCTIONS
    // ============================================================

    function getClaimableBalance(address addr) external view returns (uint256) {
        return _claimableBalances[addr];
    }

    function getClaimableEthBalance(address addr) external view returns (uint256) {
        return _claimableEthBalances[addr];
    }

    function getShareConfig(address agent) external view returns (ShareConfig memory) {
        return _shareConfigs[agent];
    }

    function getRevenueEvent(uint256 eventId) external view returns (RevenueEvent memory) {
        return _revenueEvents[eventId];
    }

    function getRevenueHistory(address agent) external view returns (uint256[] memory) {
        return _agentRevenueEventIds[agent];
    }

    function getTotalDistributed() external view returns (uint256) {
        return _totalDistributed;
    }

    function getAgentTotalDistributed(address agent) external view returns (uint256) {
        return _agentTotalDistributed[agent];
    }

    function getTotalClaimed() external view returns (uint256) {
        return _totalClaimed;
    }

    function getAddressTotalClaimed(address addr) external view returns (uint256) {
        return _addressTotalClaimed[addr];
    }

    function getEventCount() external view returns (uint256) {
        return _nextEventId;
    }

    function agentFactory() external view returns (address) {
        return _agentFactory;
    }

    function knowledgeBundleContract() external view returns (address) {
        return _knowledgeBundle;
    }

    function agentRegistryContract() external view returns (address) {
        return _agentRegistry;
    }

    /**
     * @notice Walk the spawn tree for an agent and return the receipt chain
     *         (list of parent addresses up to maxChainDepth).
     * @param agent The starting agent
     * @return chain Array of parent addresses (generation 0 = direct parent)
     */
    function getReceiptChain(address agent) external view returns (address[] memory chain) {
        chain = new address[](maxChainDepth);
        uint8 depth = 0;
        address current = agent;

        for (uint8 i = 0; i < maxChainDepth; i++) {
            address parent = _getSpawnParent(current);
            if (parent == address(0)) break;
            chain[i] = parent;
            depth++;
            current = parent;
        }

        // Trim to actual length
        assembly { mstore(chain, depth) }
    }

    // ============================================================
    //                      ADMIN FUNCTIONS
    // ============================================================

    function setDefaultShares(
        uint16 ownerBps,
        uint16 receiptChainBps,
        uint16 treasuryBps
    ) external onlyOwner {
        uint256 total = uint256(ownerBps) + receiptChainBps + treasuryBps;
        if (total != 10000) revert InvalidShares();

        defaultOwnerBps = ownerBps;
        defaultReceiptChainBps = receiptChainBps;
        defaultTreasuryBps = treasuryBps;
    }

    function setDecayFactor(uint16 newDecayBps) external onlyOwner {
        if (newDecayBps > 10000) revert InvalidShares();
        uint16 oldDecayBps = decayFactorBps;
        decayFactorBps = newDecayBps;
        emit DecayFactorUpdated(oldDecayBps, newDecayBps);
    }

    function setMaxChainDepth(uint8 newDepth) external onlyOwner {
        if (newDepth > 20) revert InvalidShares();
        uint8 oldDepth = maxChainDepth;
        maxChainDepth = newDepth;
        emit MaxChainDepthUpdated(oldDepth, newDepth);
    }

    function rescueETH(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool success, ) = to.call{value: amount}("");
        if (!success) revert EthTransferFailed();
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = newTreasury;
    }

    function setPaymentToken(address token) external onlyOwner {
        paymentToken = IERC20(token);
    }

    function setAgentFactory(address newFactory) external onlyOwner {
        if (newFactory == address(0)) revert ZeroAddress();
        _agentFactory = newFactory;
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

    function _resolveConfig(address agent) internal view returns (uint16 ownerBps, uint16 chainBps, uint16 treasuryBps_, uint256 bundleId) {
        ShareConfig memory config = _shareConfigs[agent];
        if (config.isSet) {
            return (config.ownerBps, config.receiptChainBps, config.treasuryBps, config.bundleId);
        }
        return (defaultOwnerBps, defaultReceiptChainBps, defaultTreasuryBps, _getDeploymentBundleId(agent));
    }

    function _distribute(
        address agent,
        string calldata source,
        uint256 amount,
        bool isEth
    ) internal {
        (uint16 ownerBps, uint16 chainBps, , uint256 bundleId) = _resolveConfig(agent);

        uint256 ownerAmount = (amount * ownerBps) / 10000;
        uint256 chainAmount = (amount * chainBps) / 10000;
        uint256 treasuryAmount = amount - ownerAmount - chainAmount;

        uint256 eventId = _nextEventId++;
        _revenueEvents[eventId] = RevenueEvent({
            agent: agent,
            source: source,
            amount: amount,
            isEth: isEth,
            ownerAmount: ownerAmount,
            receiptChainAmount: chainAmount,
            treasuryAmount: treasuryAmount,
            timestamp: block.timestamp
        });
        _agentRevenueEventIds[agent].push(eventId);
        _totalDistributed += amount;
        _agentTotalDistributed[agent] += amount;

        if (ownerAmount > 0) _credit(agent, ownerAmount, isEth);
        if (treasuryAmount > 0) _credit(treasury, treasuryAmount, isEth);
        if (chainAmount > 0) _distributeReceiptChain(eventId, agent, chainAmount, bundleId, isEth);

        emit RevenueDistributed(
            eventId, agent, source, amount, isEth,
            ownerAmount, chainAmount, treasuryAmount, block.timestamp
        );
    }

    function _distributeReceiptChain(
        uint256 eventId,
        address agent,
        uint256 totalChainAmount,
        uint256 bundleId,
        bool isEth
    ) internal {
        address current = agent;
        uint256 remaining = totalChainAmount;
        uint256 genShare = totalChainAmount; // Gen 0 starts with full chain amount

        for (uint8 gen = 0; gen < maxChainDepth && remaining > 0; gen++) {
            address parent = _getSpawnParent(current);
            if (parent == address(0)) break;

            // This generation's share = genShare * decayFactor^gen
            // Gen 0 gets (totalChainAmount * decayFactorBps / 10000)
            // Gen 1 gets that * decayFactorBps / 10000, etc.
            uint256 thisGenAmount;
            if (gen == 0) {
                thisGenAmount = (totalChainAmount * decayFactorBps) / 10000;
            } else {
                thisGenAmount = (genShare * decayFactorBps) / 10000;
            }

            if (thisGenAmount > remaining) {
                thisGenAmount = remaining;
            }
            if (thisGenAmount == 0) break;

            // Distribute this generation's share to bundle contributors
            _creditGeneration(eventId, thisGenAmount, bundleId, gen, isEth, parent);

            remaining -= thisGenAmount;
            genShare = thisGenAmount;
            current = parent;
        }

        // Any undistributed remainder goes to treasury
        if (remaining > 0) {
            _credit(treasury, remaining, isEth);
        }
    }

    function _creditGeneration(
        uint256 eventId,
        uint256 amount,
        uint256 bundleId,
        uint8 generation,
        bool isEth,
        address fallbackRecipient
    ) internal {
        // Try to get bundle contributors via typed interface
        IKnowledgeBundle.ContributorWeight[] memory contributors;
        try IKnowledgeBundle(_knowledgeBundle).getBundleContributors(bundleId) returns (
            IKnowledgeBundle.ContributorWeight[] memory result
        ) {
            contributors = result;
        } catch {
            // No contributors found, credit to the parent agent
            _credit(fallbackRecipient, amount, isEth);
            emit ContributorCredited(eventId, fallbackRecipient, amount, generation);
            return;
        }

        if (contributors.length == 0) {
            _credit(fallbackRecipient, amount, isEth);
            emit ContributorCredited(eventId, fallbackRecipient, amount, generation);
            return;
        }

        uint256 distributed = 0;
        for (uint256 i = 0; i < contributors.length; i++) {
            uint256 share = (amount * contributors[i].weightBps) / 10000;
            if (share > 0) {
                _credit(contributors[i].contributor, share, isEth);
                distributed += share;
                emit ContributorCredited(eventId, contributors[i].contributor, share, generation);
            }
        }

        // Dust goes to first contributor
        if (distributed < amount) {
            _credit(contributors[0].contributor, amount - distributed, isEth);
        }
    }

    function _credit(address addr, uint256 amount, bool isEth) internal {
        if (isEth) {
            _claimableEthBalances[addr] += amount;
        } else {
            _claimableBalances[addr] += amount;
        }
    }

    function _getSpawnParent(address child) internal view returns (address) {
        try IAgentFactory(_agentFactory).getSpawnParent(child) returns (address parent) {
            return parent;
        } catch {
            return address(0);
        }
    }

    function _getDeploymentBundleId(address agent) internal view returns (uint256) {
        try IAgentFactory(_agentFactory).getAgentDeploymentId(agent) returns (uint256 deploymentId) {
            try IAgentFactory(_agentFactory).getDeployment(deploymentId) returns (
                IAgentFactory.DeploymentInfo memory info
            ) {
                return info.bundleId;
            } catch {
                return 0;
            }
        } catch {
            return 0;
        }
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

    // ============================================================
    //                     RECEIVE ETH
    // ============================================================

    receive() external payable {}
}
