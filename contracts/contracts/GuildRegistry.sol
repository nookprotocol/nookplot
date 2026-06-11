// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/metatx/ERC2771ContextUpgradeable.sol";
import "./interfaces/IAgentFactory.sol";

/**
 * @title GuildRegistry
 * @author Nookplot
 * @notice On-chain registry for agent guilds — natural groupings of agents
 *         that collaborate and can collectively spawn new agents. Guilds form
 *         semi-organically: the system suggests groupings based on on-chain
 *         signals, and agents confirm by approving membership.
 *
 * @dev Uses UUPS proxy pattern. A guild is proposed by one agent with a set
 *      of members. Each member must approve to activate the guild. Active
 *      guilds can trigger collective spawns via AgentFactory.
 */
contract GuildRegistry is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    ERC2771ContextUpgradeable
{
    // ============================================================
    //                        CUSTOM ERRORS
    // ============================================================

    error ZeroAddress();
    error NotRegisteredAgent();
    error EmptyName();
    error TooFewMembers();
    error TooManyMembers();
    error GuildNotFound();
    error GuildNotProposed();
    error GuildNotActive();
    error NotGuildMember();
    error AlreadyApproved();
    error MemberNotProposed();
    error GuildAlreadyDissolved();
    error DuplicateMember();
    error ProposerMustBeMember();
    error BelowMinimumMembers();

    // ============================================================
    //                          ENUMS
    // ============================================================

    enum GuildStatus { Proposed, Active, Dissolved }
    enum MemberStatus { None, Proposed, Approved, Rejected, Left }

    // ============================================================
    //                          STRUCTS
    // ============================================================

    struct GuildInfo {
        string name;
        string descriptionCid;
        address proposer;
        uint16 memberCount;
        uint16 approvedCount;
        GuildStatus status;
        uint256 createdAt;
        uint256 activatedAt;
    }

    // ============================================================
    //                        STATE VARIABLES
    // ============================================================

    mapping(uint256 => GuildInfo) private _guilds;
    mapping(uint256 => mapping(address => MemberStatus)) private _memberStatus;
    mapping(uint256 => address[]) private _memberList;
    mapping(address => uint256[]) private _agentGuilds;

    uint256 private _nextGuildId;

    address private _agentRegistry;
    address private _agentFactory;

    uint16 public minMembers;
    uint16 public maxMembers;

    /// @dev Storage gap for future upgrades (UUPS pattern)
    uint256[42] private __gap;

    // ============================================================
    //                          EVENTS
    // ============================================================

    event GuildProposed(
        uint256 indexed guildId,
        address indexed proposer,
        string name,
        uint256 memberCount,
        uint256 timestamp
    );

    event MembershipApproved(
        uint256 indexed guildId,
        address indexed member,
        uint256 timestamp
    );

    event MembershipRejected(
        uint256 indexed guildId,
        address indexed member,
        uint256 timestamp
    );

    event GuildActivated(
        uint256 indexed guildId,
        uint256 timestamp
    );

    event MemberLeft(
        uint256 indexed guildId,
        address indexed member,
        uint256 timestamp
    );

    event GuildDissolved(
        uint256 indexed guildId,
        uint256 timestamp
    );

    event CollectiveSpawn(
        uint256 indexed guildId,
        uint256 indexed deploymentId,
        address indexed childAgent,
        uint256 bundleId,
        uint256 timestamp
    );

    event MinMembersUpdated(uint16 oldValue, uint16 newValue);
    event MaxMembersUpdated(uint16 oldValue, uint16 newValue);

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
        address agentFactory_
    ) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        if (agentRegistry_ == address(0)) revert ZeroAddress();
        if (agentFactory_ == address(0)) revert ZeroAddress();

        __Ownable_init(owner_);
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        _agentRegistry = agentRegistry_;
        _agentFactory = agentFactory_;
        minMembers = 2;
        maxMembers = 10;
    }

    // ============================================================
    //                    GUILD LIFECYCLE
    // ============================================================

    /**
     * @notice Propose a new guild with a set of members. The proposer must
     *         include themselves in the members list. All proposed members must
     *         be registered agents. The proposer is automatically approved.
     */
    function proposeGuild(
        string calldata name,
        string calldata descriptionCid,
        address[] calldata members
    ) external whenNotPaused returns (uint256 guildId) {
        if (bytes(name).length == 0) revert EmptyName();
        if (members.length < minMembers) revert TooFewMembers();
        if (members.length > maxMembers) revert TooManyMembers();

        address sender = _msgSender();
        _requireActiveAgent(sender);

        // Validate: proposer must be in the members list, no duplicates
        bool proposerIncluded = false;
        for (uint256 i = 0; i < members.length; i++) {
            if (members[i] == sender) proposerIncluded = true;
            if (members[i] == address(0)) revert ZeroAddress();
            _requireActiveAgent(members[i]);
            // Check for duplicates against prior entries
            for (uint256 j = 0; j < i; j++) {
                if (members[j] == members[i]) revert DuplicateMember();
            }
        }
        if (!proposerIncluded) revert ProposerMustBeMember();

        guildId = _nextGuildId++;

        _guilds[guildId] = GuildInfo({
            name: name,
            descriptionCid: descriptionCid,
            proposer: sender,
            memberCount: uint16(members.length),
            approvedCount: 1, // proposer auto-approves
            status: GuildStatus.Proposed,
            createdAt: block.timestamp,
            activatedAt: 0
        });

        // Store members and set their status
        for (uint256 i = 0; i < members.length; i++) {
            _memberList[guildId].push(members[i]);
            _agentGuilds[members[i]].push(guildId);

            if (members[i] == sender) {
                _memberStatus[guildId][members[i]] = MemberStatus.Approved;
            } else {
                _memberStatus[guildId][members[i]] = MemberStatus.Proposed;
            }
        }

        emit GuildProposed(guildId, sender, name, members.length, block.timestamp);

        _checkActivation(guildId);
    }

    /**
     * @notice Approve your membership in a proposed guild. When all members
     *         have approved, the guild automatically activates.
     */
    function approveMembership(uint256 guildId) external whenNotPaused {
        _requireGuildExists(guildId);
        GuildInfo storage guild = _guilds[guildId];
        if (guild.status != GuildStatus.Proposed) revert GuildNotProposed();

        address sender = _msgSender();
        MemberStatus status = _memberStatus[guildId][sender];
        if (status == MemberStatus.None) revert NotGuildMember();
        if (status != MemberStatus.Proposed) revert AlreadyApproved();

        _memberStatus[guildId][sender] = MemberStatus.Approved;
        guild.approvedCount++;

        emit MembershipApproved(guildId, sender, block.timestamp);

        _checkActivation(guildId);
    }

    /**
     * @notice Reject your membership in a proposed guild.
     */
    function rejectMembership(uint256 guildId) external whenNotPaused {
        _requireGuildExists(guildId);
        GuildInfo storage guild = _guilds[guildId];
        if (guild.status != GuildStatus.Proposed) revert GuildNotProposed();

        address sender = _msgSender();
        MemberStatus status = _memberStatus[guildId][sender];
        if (status == MemberStatus.None) revert NotGuildMember();
        if (status != MemberStatus.Proposed) revert MemberNotProposed();

        _memberStatus[guildId][sender] = MemberStatus.Rejected;

        emit MembershipRejected(guildId, sender, block.timestamp);
    }

    /**
     * @notice Leave an active guild. If member count drops below minimum,
     *         the guild is automatically dissolved.
     */
    function leaveGuild(uint256 guildId) external whenNotPaused {
        _requireGuildExists(guildId);
        GuildInfo storage guild = _guilds[guildId];
        if (guild.status != GuildStatus.Active) revert GuildNotActive();

        address sender = _msgSender();
        if (_memberStatus[guildId][sender] != MemberStatus.Approved) revert NotGuildMember();

        _memberStatus[guildId][sender] = MemberStatus.Left;
        guild.approvedCount--;

        emit MemberLeft(guildId, sender, block.timestamp);

        // Auto-dissolve if below minimum
        if (guild.approvedCount < minMembers) {
            guild.status = GuildStatus.Dissolved;
            emit GuildDissolved(guildId, block.timestamp);
        }
    }

    /**
     * @notice Admin function to dissolve a guild.
     */
    function dissolveGuild(uint256 guildId) external onlyOwner {
        _requireGuildExists(guildId);
        GuildInfo storage guild = _guilds[guildId];
        if (guild.status == GuildStatus.Dissolved) revert GuildAlreadyDissolved();

        guild.status = GuildStatus.Dissolved;
        emit GuildDissolved(guildId, block.timestamp);
    }

    /**
     * @notice Allow the proposer to dissolve their own guild while still in Proposed state.
     * @param guildId ID of the guild to dissolve
     */
    function dissolveProposedGuild(uint256 guildId) external whenNotPaused {
        _requireGuildExists(guildId);
        GuildInfo storage guild = _guilds[guildId];
        if (guild.status != GuildStatus.Proposed) revert GuildAlreadyDissolved();
        if (_msgSender() != guild.proposer) revert NotGuildMember();

        guild.status = GuildStatus.Dissolved;
        emit GuildDissolved(guildId, block.timestamp);
    }

    // ============================================================
    //                    COLLECTIVE SPAWNING
    // ============================================================

    /**
     * @notice Trigger a collective spawn — any approved member of an active
     *         guild can call this. Calls AgentFactory.deployAgent() with the
     *         calling member as creator. The guild ID is recorded in the event.
     */
    function collectiveSpawn(
        uint256 guildId,
        uint256 bundleId,
        address childAddress,
        string calldata soulCid,
        uint256 deploymentFee,
        uint256 maxFee,
        uint256 deadline,
        bytes calldata signature
    ) external whenNotPaused nonReentrant returns (uint256 deploymentId) {
        _requireGuildExists(guildId);
        GuildInfo storage guild = _guilds[guildId];
        if (guild.status != GuildStatus.Active) revert GuildNotActive();

        address sender = _msgSender();
        if (_memberStatus[guildId][sender] != MemberStatus.Approved) revert NotGuildMember();

        // Forward caller's EIP-712
        // signature to AgentFactory.deployAgentFor. The signature is over
        // (sender, bundleId, childAddress, soulCid, maxFee, deadline,
        // nonce) — even a malicious upgrade to this registry cannot forge
        // a deployment without the signer's off-chain consent.
        deploymentId = IAgentFactory(_agentFactory).deployAgentFor(
            sender,
            bundleId,
            childAddress,
            soulCid,
            deploymentFee,
            maxFee,
            deadline,
            signature
        );

        emit CollectiveSpawn(guildId, deploymentId, childAddress, bundleId, block.timestamp);
    }

    // ============================================================
    //                      VIEW FUNCTIONS
    // ============================================================

    function getGuild(uint256 guildId) external view returns (GuildInfo memory) {
        _requireGuildExists(guildId);
        return _guilds[guildId];
    }

    function getMembers(uint256 guildId) external view returns (address[] memory) {
        _requireGuildExists(guildId);
        return _memberList[guildId];
    }

    function getMemberStatus(uint256 guildId, address member) external view returns (MemberStatus) {
        return _memberStatus[guildId][member];
    }

    function getAgentGuilds(address agent) external view returns (uint256[] memory) {
        return _agentGuilds[agent];
    }

    function isGuildMember(uint256 guildId, address agent) external view returns (bool) {
        return _memberStatus[guildId][agent] == MemberStatus.Approved;
    }

    function getGuildCount() external view returns (uint256) {
        return _nextGuildId;
    }

    function agentRegistry() external view returns (address) {
        return _agentRegistry;
    }

    function agentFactory() external view returns (address) {
        return _agentFactory;
    }

    // ============================================================
    //                      ADMIN FUNCTIONS
    // ============================================================

    function setMinMembers(uint16 newMin) external onlyOwner {
        uint16 oldMin = minMembers;
        minMembers = newMin;
        emit MinMembersUpdated(oldMin, newMin);
    }

    function setMaxMembers(uint16 newMax) external onlyOwner {
        uint16 oldMax = maxMembers;
        maxMembers = newMax;
        emit MaxMembersUpdated(oldMax, newMax);
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

    function _checkActivation(uint256 guildId) internal {
        GuildInfo storage guild = _guilds[guildId];
        if (guild.approvedCount == guild.memberCount) {
            guild.status = GuildStatus.Active;
            guild.activatedAt = block.timestamp;
            emit GuildActivated(guildId, block.timestamp);
        }
    }

    function _requireGuildExists(uint256 guildId) internal view {
        if (guildId >= _nextGuildId) revert GuildNotFound();
    }

    function _requireActiveAgent(address agent) internal view {
        (bool success, bytes memory data) = _agentRegistry.staticcall(
            abi.encodeWithSignature("isActiveAgent(address)", agent)
        );
        if (!success || data.length == 0) revert NotRegisteredAgent();
        bool isActive = abi.decode(data, (bool));
        if (!isActive) revert NotRegisteredAgent();
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
    //                  OWNERSHIP RENOUNCE GUARD
    // ============================================================

    /// @notice Prevent accidental ownership renouncement — would permanently brick admin functions.
    function renounceOwnership() public pure override {
        revert("Cannot renounce ownership");
    }

    // ============================================================
    //              FORWARDER-PROOF OWNERSHIP GUARDS
    // ============================================================

    /**
     * @dev Guard: override `_checkOwner`
     *      to use raw `msg.sender`, mirroring AgentFactory's ownership pattern.
     *      Without this, a compromised forwarder could spoof admin calls
     *      with `from = owner` and pass `onlyOwner` checks. The path that
     *      matters most is `_authorizeUpgrade`: a
     *      spoofed upgrade could swap in a malicious impl that bypasses
     *      membership checks and forwards arbitrary `creator` addresses
     *      to `AgentFactory.deployAgentFor`.
     */
    function _checkOwner() internal view override {
        if (msg.sender != owner()) {
            revert OwnableUnauthorizedAccount(msg.sender);
        }
    }

    /// @dev Override `transferOwnership` to use raw `msg.sender` for the same reason.
    function transferOwnership(address newOwner) public override {
        require(msg.sender == owner(), "Only owner directly");
        if (newOwner == address(0)) revert ZeroAddress();
        _transferOwnership(newOwner);
    }

    // ============================================================
    //                     UUPS UPGRADE AUTH
    // ============================================================

    /**
     * @dev Uses raw `msg.sender` directly — even if a
     *      future override accidentally re-introduces `_msgSender()` into
     *      `_checkOwner`, the UUPS upgrade path stays forwarder-proof.
     */
    function _authorizeUpgrade(address) internal view override {
        if (msg.sender != owner()) {
            revert OwnableUnauthorizedAccount(msg.sender);
        }
    }
}
