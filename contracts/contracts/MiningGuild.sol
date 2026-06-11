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
 * @notice Minimal interface for reading agent stake info from MiningStake.
 */
interface IMiningStake {
    struct StakeInfo {
        uint256 amount;
        uint256 stakedAt;
        uint256 unstakeRequestedAt;
        uint256 unstakeAmount;
        uint256 unstakeCooldownSnapshot;
        uint256 slashedAt;
    }
    function getStakeInfo(address agent) external view returns (StakeInfo memory);
    function getStakeAmount(address agent) external view returns (uint256);
}

/**
 * @title MiningGuild
 * @author Nookplot
 * @notice On-chain mining guild contract for the Nookplot protocol. Agents form
 *         guilds to earn boosted mining rewards. Guild tier is determined by the
 *         combined individual stakes of all members (read from MiningStake).
 *
 * @dev Guild lifecycle:
 *      - Any staked agent creates a guild (unique name, 24h cooldown)
 *      - Other staked agents join (up to maxMembers)
 *      - Guild tier calculated from combined member stakes (lazy, always accurate)
 *      - Members can deposit/withdraw NOOK from guild treasury (inference fund)
 *      - Unanimous kick voting to remove bad actors (48h rejoin cooldown)
 *      - Force-removal on unstake or slash (MiningStake calls onUnstake)
 *
 *      The off-chain reward service reads guild tier, boost multiplier, and fee rate from this
 *      contract to compute mining rewards. The guild fee portion is deposited
 *      into the guild treasury by the root publisher after each epoch.
 *
 *      Security: UUPS proxy, ReentrancyGuard, SafeERC20, CEI pattern,
 *      Pausable, custom errors, emergency withdraw (excess only — admin
 *      cannot touch guild treasury funds).
 *      ERC-2771 meta-transaction support via NookplotForwarder.
 *
 * UPGRADEABILITY: Do NOT reorder inheritance — storage layout depends on this exact order.
 *      UPGRADE COORDINATION: This contract reads IMiningStake.getStakeInfo(). If
 *      MiningStake changes StakeInfo or that function's signature, both contracts
 *      must be upgraded atomically (pause both → upgrade both → unpause both).
 */
contract MiningGuild is
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

    /// @notice Thrown when a zero address is provided where a valid address is required
    error ZeroAddress();
    /// @notice Thrown when a zero amount is provided for a treasury deposit or claim
    error ZeroAmount();
    /// @notice Thrown when referencing a guild that does not exist or was dissolved
    error GuildNotFound();
    /// @notice Thrown when trying to join a guild that has reached maxMembers
    error GuildFull();
    /// @notice Thrown when an agent already in a guild tries to join or create another
    error AlreadyInGuild();
    /// @notice Thrown when an agent not in any guild tries to leave or claim
    error NotInGuild();
    /// @notice Thrown when an agent tries to leave/claim from a guild they don't belong to
    error NotInThisGuild();
    /// @notice Thrown when an agent without active stake tries to create or join a guild
    error NotStaked();
    /// @notice Thrown when an agent's stake is below minStakeToCreate or minStakeToJoin
    error BelowMinStake();
    /// @notice Thrown when an agent with a pending unstake request tries to create or join
    error AgentIsUnstaking();
    /// @notice Thrown when the proposed guild name is already taken (case-insensitive)
    error NameTaken();
    /// @notice Thrown when an empty string is provided as a guild name
    error NameEmpty();
    /// @notice Thrown when a guild name exceeds the 50-character limit
    error NameTooLong();
    /// @notice Thrown when more than MAX_DOMAINS (10) domain specializations are provided
    error TooManyDomains();
    /// @notice Thrown when an agent tries to create a guild before the 24h creation cooldown expires
    error CreationCooldownActive();
    /// @notice Thrown when an agent tries to vote to kick themselves
    error CannotKickSelf();
    /// @notice Thrown when an agent tries to submit a duplicate kick vote for the same target
    error AlreadyVotedKick();
    /// @notice Thrown when a kicked agent tries to rejoin before the 48h kick cooldown expires
    error KickCooldownActive();
    /// @notice Thrown when emergencyWithdraw/rescueETH attempts to withdraw escrowed funds
    error InsufficientExcess();
    /// @notice Thrown when a native ETH transfer fails
    error EthTransferFailed();
    /// @notice Thrown when admin sets more than MAX_TIERS (10) guild tiers
    error TooManyTiers();
    /// @notice Thrown when tier thresholds are not in strictly ascending order
    error InvalidTierOrder();
    /// @notice Thrown when a function restricted to MiningStake is called by another address
    error OnlyMiningStake();
    /// @notice Thrown when a kick vote is attempted in a guild with fewer than 3 members
    error GuildTooSmallForKick();
    /// @notice Thrown when admin tries to set maxMembers above MAX_MEMBERS_CAP (50)
    error ExceedsMaxMembersCap();
    /// @notice Thrown when claimPendingTreasury is called with no pending amount
    error NothingToClaim();
    /// @notice Thrown when claimTreasuryShare targets a guild with zero members
    error GuildHasNoMembers();
    /// @notice Thrown when claimTreasuryShare is called before minMembershipForClaim has elapsed
    error MembershipTooNew();
    /// @notice Thrown when joinGuild is called before guildJoinCooldown has elapsed since last member joined
    error GuildJoinCooldownActive();
    /// @notice Thrown when a guild name contains non-ASCII-printable characters (outside 0x20-0x7E)
    error NameNotAscii();

    // ============================================================
    //                          STRUCTS
    // ============================================================

    /**
     * @notice On-chain record of a mining guild.
     * @param name Guild display name (unique, case-insensitive)
     * @param creator Address that created the guild
     * @param createdAt Block timestamp of creation
     * @param memberCount Current number of members
     * @param treasuryBalance NOOK held in this guild's treasury
     * @param tier Guild tier (written on membership changes, view functions use live calculation)
     */
    struct Guild {
        string name;
        address creator;
        uint256 createdAt;
        uint8 memberCount;
        uint256 treasuryBalance;
        uint8 tier;
    }

    /**
     * @notice Configuration for a guild tier.
     * @param threshold Minimum combined stake to reach this tier
     * @param boostMultiplier Reward boost in basis points (100 = 1.0x baseline)
     * @param feeRate Fee percentage in basis points (500 = 5%)
     */
    struct GuildTierConfig {
        uint256 threshold;
        uint256 boostMultiplier;
        uint256 feeRate;
    }

    // ============================================================
    //                        CONSTANTS
    // ============================================================

    /// @notice Maximum guild name length
    uint256 public constant MAX_NAME_LENGTH = 50;

    /// @notice Maximum domain specializations per guild
    uint256 public constant MAX_DOMAINS = 10;

    /// @notice Maximum number of guild tiers (gas safety)
    uint8 public constant MAX_GUILD_TIERS = 10;

    /// @notice Cooldown after being kicked before rejoining any guild
    uint256 public constant KICK_REJOIN_COOLDOWN = 48 hours;

    /// @notice Hard cap on maxMembers to prevent O(n²) gas bombs in kick vote resets
    uint256 public constant MAX_MEMBERS_CAP = 50;

    /// @notice Precision multiplier for reward-per-share accumulator (avoids integer truncation)
    uint256 public constant TREASURY_PRECISION = 1e18;

    // ============================================================
    //                        STATE VARIABLES
    // ============================================================

    /// @notice NOOK ERC-20 token
    IERC20 public nookToken;

    /// @notice MiningStake contract — read individual stakes
    IMiningStake public miningStake;

    /// @notice Address of MiningStake contract (for onUnstake access control)
    address public miningStakeAddress;

    /// @notice Auto-incrementing guild ID counter
    uint256 public nextGuildId;

    /// @notice Maximum members per guild (admin-settable)
    uint256 public maxMembers;

    /// @notice Cooldown between guild creations per address (admin-settable)
    uint256 public creationCooldown;

    /// @notice Minimum individual stake to create a guild (admin-settable)
    uint256 public minStakeToCreate;

    /// @notice Minimum individual stake to join a guild (admin-settable)
    uint256 public minStakeToJoin;

    /// @notice Number of active guild tiers
    uint8 public guildTierCount;

    /// @notice Minimum members required for tier 1+ benefits
    uint8 public minMembersForTier;

    /// @notice Total NOOK held across all guild treasuries
    uint256 public totalTreasuryHeld;

    /// @notice Guild tier configurations (ascending thresholds)
    mapping(uint8 => GuildTierConfig) public guildTiers;

    /// @notice Guild data by ID
    mapping(uint256 => Guild) private _guilds;

    /// @notice Guild member lists (guildId => member addresses)
    mapping(uint256 => address[]) private _members;

    /// @notice Which guild each agent belongs to (0 = none)
    mapping(address => uint256) public guildOf;

    /// @notice Guild name uniqueness check (keccak256(lowercase name) => taken)
    mapping(bytes32 => bool) private _nameTaken;

    /// @notice Name hash per guild (for freeing name on empty guild)
    mapping(uint256 => bytes32) private _guildNameHash;

    /// @notice Last guild creation timestamp per address (cooldown enforcement)
    mapping(address => uint256) public lastGuildCreatedAt;

    /// @notice Kick votes: guildId => target => voter => voted
    mapping(uint256 => mapping(address => mapping(address => bool))) private _kickVotes;

    /// @notice Kick vote count: guildId => target => count
    mapping(uint256 => mapping(address => uint256)) public kickVoteCount;

    /// @notice Last kicked timestamp per address (rejoin cooldown)
    mapping(address => uint256) public lastKickedAt;

    /// @notice Guild domain specializations (guildId => domains)
    mapping(uint256 => bytes32[]) private _domains;

    /// @notice DEPRECATED — replaced by rewardPerShare accumulator. Slot preserved for UUPS layout.
    mapping(uint256 => mapping(address => uint256)) public lastTreasuryClaimed;

    /// @notice DEPRECATED — replaced by rewardPerShare accumulator. Slot preserved for UUPS layout.
    mapping(uint256 => uint256) public treasuryDepositEpoch;

    /// @notice DEPRECATED — replaced by rewardPerShare accumulator. Slot preserved for UUPS layout.
    mapping(uint256 => mapping(address => uint256)) public memberClaimEpoch;

    /// @notice DEPRECATED — replaced by rewardPerShare accumulator. Slot preserved for UUPS layout.
    mapping(uint256 => uint256) public epochShareAmount;

    /// @notice When each member joined their guild (for minimum membership enforcement)
    ///         guildId => member => join timestamp
    mapping(uint256 => mapping(address => uint256)) public memberJoinedAt;

    /// @notice Minimum membership duration before a member can claim treasury shares (default 24h)
    uint256 public minMembershipForClaim;

    /// @notice Last time a member joined each guild (for per-guild join rate limiting)
    ///         guildId => timestamp of most recent join
    mapping(uint256 => uint256) public lastMemberJoinedAt;

    /// @notice Cooldown between joins to the same guild (default 1h, anti-sybil)
    uint256 public guildJoinCooldown;

    /// @notice Cumulative reward-per-share accumulator for each guild's treasury.
    ///         Scaled by TREASURY_PRECISION (1e18). On each deposit, increases by
    ///         (depositAmount * 1e18 / memberCount). Members claim the delta between
    ///         this value and their memberRewardDebt. Unclaimed shares accumulate
    ///         automatically across deposits — no "use it or lose it" per epoch.
    mapping(uint256 => uint256) public rewardPerShare;

    /// @notice Per-member reward debt for the accumulator pattern.
    ///         Set to rewardPerShare[guildId] on join — prevents claiming pre-join deposits.
    ///         Updated to rewardPerShare[guildId] on each claim.
    mapping(uint256 => mapping(address => uint256)) public memberRewardDebt;

    /// @notice Pending treasury claims for agents force-removed via onUnstake as the last member.
    ///         Uses pull pattern (agent claims later) instead of push (transfer inside onUnstake)
    ///         because onUnstake is called inside MiningStake's try/catch — a revert here would
    ///         be silently swallowed, leaving the agent as a zombie guild member.
    mapping(address => uint256) public pendingTreasuryClaim;

    /// @notice Total NOOK held in pending treasury claims across all agents.
    ///         emergencyWithdraw must protect this in addition to totalTreasuryHeld.
    uint256 public totalPendingClaims;

    /// @notice Previous guild for agents removed via onUnstake (unstake/slash).
    ///         Used by onCancelUnstake to restore guild membership on cancel.
    ///         Cleared on successful restore or when agent joins a new guild.
    mapping(address => uint256) public previousGuild;

    /// @dev Storage gap for future upgrades (reduced from 20 to 19 — previousGuild mapping added)
    uint256[19] private __gap;

    // ============================================================
    //                          EVENTS
    // ============================================================

    /// @notice Emitted when a new guild is created
    event GuildCreated(
        uint256 indexed guildId,
        address indexed creator,
        string name,
        bytes32[] domains
    );

    /// @notice Emitted when a guild is dissolved (last member leaves or is removed)
    event GuildDissolved(
        uint256 indexed guildId,
        uint256 treasuryOrphaned
    );

    /// @notice Emitted when an agent joins a guild
    event MemberJoined(
        uint256 indexed guildId,
        address indexed agent,
        uint8 newMemberCount
    );

    /// @notice Emitted when an agent voluntarily leaves a guild
    event MemberLeft(
        uint256 indexed guildId,
        address indexed agent,
        uint8 newMemberCount
    );

    /// @notice Emitted when an agent is kicked from a guild via majority vote
    event MemberKicked(
        uint256 indexed guildId,
        address indexed agent,
        uint8 newMemberCount
    );

    /// @notice Emitted when a guild member submits a kick vote against a target
    event KickVoteSubmitted(
        uint256 indexed guildId,
        address indexed target,
        address indexed voter,
        uint256 currentVotes,
        uint256 votesNeeded
    );

    /// @notice Emitted when kick votes for a target are reset (membership change or kick cooldown)
    event KickVotesReset(
        uint256 indexed guildId,
        address indexed target
    );

    /// @notice Emitted when a guild's tier changes due to stake threshold crossing
    event GuildTierChanged(
        uint256 indexed guildId,
        uint8 oldTier,
        uint8 newTier
    );

    /// @notice Emitted when NOOK tokens are deposited into a guild treasury
    event TreasuryDeposited(
        uint256 indexed guildId,
        address indexed depositor,
        uint256 amount
    );

    /// @notice Emitted when a member claims their treasury share
    event TreasuryClaimed(
        uint256 indexed guildId,
        address indexed member,
        uint256 amount
    );

    /// @notice Emitted when admin updates the maximum members per guild
    event MaxMembersUpdated(uint256 oldMax, uint256 newMax);
    /// @notice Emitted when admin updates the guild creation cooldown
    event CreationCooldownUpdated(uint256 oldCooldown, uint256 newCooldown);
    /// @notice Emitted when admin updates the minimum stake required to create a guild
    event MinStakeToCreateUpdated(uint256 oldMin, uint256 newMin);
    /// @notice Emitted when admin updates the minimum stake required to join a guild
    event MinStakeToJoinUpdated(uint256 oldMin, uint256 newMin);
    /// @notice Emitted when admin updates the guild tier thresholds, boosts, and fee rates
    event GuildTiersUpdated(uint8 tierCount, uint256[] thresholds, uint256[] boostMultipliers, uint256[] feeRates);
    /// @notice Emitted when admin updates the minimum members needed for tier calculation
    event MinMembersForTierUpdated(uint8 oldMin, uint8 newMin);
    /// @notice Emitted when admin updates the MiningStake contract address
    event MiningStakeUpdated(address indexed oldStake, address indexed newStake);
    /// @notice Emitted when admin updates the minimum membership duration for treasury claims
    event MinMembershipForClaimUpdated(uint256 oldMin, uint256 newMin);
    /// @notice Emitted when admin updates the guild join cooldown period
    event GuildJoinCooldownUpdated(uint256 oldCooldown, uint256 newCooldown);
    /// @notice Emitted when an agent is force-removed from a guild by MiningStake (unstake/slash)
    event MemberForceRemoved(uint256 indexed guildId, address indexed agent, uint8 newMemberCount);
    /// @notice Emitted when a leaving/removed member's treasury share is recorded as a pending claim
    event PendingTreasuryRecorded(address indexed agent, uint256 amount);
    /// @notice Emitted when a member withdraws their pending treasury claim
    event PendingTreasuryClaimed(address indexed agent, uint256 amount);
    /// @notice Emitted when a member is restored to their guild after cancelling an unstake
    event MemberRestored(uint256 indexed guildId, address indexed agent, uint8 newMemberCount);
    /// @notice Emitted when admin withdraws excess ERC-20 tokens (above escrowed amounts)
    event EmergencyWithdraw(address indexed token, address indexed to, uint256 amount);
    /// @notice Emitted when admin rescues native ETH accidentally sent to the contract
    event NativeETHRescued(address indexed to, uint256 amount);

    // ============================================================
    //                        INITIALIZER
    // ============================================================

    /// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
    constructor(address trustedForwarder_) ERC2771ContextUpgradeable(trustedForwarder_) {
        _disableInitializers();
    }

    /**
     * @notice Initialize the MiningGuild contract.
     * @param owner_ Admin address
     * @param nookToken_ NOOK ERC-20 address
     * @param miningStake_ MiningStake contract address
     */
    function initialize(
        address owner_,
        address nookToken_,
        address miningStake_
    ) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        if (nookToken_ == address(0)) revert ZeroAddress();
        if (miningStake_ == address(0)) revert ZeroAddress();

        __Ownable_init(owner_);
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        nookToken = IERC20(nookToken_);
        miningStake = IMiningStake(miningStake_);
        miningStakeAddress = miningStake_;

        nextGuildId = 1;
        maxMembers = 6;
        creationCooldown = 24 hours;
        minStakeToCreate = 3_000_000 ether; // 3M NOOK — prevents zero-stake guild spam
        minStakeToJoin = 3_000_000 ether;  // 3M NOOK — must be staked to join a guild
        minMembersForTier = 3;
        minMembershipForClaim = 24 hours;
        guildJoinCooldown = 1 hours;
    }

    // ============================================================
    //                    GUILD LIFECYCLE
    // ============================================================

    /**
     * @notice Create a new mining guild. Caller becomes the first member.
     * @param name Guild name (unique, case-insensitive, max 50 chars)
     * @param domains Domain specializations (max 10, e.g., keccak256("smart_contract_audit"))
     *
     * @dev Agent must have active stake (not unstaking) above minStakeToCreate
     *      (zero-stake agents cannot create guilds, but the threshold is admin-configurable).
     *      One guild per agent. 24h cooldown between creations per address.
     *      Guild starts at tier 0 (needs minMembersForTier members for tier 1+).
     *
     * Emits {GuildCreated} and {MemberJoined}.
     */
    function createGuild(string calldata name, bytes32[] calldata domains) external whenNotPaused nonReentrant {
        address sender = _msgSender();

        // Validate name (ASCII check + case-insensitive hash in single pass)
        bytes memory nameBytes = bytes(name);
        if (nameBytes.length == 0) revert NameEmpty();
        if (nameBytes.length > MAX_NAME_LENGTH) revert NameTooLong();

        bytes32 nameHash = _validateAndLowerHash(nameBytes);
        if (_nameTaken[nameHash]) revert NameTaken();

        // Validate domains
        if (domains.length > MAX_DOMAINS) revert TooManyDomains();

        // Must have sufficient stake and NOT be unstaking
        IMiningStake.StakeInfo memory stakeInfo = miningStake.getStakeInfo(sender);
        if (stakeInfo.amount < minStakeToCreate) revert BelowMinStake();
        if (stakeInfo.unstakeRequestedAt != 0) revert AgentIsUnstaking();

        // Cannot already be in a guild
        if (guildOf[sender] != 0) revert AlreadyInGuild();

        // Creation cooldown
        if (block.timestamp < lastGuildCreatedAt[sender] + creationCooldown) {
            revert CreationCooldownActive();
        }

        uint256 guildId = nextGuildId++;

        _guilds[guildId] = Guild({
            name: name,
            creator: sender,
            createdAt: block.timestamp,
            memberCount: 1,
            treasuryBalance: 0,
            tier: 0
        });

        _members[guildId].push(sender);
        guildOf[sender] = guildId;
        _nameTaken[nameHash] = true;
        _guildNameHash[guildId] = nameHash;
        lastGuildCreatedAt[sender] = block.timestamp;
        memberJoinedAt[guildId][sender] = block.timestamp;
        lastMemberJoinedAt[guildId] = block.timestamp;

        // Store domains
        for (uint256 i = 0; i < domains.length; ) {
            _domains[guildId].push(domains[i]);
            unchecked { ++i; }
        }

        emit GuildCreated(guildId, sender, name, domains);
        emit MemberJoined(guildId, sender, 1);
    }

    /**
     * @notice Join an existing guild.
     * @param guildId Guild to join
     *
     * @dev Agent must have active stake (not unstaking) above minStakeToJoin.
     *      Cannot be in another guild. 48h cooldown after being kicked.
     *      guildJoinCooldown enforced between successive joins to the same guild.
     *      Kick votes are reset on membership change.
     *
     * Emits {MemberJoined} and optionally {GuildTierChanged}.
     */
    function joinGuild(uint256 guildId) external whenNotPaused nonReentrant {
        address sender = _msgSender();

        Guild storage guild = _guilds[guildId];
        if (guild.createdAt == 0) revert GuildNotFound();
        if (guild.memberCount >= maxMembers) revert GuildFull();
        if (guildOf[sender] != 0) revert AlreadyInGuild();

        // Must have sufficient stake and NOT be unstaking
        IMiningStake.StakeInfo memory stakeInfo = miningStake.getStakeInfo(sender);
        if (stakeInfo.amount < minStakeToJoin) revert BelowMinStake();
        if (stakeInfo.unstakeRequestedAt != 0) revert AgentIsUnstaking();

        // Kick rejoin cooldown
        if (block.timestamp < lastKickedAt[sender] + KICK_REJOIN_COOLDOWN) {
            revert KickCooldownActive();
        }

        // Per-guild join rate limit — prevents sybil flooding
        if (guildJoinCooldown > 0 && block.timestamp < lastMemberJoinedAt[guildId] + guildJoinCooldown) {
            revert GuildJoinCooldownActive();
        }

        uint8 oldTier = guild.tier;

        guild.memberCount++;
        _members[guildId].push(sender);
        guildOf[sender] = guildId;

        // Clear stale kick vote mappings from a prior membership in this guild.
        // Without this, a member who left and rejoined would be permanently
        // unable to vote against the same targets they voted against before.
        address[] storage members = _members[guildId];
        for (uint256 i = 0; i < members.length; ) {
            delete _kickVotes[guildId][members[i]][sender]; // sender's old votes against members
            delete _kickVotes[guildId][sender][members[i]]; // old votes against sender
            unchecked { ++i; }
        }

        // Prevent new joiner from claiming treasury shares deposited before they joined.
        // Without this, a joiner can front-run claims and steal an original member's share.
        memberRewardDebt[guildId][sender] = rewardPerShare[guildId];

        // Clear stale previousGuild if agent is manually joining (overrides restore target)
        delete previousGuild[sender];

        // Record join timestamp — read off-chain for boost sniping protection
        // and enforced on-chain for minimum membership before treasury claims.
        memberJoinedAt[guildId][sender] = block.timestamp;
        lastMemberJoinedAt[guildId] = block.timestamp;

        // Recalculate guild tier — skip N external calls if below min members (always tier 0)
        uint8 newTier = guild.memberCount >= minMembersForTier ? _calculateGuildTier(guildId) : 0;
        guild.tier = newTier;

        // Reset all kick votes (membership changed)
        _resetAllKickVotes(guildId);

        emit MemberJoined(guildId, sender, guild.memberCount);

        if (oldTier != newTier) {
            emit GuildTierChanged(guildId, oldTier, newTier);
        }
    }

    /**
     * @notice Leave your current guild voluntarily.
     *
     * @dev If the caller is the last member, any remaining treasury balance
     *      (including integer-truncation dust) is auto-swept to them. This
     *      prevents the dust-lock bug where accumulator rounding leaves a few
     *      wei in treasuryBalance that the last member can neither claim nor
     *      leave behind.
     *      Empty guilds are dissolved (name freed for reuse).
     *
     * Emits {MemberLeft}, optionally {TreasuryClaimed}, {GuildTierChanged}, {GuildDissolved}.
     */
    function leaveGuild() external whenNotPaused nonReentrant {
        address sender = _msgSender();
        uint256 guildId = guildOf[sender];
        if (guildId == 0) revert NotInGuild();

        Guild storage guild = _guilds[guildId];

        // Last member: auto-sweep remaining treasury (including dust from
        // integer truncation) so they are never locked.
        uint256 swept = 0;
        if (guild.memberCount == 1 && guild.treasuryBalance > 0) {
            swept = guild.treasuryBalance;
            guild.treasuryBalance = 0;
            totalTreasuryHeld -= swept;
        } else if (guild.memberCount > 1) {
            // Non-last member: settle accumulated treasury share as pending claim
            // ONLY if minimum membership duration is met. This prevents treasury sniping
            // where an attacker joins, front-runs a deposit, and immediately leaves to
            // claim via claimPendingTreasury() — bypassing the 24h minimum membership
            // gate on claimTreasuryShare().
            // Involuntary removals (kick, unstake, force-remove) always settle —
            // those members earned their share and should not lose it.
            if (block.timestamp >= memberJoinedAt[guildId][sender] + minMembershipForClaim) {
                _settlePendingTreasury(guildId, sender);
            }
            // If membership too new, accumulated share stays in guild treasury (forfeited).
        }

        uint8 oldTier = guild.tier;

        _removeMember(guildId, sender);

        emit MemberLeft(guildId, sender, guild.memberCount);

        if (guild.memberCount == 0) {
            // Dissolve empty guild — free the name
            _dissolveGuild(guildId);
        } else {
            // Skip N external calls if below min members (always tier 0)
            uint8 newTier = guild.memberCount >= minMembersForTier ? _calculateGuildTier(guildId) : 0;
            guild.tier = newTier;
            if (oldTier != newTier) {
                emit GuildTierChanged(guildId, oldTier, newTier);
            }
        }

        // Interaction: transfer swept treasury AFTER all state changes (CEI)
        if (swept > 0) {
            nookToken.safeTransfer(sender, swept);
            emit TreasuryClaimed(guildId, sender, swept);
        }
    }

    // ============================================================
    //                    KICK VOTING
    // ============================================================

    /**
     * @notice Vote to kick a member from the guild. Requires unanimous vote
     *         from all OTHER members (excluding the target).
     * @param guildId Guild ID
     * @param target Member address to kick
     *
     * @dev Kick votes reset on any membership change (join/leave/kick).
     *      Kicked agents have a 48h cooldown before rejoining any guild.
     *
     * Emits {KickVoteSubmitted} and optionally {MemberKicked}, {GuildTierChanged}, {GuildDissolved}.
     */
    function voteKick(uint256 guildId, address target) external whenNotPaused nonReentrant {
        address sender = _msgSender();

        Guild storage guild = _guilds[guildId];
        if (guild.createdAt == 0) revert GuildNotFound();
        if (guild.memberCount < 3) revert GuildTooSmallForKick();
        if (guildOf[sender] != guildId) revert NotInThisGuild();
        if (guildOf[target] != guildId) revert NotInThisGuild();
        if (sender == target) revert CannotKickSelf();
        if (_kickVotes[guildId][target][sender]) revert AlreadyVotedKick();

        _kickVotes[guildId][target][sender] = true;
        kickVoteCount[guildId][target]++;

        // Unanimous = all members except the target
        uint256 votesNeeded = uint256(guild.memberCount) - 1;

        emit KickVoteSubmitted(guildId, target, sender, kickVoteCount[guildId][target], votesNeeded);

        // Execute kick if unanimous
        if (kickVoteCount[guildId][target] >= votesNeeded) {
            // Settle target's accumulated treasury share before removal so they
            // don't forfeit earned shares. Kick is atomic — no window to claim first.
            _settlePendingTreasury(guildId, target);

            uint8 oldTier = guild.tier;

            lastKickedAt[target] = block.timestamp;
            _removeMember(guildId, target);

            emit MemberKicked(guildId, target, guild.memberCount);

            if (guild.memberCount == 0) {
                _dissolveGuild(guildId);
            } else {
                uint8 newTier = guild.memberCount >= minMembersForTier ? _calculateGuildTier(guildId) : 0;
                guild.tier = newTier;
                if (oldTier != newTier) {
                    emit GuildTierChanged(guildId, oldTier, newTier);
                }
            }
        }
    }

    // ============================================================
    //                    TREASURY
    // ============================================================

    /**
     * @notice Deposit NOOK into a guild's treasury. Anyone can deposit.
     * @param guildId Guild to deposit into
     * @param amount NOOK amount to deposit
     *
     * @dev Used by the root publisher to deposit guild fee portions after each epoch.
     *      Also allows anyone (members, sponsors) to fund a guild.
     *
     * Emits {TreasuryDeposited}.
     */
    function depositTreasury(uint256 guildId, uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Guild storage guild = _guilds[guildId];
        if (guild.createdAt == 0) revert GuildNotFound();
        if (guild.memberCount == 0) revert GuildHasNoMembers();

        address sender = _msgSender();

        // Accumulate per-member share. Unclaimed shares carry forward automatically —
        // members can claim at any time without losing entitlements from prior deposits.
        rewardPerShare[guildId] += (amount * TREASURY_PRECISION) / uint256(guild.memberCount);

        // Effects
        guild.treasuryBalance += amount;
        totalTreasuryHeld += amount;

        // Interactions
        nookToken.safeTransferFrom(sender, address(this), amount);

        emit TreasuryDeposited(guildId, sender, amount);
    }

    /**
     * @notice Claim accumulated treasury shares. Uses a reward-per-share accumulator
     *         so unclaimed shares carry forward across deposits — no "use it or lose it."
     *         Each member's entitlement = (rewardPerShare - memberRewardDebt) / PRECISION.
     * @param guildId Guild to claim from
     *
     * @dev When a member leaves or is kicked, their accumulated share is auto-settled
     *      as a pendingTreasuryClaim (pull pattern). They claim via claimPendingTreasury().
     *
     * Emits {TreasuryClaimed}.
     */
    function claimTreasuryShare(uint256 guildId) external whenNotPaused nonReentrant {
        address sender = _msgSender();
        if (guildOf[sender] != guildId) revert NotInThisGuild();

        // Minimum membership duration before claiming — prevents boost/treasury sniping
        if (block.timestamp < memberJoinedAt[guildId][sender] + minMembershipForClaim) {
            revert MembershipTooNew();
        }

        Guild storage guild = _guilds[guildId];

        // Calculate accumulated unclaimed share via accumulator delta
        uint256 accumulated = rewardPerShare[guildId];
        uint256 debt = memberRewardDebt[guildId][sender];
        if (accumulated <= debt) revert NothingToClaim();

        uint256 share = (accumulated - debt) / TREASURY_PRECISION;
        if (share == 0) revert NothingToClaim();

        // Safety: cap at remaining balance (handles dust from integer division)
        if (share > guild.treasuryBalance) {
            share = guild.treasuryBalance;
        }

        // Effects: update debt to current accumulator (CEI pattern)
        memberRewardDebt[guildId][sender] = accumulated;
        guild.treasuryBalance -= share;
        totalTreasuryHeld -= share;

        // Interactions
        nookToken.safeTransfer(sender, share);

        emit TreasuryClaimed(guildId, sender, share);
    }

    /**
     * @notice Claim pending treasury funds from force-removal via onUnstake.
     *         When the last guild member is force-removed (unstake/slash), their
     *         treasury share is recorded as a pending claim instead of transferred
     *         directly (pull pattern — keeps onUnstake revert-safe).
     *
     * @dev Anyone with a pending balance can claim. No guild membership required.
     *
     * Emits {PendingTreasuryClaimed}.
     */
    function claimPendingTreasury() external nonReentrant {
        address sender = _msgSender();
        uint256 amount = pendingTreasuryClaim[sender];
        if (amount == 0) revert NothingToClaim();

        // Effects
        pendingTreasuryClaim[sender] = 0;
        totalPendingClaims -= amount;

        // Interactions
        nookToken.safeTransfer(sender, amount);

        emit PendingTreasuryClaimed(sender, amount);
    }

    // ============================================================
    //                MINSTAKE CALLBACK
    // ============================================================

    /**
     * @notice Called by MiningStake when an agent unstakes or is slashed.
     *         Force-removes the agent from their guild.
     * @param agent Address of the agent being unstaked/slashed
     *
     * @dev Only callable by the MiningStake contract. Silently returns if
     *      the agent isn't in a guild (no revert — keeps MiningStake flow clean).
     *      Guild tier is recalculated. Empty guilds are dissolved.
     *
     * Emits {MemberLeft}, optionally {GuildTierChanged}, optionally {GuildDissolved},
     *      optionally {PendingTreasuryRecorded}.
     */
    function onUnstake(address agent) external nonReentrant {
        if (msg.sender != miningStakeAddress) revert OnlyMiningStake();

        uint256 guildId = guildOf[agent];
        if (guildId == 0) return; // Not in a guild, nothing to do

        // Store previous guild so onCancelUnstake can restore membership
        previousGuild[agent] = guildId;

        Guild storage guild = _guilds[guildId];

        // Last member: record pending treasury claim so they can pull it later.
        // We use a pull pattern (not direct transfer) because this function is
        // called inside MiningStake's try/catch — a safeTransfer revert here
        // would be silently swallowed, leaving the agent as a zombie member.
        if (guild.memberCount == 1 && guild.treasuryBalance > 0) {
            uint256 swept = guild.treasuryBalance;
            guild.treasuryBalance = 0;
            totalTreasuryHeld -= swept;
            pendingTreasuryClaim[agent] += swept;
            totalPendingClaims += swept;
            emit PendingTreasuryRecorded(agent, swept);
        } else if (guild.memberCount > 1) {
            // Non-last member: settle accumulated treasury share as pending claim
            // so they don't forfeit earned shares.
            _settlePendingTreasury(guildId, agent);
        }

        uint8 oldTier = guild.tier;

        _removeMember(guildId, agent);

        emit MemberLeft(guildId, agent, guild.memberCount);

        if (guild.memberCount == 0) {
            _dissolveGuild(guildId);
        } else {
            uint8 newTier = guild.memberCount >= minMembersForTier ? _calculateGuildTier(guildId) : 0;
            guild.tier = newTier;
            if (oldTier != newTier) {
                emit GuildTierChanged(guildId, oldTier, newTier);
            }
        }
    }

    /**
     * @notice Called by MiningStake when an agent cancels their unstake.
     *         Best-effort restore of guild membership from previousGuild.
     * @param agent Address of the agent who cancelled unstake
     *
     * @dev Only callable by the MiningStake contract. Silently returns (no revert)
     *      if restore is not possible — agent falls back to manual joinGuild().
     *
     *      Restore fails silently when:
     *      - No previousGuild recorded (agent wasn't in a guild before unstake)
     *      - Guild was dissolved (memberCount == 0, createdAt reset)
     *      - Guild is full (memberCount >= maxMembers)
     *      - Agent already joined a different guild
     *
     *      On success: agent is re-added to the guild, tier is recalculated,
     *      memberRewardDebt is set to current rewardPerShare (treasury deposits
     *      during the gap are intentionally forfeited — agent wasn't contributing).
     *      The guildJoinCooldown is NOT applied (this is a restore, not a fresh join).
     *      Kick votes ARE reset (returning member shifts vote thresholds).
     *
     * Emits {MemberRestored} and optionally {GuildTierChanged}.
     */
    function onCancelUnstake(address agent) external nonReentrant {
        if (msg.sender != miningStakeAddress) revert OnlyMiningStake();

        uint256 guildId = previousGuild[agent];
        if (guildId == 0) return; // No previous guild recorded

        // Clear previousGuild regardless of outcome
        delete previousGuild[agent];

        // Can't restore if agent already joined another guild
        if (guildOf[agent] != 0) return;

        Guild storage guild = _guilds[guildId];

        // Can't restore to dissolved guild
        if (guild.createdAt == 0) return;

        // Can't restore if guild is full
        if (guild.memberCount >= maxMembers) return;

        // Restore membership
        uint8 oldTier = guild.tier;

        guild.memberCount++;
        _members[guildId].push(agent);
        guildOf[agent] = guildId;

        // Prevent claiming treasury shares deposited during the gap
        memberRewardDebt[guildId][agent] = rewardPerShare[guildId];

        // Record join timestamp for minimum membership enforcement
        memberJoinedAt[guildId][agent] = block.timestamp;

        // NOTE: lastMemberJoinedAt is NOT updated — this is a restore, not a fresh join.
        // guildJoinCooldown should not be triggered by a returning member.

        // Recalculate tier
        uint8 newTier = guild.memberCount >= minMembersForTier ? _calculateGuildTier(guildId) : 0;
        guild.tier = newTier;

        // Reset all kick votes — membership changed (returning member shifts vote thresholds)
        _resetAllKickVotes(guildId);

        emit MemberRestored(guildId, agent, guild.memberCount);

        if (oldTier != newTier) {
            emit GuildTierChanged(guildId, oldTier, newTier);
        }
    }

    // ============================================================
    //                    VIEW FUNCTIONS
    // ============================================================

    /**
     * @notice Get guild info.
     * @param guildId Guild ID to look up
     * @return name Guild name
     * @return creator Address that created the guild
     * @return createdAt Timestamp of creation
     * @return memberCount Current member count
     * @return treasuryBalance NOOK in treasury
     * @return tier Current guild tier (live calculation from member stakes)
     * @return boostMultiplier Reward boost in basis points (100 = 1.0x)
     * @return feeRate Fee in basis points (500 = 5%)
     */
    function getGuild(uint256 guildId) external view returns (
        string memory name,
        address creator,
        uint256 createdAt,
        uint8 memberCount,
        uint256 treasuryBalance,
        uint8 tier,
        uint256 boostMultiplier,
        uint256 feeRate
    ) {
        Guild storage guild = _guilds[guildId];
        uint8 t = _calculateGuildTier(guildId);
        return (
            guild.name,
            guild.creator,
            guild.createdAt,
            guild.memberCount,
            guild.treasuryBalance,
            t,
            t > 0 ? guildTiers[t - 1].boostMultiplier : 100,
            t > 0 ? guildTiers[t - 1].feeRate : 0
        );
    }

    /**
     * @notice Get all members of a guild.
     */
    function getMembers(uint256 guildId) external view returns (address[] memory) {
        return _members[guildId];
    }

    /**
     * @notice Get the live guild tier (computed from current member stakes via MiningStake).
     *         Equivalent to the tier returned by getGuild().
     */
    function getLiveGuildTier(uint256 guildId) external view returns (uint8) {
        return _calculateGuildTier(guildId);
    }

    /**
     * @notice Get the reward boost multiplier for a guild (basis points, 100 = 1.0x).
     *         Uses live tier calculation to reflect current member stakes.
     */
    function getBoostMultiplier(uint256 guildId) external view returns (uint256) {
        uint8 tier = _calculateGuildTier(guildId);
        if (tier == 0) return 100; // 1.0x (no boost)
        return guildTiers[tier - 1].boostMultiplier;
    }

    /**
     * @notice Get the fee rate for a guild (basis points, 500 = 5%).
     *         Uses live tier calculation to reflect current member stakes.
     */
    function getFeeRate(uint256 guildId) external view returns (uint256) {
        uint8 tier = _calculateGuildTier(guildId);
        if (tier == 0) return 0; // No fee for tier 0
        return guildTiers[tier - 1].feeRate;
    }

    /**
     * @notice Get the combined stake of all guild members (live from MiningStake).
     */
    function getCombinedStake(uint256 guildId) external view returns (uint256) {
        return _getCombinedStake(guildId);
    }

    /**
     * @notice Get domains for a guild.
     */
    function getDomains(uint256 guildId) external view returns (bytes32[] memory) {
        return _domains[guildId];
    }

    /**
     * @notice Check kick votes against a target in a guild.
     * @return votes Current vote count
     * @return needed Votes needed for unanimous kick
     */
    function getKickVotes(uint256 guildId, address target) external view returns (
        uint256 votes,
        uint256 needed
    ) {
        Guild storage guild = _guilds[guildId];
        uint256 votesNeeded = guild.memberCount > 1 ? uint256(guild.memberCount) - 1 : 1;
        return (kickVoteCount[guildId][target], votesNeeded);
    }

    /**
     * @notice Get all guild tier configurations.
     */
    function getGuildTierConfigs() external view returns (GuildTierConfig[] memory) {
        GuildTierConfig[] memory result = new GuildTierConfig[](guildTierCount);
        for (uint8 i = 0; i < guildTierCount; ) {
            result[i] = guildTiers[i];
            unchecked { ++i; }
        }
        return result;
    }

    // ============================================================
    //                    INTERNAL FUNCTIONS
    // ============================================================

    /**
     * @dev Remove a member from a guild. Handles cleanup: member array,
     *      guildOf mapping, kick votes. Does NOT recalculate tier (caller does).
     */
    function _removeMember(uint256 guildId, address agent) internal {
        Guild storage guild = _guilds[guildId];

        // Remove from member array (swap with last)
        address[] storage members = _members[guildId];
        bool found = false;
        for (uint256 i = 0; i < members.length; ) {
            if (members[i] == agent) {
                members[i] = members[members.length - 1];
                members.pop();
                found = true;
                break;
            }
            unchecked { ++i; }
        }
        if (!found) revert NotInThisGuild();

        guild.memberCount--;
        guildOf[agent] = 0;

        // Reset kick votes against the removed member
        _resetKickVotesFor(guildId, agent);

        // Reset all kick votes (membership changed)
        _resetAllKickVotes(guildId);
    }

    /**
     * @dev Dissolve an empty guild — free the name for reuse.
     */
    function _dissolveGuild(uint256 guildId) internal {
        Guild storage guild = _guilds[guildId];

        // Free the name
        bytes32 nameHash = _guildNameHash[guildId];
        if (nameHash != bytes32(0)) {
            _nameTaken[nameHash] = false;
            delete _guildNameHash[guildId];
        }

        // If treasury had balance (e.g., force-removed via onUnstake),
        // reduce totalTreasuryHeld so admin can recover via emergencyWithdraw
        uint256 orphanedTreasury = guild.treasuryBalance;
        if (orphanedTreasury > 0) {
            totalTreasuryHeld -= orphanedTreasury;
            guild.treasuryBalance = 0;
        }

        // Clean up storage — reclaim gas refunds for dead guild data.
        // name (string, multi-slot), creator, createdAt, memberCount, tier
        // are all cleared by delete. _domains array is also freed.
        delete _guilds[guildId];
        delete _domains[guildId];

        emit GuildDissolved(guildId, orphanedTreasury);
    }

    /**
     * @dev Calculate the guild tier based on combined member stakes.
     *      Only members with amount > 0 count toward minMembersForTier.
     *      This prevents zero-stake members (joined with minStakeToJoin=0,
     *      or fully slashed) from inflating the tier.
     *      Combined into a single loop with stake summation for gas efficiency.
     */
    function _calculateGuildTier(uint256 guildId) internal view returns (uint8) {
        address[] storage members = _members[guildId];
        uint256 stakedMemberCount = 0;
        uint256 combined = 0;
        // Use getStakeAmount (32-byte return) instead of getStakeInfo (192-byte return)
        // to reduce ABI decode + memory expansion cost per member.
        for (uint256 i = 0; i < members.length; ) {
            uint256 stakeAmount = miningStake.getStakeAmount(members[i]);
            if (stakeAmount > 0) {
                stakedMemberCount++;
                combined += stakeAmount;
            }
            unchecked { ++i; }
        }

        if (stakedMemberCount < minMembersForTier) return 0;

        for (uint8 i = guildTierCount; i > 0; ) {
            if (combined >= guildTiers[i - 1].threshold) {
                return i;
            }
            unchecked { --i; }
        }
        return 0;
    }

    /**
     * @dev Sum all member stakes from MiningStake contract.
     */
    function _getCombinedStake(uint256 guildId) internal view returns (uint256) {
        address[] storage members = _members[guildId];
        uint256 combined = 0;
        for (uint256 i = 0; i < members.length; ) {
            combined += miningStake.getStakeAmount(members[i]);
            unchecked { ++i; }
        }
        return combined;
    }

    /**
     * @dev Settle a member's accumulated treasury share as a pending claim.
     *      Called before removal for non-last members so they don't forfeit
     *      earned treasury shares. Uses pull pattern (pendingTreasuryClaim)
     *      for consistency across all removal paths, including onUnstake which
     *      runs inside MiningStake's try/catch where a direct transfer revert
     *      would be silently swallowed.
     */
    function _settlePendingTreasury(uint256 guildId, address agent) internal {
        uint256 accumulated = rewardPerShare[guildId];
        uint256 debt = memberRewardDebt[guildId][agent];
        if (accumulated > debt) {
            // Defense-in-depth: mark debt as settled even though agent is about to be
            // removed. Prevents any future regression from allowing a double-claim if
            // removal logic changes.
            memberRewardDebt[guildId][agent] = accumulated;

            uint256 share = (accumulated - debt) / TREASURY_PRECISION;
            if (share > 0) {
                Guild storage guild = _guilds[guildId];
                if (share > guild.treasuryBalance) {
                    share = guild.treasuryBalance;
                }
                guild.treasuryBalance -= share;
                totalTreasuryHeld -= share;
                pendingTreasuryClaim[agent] += share;
                totalPendingClaims += share;
                emit PendingTreasuryRecorded(agent, share);
            }
        }
    }

    /**
     * @dev Reset all kick votes for a specific target in a guild.
     */
    function _resetKickVotesFor(uint256 guildId, address target) internal {
        address[] storage members = _members[guildId];
        for (uint256 i = 0; i < members.length; ) {
            delete _kickVotes[guildId][target][members[i]];
            unchecked { ++i; }
        }
        // Also clear the removed member's own vote against the target
        delete _kickVotes[guildId][target][target];

        if (kickVoteCount[guildId][target] > 0) {
            kickVoteCount[guildId][target] = 0;
            emit KickVotesReset(guildId, target);
        }
    }

    /**
     * @dev Reset ALL kick votes in a guild (called on membership change).
     *      O(n²) where n = memberCount. Bounded by MAX_MEMBERS_CAP (50) —
     *      worst case ~2500 iterations ≈ 756K gas measured (well within Base 30M block limit).
     */
    function _resetAllKickVotes(uint256 guildId) internal {
        address[] storage members = _members[guildId];
        for (uint256 i = 0; i < members.length; ) {
            if (kickVoteCount[guildId][members[i]] > 0) {
                for (uint256 j = 0; j < members.length; ) {
                    delete _kickVotes[guildId][members[i]][members[j]];
                    unchecked { ++j; }
                }
                kickVoteCount[guildId][members[i]] = 0;
                emit KickVotesReset(guildId, members[i]);
            }
            unchecked { ++i; }
        }
    }

    /**
     * @dev Validate ASCII printable range and compute case-insensitive name hash
     *      in a single pass. Saves one full name iteration vs separate _requireAscii
     *      + _toLower calls. Returns keccak256 of the lowercase name bytes.
     */
    function _validateAndLowerHash(bytes memory b) internal pure returns (bytes32) {
        bytes memory lower = new bytes(b.length);
        for (uint256 i; i < b.length; ) {
            bytes1 c = b[i];
            if (c < 0x20 || c > 0x7E) revert NameNotAscii();
            lower[i] = (c >= 0x41 && c <= 0x5A) ? bytes1(uint8(c) + 32) : c;
            unchecked { ++i; }
        }
        return keccak256(abi.encodePacked(lower));
    }

    // ============================================================
    //                      ADMIN FUNCTIONS
    // ============================================================

    /**
     * @notice Set max members per guild.
     * @param newMax New maximum (must be > 0)
     *
     * @dev Existing guilds above the new cap can't add members but aren't forced to shrink.
     *
     * Emits {MaxMembersUpdated}.
     */
    function setMaxMembers(uint256 newMax) external onlyOwner {
        if (newMax == 0) revert ZeroAmount();
        if (newMax > MAX_MEMBERS_CAP) revert ExceedsMaxMembersCap();
        uint256 oldMax = maxMembers;
        maxMembers = newMax;
        emit MaxMembersUpdated(oldMax, newMax);
    }

    /**
     * @notice Set guild creation cooldown.
     * @param newCooldown New cooldown in seconds
     *
     * Emits {CreationCooldownUpdated}.
     */
    function setCreationCooldown(uint256 newCooldown) external onlyOwner {
        uint256 oldCooldown = creationCooldown;
        creationCooldown = newCooldown;
        emit CreationCooldownUpdated(oldCooldown, newCooldown);
    }

    /**
     * @notice Set minimum stake to create a guild.
     * @param newMin New minimum in NOOK (18 decimals)
     *
     * Emits {MinStakeToCreateUpdated}.
     */
    function setMinStakeToCreate(uint256 newMin) external onlyOwner {
        uint256 oldMin = minStakeToCreate;
        minStakeToCreate = newMin;
        emit MinStakeToCreateUpdated(oldMin, newMin);
    }

    /**
     * @notice Set minimum stake to join a guild.
     * @param newMin New minimum in NOOK (18 decimals)
     *
     * Emits {MinStakeToJoinUpdated}.
     */
    function setMinStakeToJoin(uint256 newMin) external onlyOwner {
        uint256 oldMin = minStakeToJoin;
        minStakeToJoin = newMin;
        emit MinStakeToJoinUpdated(oldMin, newMin);
    }

    /**
     * @notice Set minimum membership duration before a member can claim treasury shares.
     * @param newMin New minimum duration in seconds (0 = no minimum)
     *
     * @dev Prevents treasury sniping — agents must be guild members for this long
     *      before claimTreasuryShare() works. The off-chain reward service can also read memberJoinedAt
     *      to enforce minimum membership for boost multiplier application.
     *
     * Emits {MinMembershipForClaimUpdated}.
     */
    function setMinMembershipForClaim(uint256 newMin) external onlyOwner {
        uint256 oldMin = minMembershipForClaim;
        minMembershipForClaim = newMin;
        emit MinMembershipForClaimUpdated(oldMin, newMin);
    }

    /**
     * @notice Set per-guild join rate limit cooldown.
     * @param newCooldown New cooldown in seconds (0 = no rate limit)
     *
     * @dev After someone joins a guild, the next join to that same guild must wait
     *      this long. Prevents sybil flooding — spreading joins over time gives
     *      legitimate members time to notice and react.
     *
     * Emits {GuildJoinCooldownUpdated}.
     */
    function setGuildJoinCooldown(uint256 newCooldown) external onlyOwner {
        uint256 oldCooldown = guildJoinCooldown;
        guildJoinCooldown = newCooldown;
        emit GuildJoinCooldownUpdated(oldCooldown, newCooldown);
    }

    /**
     * @notice Set minimum members required for tier 1+ benefits.
     * @param newMin New minimum member count
     *
     * Emits {MinMembersForTierUpdated}.
     */
    function setMinMembersForTier(uint8 newMin) external onlyOwner {
        uint8 oldMin = minMembersForTier;
        minMembersForTier = newMin;
        emit MinMembersForTierUpdated(oldMin, newMin);
    }

    /**
     * @notice Update the MiningStake contract reference.
     * @param newStake New MiningStake contract address
     *
     * @dev Only needed if MiningStake is ever redeployed to a new proxy address.
     *
     * Emits {MiningStakeUpdated}.
     */
    function setMiningStake(address newStake) external onlyOwner {
        if (newStake == address(0)) revert ZeroAddress();
        address oldStake = miningStakeAddress;
        miningStake = IMiningStake(newStake);
        miningStakeAddress = newStake;
        emit MiningStakeUpdated(oldStake, newStake);
    }

    /**
     * @notice Set all guild tier configurations (thresholds, boosts, fees).
     * @param newTiers Array of GuildTierConfig in ascending threshold order.
     *
     * @dev Validates ascending thresholds and ascending boost multipliers.
     *      Existing guilds are reclassified based on new thresholds — no grandfathering.
     *
     * Emits {GuildTiersUpdated}.
     */
    function setGuildTiers(GuildTierConfig[] calldata newTiers) external onlyOwner {
        if (newTiers.length > MAX_GUILD_TIERS) revert TooManyTiers();

        for (uint256 i = 0; i < newTiers.length; ) {
            if (newTiers[i].threshold == 0) revert ZeroAmount();
            if (i > 0 && newTiers[i].threshold <= newTiers[i - 1].threshold) {
                revert InvalidTierOrder();
            }
            if (i > 0 && newTiers[i].boostMultiplier <= newTiers[i - 1].boostMultiplier) {
                revert InvalidTierOrder();
            }
            // Fee rates must be non-descending (allows flat fees across tiers)
            if (i > 0 && newTiers[i].feeRate < newTiers[i - 1].feeRate) {
                revert InvalidTierOrder();
            }
            unchecked { ++i; }
        }

        // Clear old tiers
        for (uint8 i = 0; i < guildTierCount; ) {
            delete guildTiers[i];
            unchecked { ++i; }
        }

        // Set new tiers + build arrays for event
        uint256[] memory thresholds = new uint256[](newTiers.length);
        uint256[] memory boostMultipliers = new uint256[](newTiers.length);
        uint256[] memory feeRates = new uint256[](newTiers.length);
        for (uint256 i = 0; i < newTiers.length; ) {
            guildTiers[uint8(i)] = newTiers[i];
            thresholds[i] = newTiers[i].threshold;
            boostMultipliers[i] = newTiers[i].boostMultiplier;
            feeRates[i] = newTiers[i].feeRate;
            unchecked { ++i; }
        }

        guildTierCount = uint8(newTiers.length);
        emit GuildTiersUpdated(guildTierCount, thresholds, boostMultipliers, feeRates);
    }

    /**
     * @notice Admin force-remove an agent from their guild. Use when onUnstake()
     *         silently fails (try/catch) and the agent is left orphaned in a guild
     *         with 0 stake.
     * @param agent Address of the agent to remove
     *
     * @dev Same removal logic as onUnstake/leaveGuild — recalculates tier, dissolves
     *      empty guilds. Does NOT set lastKickedAt (no rejoin cooldown penalty).
     *      If agent is the last member, their treasury share is recorded as a pending
     *      claim (pull pattern, same as onUnstake) so admin can't accidentally orphan funds.
     *
     * Emits {MemberForceRemoved}, optionally {PendingTreasuryRecorded},
     *        {GuildTierChanged}, {GuildDissolved}.
     */
    function forceRemoveFromGuild(address agent) external onlyOwner nonReentrant {
        uint256 guildId = guildOf[agent];
        if (guildId == 0) revert NotInGuild();

        Guild storage guild = _guilds[guildId];

        // Last member: record pending treasury claim (same logic as onUnstake).
        // Without this, the treasury becomes admin-recoverable "excess" and the
        // agent loses their legitimate share.
        if (guild.memberCount == 1 && guild.treasuryBalance > 0) {
            uint256 swept = guild.treasuryBalance;
            guild.treasuryBalance = 0;
            totalTreasuryHeld -= swept;
            pendingTreasuryClaim[agent] += swept;
            totalPendingClaims += swept;
            emit PendingTreasuryRecorded(agent, swept);
        } else if (guild.memberCount > 1) {
            // Non-last member: settle accumulated treasury share as pending claim
            // so they don't forfeit earned shares.
            _settlePendingTreasury(guildId, agent);
        }

        uint8 oldTier = guild.tier;

        _removeMember(guildId, agent);

        emit MemberForceRemoved(guildId, agent, guild.memberCount);

        if (guild.memberCount == 0) {
            _dissolveGuild(guildId);
        } else {
            uint8 newTier = guild.memberCount >= minMembersForTier ? _calculateGuildTier(guildId) : 0;
            guild.tier = newTier;
            if (oldTier != newTier) {
                emit GuildTierChanged(guildId, oldTier, newTier);
            }
        }
    }

    /**
     * @notice Pause all guild operations (emergency stop).
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause guild operations.
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
     * @dev If withdrawing NOOK, only the excess above (totalTreasuryHeld + totalPendingClaims)
     *      is withdrawable — admin can NEVER touch guild treasury funds or pending claims.
     *      For any other ERC-20, the full amount is withdrawable.
     *
     * Emits {EmergencyWithdraw}.
     */
    function emergencyWithdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        if (token == address(nookToken)) {
            uint256 balance = nookToken.balanceOf(address(this));
            uint256 reserved = totalTreasuryHeld + totalPendingClaims;
            uint256 excess = balance > reserved ? balance - reserved : 0;
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
     *      (forceRemoveFromGuild, setters, emergencyWithdraw, pause/unpause, etc.).
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
