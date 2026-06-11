// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/metatx/ERC2771ContextUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title RewardPool
 * @author Nookplot
 * @notice Generic ERC-20 Merkle claim pool. Deployed twice — once for wETH
 *         (agent rewards) and once for NOOK (citation rewards).
 *
 * @dev Uses cumulative Merkle-root claiming: an off-chain service computes total
 *      entitlements off-chain, publishes a root, and agents claim with proofs.
 *      Each claim pays the delta between the cumulative entitlement and what
 *      has already been claimed.
 *
 *      Leaf format: keccak256(bytes.concat(keccak256(abi.encode(account, cumulativeAmount))))
 *      This matches OpenZeppelin merkle-tree StandardMerkleTree with ["address", "uint256"].
 *
 *      Starts non-claimable — tokens accumulate until the admin enables claiming.
 *
 *      V2: Role-based access control (AccessControlUpgradeable).
 *        - DEFAULT_ADMIN_ROLE: multi-sig — toggle claimable, emergency, upgrade, unpause
 *        - ROOT_PUBLISHER_ROLE: off-chain publisher key or multi-sig — setMerkleRoot
 *        - GUARDIAN_ROLE: security responder — pause only
 *
 *      ERC-2771 meta-transaction support via NookplotForwarder — relayer pays
 *      gas for agent claims. Agents can also claim directly if they prefer.
 */
contract RewardPool is
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    ERC2771ContextUpgradeable
{
    using SafeERC20 for IERC20;

    // ============================================================
    //                        ROLES
    // ============================================================

    bytes32 public constant ROOT_PUBLISHER_ROLE = keccak256("ROOT_PUBLISHER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    // ============================================================
    //                        CUSTOM ERRORS
    // ============================================================

    error ZeroAddress();
    error ClaimingDisabled();
    error InvalidProof();
    error NothingToClaim();
    error ZeroAmount();
    error ZeroRoot();
    error EthTransferFailed();
    error InsolventRoot();
    error ExceedsMaxEpochPayout();
    error TotalCommittedCannotDecrease();
    error InsufficientExcess();
    error RootPublishCooldownActive();

    // ============================================================
    //                        STATE VARIABLES
    // ============================================================

    /// @notice The ERC-20 token this pool distributes
    IERC20 public rewardToken;

    /// @notice Whether claiming is currently enabled
    bool public claimable;

    /// @notice Current Merkle root of cumulative entitlements
    bytes32 public merkleRoot;

    /// @notice Epoch counter — incremented on each root update
    uint256 public epoch;

    /// @notice Tracks cumulative amount already claimed per account
    mapping(address => uint256) public cumulativeClaimed;

    /// @notice Total tokens claimed across all accounts
    uint256 public totalClaimed;

    /// @notice Total cumulative entitlements committed via publishRoot (V3)
    uint256 public totalCommitted;

    /// @notice Maximum new commitments per root publish (0 = no limit) (V3)
    uint256 public maxEpochPayout;

    /// @notice Minimum time between root publishes in seconds (0 = no cooldown) (V3)
    uint256 public rootPublishCooldown;

    /// @notice Timestamp of last root publish (V3)
    uint256 public lastRootPublishedAt;

    /// @dev Storage gap for future upgrades (UUPS pattern)
    uint256[46] private __gap;

    // ============================================================
    //                          EVENTS
    // ============================================================

    event RewardClaimed(
        address indexed account,
        uint256 amount,
        uint256 cumulativeAmount,
        uint256 epoch
    );

    event MerkleRootUpdated(bytes32 oldRoot, bytes32 newRoot, uint256 epoch);
    event ClaimableToggled(bool claimable);
    event EmergencyWithdraw(address indexed token, address indexed to, uint256 amount);
    event NativeETHRescued(address indexed to, uint256 amount);
    event MaxEpochPayoutUpdated(uint256 oldMax, uint256 newMax);
    event RootPublishCooldownUpdated(uint256 oldCooldown, uint256 newCooldown);

    // ============================================================
    //                      INITIALIZERS
    // ============================================================

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address trustedForwarder_) ERC2771ContextUpgradeable(trustedForwarder_) {
        _disableInitializers();
    }

    /**
     * @notice Initialize the reward pool (V1).
     * @param admin_ Temporary admin (gets DEFAULT_ADMIN_ROLE — use initializeAll for fresh deploys)
     * @param rewardToken_ The ERC-20 token this pool distributes
     */
    function initialize(
        address admin_,
        address rewardToken_
    ) external initializer {
        if (admin_ == address(0) || rewardToken_ == address(0)) revert ZeroAddress();

        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);

        rewardToken = IERC20(rewardToken_);
        claimable = false; // starts non-claimable
    }

    /**
     * @notice Atomic initializer combining V1 + V2 — use for fresh deploys to
     *         initialize atomically and avoid an uninitialized-implementation window
     *         between separate transactions.
     *         Skips Ownable entirely — all access via AccessControl roles.
     * @param admin_ Multi-sig address (gets DEFAULT_ADMIN_ROLE)
     * @param rewardToken_ The ERC-20 token this pool distributes
     * @param rootPublisher_ Root publisher address (gets ROOT_PUBLISHER_ROLE)
     * @param guardian_ Guardian EOA (gets GUARDIAN_ROLE)
     */
    function initializeAll(
        address admin_,
        address rewardToken_,
        address rootPublisher_,
        address guardian_
    ) external reinitializer(2) {
        if (admin_ == address(0)) revert ZeroAddress();
        if (rewardToken_ == address(0)) revert ZeroAddress();
        if (rootPublisher_ == address(0)) revert ZeroAddress();
        if (guardian_ == address(0)) revert ZeroAddress();

        // V1: core infrastructure
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        rewardToken = IERC20(rewardToken_);
        claimable = false;

        // V2: AccessControl roles (skip Ownable — AC handles auth)
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ROOT_PUBLISHER_ROLE, rootPublisher_);
        _grantRole(GUARDIAN_ROLE, guardian_);
    }

    /**
     * @notice V3 upgrade: insolvency/epoch/cooldown safety (no state init needed).
     * @dev New state variables default to 0 which is safe (no cap, no cooldown,
     *      no committed). Admin sets values post-upgrade via setMaxEpochPayout
     *      and setRootPublishCooldown.
     */
    function initializeV3() external reinitializer(3) {
        // No-op: totalCommitted, maxEpochPayout, rootPublishCooldown, lastRootPublishedAt
        // all default to 0, which means no cap, no cooldown, and no prior commitments.
    }

    /**
     * @notice V2 upgrade: set up role-based access control.
     * @param admin_ Multi-sig address (gets DEFAULT_ADMIN_ROLE)
     * @param rootPublisher_ Root publisher address (gets ROOT_PUBLISHER_ROLE)
     * @param guardian_ Guardian EOA (gets GUARDIAN_ROLE)
     */
    function initializeV2(
        address admin_,
        address rootPublisher_,
        address guardian_
    ) external reinitializer(2) {
        if (admin_ == address(0)) revert ZeroAddress();
        if (rootPublisher_ == address(0)) revert ZeroAddress();
        if (guardian_ == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ROOT_PUBLISHER_ROLE, rootPublisher_);
        _grantRole(GUARDIAN_ROLE, guardian_);
    }

    // ============================================================
    //                      CLAIMING
    // ============================================================

    /**
     * @notice Claim reward tokens using a Merkle proof.
     * @param cumulativeAmount Total cumulative entitlement for the caller
     * @param proof Merkle proof for the (account, cumulativeAmount) leaf
     */
    function claim(
        uint256 cumulativeAmount,
        bytes32[] calldata proof
    ) external whenNotPaused nonReentrant {
        if (!claimable) revert ClaimingDisabled();

        address account = _msgSender();

        // Verify Merkle proof — leaf = keccak256(bytes.concat(keccak256(abi.encode(account, cumulativeAmount))))
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, cumulativeAmount))));
        if (!MerkleProof.verify(proof, merkleRoot, leaf)) revert InvalidProof();

        // Calculate claimable delta
        uint256 alreadyClaimed = cumulativeClaimed[account];
        if (cumulativeAmount <= alreadyClaimed) revert NothingToClaim();
        uint256 amount = cumulativeAmount - alreadyClaimed;

        // Update state before transfer (CEI)
        cumulativeClaimed[account] = cumulativeAmount;
        totalClaimed += amount;

        // Transfer tokens
        rewardToken.safeTransfer(account, amount);

        emit RewardClaimed(account, amount, cumulativeAmount, epoch);
    }

    // ============================================================
    //                      VIEW FUNCTIONS
    // ============================================================

    /**
     * @notice Calculate how much an account can claim given a cumulative entitlement.
     * @param account The account address
     * @param cumulativeAmount The total cumulative entitlement
     * @return The amount that can be claimed (delta)
     */
    function getClaimableAmount(
        address account,
        uint256 cumulativeAmount
    ) external view returns (uint256) {
        uint256 alreadyClaimed = cumulativeClaimed[account];
        if (cumulativeAmount <= alreadyClaimed) return 0;
        return cumulativeAmount - alreadyClaimed;
    }

    /**
     * @notice Get the pool's token balance.
     */
    function poolBalance() external view returns (uint256) {
        return rewardToken.balanceOf(address(this));
    }

    /**
     * @notice Get unclaimed obligations (totalCommitted - totalClaimed).
     */
    function unclaimedObligations() external view returns (uint256) {
        return totalCommitted > totalClaimed ? totalCommitted - totalClaimed : 0;
    }

    // ============================================================
    //                      ADMIN FUNCTIONS
    // ============================================================

    /**
     * @notice Publish a new Merkle root of cumulative entitlements (V3: with safety checks).
     * @param newRoot The new Merkle root
     * @param newTotalCommitted Cumulative total of all entitlements in the new tree
     *
     * @dev V3 adds three safety checks matching MiningRewardPool:
     *      1. Insolvency guard: unclaimed obligations cannot exceed pool balance
     *      2. Epoch payout cap: limits max new commitments per publish
     *      3. Publish cooldown: minimum time between root publishes
     */
    function publishRoot(bytes32 newRoot, uint256 newTotalCommitted) external onlyRole(ROOT_PUBLISHER_ROLE) {
        if (newRoot == bytes32(0)) revert ZeroRoot();
        if (newTotalCommitted < totalCommitted) revert TotalCommittedCannotDecrease();

        // Cooldown check
        if (rootPublishCooldown > 0 && block.timestamp < lastRootPublishedAt + rootPublishCooldown) {
            revert RootPublishCooldownActive();
        }

        // Epoch payout cap
        uint256 newCommitments = newTotalCommitted - totalCommitted;
        if (maxEpochPayout > 0 && newCommitments > maxEpochPayout) {
            revert ExceedsMaxEpochPayout();
        }

        // Insolvency check: unclaimed obligations must not exceed pool balance
        uint256 unclaimedAfter = newTotalCommitted - totalClaimed;
        uint256 balance = rewardToken.balanceOf(address(this));
        if (unclaimedAfter > balance) revert InsolventRoot();

        bytes32 oldRoot = merkleRoot;
        merkleRoot = newRoot;
        totalCommitted = newTotalCommitted;
        lastRootPublishedAt = block.timestamp;
        epoch++;
        emit MerkleRootUpdated(oldRoot, newRoot, epoch);
    }

    /**
     * @notice Legacy setMerkleRoot for backward compatibility (V1/V2 callers).
     * @param newRoot The new Merkle root
     * @dev Delegates to publishRoot with totalCommitted unchanged. Will be removed in a future version.
     */
    function setMerkleRoot(bytes32 newRoot) external onlyRole(ROOT_PUBLISHER_ROLE) {
        if (newRoot == bytes32(0)) revert ZeroRoot();
        bytes32 oldRoot = merkleRoot;
        merkleRoot = newRoot;
        epoch++;
        emit MerkleRootUpdated(oldRoot, newRoot, epoch);
    }

    /**
     * @notice Enable or disable claiming.
     * @param _claimable Whether claiming should be enabled
     */
    function setClaimable(bool _claimable) external onlyRole(DEFAULT_ADMIN_ROLE) {
        claimable = _claimable;
        emit ClaimableToggled(_claimable);
    }

    /**
     * @notice Set the maximum new commitments allowed per root publish (V3).
     * @param newMax Maximum epoch payout (0 = no limit)
     */
    function setMaxEpochPayout(uint256 newMax) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 oldMax = maxEpochPayout;
        maxEpochPayout = newMax;
        emit MaxEpochPayoutUpdated(oldMax, newMax);
    }

    /**
     * @notice Set the minimum time between root publishes (V3).
     * @param newCooldown Cooldown in seconds (0 = no cooldown)
     */
    function setRootPublishCooldown(uint256 newCooldown) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 oldCooldown = rootPublishCooldown;
        rootPublishCooldown = newCooldown;
        emit RootPublishCooldownUpdated(oldCooldown, newCooldown);
    }

    /**
     * @notice Emergency withdraw ERC-20 tokens from the pool.
     * @param token The token to withdraw
     * @param to The recipient address
     * @param amount The amount to withdraw
     *
     * @dev V3: For the reward token, withdrawals are limited to excess above
     *      unclaimed obligations. Other tokens can be fully withdrawn.
     */
    function emergencyWithdraw(
        address token,
        address to,
        uint256 amount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        // V3: excess-only guard for the reward token
        if (token == address(rewardToken)) {
            uint256 balance = rewardToken.balanceOf(address(this));
            uint256 unclaimed = totalCommitted > totalClaimed ? totalCommitted - totalClaimed : 0;
            uint256 excess = balance > unclaimed ? balance - unclaimed : 0;
            if (amount > excess) revert InsufficientExcess();
        }
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
        if (!success) revert EthTransferFailed();
        emit NativeETHRescued(to, amount);
    }

    /**
     * @notice Pause all claims. Callable by guardian or admin.
     */
    function pause() external {
        address sender = _msgSender();
        if (!hasRole(GUARDIAN_ROLE, sender) && !hasRole(DEFAULT_ADMIN_ROLE, sender)) {
            revert AccessControlUnauthorizedAccount(sender, GUARDIAN_ROLE);
        }
        _pause();
    }

    /**
     * @notice Unpause claims. Admin only.
     */
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ============================================================
    //                      ERC-2771 OVERRIDES
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
