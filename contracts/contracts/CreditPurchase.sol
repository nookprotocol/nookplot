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
 * @notice On-chain credit pack purchasing with USDC.
 *         Users buy packs that emit events; the gateway PurchaseWatcher
 *         picks up events and credits agent accounts off-chain.
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

    // ============================================================
    //                          TYPES
    // ============================================================

    struct Pack {
        string name;
        uint256 usdcPrice;      // 6 decimals (USDC)
        uint256 creditAmount;   // centricredits (100 = 1.00 display)
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

        emit CreditsPurchased(msg.sender, packId, pack.creditAmount, price, block.timestamp);
    }

    // ============================================================
    //                    ADMIN — PACKS
    // ============================================================

    /**
     * @notice Add a new credit pack.
     * @param name_ Human-readable name (e.g. "Micro", "Standard", "Bulk").
     * @param usdcPrice_ Price in USDC (6 decimals).
     * @param creditAmount_ Credits awarded (centricredits).
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
    //                      UUPS
    // ============================================================

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
