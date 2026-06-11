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

/**
 * @notice Minimal interface for checking agent registration status.
 */
interface IAgentRegistry {
    function isRegistered(address agent) external view returns (bool);
}

/**
 * @notice Minimal interface for MiningGuild — called on unstake/slash to force-remove agent,
 *         and on cancel-unstake to restore guild membership.
 */
interface IMiningGuild {
    function onUnstake(address agent) external;
    function onCancelUnstake(address agent) external;
}

/**
 * @title MiningStake
 * @author Nookplot
 * @notice Mining staking contract for the Nookplot protocol. Agents stake NOOK
 *         tokens to earn tier assignments and mining reward multipliers. Higher
 *         stakes unlock higher tiers with greater multipliers.
 *
 * @dev Uses UUPS proxy pattern for upgradeability. Tier assignment is on-chain;
 *      reward computation and distribution happen off-chain and on-chain
 *      (MiningRewardPool). The off-chain reward service reads `stakedAt` and `unstakeRequestedAt`
 *      to enforce reward accrual cutoff — rewards stop when an agent requests
 *      unstake, even though tokens remain locked during cooldown.
 *
 *      Unstake flow: requestUnstake() → 7-day cooldown → completeUnstake().
 *      Agents can cancelUnstake() during cooldown to return to active staking.
 *
 *      Security: ReentrancyGuard on all token-involving functions, Pausable for
 *      emergency, MAX_TIERS gas-safety bound, SafeERC20, CEI pattern.
 *      Emergency withdraw is excess-only — admin can never touch staker funds.
 *      No hardcoded ceilings on parameter values — admin has full flexibility,
 *      and ceilings can be added via UUPS upgrade if needed later.
 *
 *      ERC-2771 meta-transaction support via NookplotForwarder — relayer pays gas.
 *      Agents need gas only for the initial NOOK approve() call.
 *
 *      Integrates with MiningGuild contract — agents are force-removed from their
 *      guild on unstake request or slash via onUnstake() callback.
 *
 *      UPGRADE COORDINATION: MiningGuild reads IMiningStake.getStakeInfo(). If
 *      StakeInfo struct changes, both contracts must be upgraded atomically
 *      (pause both → upgrade both → unpause both).
 *
 * UPGRADEABILITY: Do NOT reorder inheritance — storage layout depends on this exact order.
 */
contract MiningStake is
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

    /// @notice Thrown when a zero amount is passed to stake, unstake, or withdraw
    error ZeroAmount();

    /// @notice Thrown when a non-registered agent tries to stake
    error NotRegisteredAgent();

    /// @notice Thrown when trying to unstake more than the staked amount
    error InsufficientStake();

    /// @notice Thrown when an operation requires an active stake but agent has none
    error NotStaked();

    /// @notice Thrown when requesting unstake while a request is already pending
    error UnstakeAlreadyRequested();

    /// @notice Thrown when trying to cancel or complete a non-existent unstake request
    error NoUnstakeRequested();

    /// @notice Thrown when trying to complete unstake before cooldown has elapsed
    error CooldownNotElapsed();

    /// @notice Thrown when trying to re-stake within the slash restake cooldown
    error SlashCooldownActive();

    /// @notice Thrown when trying to slash an agent with no stake
    error NoStakeToSlash();

    /// @notice Thrown when setting more tiers than MAX_TIERS allows
    error TooManyTiers();

    /// @notice Thrown when tier thresholds are not in ascending order
    error InvalidTierOrder();

    /// @notice Thrown when a new staker's amount is below the minimum stake
    error BelowMinimumStake();

    /// @notice Thrown when emergency withdraw exceeds the excess NOOK balance
    error InsufficientExcess();

    /// @notice Thrown when an ETH transfer fails
    error EthTransferFailed();

    /// @notice Thrown when batch arrays have different lengths
    error ArrayLengthMismatch();

    /// @notice Thrown when batch exceeds MAX_BATCH_SIZE
    error BatchTooLarge();

    /// @notice Thrown when trying to admin-stake for an agent with a pending unstake request
    error AgentHasActiveUnstake();

    // ============================================================
    //                          STRUCTS
    // ============================================================

    /**
     * @notice On-chain record of an agent's mining stake.
     * @param amount Currently staked NOOK amount
     * @param stakedAt Block timestamp of first stake (reset on fresh stake after full withdrawal)
     * @param unstakeRequestedAt Block timestamp of unstake request (0 = not unstaking)
     * @param unstakeAmount Amount of NOOK requested for unstake (0 = not unstaking)
     * @param unstakeCooldownSnapshot Cooldown value captured at request time (immune to later admin changes)
     * @param slashedAt Block timestamp of last slash (0 = never slashed; slashRestakeCooldown before re-stake)
     */
    struct StakeInfo {
        uint256 amount;
        uint256 stakedAt;
        uint256 unstakeRequestedAt;
        uint256 unstakeAmount;
        uint256 unstakeCooldownSnapshot;
        uint256 slashedAt;
    }

    /**
     * @notice Configuration for a staking tier.
     * @param threshold Minimum NOOK staked to reach this tier
     * @param multiplier Reward multiplier in basis points (100 = 1x, 200 = 2x, 300 = 3x)
     */
    struct TierConfig {
        uint256 threshold;
        uint256 multiplier;
    }

    // ============================================================
    //                        CONSTANTS
    // ============================================================

    /// @notice Maximum number of staking tiers allowed (gas safety — bounds _calculateTier loop)
    uint8 public constant MAX_TIERS = 10;

    /// @notice Maximum agents per adminBatchStakeFor call (gas safety — ~60-80k gas per agent)
    uint16 public constant MAX_BATCH_SIZE = 200;

    // ============================================================
    //                        STATE VARIABLES
    // ============================================================

    /// @notice The NOOK ERC-20 token (hardcoded at initialization, not changeable)
    IERC20 public nookToken;

    /// @notice AgentRegistry contract — agents must be registered to stake
    IAgentRegistry public agentRegistry;

    /// @notice Treasury address where slashed stakes are sent
    address public treasury;

    /// @notice Total NOOK currently staked across all agents
    uint256 public totalStaked;

    /// @notice Cooldown period between unstake request and completion (default: 7 days)
    uint256 public unstakeCooldown;

    /// @notice Minimum NOOK required to open a new staking position (0 = no minimum)
    uint256 public minimumStake;

    /// @notice Cooldown period after slash before agent can re-stake (default: 24 hours)
    uint256 public slashRestakeCooldown;

    /// @notice Number of active staking tiers
    uint8 public tierCount;

    /// @notice Tier configurations indexed 0 to tierCount-1 (ascending thresholds)
    mapping(uint8 => TierConfig) public tiers;

    /// @notice Maps agent wallet address to their stake info
    mapping(address => StakeInfo) private _stakes;

    /// @notice MiningGuild contract — called on unstake/slash to force-remove agent from guild
    IMiningGuild public miningGuild;

    /// @dev Storage gap for future upgrades (UUPS pattern)
    uint256[40] private __gap;

    // ============================================================
    //                          EVENTS
    // ============================================================

    /// @notice Emitted when an agent stakes NOOK tokens
    event Staked(
        address indexed agent,
        uint256 amount,
        uint256 totalStake
    );

    /// @notice Emitted when an agent requests to unstake NOOK tokens
    event UnstakeRequested(
        address indexed agent,
        uint256 amount,
        uint256 completesAt
    );

    /// @notice Emitted when an agent cancels a pending unstake request
    event UnstakeCancelled(
        address indexed agent,
        uint256 amount
    );

    /// @notice Emitted when an agent completes an unstake after cooldown
    event UnstakeCompleted(
        address indexed agent,
        uint256 amount,
        uint256 remainingStake
    );

    /// @notice Emitted when an agent's tier changes (up or down)
    event TierChanged(
        address indexed agent,
        uint8 oldTier,
        uint8 newTier
    );

    /// @notice Emitted when an agent's stake is slashed (penalty)
    event Slashed(
        address indexed agent,
        uint256 amount,
        uint256 remainingStake,
        address indexed toTreasury,
        string reason
    );

    /// @notice Emitted when admin updates the tier configuration
    event TiersUpdated(uint8 tierCount, uint256[] thresholds, uint256[] multipliers);

    /// @notice Emitted when the minimum stake is changed
    event MinimumStakeUpdated(uint256 oldMin, uint256 newMin);

    /// @notice Emitted when the unstake cooldown period is changed
    event UnstakeCooldownUpdated(uint256 oldCooldown, uint256 newCooldown);

    /// @notice Emitted when the AgentRegistry address is changed
    event AgentRegistryUpdated(address indexed oldRegistry, address indexed newRegistry);

    /// @notice Emitted when the treasury address is changed
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    /// @notice Emitted when the slash restake cooldown is changed
    event SlashRestakeCooldownUpdated(uint256 oldCooldown, uint256 newCooldown);

    /// @notice Emitted when admin waives an agent's unstake cooldown
    event CooldownWaived(address indexed agent, uint256 newUnstakeRequestedAt);

    /// @notice Emitted when the MiningGuild contract address is set
    event MiningGuildUpdated(address indexed oldGuild, address indexed newGuild);

    /// @notice Emitted when admin emergency-withdraws stuck tokens
    event EmergencyWithdraw(address indexed token, address indexed to, uint256 amount);

    /// @notice Emitted when admin rescues native ETH from the contract
    event NativeETHRescued(address indexed to, uint256 amount);

    /// @notice Emitted when onUnstake callback to MiningGuild fails silently
    event GuildRemovalFailed(address indexed agent);

    /// @notice Emitted when admin stakes NOOK on behalf of an agent (airdrop vesting)
    event AdminStakedFor(
        address indexed admin,
        address indexed agent,
        uint256 amount,
        uint256 totalStake
    );

    /// @notice Emitted at the end of a batch admin-stake operation.
    /// @dev agentCount reflects agents.length (array entries processed), NOT unique addresses.
    ///      Duplicate addresses are additive — [Alice, Alice] with [100, 100] emits agentCount=2
    ///      but only one agent was staked (with 200 total). Off-chain consumers must deduplicate.
    event AdminBatchStaked(
        address indexed admin,
        uint256 agentCount,
        uint256 totalAmount
    );

    // ============================================================
    //                        INITIALIZER
    // ============================================================

    /// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
    constructor(address trustedForwarder_) ERC2771ContextUpgradeable(trustedForwarder_) {
        _disableInitializers();
    }

    /**
     * @notice Initialize the MiningStake contract (atomic — all params in one TX).
     * @param owner_ Address that will own this contract (admin — can upgrade, pause, slash, set tiers)
     * @param nookToken_ Address of the NOOK ERC-20 token (hardcoded, not changeable after init)
     * @param agentRegistry_ Address of the AgentRegistry contract (updatable by admin)
     * @param treasury_ Address where slashed stakes are sent
     *
     * @dev Encoded in ERC1967Proxy constructor data for atomic deploy — initialize
     *      atomically to avoid an uninitialized-implementation window.
     *      Tiers are NOT set here — admin calls setTiers() after deploy.
     *
     *      INIT WINDOW: Between deploy and setTiers(), tierCount = 0. Agents CAN
     *      stake (tier 0, no TierChanged event). After setTiers(), tiers apply retroactively
     *      on the next stake/unstake — but no catch-up TierChanged events for pre-existing
     *      stakes. Duration: 1 TX in deploy script.
     *
     *      INIT WINDOW: Between deploy and setMiningGuild(), miningGuild = address(0).
     *      requestUnstake() skips guild removal (the address(0) check protects against revert).
     *      Agents can unstake while remaining guild members — creating "ghost members" with 0
     *      stake who still count in memberCount and can vote-kick. Duration: until
     *      setMiningGuild() is wired during deployment. Must wire before any
     *      agent activity.
     */
    function initialize(
        address owner_,
        address nookToken_,
        address agentRegistry_,
        address treasury_
    ) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        if (nookToken_ == address(0)) revert ZeroAddress();
        if (agentRegistry_ == address(0)) revert ZeroAddress();
        if (treasury_ == address(0)) revert ZeroAddress();

        __Ownable_init(owner_);
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        nookToken = IERC20(nookToken_);
        agentRegistry = IAgentRegistry(agentRegistry_);
        treasury = treasury_;
        unstakeCooldown = 7 days;
        slashRestakeCooldown = 24 hours;
        // minimumStake defaults to 0 (no minimum)
        // tierCount defaults to 0 (admin sets tiers after deploy)
    }

    // ============================================================
    //                     STAKING FUNCTIONS
    // ============================================================

    /**
     * @notice Stake NOOK tokens for mining. Must be a registered agent.
     * @param amount Number of NOOK tokens to stake.
     *
     * @dev Agent must have called approve() on the NOOK token for this contract.
     *      First-time stakers must meet minimumStake requirement. Adding to an
     *      existing position has no minimum. Agents within slashRestakeCooldown cannot stake.
     *
     * Emits {Staked} and optionally {TierChanged}.
     */
    function stake(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        address sender = _msgSender();

        // Must be registered agent (checked on stake only, not unstake/withdraw)
        if (!agentRegistry.isRegistered(sender)) revert NotRegisteredAgent();

        StakeInfo storage info = _stakes[sender];

        // Cooldown after being slashed before re-staking
        if (info.slashedAt != 0 && block.timestamp < info.slashedAt + slashRestakeCooldown) {
            revert SlashCooldownActive();
        }

        // Cannot add stake while an unstake is pending — cancel unstake first
        if (info.unstakeRequestedAt != 0) revert UnstakeAlreadyRequested();

        // New stakers must meet minimum stake requirement
        if (info.amount == 0 && minimumStake > 0 && amount < minimumStake) {
            revert BelowMinimumStake();
        }

        uint8 oldTier = _calculateTier(info.amount);

        // Effects: update state BEFORE external call (CEI pattern)
        info.amount += amount;
        totalStaked += amount;

        // Set stakedAt on first stake (reset after full withdrawal, so 0 means fresh)
        if (info.stakedAt == 0) {
            info.stakedAt = block.timestamp;
        }

        // Clear slash cooldown on successful re-stake
        if (info.slashedAt != 0) {
            info.slashedAt = 0;
        }

        uint8 newTier = _calculateTier(info.amount);

        // Interactions: transfer tokens into contract
        nookToken.safeTransferFrom(sender, address(this), amount);

        emit Staked(sender, amount, info.amount);

        if (oldTier != newTier) {
            emit TierChanged(sender, oldTier, newTier);
        }
    }

    /**
     * @notice Stake NOOK on behalf of a registered agent (airdrop vesting).
     * @param agent  Wallet address of the agent to stake for.
     * @param amount Number of NOOK tokens to stake.
     *
     * @dev Caller (owner/multisig) must have called NOOK.approve(miningStake, amount)
     *      before calling. Tokens are pulled from the caller, credited to the agent's
     *      StakeInfo. Agent can later requestUnstake → cooldown → completeUnstake
     *      to access the tokens.
     *
     *      Skips slash cooldown check (admin override is intentional).
     *      Also clears slashedAt — effectively reverses the slash penalty if called
     *      with the same amount. This is by design (admin controls both slash and restore).
     *      Reverts if agent has an active unstake request.
     *      Requires agent to be registered in AgentRegistry.
     *
     *      STALE GUILD NOTE: If the agent was previously in a guild and was removed
     *      (via requestUnstake → onUnstake or slash → onUnstake), MiningGuild's
     *      `previousGuild[agent]` still holds the old guild ID. Admin-staking does NOT
     *      auto-rejoin the agent to their old guild. The agent must manually call
     *      joinGuild() after receiving admin-staked tokens. This is by design — auto-rejoin
     *      could fail (guild full, dissolved) and would add unnecessary coupling.
     *
     * Emits {AdminStakedFor} and optionally {TierChanged}.
     */
    function adminStakeFor(address agent, uint256 amount) external onlyOwner whenNotPaused nonReentrant {
        if (agent == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (!agentRegistry.isRegistered(agent)) revert NotRegisteredAgent();

        StakeInfo storage info = _stakes[agent];
        if (info.unstakeRequestedAt != 0) revert AgentHasActiveUnstake();
        // NOTE: slash cooldown deliberately NOT checked (admin override)

        uint8 oldTier = _calculateTier(info.amount);

        // Effects
        info.amount += amount;
        totalStaked += amount;
        if (info.stakedAt == 0) {
            info.stakedAt = block.timestamp;
        }
        if (info.slashedAt != 0) {
            info.slashedAt = 0;
        }

        uint8 newTier = _calculateTier(info.amount);

        // Interactions: pull tokens from caller (owner/multisig)
        address caller = _msgSender();
        nookToken.safeTransferFrom(caller, address(this), amount);

        emit AdminStakedFor(caller, agent, amount, info.amount);
        if (oldTier != newTier) {
            emit TierChanged(agent, oldTier, newTier);
        }
    }

    /**
     * @notice Batch-stake NOOK on behalf of multiple registered agents.
     * @param agents  Array of agent wallet addresses.
     * @param amounts Array of NOOK amounts (1:1 correspondence with agents).
     *
     * @dev Caller must have called NOOK.approve(miningStake, sum(amounts)) before
     *      calling. Performs a single safeTransferFrom for the total, then updates
     *      each agent's StakeInfo in a loop. Atomic — all succeed or all revert.
     *      Max 200 agents per call. Duplicate addresses are additive (not an error).
     *
     *      DUPLICATE BEHAVIOR: If the same address appears N times, its stake increases
     *      by the sum of all corresponding amounts. The effects loop sees progressively
     *      updated state — tier calculations on the 2nd+ occurrence reflect prior additions
     *      from the same TX. This can emit multiple TierChanged events for one agent if
     *      amounts cross multiple tier boundaries. totalStaked increments correctly (N times).
     *      AdminBatchStaked.agentCount reflects array length, not unique addresses.
     *      Callers should deduplicate off-chain before submitting to avoid accidental over-staking.
     *
     * Emits {AdminStakedFor} per agent, optionally {TierChanged} per agent,
     * and {AdminBatchStaked} once at the end.
     */
    function adminBatchStakeFor(
        address[] calldata agents,
        uint256[] calldata amounts
    ) external onlyOwner whenNotPaused nonReentrant {
        if (agents.length != amounts.length) revert ArrayLengthMismatch();
        if (agents.length == 0) revert ZeroAmount();
        if (agents.length > MAX_BATCH_SIZE) revert BatchTooLarge();

        // Checks: validate all agents and calculate total before any state changes
        uint256 totalAmount = 0;
        for (uint256 i = 0; i < agents.length; ) {
            if (agents[i] == address(0)) revert ZeroAddress();
            if (amounts[i] == 0) revert ZeroAmount();
            if (!agentRegistry.isRegistered(agents[i])) revert NotRegisteredAgent();
            if (_stakes[agents[i]].unstakeRequestedAt != 0) revert AgentHasActiveUnstake();
            totalAmount += amounts[i];
            unchecked { ++i; }
        }

        // Effects: update each agent's stake (pure storage writes — no external calls)
        address caller = _msgSender();
        for (uint256 i = 0; i < agents.length; ) {
            StakeInfo storage info = _stakes[agents[i]];
            uint8 oldTier = _calculateTier(info.amount);

            info.amount += amounts[i];
            totalStaked += amounts[i];
            if (info.stakedAt == 0) {
                info.stakedAt = block.timestamp;
            }
            if (info.slashedAt != 0) {
                info.slashedAt = 0;
            }

            uint8 newTier = _calculateTier(info.amount);

            emit AdminStakedFor(caller, agents[i], amounts[i], info.amount);
            if (oldTier != newTier) {
                emit TierChanged(agents[i], oldTier, newTier);
            }
            unchecked { ++i; }
        }

        // Interactions: single transfer for entire batch (after all effects)
        nookToken.safeTransferFrom(caller, address(this), totalAmount);

        emit AdminBatchStaked(caller, agents.length, totalAmount);
    }

    /**
     * @notice Request to unstake NOOK tokens. Starts the cooldown period.
     * @param amount Number of NOOK tokens to unstake.
     *
     * @dev Only one unstake request can be active at a time. Tokens remain locked
     *      during cooldown. Agent can cancel with cancelUnstake() to return to
     *      active staking, or complete with completeUnstake() after cooldown.
     *      The off-chain reward service stops reward accrual when unstakeRequestedAt is set.
     *
     * Emits {UnstakeRequested}, optionally {GuildRemovalFailed} (if onUnstake callback reverts).
     */
    function requestUnstake(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        address sender = _msgSender();
        StakeInfo storage info = _stakes[sender];

        if (info.amount == 0) revert NotStaked();
        if (info.unstakeRequestedAt != 0) revert UnstakeAlreadyRequested();
        if (amount > info.amount) revert InsufficientStake();

        // Effects — snapshot cooldown so admin changes don't retroactively affect this request
        info.unstakeRequestedAt = block.timestamp;
        info.unstakeAmount = amount;
        info.unstakeCooldownSnapshot = unstakeCooldown;

        // Force-remove agent from mining guild (if set and agent is in one)
        if (address(miningGuild) != address(0)) {
            try miningGuild.onUnstake(sender) {} catch {
                emit GuildRemovalFailed(sender);
            }
        }

        emit UnstakeRequested(sender, amount, block.timestamp + unstakeCooldown);
    }

    /**
     * @notice Cancel a pending unstake request and return to active staking.
     *
     * @dev Clears the unstake request. The agent's stake, tier, and stakedAt remain
     *      unchanged (stakedAt does NOT reset on cancel — maintains original stake date).
     *      The off-chain reward service resumes reward accrual when unstakeRequestedAt is cleared.
     *
     *      Guild restore: calls miningGuild.onCancelUnstake(sender) to best-effort
     *      restore the agent to their previous guild. The agent was removed when
     *      requestUnstake() was called — this reverses that side effect. Restore
     *      fails silently (try/catch) if the guild dissolved, filled, or the agent
     *      already joined another guild. In that case, agent must joinGuild() manually.
     *
     *      Treasury deposits made during the gap (between removal and restore) are
     *      intentionally forfeited — the agent wasn't contributing to the guild's tier.
     *
     * Emits {UnstakeCancelled}.
     */
    function cancelUnstake() external whenNotPaused nonReentrant {
        address sender = _msgSender();
        StakeInfo storage info = _stakes[sender];

        if (info.unstakeRequestedAt == 0) revert NoUnstakeRequested();

        uint256 amount = info.unstakeAmount;

        // Effects
        info.unstakeRequestedAt = 0;
        info.unstakeAmount = 0;
        info.unstakeCooldownSnapshot = 0;

        // Best-effort guild restore (if miningGuild is set)
        if (address(miningGuild) != address(0)) {
            try miningGuild.onCancelUnstake(sender) {} catch {
                emit GuildRemovalFailed(sender); // reuses event — restore failed, agent must manually rejoin
            }
        }

        emit UnstakeCancelled(sender, amount);
    }

    /**
     * @notice Complete an unstake after the cooldown period has elapsed.
     *
     * @dev Transfers the requested NOOK amount back to the agent. If this is a
     *      partial unstake, emits TierChanged if the tier drops. If the agent fully
     *      withdraws, stakedAt is reset to 0 (next stake gets a fresh timestamp).
     *
     * Emits {UnstakeCompleted} and optionally {TierChanged}.
     */
    function completeUnstake() external whenNotPaused nonReentrant {
        address sender = _msgSender();
        StakeInfo storage info = _stakes[sender];

        if (info.unstakeRequestedAt == 0) revert NoUnstakeRequested();
        if (block.timestamp < info.unstakeRequestedAt + info.unstakeCooldownSnapshot) {
            revert CooldownNotElapsed();
        }

        uint256 amount = info.unstakeAmount;
        uint8 oldTier = _calculateTier(info.amount);

        // Effects: update state BEFORE external call (CEI pattern)
        info.amount -= amount;
        info.unstakeRequestedAt = 0;
        info.unstakeAmount = 0;
        info.unstakeCooldownSnapshot = 0;
        totalStaked -= amount;

        // Reset stakedAt if fully withdrawn (next stake gets fresh timestamp)
        if (info.amount == 0) {
            info.stakedAt = 0;
        }

        uint8 newTier = _calculateTier(info.amount);

        // Interactions: transfer tokens back to agent
        nookToken.safeTransfer(sender, amount);

        emit UnstakeCompleted(sender, amount, info.amount);

        if (oldTier != newTier) {
            emit TierChanged(sender, oldTier, newTier);
        }
    }

    // ============================================================
    //                      VIEW FUNCTIONS
    // ============================================================

    /**
     * @notice Get the full stake info for an agent.
     * @param agent Wallet address to look up.
     * @return StakeInfo struct with amount, timestamps, and slash status.
     */
    function getStakeInfo(address agent) external view returns (StakeInfo memory) {
        return _stakes[agent];
    }

    /**
     * @notice Get only the staked amount for an agent (gas-optimized).
     * @param agent Wallet address to look up.
     * @return Currently staked NOOK amount.
     *
     * @dev Returns only the amount field (32 bytes vs 192 bytes for getStakeInfo).
     *      Used by MiningGuild for tier calculations — avoids copying the full
     *      6-field StakeInfo struct for operations that only need the amount.
     */
    function getStakeAmount(address agent) external view returns (uint256) {
        return _stakes[agent].amount;
    }

    /**
     * @notice Get the current tier for an agent (1-based, 0 = below all tiers).
     * @param agent Wallet address to look up.
     * @return Tier number (1 to tierCount) or 0 if below all tier thresholds.
     */
    function getTier(address agent) external view returns (uint8) {
        return _calculateTier(_stakes[agent].amount);
    }

    /**
     * @notice Get the reward multiplier for an agent's current tier.
     * @param agent Wallet address to look up.
     * @return Multiplier in basis points (100 = 1x, 200 = 2x), or 0 if no tier.
     */
    function getMultiplier(address agent) external view returns (uint256) {
        uint8 tier = _calculateTier(_stakes[agent].amount);
        if (tier == 0) return 0;
        return tiers[tier - 1].multiplier;
    }

    /**
     * @notice Check if an agent has a pending unstake request.
     * @param agent Wallet address to check.
     * @return True if the agent has an active unstake request.
     */
    function isUnstaking(address agent) external view returns (bool) {
        return _stakes[agent].unstakeRequestedAt != 0;
    }

    /**
     * @notice Get all tier configurations as an array.
     * @return Array of TierConfig structs (ascending threshold order).
     */
    function getTierThresholds() external view returns (TierConfig[] memory) {
        TierConfig[] memory result = new TierConfig[](tierCount);
        for (uint8 i = 0; i < tierCount; ) {
            result[i] = tiers[i];
            unchecked { ++i; }
        }
        return result;
    }

    // ============================================================
    //                    INTERNAL FUNCTIONS
    // ============================================================

    /**
     * @dev Calculate the tier for a given stake amount.
     *      Iterates from highest tier down, returns first match.
     * @param amount The staked amount to evaluate.
     * @return Tier number (1-based) or 0 if below all thresholds.
     */
    function _calculateTier(uint256 amount) internal view returns (uint8) {
        for (uint8 i = tierCount; i > 0; ) {
            if (amount >= tiers[i - 1].threshold) {
                return i;
            }
            unchecked { --i; }
        }
        return 0;
    }

    // ============================================================
    //                      ADMIN FUNCTIONS
    // ============================================================

    /**
     * @notice Set all staking tiers at once (replaces existing tiers).
     * @param newTiers Array of TierConfig structs in ascending threshold order.
     *
     * @dev Validates: ascending thresholds, non-zero thresholds, ascending multipliers,
     *      and count within MAX_TIERS. Existing stakers are reclassified immediately —
     *      no grandfathering in v1.
     *
     * Emits {TiersUpdated}.
     */
    function setTiers(TierConfig[] calldata newTiers) external onlyOwner {
        if (newTiers.length > MAX_TIERS) revert TooManyTiers();

        // Validate ascending order
        for (uint256 i = 0; i < newTiers.length; ) {
            if (newTiers[i].threshold == 0) revert ZeroAmount();
            if (i > 0 && newTiers[i].threshold <= newTiers[i - 1].threshold) {
                revert InvalidTierOrder();
            }
            if (i > 0 && newTiers[i].multiplier <= newTiers[i - 1].multiplier) {
                revert InvalidTierOrder();
            }
            unchecked { ++i; }
        }

        // Clear old tiers
        for (uint8 i = 0; i < tierCount; ) {
            delete tiers[i];
            unchecked { ++i; }
        }

        // Set new tiers + build arrays for event
        uint256[] memory thresholds = new uint256[](newTiers.length);
        uint256[] memory multipliers = new uint256[](newTiers.length);
        for (uint256 i = 0; i < newTiers.length; ) {
            tiers[uint8(i)] = newTiers[i];
            thresholds[i] = newTiers[i].threshold;
            multipliers[i] = newTiers[i].multiplier;
            unchecked { ++i; }
        }

        tierCount = uint8(newTiers.length);

        emit TiersUpdated(tierCount, thresholds, multipliers);
    }

    /**
     * @notice Set the minimum NOOK required for a new staking position.
     * @param amount New minimum stake (0 = no minimum).
     *
     * @dev Only affects new stakers — existing positions are not forcefully unstaked.
     *
     * Emits {MinimumStakeUpdated}.
     */
    function setMinimumStake(uint256 amount) external onlyOwner {
        uint256 oldMin = minimumStake;
        minimumStake = amount;
        emit MinimumStakeUpdated(oldMin, amount);
    }

    /**
     * @notice Set the unstake cooldown period.
     * @param cooldown_ New cooldown in seconds.
     *
     * @dev In-progress cooldowns are NOT affected — each unstake request snapshots
     *      the cooldown value at request time.
     *
     * Emits {UnstakeCooldownUpdated}.
     */
    function setUnstakeCooldown(uint256 cooldown_) external onlyOwner {
        uint256 oldCooldown = unstakeCooldown;
        unstakeCooldown = cooldown_;
        emit UnstakeCooldownUpdated(oldCooldown, cooldown_);
    }

    /**
     * @notice Set the cooldown period after slash before agent can re-stake.
     * @param cooldown_ New slash restake cooldown in seconds (0 = no cooldown).
     *
     * Emits {SlashRestakeCooldownUpdated}.
     */
    function setSlashRestakeCooldown(uint256 cooldown_) external onlyOwner {
        uint256 oldCooldown = slashRestakeCooldown;
        slashRestakeCooldown = cooldown_;
        emit SlashRestakeCooldownUpdated(oldCooldown, cooldown_);
    }

    /**
     * @notice Update the AgentRegistry contract address.
     * @param registry New AgentRegistry address.
     *
     * @dev Allows migration to a new AgentRegistry without contract upgrade.
     *
     * Emits {AgentRegistryUpdated}.
     */
    function setAgentRegistry(address registry) external onlyOwner {
        if (registry == address(0)) revert ZeroAddress();
        address oldRegistry = address(agentRegistry);
        agentRegistry = IAgentRegistry(registry);
        emit AgentRegistryUpdated(oldRegistry, registry);
    }

    /**
     * @notice Set the MiningGuild contract address. Called once after MiningGuild deploys.
     * @param guild Address of the MiningGuild contract (address(0) to unset).
     *
     * @dev MiningStake calls guild.onUnstake(agent) during requestUnstake() and slashAgent()
     *      to force-remove agents from their mining guild. Can be updated if MiningGuild
     *      is upgraded to a new address.
     *
     * Emits {MiningGuildUpdated}.
     */
    function setMiningGuild(address guild) external onlyOwner whenPaused {
        address oldGuild = address(miningGuild);
        miningGuild = IMiningGuild(guild);
        emit MiningGuildUpdated(oldGuild, guild);
    }

    /**
     * @notice Update the treasury address where slashed stakes are sent.
     * @param newTreasury New treasury address.
     *
     * Emits {TreasuryUpdated}.
     */
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        address oldTreasury = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(oldTreasury, newTreasury);
    }

    /**
     * @notice Slash an agent's stake as a penalty (spam, malicious behavior, etc.).
     * @param agent Wallet address of the agent to slash.
     * @param amount Number of NOOK tokens to slash from their stake.
     *
     * @dev Slashed tokens are sent to the treasury. If the slash reduces the stake
     *      below the pending unstake amount, the unstake request is cancelled
     *      (emits UnstakeCancelled). Sets slashRestakeCooldown to prevent immediate
     *      re-staking after slash. adminStakeFor() deliberately bypasses this cooldown.
     *
     *      No whenNotPaused — admin retains punitive capability during emergency pause.
     *      Paused agents cannot stake/unstake/leave-guild until unpause.
     *
     *      Guild removal: ONLY on full slash (info.amount == 0). Partial slashes leave
     *      the agent in their guild — _calculateGuildTier() reflects the reduced stake
     *      automatically. Off-chain indexers may resync the agent's guild tier from
     *      emitted events.
     *      Manual fallback: an off-chain sync job.
     *
     *      UNSTAKE-CANCEL INTERACTION: If an agent has a pending unstake, they were
     *      already removed from their guild by requestUnstake → onUnstake(). A partial
     *      slash that cancels the unstake does NOT restore guild membership — the agent
     *      must manually rejoin. Note: this differs from cancelUnstake() which DOES
     *      attempt guild restore via onCancelUnstake(). Slash is punitive — no auto-restore.
     *
     * Emits {Slashed}, optionally {TierChanged}, optionally {UnstakeCancelled}.
     */
    function slashAgent(address agent, uint256 amount, string calldata reason) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        StakeInfo storage info = _stakes[agent];
        if (info.amount == 0) revert NoStakeToSlash();

        // Cap slash to actual stake
        uint256 slashAmount = amount > info.amount ? info.amount : amount;

        uint8 oldTier = _calculateTier(info.amount);

        // Effects: update state BEFORE external call (CEI pattern)
        info.amount -= slashAmount;
        info.slashedAt = block.timestamp;
        totalStaked -= slashAmount;

        // If remaining stake < pending unstake amount, clear the unstake request
        if (info.unstakeRequestedAt != 0 && info.amount < info.unstakeAmount) {
            emit UnstakeCancelled(agent, info.unstakeAmount);
            info.unstakeRequestedAt = 0;
            info.unstakeAmount = 0;
            info.unstakeCooldownSnapshot = 0;
        }

        // Reset stakedAt if fully slashed
        if (info.amount == 0) {
            info.stakedAt = 0;
        }

        // Force-remove agent from mining guild on full slash only.
        // Partial slashes leave the agent in their guild — their reduced stake
        // is reflected in _calculateGuildTier() automatically. Removing a member
        // on every slash (even 1 wei) would be disproportionate punishment that
        // also harms innocent guildmates by breaking tier thresholds.
        if (address(miningGuild) != address(0) && info.amount == 0) {
            try miningGuild.onUnstake(agent) {} catch {
                emit GuildRemovalFailed(agent);
            }
        }

        uint8 newTier = _calculateTier(info.amount);

        // Interactions: send slashed tokens to treasury
        nookToken.safeTransfer(treasury, slashAmount);

        emit Slashed(agent, slashAmount, info.amount, treasury, reason);

        if (oldTier != newTier) {
            emit TierChanged(agent, oldTier, newTier);
        }
    }

    /**
     * @notice Waive the unstake cooldown for an agent (migration/emergency).
     * @param agent Wallet address of the agent whose cooldown to waive.
     *
     * @dev Sets unstakeRequestedAt to 1 (epoch origin) so any cooldown check
     *      passes immediately. Immune to subsequent cooldown changes — unlike
     *      a relative backdate, this value is always in the past.
     *      Agent must still call completeUnstake() to receive tokens — admin
     *      cannot withdraw tokens on an agent's behalf.
     *
     *      Only modifies unstakeRequestedAt — does NOT touch unstakeCooldownSnapshot.
     *      completeUnstake() checks `block.timestamp < 1 + snapshot`, which always
     *      passes since current timestamps are ~1.74 billion.
     *
     *      OFF-CHAIN STALENESS: This function is onlyOwner (direct call, not relayed).
     *      Off-chain indexers may resync from emitted CooldownWaived events. They
     *      correctly handle epoch-origin values — computing
     *      `unstake_available_at = new Date((1 + cooldownSeconds) * 1000)` which
     *      resolves to Jan 1970, causing clients to show "Ready".
     *      Manual fallback: an off-chain sync job.
     *
     * Emits {CooldownWaived}.
     */
    function waiveCooldown(address agent) external onlyOwner {
        StakeInfo storage info = _stakes[agent];
        if (info.unstakeRequestedAt == 0) revert NoUnstakeRequested();

        // Set to epoch origin (1) — guaranteed past any cooldown snapshot
        info.unstakeRequestedAt = 1;

        emit CooldownWaived(agent, 1);
    }

    /**
     * @notice Pause all staking operations (emergency stop).
     * @dev Only callable by the contract owner.
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause staking operations.
     * @dev Only callable by the contract owner.
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    // ============================================================
    //                   EMERGENCY WITHDRAW
    // ============================================================

    /**
     * @notice Withdraw stuck ERC-20 tokens sent to this contract by mistake.
     * @param token Address of the ERC-20 token to withdraw.
     * @param to Recipient address.
     * @param amount Amount to withdraw.
     *
     * @dev If withdrawing NOOK, only the excess above totalStaked is withdrawable —
     *      admin can NEVER touch staker funds. For any other ERC-20 token, the full
     *      amount is withdrawable (those tokens don't belong to stakers).
     *
     * Emits {EmergencyWithdraw}.
     */
    function emergencyWithdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        // Protect staker funds: if withdrawing NOOK, limit to excess
        if (token == address(nookToken)) {
            uint256 balance = nookToken.balanceOf(address(this));
            uint256 excess = balance > totalStaked ? balance - totalStaked : 0;
            if (amount > excess) revert InsufficientExcess();
        }

        IERC20(token).safeTransfer(to, amount);
        emit EmergencyWithdraw(token, to, amount);
    }

    /**
     * @notice Rescue native ETH accidentally sent to this contract.
     * @param to Recipient address.
     * @param amount Amount of ETH to rescue.
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
     *      (slashAgent, setTreasury, emergencyWithdraw, setters, pause/unpause, etc.).
     *      Without this, onlyOwner checks go through _msgSender() → ERC-2771, which
     *      means a compromised forwarder gains full admin control.
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

    /**
     * @notice Authorization check for UUPS upgrades.
     * @dev Uses msg.sender (not _msgSender via onlyOwner) to prevent a compromised
     *      ERC-2771 forwarder from spoofing the owner and performing a malicious
     *      UUPS upgrade. The owner must call upgradeToAndCall directly, not through
     *      the forwarder. This is the highest-privilege operation on the contract.
     */
    function _authorizeUpgrade(address) internal view override {
        require(msg.sender == owner(), "Only owner directly");
    }

    /// @notice Accept native ETH transfers (so rescueETH can recover them).
    receive() external payable {}
}
