// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title FeeDistributor
 * @author Nookplot
 * @notice Receives wETH and NOOK trading fees from the DEX pool and splits
 *         them to protocol destinations.
 *
 * @dev wETH splits to 3 destinations (default 50/30/20 bps):
 *        - R&D wallet
 *        - Buyback wallet
 *        - AgentRewardPool (RewardPool instance)
 *
 *      NOOK splits to 2 destinations (default 40/60 bps):
 *        - CitationPool (RewardPool instance)
 *        - Ecosystem wallet
 *
 *      V2: Role-based access control (AccessControlUpgradeable).
 *        - DEFAULT_ADMIN_ROLE: multi-sig — splits, destinations, emergency, upgrade, unpause
 *        - OPERATOR_ROLE: automated operator EOA — trigger distributions
 *        - GUARDIAN_ROLE: security responder — pause only
 *
 *      UUPS proxy, no ERC-2771 — direct wallet transactions.
 */
contract FeeDistributor is
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;

    // ============================================================
    //                        ROLES
    // ============================================================

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    // ============================================================
    //                        CUSTOM ERRORS
    // ============================================================

    error ZeroAddress();
    error ZeroAmount();
    error InvalidSplit();
    error PoolNotSet();
    error BelowMinimum();

    // ============================================================
    //                        STATE VARIABLES
    // ============================================================

    /// @notice wETH token address
    IERC20 public weth;

    /// @notice NOOK token address
    IERC20 public nook;

    // --- wETH destinations ---
    address public rdWallet;
    address public buybackWallet;
    address public agentRewardPool;

    // --- wETH split (basis points, must sum to 10000) ---
    uint16 public rdBps;
    uint16 public buybackBps;
    uint16 public agentRewardBps;

    // --- NOOK destinations ---
    address public citationPool;
    address public ecosystemWallet;

    // --- NOOK split (basis points, must sum to 10000) ---
    uint16 public citationBps;
    uint16 public ecosystemBps;

    // --- Accounting ---
    uint256 public totalWethDistributed;
    uint256 public totalNookDistributed;

    // --- V2 state ---
    uint256 public minDistributionAmount;

    /// @dev Storage gap for future upgrades (UUPS pattern)
    uint256[39] private __gap;

    // ============================================================
    //                          EVENTS
    // ============================================================

    event WethDistributed(
        uint256 total,
        uint256 rdAmount,
        uint256 buybackAmount,
        uint256 agentRewardAmount,
        uint256 timestamp
    );

    event NookDistributed(
        uint256 total,
        uint256 citationAmount,
        uint256 ecosystemAmount,
        uint256 timestamp
    );

    event WethSplitUpdated(uint16 rdBps, uint16 buybackBps, uint16 agentRewardBps);
    event NookSplitUpdated(uint16 citationBps, uint16 ecosystemBps);

    event RdWalletUpdated(address oldWallet, address newWallet);
    event BuybackWalletUpdated(address oldWallet, address newWallet);
    event AgentRewardPoolUpdated(address oldPool, address newPool);
    event CitationPoolUpdated(address oldPool, address newPool);
    event EcosystemWalletUpdated(address oldWallet, address newWallet);

    event EmergencyWithdraw(address indexed token, address indexed to, uint256 amount);
    event NativeETHRescued(address indexed to, uint256 amount);
    event MinDistributionAmountUpdated(uint256 oldAmount, uint256 newAmount);

    // ============================================================
    //                      INITIALIZERS
    // ============================================================

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the fee distributor (V1).
     * @param admin_ Temporary admin (gets DEFAULT_ADMIN_ROLE — use initializeAll for fresh deploys)
     * @param weth_ wETH token address
     * @param nook_ NOOK token address
     * @param rdWallet_ R&D wallet address
     * @param buybackWallet_ Buyback wallet address
     * @param ecosystemWallet_ Ecosystem fund wallet address
     */
    function initialize(
        address admin_,
        address weth_,
        address nook_,
        address rdWallet_,
        address buybackWallet_,
        address ecosystemWallet_
    ) external initializer {
        if (admin_ == address(0)) revert ZeroAddress();
        if (weth_ == address(0)) revert ZeroAddress();
        if (nook_ == address(0)) revert ZeroAddress();
        if (rdWallet_ == address(0)) revert ZeroAddress();
        if (buybackWallet_ == address(0)) revert ZeroAddress();
        if (ecosystemWallet_ == address(0)) revert ZeroAddress();

        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);

        weth = IERC20(weth_);
        nook = IERC20(nook_);

        rdWallet = rdWallet_;
        buybackWallet = buybackWallet_;
        ecosystemWallet = ecosystemWallet_;

        // Default wETH split: 50% R&D, 30% Buyback, 20% AgentRewardPool
        rdBps = 5000;
        buybackBps = 3000;
        agentRewardBps = 2000;

        // Default NOOK split: 40% Citation, 60% Ecosystem
        citationBps = 4000;
        ecosystemBps = 6000;
    }

    /**
     * @notice Atomic initializer combining V1 + V2 — use for fresh deploys to
     *         initialize atomically and avoid an uninitialized-implementation window
     *         between separate transactions.
     *         Skips Ownable entirely — all access via AccessControl roles.
     * @param admin_ Multi-sig address (gets DEFAULT_ADMIN_ROLE)
     * @param weth_ wETH token address
     * @param nook_ NOOK token address
     * @param rdWallet_ R&D wallet address
     * @param buybackWallet_ Buyback wallet address
     * @param ecosystemWallet_ Ecosystem fund wallet address
     * @param operator_ Operator EOA (gets OPERATOR_ROLE)
     * @param guardian_ Guardian EOA (gets GUARDIAN_ROLE)
     */
    function initializeAll(
        address admin_,
        address weth_,
        address nook_,
        address rdWallet_,
        address buybackWallet_,
        address ecosystemWallet_,
        address operator_,
        address guardian_
    ) external reinitializer(2) {
        if (admin_ == address(0)) revert ZeroAddress();
        if (weth_ == address(0)) revert ZeroAddress();
        if (nook_ == address(0)) revert ZeroAddress();
        if (rdWallet_ == address(0)) revert ZeroAddress();
        if (buybackWallet_ == address(0)) revert ZeroAddress();
        if (ecosystemWallet_ == address(0)) revert ZeroAddress();
        if (operator_ == address(0)) revert ZeroAddress();
        if (guardian_ == address(0)) revert ZeroAddress();

        // V1: core infrastructure
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        weth = IERC20(weth_);
        nook = IERC20(nook_);
        rdWallet = rdWallet_;
        buybackWallet = buybackWallet_;
        ecosystemWallet = ecosystemWallet_;

        // Default splits
        rdBps = 5000;
        buybackBps = 3000;
        agentRewardBps = 2000;
        citationBps = 4000;
        ecosystemBps = 6000;

        // V2: AccessControl roles + minDistribution
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(OPERATOR_ROLE, operator_);
        _grantRole(GUARDIAN_ROLE, guardian_);
        minDistributionAmount = 1e12;
    }

    /**
     * @notice V2 upgrade: set up role-based access control.
     * @param admin_ Multi-sig address (gets DEFAULT_ADMIN_ROLE)
     * @param operator_ Operator EOA (gets OPERATOR_ROLE)
     * @param guardian_ Guardian EOA (gets GUARDIAN_ROLE)
     */
    function initializeV2(
        address admin_,
        address operator_,
        address guardian_
    ) external reinitializer(2) {
        if (admin_ == address(0)) revert ZeroAddress();
        if (operator_ == address(0)) revert ZeroAddress();
        if (guardian_ == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(OPERATOR_ROLE, operator_);
        _grantRole(GUARDIAN_ROLE, guardian_);

        minDistributionAmount = 1e12;
    }

    // ============================================================
    //                    DISTRIBUTION
    // ============================================================

    /**
     * @notice Distribute a specific amount of wETH from the contract's balance.
     * @param amount Amount of wETH to distribute
     */
    function distributeWeth(uint256 amount) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount < minDistributionAmount) revert BelowMinimum();
        if (agentRewardPool == address(0)) revert PoolNotSet();

        _distributeWeth(amount);
    }

    /**
     * @notice Distribute a specific amount of NOOK from the contract's balance.
     * @param amount Amount of NOOK to distribute
     */
    function distributeNook(uint256 amount) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount < minDistributionAmount) revert BelowMinimum();
        if (citationPool == address(0)) revert PoolNotSet();

        _distributeNook(amount);
    }

    /**
     * @notice Distribute entire wETH and NOOK balances held by this contract.
     */
    function distributeAll() external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant {
        uint256 wethBal = weth.balanceOf(address(this));
        uint256 nookBal = nook.balanceOf(address(this));

        if (wethBal >= minDistributionAmount && wethBal > 0) {
            if (agentRewardPool == address(0)) revert PoolNotSet();
            _distributeWeth(wethBal);
        }

        if (nookBal >= minDistributionAmount && nookBal > 0) {
            if (citationPool == address(0)) revert PoolNotSet();
            _distributeNook(nookBal);
        }
    }

    // ============================================================
    //                  INTERNAL DISTRIBUTION
    // ============================================================

    function _distributeWeth(uint256 amount) internal {
        uint256 rdAmount = (amount * rdBps) / 10000;
        uint256 buybackAmount = (amount * buybackBps) / 10000;
        uint256 agentRewardAmount = amount - rdAmount - buybackAmount; // remainder avoids dust

        weth.safeTransfer(rdWallet, rdAmount);
        weth.safeTransfer(buybackWallet, buybackAmount);
        weth.safeTransfer(agentRewardPool, agentRewardAmount);

        totalWethDistributed += amount;

        emit WethDistributed(amount, rdAmount, buybackAmount, agentRewardAmount, block.timestamp);
    }

    function _distributeNook(uint256 amount) internal {
        uint256 citationAmount = (amount * citationBps) / 10000;
        uint256 ecosystemAmount = amount - citationAmount; // remainder avoids dust

        nook.safeTransfer(citationPool, citationAmount);
        nook.safeTransfer(ecosystemWallet, ecosystemAmount);

        totalNookDistributed += amount;

        emit NookDistributed(amount, citationAmount, ecosystemAmount, block.timestamp);
    }

    // ============================================================
    //                      VIEW FUNCTIONS
    // ============================================================

    /**
     * @notice Get the contract's current wETH balance.
     */
    function wethBalance() external view returns (uint256) {
        return weth.balanceOf(address(this));
    }

    /**
     * @notice Get the contract's current NOOK balance.
     */
    function nookBalance() external view returns (uint256) {
        return nook.balanceOf(address(this));
    }

    // ============================================================
    //                      ADMIN — SPLITS
    // ============================================================

    /**
     * @notice Update the wETH split.
     * @param rdBps_ R&D basis points
     * @param buybackBps_ Buyback basis points
     * @param agentRewardBps_ Agent reward basis points
     */
    function setWethSplit(
        uint16 rdBps_,
        uint16 buybackBps_,
        uint16 agentRewardBps_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (uint256(rdBps_) + buybackBps_ + agentRewardBps_ != 10000) revert InvalidSplit();

        rdBps = rdBps_;
        buybackBps = buybackBps_;
        agentRewardBps = agentRewardBps_;

        emit WethSplitUpdated(rdBps_, buybackBps_, agentRewardBps_);
    }

    /**
     * @notice Update the NOOK split.
     * @param citationBps_ Citation pool basis points
     * @param ecosystemBps_ Ecosystem wallet basis points
     */
    function setNookSplit(
        uint16 citationBps_,
        uint16 ecosystemBps_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (uint256(citationBps_) + ecosystemBps_ != 10000) revert InvalidSplit();

        citationBps = citationBps_;
        ecosystemBps = ecosystemBps_;

        emit NookSplitUpdated(citationBps_, ecosystemBps_);
    }

    // ============================================================
    //                  ADMIN — DESTINATIONS
    // ============================================================

    function setRdWallet(address wallet) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (wallet == address(0)) revert ZeroAddress();
        address old = rdWallet;
        rdWallet = wallet;
        emit RdWalletUpdated(old, wallet);
    }

    function setBuybackWallet(address wallet) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (wallet == address(0)) revert ZeroAddress();
        address old = buybackWallet;
        buybackWallet = wallet;
        emit BuybackWalletUpdated(old, wallet);
    }

    function setAgentRewardPool(address pool) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (pool == address(0)) revert ZeroAddress();
        address old = agentRewardPool;
        agentRewardPool = pool;
        emit AgentRewardPoolUpdated(old, pool);
    }

    function setCitationPool(address pool) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (pool == address(0)) revert ZeroAddress();
        address old = citationPool;
        citationPool = pool;
        emit CitationPoolUpdated(old, pool);
    }

    function setEcosystemWallet(address wallet) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (wallet == address(0)) revert ZeroAddress();
        address old = ecosystemWallet;
        ecosystemWallet = wallet;
        emit EcosystemWalletUpdated(old, wallet);
    }

    // ============================================================
    //                      ADMIN — SAFETY
    // ============================================================

    /**
     * @notice Emergency withdraw any ERC-20 token from the contract.
     * @param token The token to withdraw
     * @param to The recipient address
     * @param amount The amount to withdraw
     */
    function emergencyWithdraw(
        address token,
        address to,
        uint256 amount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(to, amount);
        emit EmergencyWithdraw(token, to, amount);
    }

    /**
     * @notice Rescue native ETH accidentally sent to this contract.
     * @param to Recipient address
     * @param amount Amount of ETH to rescue
     */
    function rescueETH(address payable to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        (bool success, ) = to.call{value: amount}("");
        require(success, "ETH transfer failed");
        emit NativeETHRescued(to, amount);
    }

    /**
     * @notice Set minimum distribution amount (anti-griefing).
     * @param amount New minimum amount in token wei
     */
    function setMinDistributionAmount(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 oldAmount = minDistributionAmount;
        minDistributionAmount = amount;
        emit MinDistributionAmountUpdated(oldAmount, amount);
    }

    /**
     * @notice Pause all distributions. Callable by guardian or admin.
     */
    function pause() external {
        if (!hasRole(GUARDIAN_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, GUARDIAN_ROLE);
        }
        _pause();
    }

    /**
     * @notice Unpause distributions. Admin only.
     */
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ============================================================
    //                      UUPS + INTROSPECTION
    // ============================================================

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    /**
     * @dev See {IERC165-supportsInterface}. Required because both
     *      AccessControlUpgradeable and ERC165 define supportsInterface.
     */
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControlUpgradeable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    /// @notice Accept native ETH transfers (so rescueETH can recover them).
    receive() external payable {}
}
