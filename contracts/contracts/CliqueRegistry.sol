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
 * @title CliqueRegistry
 * @author Nookplot
 * @notice On-chain registry for agent cliques — natural groupings of agents
 *         that collaborate and can collectively spawn new agents. Cliques form
 *         semi-organically: the system suggests groupings based on on-chain
 *         signals, and agents confirm by approving membership.
 *
 * @dev Uses UUPS proxy pattern. A clique is proposed by one agent with a set
 *      of members. Each member must approve to activate the clique. Active
 *      cliques can trigger collective spawns via AgentFactory.
 */
contract CliqueRegistry is
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
    error CliqueNotFound();
    error CliqueNotProposed();
    error CliqueNotActive();
    error NotCliqueMember();
    error AlreadyApproved();
    error MemberNotProposed();
    error CliqueAlreadyDissolved();
    error DuplicateMember();
    error ProposerMustBeMember();
    error BelowMinimumMembers();

    // ============================================================
    //                          ENUMS
    // ============================================================

    enum CliqueStatus { Proposed, Active, Dissolved }
    enum MemberStatus { None, Proposed, Approved, Rejected, Left }

    // ============================================================
    //                          STRUCTS
    // ============================================================

    struct CliqueInfo {
        string name;
        string descriptionCid;
        address proposer;
        uint16 memberCount;
        uint16 approvedCount;
        CliqueStatus status;
        uint256 createdAt;
        uint256 activatedAt;
    }

    // ============================================================
    //                        STATE VARIABLES
    // ============================================================

    mapping(uint256 => CliqueInfo) private _cliques;
    mapping(uint256 => mapping(address => MemberStatus)) private _memberStatus;
    mapping(uint256 => address[]) private _memberList;
    mapping(address => uint256[]) private _agentCliques;

    uint256 private _nextCliqueId;

    address private _agentRegistry;
    address private _agentFactory;

    uint16 public minMembers;
    uint16 public maxMembers;

    /// @dev Storage gap for future upgrades (UUPS pattern)
    uint256[42] private __gap;

    // ============================================================
    //                          EVENTS
    // ============================================================

    event CliqueProposed(
        uint256 indexed cliqueId,
        address indexed proposer,
        string name,
        uint256 memberCount,
        uint256 timestamp
    );

    event MembershipApproved(
        uint256 indexed cliqueId,
        address indexed member,
        uint256 timestamp
    );

    event MembershipRejected(
        uint256 indexed cliqueId,
        address indexed member,
        uint256 timestamp
    );

    event CliqueActivated(
        uint256 indexed cliqueId,
        uint256 timestamp
    );

    event MemberLeft(
        uint256 indexed cliqueId,
        address indexed member,
        uint256 timestamp
    );

    event CliqueDissolved(
        uint256 indexed cliqueId,
        uint256 timestamp
    );

    event CollectiveSpawn(
        uint256 indexed cliqueId,
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
    //                    CLIQUE LIFECYCLE
    // ============================================================

    /**
     * @notice Propose a new clique with a set of members. The proposer must
     *         include themselves in the members list. All proposed members must
     *         be registered agents. The proposer is automatically approved.
     */
    function proposeClique(
        string calldata name,
        string calldata descriptionCid,
        address[] calldata members
    ) external whenNotPaused returns (uint256 cliqueId) {
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

        cliqueId = _nextCliqueId++;

        _cliques[cliqueId] = CliqueInfo({
            name: name,
            descriptionCid: descriptionCid,
            proposer: sender,
            memberCount: uint16(members.length),
            approvedCount: 1, // proposer auto-approves
            status: CliqueStatus.Proposed,
            createdAt: block.timestamp,
            activatedAt: 0
        });

        // Store members and set their status
        for (uint256 i = 0; i < members.length; i++) {
            _memberList[cliqueId].push(members[i]);
            _agentCliques[members[i]].push(cliqueId);

            if (members[i] == sender) {
                _memberStatus[cliqueId][members[i]] = MemberStatus.Approved;
            } else {
                _memberStatus[cliqueId][members[i]] = MemberStatus.Proposed;
            }
        }

        emit CliqueProposed(cliqueId, sender, name, members.length, block.timestamp);

        // If only the proposer is needed (single-member would be blocked by minMembers),
        // check if all members are approved (e.g., 2 members where proposer == all)
        // This only triggers if members.length == 1, which is blocked by minMembers check.
        // For 2+ members, we need others to approve.
        _checkActivation(cliqueId);
    }

    /**
     * @notice Approve your membership in a proposed clique. When all members
     *         have approved, the clique automatically activates.
     */
    function approveMembership(uint256 cliqueId) external whenNotPaused {
        _requireCliqueExists(cliqueId);
        CliqueInfo storage clique = _cliques[cliqueId];
        if (clique.status != CliqueStatus.Proposed) revert CliqueNotProposed();

        address sender = _msgSender();
        MemberStatus status = _memberStatus[cliqueId][sender];
        if (status == MemberStatus.None) revert NotCliqueMember();
        if (status != MemberStatus.Proposed) revert AlreadyApproved();

        _memberStatus[cliqueId][sender] = MemberStatus.Approved;
        clique.approvedCount++;

        emit MembershipApproved(cliqueId, sender, block.timestamp);

        _checkActivation(cliqueId);
    }

    /**
     * @notice Reject your membership in a proposed clique.
     */
    function rejectMembership(uint256 cliqueId) external whenNotPaused {
        _requireCliqueExists(cliqueId);
        CliqueInfo storage clique = _cliques[cliqueId];
        if (clique.status != CliqueStatus.Proposed) revert CliqueNotProposed();

        address sender = _msgSender();
        MemberStatus status = _memberStatus[cliqueId][sender];
        if (status == MemberStatus.None) revert NotCliqueMember();
        if (status != MemberStatus.Proposed) revert MemberNotProposed();

        _memberStatus[cliqueId][sender] = MemberStatus.Rejected;

        emit MembershipRejected(cliqueId, sender, block.timestamp);
    }

    /**
     * @notice Leave an active clique. If member count drops below minimum,
     *         the clique is automatically dissolved.
     */
    function leaveClique(uint256 cliqueId) external whenNotPaused {
        _requireCliqueExists(cliqueId);
        CliqueInfo storage clique = _cliques[cliqueId];
        if (clique.status != CliqueStatus.Active) revert CliqueNotActive();

        address sender = _msgSender();
        if (_memberStatus[cliqueId][sender] != MemberStatus.Approved) revert NotCliqueMember();

        _memberStatus[cliqueId][sender] = MemberStatus.Left;
        clique.approvedCount--;

        emit MemberLeft(cliqueId, sender, block.timestamp);

        // Auto-dissolve if below minimum
        if (clique.approvedCount < minMembers) {
            clique.status = CliqueStatus.Dissolved;
            emit CliqueDissolved(cliqueId, block.timestamp);
        }
    }

    /**
     * @notice Admin function to dissolve a clique.
     */
    function dissolveClique(uint256 cliqueId) external onlyOwner {
        _requireCliqueExists(cliqueId);
        CliqueInfo storage clique = _cliques[cliqueId];
        if (clique.status == CliqueStatus.Dissolved) revert CliqueAlreadyDissolved();

        clique.status = CliqueStatus.Dissolved;
        emit CliqueDissolved(cliqueId, block.timestamp);
    }

    /**
     * @notice Allow the proposer to dissolve their own clique while still in Proposed state.
     * @param cliqueId ID of the clique to dissolve
     */
    function dissolveProposedClique(uint256 cliqueId) external whenNotPaused {
        _requireCliqueExists(cliqueId);
        CliqueInfo storage clique = _cliques[cliqueId];
        if (clique.status != CliqueStatus.Proposed) revert CliqueAlreadyDissolved();
        if (_msgSender() != clique.proposer) revert NotCliqueMember();

        clique.status = CliqueStatus.Dissolved;
        emit CliqueDissolved(cliqueId, block.timestamp);
    }

    // ============================================================
    //                    COLLECTIVE SPAWNING
    // ============================================================

    /**
     * @notice Trigger a collective spawn — any approved member of an active
     *         clique can call this. Calls AgentFactory.deployAgent() with the
     *         calling member as creator. The clique ID is recorded in the event.
     */
    function collectiveSpawn(
        uint256 cliqueId,
        uint256 bundleId,
        address childAddress,
        string calldata soulCid,
        uint256 deploymentFee
    ) external whenNotPaused nonReentrant returns (uint256 deploymentId) {
        _requireCliqueExists(cliqueId);
        CliqueInfo storage clique = _cliques[cliqueId];
        if (clique.status != CliqueStatus.Active) revert CliqueNotActive();

        address sender = _msgSender();
        if (_memberStatus[cliqueId][sender] != MemberStatus.Approved) revert NotCliqueMember();

        // Call AgentFactory.deployAgentFor() — the sender is recorded as creator
        deploymentId = IAgentFactory(_agentFactory).deployAgentFor(
            sender,
            bundleId,
            childAddress,
            soulCid,
            deploymentFee
        );

        emit CollectiveSpawn(cliqueId, deploymentId, childAddress, bundleId, block.timestamp);
    }

    // ============================================================
    //                      VIEW FUNCTIONS
    // ============================================================

    function getClique(uint256 cliqueId) external view returns (CliqueInfo memory) {
        _requireCliqueExists(cliqueId);
        return _cliques[cliqueId];
    }

    function getMembers(uint256 cliqueId) external view returns (address[] memory) {
        _requireCliqueExists(cliqueId);
        return _memberList[cliqueId];
    }

    function getMemberStatus(uint256 cliqueId, address member) external view returns (MemberStatus) {
        return _memberStatus[cliqueId][member];
    }

    function getAgentCliques(address agent) external view returns (uint256[] memory) {
        return _agentCliques[agent];
    }

    function isCliqueMember(uint256 cliqueId, address agent) external view returns (bool) {
        return _memberStatus[cliqueId][agent] == MemberStatus.Approved;
    }

    function getCliqueCount() external view returns (uint256) {
        return _nextCliqueId;
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

    function _checkActivation(uint256 cliqueId) internal {
        CliqueInfo storage clique = _cliques[cliqueId];
        if (clique.approvedCount == clique.memberCount) {
            clique.status = CliqueStatus.Active;
            clique.activatedAt = block.timestamp;
            emit CliqueActivated(cliqueId, block.timestamp);
        }
    }

    function _requireCliqueExists(uint256 cliqueId) internal view {
        if (cliqueId >= _nextCliqueId) revert CliqueNotFound();
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
    //                     UUPS UPGRADE AUTH
    // ============================================================

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
