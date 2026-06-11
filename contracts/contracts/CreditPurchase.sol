// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title CreditPurchase
 * @author Nookplot
 * @notice On-chain credit pack purchasing with USDC or NOOK token.
 *         Users buy packs that emit events; an authorized off-chain service
 *         picks up events and credits agent accounts off-chain.
 *         NOOK purchases route to FeeDistributor at a tiered discount.
 *
 * @dev UUPS proxy. No ERC-2771 needed — purchases are direct wallet tx,
 *      not meta-transactions.
 */
contract CreditPurchase is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;

    // ============================================================
    //                        CUSTOM ERRORS
    // ============================================================

    error ZeroAddress();
    error PackNotFound();
    error PackInactive();
    error InsufficientAllowance();
    error InvalidPackConfig();
    error NookNotEnabled();
    error NookPriceNotSet();
    error FeeDistributorNotSet();
    error ZeroAmount();
    error EthTransferFailed();

    // ============================================================
    //                          TYPES
    // ============================================================

    struct Pack {
        string name;
        uint256 usdcPrice;      // 6 decimals (USDC)
        uint256 creditAmount;   // stored credits (100 = 1.00 display)
        bool active;
    }

    // ============================================================
    //                         EVENTS
    // ============================================================

    event CreditsPurchased(
        address indexed buyer,
        uint256 indexed packId,
        uint256 creditAmount,
        uint256 pricePaid,
        bool isNook,
        uint256 timestamp
    );

    event PackAdded(uint256 indexed packId, string name, uint256 usdcPrice, uint256 creditAmount);
    event PackUpdated(uint256 indexed packId, bool active);

    // ============================================================
    //                        STORAGE
    // ============================================================

    IERC20 public usdc;
    address public treasury;

    Pack[] public packs;

    // --- V2 storage (appended — safe for UUPS proxy) ---
    IERC20 public nook;                            // NOOK token
    address public feeDistributor;                 // receives NOOK revenue (not treasury)
    bool public nookEnabled;                       // feature gate, starts false
    mapping(uint256 => uint256) public nookPrices; // packId → NOOK price (18 decimals)

    uint256[46] private __gap;                     // storage gap for future upgrades

    // ============================================================
    //                      INITIALIZER
    // ============================================================

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address owner_,
        address usdc_,
        address treasury_
    ) external initializer {
        if (owner_ == address(0) || usdc_ == address(0) || treasury_ == address(0)) revert ZeroAddress();

        __Ownable_init(owner_);
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        usdc = IERC20(usdc_);
        treasury = treasury_;
    }

    // ============================================================
    //                      PURCHASE
    // ============================================================

    /**
     * @notice Purchase a credit pack with USDC.
     * @param packId Index into the packs array.
     */
    function purchaseWithUSDC(uint256 packId) external whenNotPaused nonReentrant {
        if (packId >= packs.length) revert PackNotFound();
        Pack storage pack = packs[packId];
        if (!pack.active) revert PackInactive();

        uint256 price = pack.usdcPrice;
        usdc.safeTransferFrom(msg.sender, treasury, price);

        emit CreditsPurchased(msg.sender, packId, pack.creditAmount, price, false, block.timestamp);
    }

    /**
     * @notice Purchase a credit pack with NOOK token (discounted).
     * @param packId Index into the packs array.
     */
    function purchaseWithNook(uint256 packId) external whenNotPaused nonReentrant {
        if (!nookEnabled) revert NookNotEnabled();
        if (address(nook) == address(0)) revert NookNotEnabled();
        if (feeDistributor == address(0)) revert FeeDistributorNotSet();
        if (packId >= packs.length) revert PackNotFound();

        Pack storage pack = packs[packId];
        if (!pack.active) revert PackInactive();

        uint256 price = nookPrices[packId];
        if (price == 0) revert NookPriceNotSet();

        nook.safeTransferFrom(msg.sender, feeDistributor, price);

        emit CreditsPurchased(msg.sender, packId, pack.creditAmount, price, true, block.timestamp);
    }

    // ============================================================
    //                    ADMIN — PACKS
    // ============================================================

    /**
     * @notice Add a new credit pack.
     * @param name_ Human-readable name (e.g. "Micro", "Standard", "Bulk").
     * @param usdcPrice_ Price in USDC (6 decimals).
     * @param creditAmount_ Credits awarded (stored credits, 100 = 1.00 display).
     */
    function addPack(
        string calldata name_,
        uint256 usdcPrice_,
        uint256 creditAmount_
    ) external onlyOwner {
        if (usdcPrice_ == 0 || creditAmount_ == 0) revert InvalidPackConfig();

        packs.push(Pack({
            name: name_,
            usdcPrice: usdcPrice_,
            creditAmount: creditAmount_,
            active: true
        }));

        emit PackAdded(packs.length - 1, name_, usdcPrice_, creditAmount_);
    }

    /**
     * @notice Update a pack's active status.
     */
    function updatePackActive(uint256 packId, bool active_) external onlyOwner {
        if (packId >= packs.length) revert PackNotFound();
        packs[packId].active = active_;
        emit PackUpdated(packId, active_);
    }

    /**
     * @notice Update a pack's USDC price.
     */
    function updatePackPrice(uint256 packId, uint256 usdcPrice_) external onlyOwner {
        if (packId >= packs.length) revert PackNotFound();
        if (usdcPrice_ > 0) packs[packId].usdcPrice = usdcPrice_;
    }

    // ============================================================
    //                    ADMIN — CONFIG
    // ============================================================

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
    }

    function setNookToken(address nook_) external onlyOwner {
        if (nook_ == address(0)) revert ZeroAddress();
        nook = IERC20(nook_);
    }

    function setFeeDistributor(address feeDistributor_) external onlyOwner {
        if (feeDistributor_ == address(0)) revert ZeroAddress();
        feeDistributor = feeDistributor_;
    }

    function setNookEnabled(bool enabled_) external onlyOwner {
        nookEnabled = enabled_;
    }

    function setNookPrice(uint256 packId, uint256 price_) external onlyOwner {
        if (packId >= packs.length) revert PackNotFound();
        nookPrices[packId] = price_;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ============================================================
    //                       VIEW
    // ============================================================

    function getPackCount() external view returns (uint256) {
        return packs.length;
    }

    function getPack(uint256 packId) external view returns (Pack memory) {
        if (packId >= packs.length) revert PackNotFound();
        return packs[packId];
    }

    function getNookPrice(uint256 packId) external view returns (uint256) {
        if (packId >= packs.length) revert PackNotFound();
        return nookPrices[packId];
    }

    function getActivePacks() external view returns (Pack[] memory, uint256[] memory) {
        uint256 count;
        for (uint256 i = 0; i < packs.length; i++) {
            if (packs[i].active) count++;
        }

        Pack[] memory activePacks = new Pack[](count);
        uint256[] memory ids = new uint256[](count);
        uint256 idx;
        for (uint256 i = 0; i < packs.length; i++) {
            if (packs[i].active) {
                activePacks[idx] = packs[i];
                ids[idx] = i;
                idx++;
            }
        }
        return (activePacks, ids);
    }

    // ============================================================
    //                   EMERGENCY WITHDRAW
    // ============================================================

    event EmergencyWithdraw(address indexed token, address indexed to, uint256 amount);
    event EmergencyETHWithdraw(address indexed to, uint256 amount);

    /// @notice Withdraw stuck ERC-20 tokens sent to this contract by mistake.
    function emergencyWithdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(to, amount);
        emit EmergencyWithdraw(token, to, amount);
    }

    /// @notice Rescue stuck ETH sent to this contract by mistake.
    function rescueETH(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        (bool success, ) = to.call{value: amount}("");
        if (!success) revert EthTransferFailed();
        emit EmergencyETHWithdraw(to, amount);
    }

    // ============================================================
    //                  OWNERSHIP RENOUNCE GUARD
    // ============================================================

    /// @notice Prevent accidental ownership renouncement — would permanently brick admin functions.
    function renounceOwnership() public pure override {
        revert("Cannot renounce ownership");
    }

    // ============================================================
    //                      UUPS
    // ============================================================

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
