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
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title MiningRewardPool
 * @author Nookplot
 * @notice NOOK-only Merkle claim pool for mining rewards. Purpose-built for
 *         the mining system — agents earn rewards by solving challenges and
 *         verifying submissions, then claim via Merkle proof.
 *
 * @dev Uses cumulative Merkle-root claiming: an off-chain service computes total
 *      entitlements off-chain, a root publisher publishes the root on-chain,
 *      and agents claim with proofs. Each claim pays the delta between the
 *      cumulative entitlement and what has already been claimed.
 *
 *      Leaf format: keccak256(bytes.concat(keccak256(abi.encode(account, cumulativeAmount))))
 *      This matches OpenZeppelin merkle-tree StandardMerkleTree with ["address", "uint256"].
 *
 *      Insolvency protection: the root publisher must declare `totalCommitted`
 *      (sum of all cumulative entitlements in the tree). The contract ensures
 *      unclaimed obligations never exceed the pool's NOOK balance.
 *
 *      Optional max epoch payout caps how much new reward can be committed per
 *      root update — limits damage from a compromised publisher key.
 *
 *      Uses Ownable (not AccessControl) for consistency with MiningStake.
 *      Root publisher is a separate trusted address that can only publish roots.
 *
 *      ERC-2771 meta-transaction support via NookplotForwarder — relayer pays
 *      gas for agent claims.
 *
 *      Storage gaps reserved for future features.
 *
 * UPGRADEABILITY: Do NOT reorder inheritance — storage layout depends on this exact order.
 */
contract MiningRewardPool is
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

    /// @notice Thrown when the zero address is passed where it shouldn't be
    error ZeroAddress();

    /// @notice Thrown when a zero amount is passed
    error ZeroAmount();

    /// @notice Thrown when a zero Merkle root is submitted
    error ZeroRoot();

    /// @notice Thrown when claiming is disabled
    error ClaimingDisabled();

    /// @notice Thrown when a Merkle proof is invalid
    error InvalidProof();

    /// @notice Thrown when an agent has nothing to claim (already claimed up to cumulative amount)
    error NothingToClaim();

    /// @notice Thrown when a new root would make the pool insolvent (obligations > balance)
    error InsolventRoot();

    /// @notice Thrown when new commitments exceed the max epoch payout
    error ExceedsMaxEpochPayout();

    /// @notice Thrown when newTotalCommitted is less than the previous value (must be cumulative)
    error TotalCommittedCannotDecrease();

    /// @notice Thrown when emergency withdraw exceeds the excess NOOK balance
    error InsufficientExcess();

    /// @notice Thrown when an ETH transfer fails
    error EthTransferFailed();

    /// @notice Thrown when a non-authorized caller tries to publish a root (requires ROOT_PUBLISHER_ROLE or owner)
    error NotRootPublisher();

    /// @notice Thrown when publishRoot is called before the cooldown has elapsed
    error RootPublishCooldownActive();

    /// @notice Thrown when a claim would push totalClaimed above totalCommitted (defense-in-depth)
    error ClaimsExceedCommitted();

    /// @notice Thrown when publishRoot sets totalCommitted below what has already been claimed
    error TotalCommittedBelowClaimed();

    // ============================================================
    //                        STATE VARIABLES
    // ============================================================

    /// @notice The NOOK ERC-20 token (hardcoded at initialization, not changeable)
    IERC20 public nookToken;

    /// @notice Address authorized to publish Merkle roots (settable by admin)
    address public rootPublisher;

    /// @notice Whether claiming is currently enabled
    bool public claimable;

    /// @notice Current Merkle root of cumulative entitlements
    bytes32 public merkleRoot;

    /// @notice Epoch counter — incremented on each root update
    uint256 public epoch;

    /// @notice Total cumulative obligations across all agents (declared by publisher)
    uint256 public totalCommitted;

    /// @notice Total NOOK claimed across all accounts
    uint256 public totalClaimed;

    /// @notice Maximum new commitment allowed per root update (0 = no limit)
    uint256 public maxEpochPayout;

    /// @notice Tracks cumulative amount already claimed per account
    mapping(address => uint256) public cumulativeClaimed;

    /// @notice Minimum time between successive publishRoot calls (0 = no cooldown).
    ///         Without this, a compromised root publisher can bypass maxEpochPayout
    ///         by calling publishRoot hundreds of times in one block.
    uint256 public rootPublishCooldown;

    /// @notice Timestamp of the last publishRoot call
    uint256 public lastRootPublishedAt;

    /// @dev Storage gap for future upgrades (reduced from 40 to 38 — 2 uint256 added)
    uint256[38] private __gap;

    // ============================================================
    //                          EVENTS
    // ============================================================

    /// @notice Emitted when an agent claims mining rewards
    event RewardClaimed(
        address indexed account,
        uint256 amount,
        uint256 cumulativeAmount,
        uint256 epoch
    );

    /// @notice Emitted when a new Merkle root is published
    event MerkleRootPublished(
        bytes32 oldRoot,
        bytes32 newRoot,
        uint256 epoch,
        uint256 totalCommitted
    );

    /// @notice Emitted when claiming is enabled or disabled
    event ClaimableToggled(bool claimable);

    /// @notice Emitted when max epoch payout is changed
    event MaxEpochPayoutUpdated(uint256 oldMax, uint256 newMax);

    /// @notice Emitted when the root publisher address is changed
    event RootPublisherUpdated(address indexed oldPublisher, address indexed newPublisher);

    /// @notice Emitted when the root publish cooldown is changed
    event RootPublishCooldownUpdated(uint256 oldCooldown, uint256 newCooldown);

    /// @notice Emitted when admin emergency-withdraws stuck tokens
    event EmergencyWithdraw(address indexed token, address indexed to, uint256 amount);

    /// @notice Emitted when admin rescues native ETH from the contract
    event NativeETHRescued(address indexed to, uint256 amount);

    // ============================================================
    //                        INITIALIZER
    // ============================================================

    /// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
    constructor(address trustedForwarder_) ERC2771ContextUpgradeable(trustedForwarder_) {
        _disableInitializers();
    }

    /**
     * @notice Initialize the MiningRewardPool contract (atomic — all params in one TX).
     * @param owner_ Address that will own this contract (admin)
     * @param nookToken_ Address of the NOOK ERC-20 token
     * @param rootPublisher_ Address authorized to publish Merkle roots
     *
     * @dev Encoded in ERC1967Proxy constructor data for atomic deploy — initialize
     *      atomically to avoid an uninitialized-implementation window.
     *
     *      INITIAL STATE:
     *      maxEpochPayout defaults to 0 (no per-epoch cap). The insolvency check
     *      (unclaimedObligations <= balance) prevents committing more than the actual
     *      balance, so funds cannot be over-committed. Set via setMaxEpochPayout().
     *
     *      rootPublishCooldown defaults to 0 (no cooldown). The cooldown adds rate
     *      limiting as defense-in-depth, bounding how fast commitments can accumulate
     *      even when each call is valid within the balance. Set via setRootPublishCooldown().
     *
     *      Pool starts unfunded. publishRoot reverts with InsolventRoot until NOOK is
     *      transferred. Safe but non-functional until funded.
     */
    function initialize(
        address owner_,
        address nookToken_,
        address rootPublisher_
    ) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        if (nookToken_ == address(0)) revert ZeroAddress();
        if (rootPublisher_ == address(0)) revert ZeroAddress();

        __Ownable_init(owner_);
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        nookToken = IERC20(nookToken_);
        rootPublisher = rootPublisher_;
        claimable = false; // starts non-claimable
        // epoch, totalCommitted, totalClaimed, maxEpochPayout default to 0
    }

    // ============================================================
    //                      CLAIMING
    // ============================================================

    /**
     * @notice Claim mining rewards using a Merkle proof.
     * @param cumulativeAmount Total cumulative entitlement for the caller
     * @param proof Merkle proof for the (account, cumulativeAmount) leaf
     *
     * @dev The caller receives the delta between their cumulative entitlement
     *      and what they have already claimed. Reverts if nothing to claim.
     *
     * Emits {RewardClaimed}.
     */
    function claim(
        uint256 cumulativeAmount,
        bytes32[] calldata proof
    ) external whenNotPaused nonReentrant {
        if (!claimable) revert ClaimingDisabled();

        address account = _msgSender();

        // Verify Merkle proof
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, cumulativeAmount))));
        if (!MerkleProof.verify(proof, merkleRoot, leaf)) revert InvalidProof();

        // Calculate claimable delta
        uint256 alreadyClaimed = cumulativeClaimed[account];
        if (cumulativeAmount <= alreadyClaimed) revert NothingToClaim();
        // Safe: cumulativeAmount > alreadyClaimed checked above
        uint256 amount;
        unchecked { amount = cumulativeAmount - alreadyClaimed; }

        // Defense-in-depth: block claims that would push totalClaimed above totalCommitted.
        // An honest root publisher never triggers this — it catches the case where a
        // compromised publisher submits a Merkle tree whose leaf sums exceed the declared
        // totalCommitted. Without this, emergencyWithdraw would see the over-claimed NOOK
        // as "excess" (since unclaimedObligations returns 0 when totalClaimed > totalCommitted).
        if (totalClaimed + amount > totalCommitted) revert ClaimsExceedCommitted();

        // Effects: update state BEFORE external call (CEI pattern)
        cumulativeClaimed[account] = cumulativeAmount;
        totalClaimed += amount;

        // Interactions: transfer NOOK to agent
        nookToken.safeTransfer(account, amount);

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
     * @notice Get the pool's NOOK balance.
     * @return Current NOOK token balance of this contract
     */
    function poolBalance() external view returns (uint256) {
        return nookToken.balanceOf(address(this));
    }

    /**
     * @notice Get the unclaimed obligation (total committed minus total claimed).
     * @return Amount of NOOK that is committed but not yet claimed
     */
    function unclaimedObligations() external view returns (uint256) {
        return totalCommitted > totalClaimed ? totalCommitted - totalClaimed : 0;
    }

    // ============================================================
    //                   ROOT PUBLISHING
    // ============================================================

    /**
     * @notice Publish a new Merkle root of cumulative entitlements.
     * @param newRoot The new Merkle root
     * @param newTotalCommitted Total cumulative obligations across all agents in the tree
     *
     * @dev Only callable by the root publisher or admin. Validates:
     *      1. newTotalCommitted >= previous (cumulative, can only go up)
     *      2. If maxEpochPayout > 0: new commitments don't exceed cap
     *      3. Unclaimed obligations don't exceed pool balance (insolvency check)
     *
     * Emits {MerkleRootPublished}.
     */
    function publishRoot(
        bytes32 newRoot,
        uint256 newTotalCommitted
    ) external whenNotPaused nonReentrant {
        // Use msg.sender (not _msgSender) — root publishing should never go through
        // the forwarder. Keeps the forwarder out of the trust path for this critical
        // function. The authorized publisher has its own ETH for gas.
        if (msg.sender != rootPublisher && msg.sender != owner()) revert NotRootPublisher();
        if (newRoot == bytes32(0)) revert ZeroRoot();
        if (newTotalCommitted < totalCommitted) revert TotalCommittedCannotDecrease();

        // Defense-in-depth: cannot set totalCommitted below what has already been claimed.
        // This catches the edge case where a publisher tries to "rewind" committed obligations
        // to below the already-claimed watermark (which would break unclaimedObligations math).
        if (newTotalCommitted < totalClaimed) revert TotalCommittedBelowClaimed();

        // Cooldown between successive publishRoot calls. Without this, a compromised
        // root publisher can bypass maxEpochPayout by calling publishRoot N times in
        // one block, ratcheting totalCommitted up to the pool balance.
        if (rootPublishCooldown > 0 && block.timestamp < lastRootPublishedAt + rootPublishCooldown) {
            revert RootPublishCooldownActive();
        }

        // Max epoch payout check (0 = no limit)
        // Safe: newTotalCommitted >= totalCommitted checked above
        uint256 newCommitments;
        unchecked { newCommitments = newTotalCommitted - totalCommitted; }
        if (maxEpochPayout > 0 && newCommitments > maxEpochPayout) {
            revert ExceedsMaxEpochPayout();
        }

        // Insolvency check: unclaimed obligations must not exceed pool balance
        uint256 unclaimedAfter = newTotalCommitted > totalClaimed ? newTotalCommitted - totalClaimed : 0;
        uint256 balance = nookToken.balanceOf(address(this));
        if (unclaimedAfter > balance) revert InsolventRoot();

        // Effects
        bytes32 oldRoot = merkleRoot;
        merkleRoot = newRoot;
        totalCommitted = newTotalCommitted;
        lastRootPublishedAt = block.timestamp;
        unchecked { epoch++; } // Cannot overflow uint256 in practice

        emit MerkleRootPublished(oldRoot, newRoot, epoch, newTotalCommitted);
    }

    // ============================================================
    //                      ADMIN FUNCTIONS
    // ============================================================

    /**
     * @notice Enable or disable claiming.
     * @param _claimable Whether claiming should be enabled
     *
     * Emits {ClaimableToggled}.
     */
    function setClaimable(bool _claimable) external onlyOwner {
        claimable = _claimable;
        emit ClaimableToggled(_claimable);
    }

    /**
     * @notice Set the maximum new commitment allowed per root update.
     * @param _maxEpochPayout New max epoch payout (0 = no limit)
     *
     * Emits {MaxEpochPayoutUpdated}.
     */
    function setMaxEpochPayout(uint256 _maxEpochPayout) external onlyOwner {
        uint256 oldMax = maxEpochPayout;
        maxEpochPayout = _maxEpochPayout;
        emit MaxEpochPayoutUpdated(oldMax, _maxEpochPayout);
    }

    /**
     * @notice Set the minimum cooldown between publishRoot calls.
     * @param _cooldown New cooldown in seconds (0 = no cooldown)
     *
     * @dev Without a cooldown, maxEpochPayout can be bypassed by calling publishRoot
     *      many times in a single block. The cooldown rate-limits publishing so that
     *      commitments accumulate gradually rather than all at once.
     *
     * Emits {RootPublishCooldownUpdated}.
     */
    function setRootPublishCooldown(uint256 _cooldown) external onlyOwner {
        uint256 oldCooldown = rootPublishCooldown;
        rootPublishCooldown = _cooldown;
        emit RootPublishCooldownUpdated(oldCooldown, _cooldown);
    }

    /**
     * @notice Update the root publisher address.
     * @param _rootPublisher New root publisher address
     *
     * Emits {RootPublisherUpdated}.
     */
    function setRootPublisher(address _rootPublisher) external onlyOwner {
        if (_rootPublisher == address(0)) revert ZeroAddress();
        address oldPublisher = rootPublisher;
        rootPublisher = _rootPublisher;
        emit RootPublisherUpdated(oldPublisher, _rootPublisher);
    }

    /**
     * @notice Pause all claims and root publishing.
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause the contract.
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    // ============================================================
    //                   EMERGENCY WITHDRAW
    // ============================================================

    /**
     * @notice Withdraw stuck ERC-20 tokens sent to this contract by mistake.
     * @param token Address of the ERC-20 token to withdraw
     * @param to Recipient address
     * @param amount Amount to withdraw
     *
     * @dev If withdrawing NOOK, only the excess above unclaimed obligations is
     *      withdrawable — admin can NEVER touch committed reward funds. For any
     *      other ERC-20 token, the full amount is withdrawable.
     *
     * Emits {EmergencyWithdraw}.
     */
    function emergencyWithdraw(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        // Protect committed rewards: if withdrawing NOOK, limit to excess
        if (token == address(nookToken)) {
            uint256 balance = nookToken.balanceOf(address(this));
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
     *
     * Emits {NativeETHRescued}.
     */
    function rescueETH(address payable to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        (bool success, ) = to.call{value: amount}("");
        if (!success) revert EthTransferFailed();
        emit NativeETHRescued(to, amount);
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
    //                  OWNERSHIP GUARDS
    // ============================================================

    /**
     * @dev Override OwnableUpgradeable._checkOwner to use raw msg.sender instead of
     *      _msgSender(). This makes ALL onlyOwner functions forwarder-proof — a
     *      compromised ERC-2771 forwarder cannot spoof the owner for admin operations
     *      (setRootPublisher, setMaxEpochPayout, emergencyWithdraw, pause/unpause, etc.).
     */
    function _checkOwner() internal view override {
        if (msg.sender != owner()) {
            revert OwnableUnauthorizedAccount(msg.sender);
        }
    }

    /**
     * @notice Transfer ownership using raw msg.sender (forwarder-proof).
     * @dev Defense-in-depth: _checkOwner() override already makes all onlyOwner
     *      functions forwarder-proof, but this explicit override ensures ownership
     *      transfer cannot go through the forwarder even if _checkOwner is removed
     *      in a future upgrade.
     */
    function transferOwnership(address newOwner) public override {
        require(msg.sender == owner(), "Only owner directly");
        if (newOwner == address(0)) revert ZeroAddress();
        _transferOwnership(newOwner);
    }

    /// @notice Prevent accidental ownership renouncement — would permanently brick admin functions.
    function renounceOwnership() public pure override {
        revert("Cannot renounce ownership");
    }

    // ============================================================
    //                     UUPS UPGRADE AUTH
    // ============================================================

    /// @dev Uses msg.sender (not _msgSender via onlyOwner) to prevent a compromised
    ///      ERC-2771 forwarder from spoofing the owner for UUPS upgrades.
    function _authorizeUpgrade(address) internal view override {
        require(msg.sender == owner(), "Only owner directly");
    }

    /// @notice Accept native ETH transfers (so rescueETH can recover them).
    receive() external payable {}
}
