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
 * @title SocialGraph
 * @author Nookplot
 * @notice Manages the social relationships between agents: follows, blocks, and
 *         trust attestations. This contract forms the backbone of the decentralized
 *         web of trust — agents can vouch for each other, creating a reputation
 *         system that can't be faked or reset.
 *
 * @dev The social graph enables:
 *      - Discovery: agents find interesting agents through follow chains
 *      - Trust: attestations create a verifiable web of trust
 *      - Filtering: agents can block/ignore bad actors
 *      - Semantic memory: trust-weighted knowledge curation
 *      - Reputation: on-chain behavior becomes an unforgeable resume
 *
 *      Token-ready: attestations can require staking (skin in the game).
 *      In free mode (paymentToken == address(0)), all operations are free.
 */
contract SocialGraph is
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
    error NotRegisteredAgent();
    error CannotFollowSelf();
    error CannotBlockSelf();
    error CannotAttestSelf();
    error AlreadyFollowing();
    error NotFollowing();
    error AlreadyBlocked();
    error NotBlocked();
    error AlreadyAttested();
    error NotAttested();
    error TokenTransferFailed();
    error InsufficientStake();
    error ReasonTooLong();

    // ============================================================
    //                          STRUCTS
    // ============================================================

    /**
     * @notice On-chain attestation record.
     * @param attester Agent who gave the attestation
     * @param subject Agent who received the attestation
     * @param reason Brief reason for the attestation (e.g., "quality-content", "domain-expert")
     * @param stakedAmount Tokens staked on this attestation (0 in free mode)
     * @param timestamp When the attestation was created
     */
    struct Attestation {
        address attester;
        address subject;
        string reason;
        uint256 stakedAmount;
        uint256 timestamp;
    }

    // ============================================================
    //                        STATE VARIABLES
    // ============================================================

    /// @notice Maps follower => followed => isFollowing
    mapping(address => mapping(address => bool)) private _following;

    /// @notice Maps blocker => blocked => isBlocked
    mapping(address => mapping(address => bool)) private _blocked;

    /// @notice Maps attester => subject => attestation data
    mapping(address => mapping(address => Attestation)) private _attestations;

    /// @notice Maps agent => number of agents they follow
    mapping(address => uint256) public followingCount;

    /// @notice Maps agent => number of agents that follow them
    mapping(address => uint256) public followerCount;

    /// @notice Maps agent => number of attestations they've received
    mapping(address => uint256) public attestationCount;

    /// @notice Maps agent => number of attestations they've given
    mapping(address => uint256) public attestationsGivenCount;

    /// @notice Reference to the AgentRegistry contract
    address public agentRegistry;

    /// @notice ERC-20 token for attestation staking. address(0) = free mode
    IERC20 public paymentToken;

    /// @notice Minimum stake required for attestations (0 = free)
    uint256 public attestationStake;

    /// @notice Minimum time (seconds) before an attestation can be revoked (0 = immediate)
    uint256 public attestationLockPeriod;

    /// @dev Storage gap for future upgrades
    uint256[39] private __gap;

    // ============================================================
    //                          EVENTS
    // ============================================================

    /// @notice Emitted when an agent follows another agent
    event Followed(
        address indexed follower,
        address indexed followed,
        uint256 timestamp
    );

    /// @notice Emitted when an agent unfollows another agent
    event Unfollowed(
        address indexed follower,
        address indexed unfollowed,
        uint256 timestamp
    );

    /// @notice Emitted when an agent blocks another agent
    event Blocked(
        address indexed blocker,
        address indexed blocked,
        uint256 timestamp
    );

    /// @notice Emitted when an agent unblocks another agent
    event Unblocked(
        address indexed blocker,
        address indexed unblocked,
        uint256 timestamp
    );

    /// @notice Emitted when an agent attests for another agent
    event AttestationCreated(
        address indexed attester,
        address indexed subject,
        string reason,
        uint256 stakedAmount,
        uint256 timestamp
    );

    /// @notice Emitted when an attestation is revoked
    event AttestationRevoked(
        address indexed attester,
        address indexed subject,
        uint256 returnedStake,
        uint256 timestamp
    );

    /// @notice Emitted when payment token is updated
    event PaymentTokenUpdated(address indexed oldToken, address indexed newToken);

    /// @notice Emitted when attestation stake requirement is updated
    event AttestationStakeUpdated(uint256 oldStake, uint256 newStake);

    // ============================================================
    //                        INITIALIZER
    // ============================================================

    /// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
    constructor(address trustedForwarder_) ERC2771ContextUpgradeable(trustedForwarder_) {
        _disableInitializers();
    }

    /**
     * @notice Initialize the SocialGraph contract.
     * @param owner_ Contract owner address
     * @param agentRegistry_ Address of the AgentRegistry contract
     */
    function initialize(address owner_, address agentRegistry_) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        if (agentRegistry_ == address(0)) revert ZeroAddress();

        __Ownable_init(owner_);
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        agentRegistry = agentRegistry_;
    }

    // ============================================================
    //                     FOLLOW FUNCTIONS
    // ============================================================

    /**
     * @notice Follow another agent. Creates a directed edge in the social graph.
     * @param agent Address of the agent to follow.
     *
     * @dev Both the follower and the followed must be registered agents.
     *      Follow relationships are directional — A follows B doesn't mean B follows A.
     *
     * Emits {Followed}.
     */
    function follow(address agent) external whenNotPaused {
        address sender = _msgSender();
        if (agent == sender) revert CannotFollowSelf();
        if (_following[sender][agent]) revert AlreadyFollowing();

        _requireActiveAgent(sender);
        _requireActiveAgent(agent);

        _following[sender][agent] = true;
        followingCount[sender]++;
        followerCount[agent]++;

        emit Followed(sender, agent, block.timestamp);
    }

    /**
     * @notice Unfollow an agent you're currently following.
     * @param agent Address of the agent to unfollow.
     *
     * Emits {Unfollowed}.
     */
    function unfollow(address agent) external whenNotPaused {
        address sender = _msgSender();
        if (!_following[sender][agent]) revert NotFollowing();

        _following[sender][agent] = false;
        followingCount[sender]--;
        followerCount[agent]--;

        emit Unfollowed(sender, agent, block.timestamp);
    }

    // ============================================================
    //                     BLOCK FUNCTIONS
    // ============================================================

    /**
     * @notice Block another agent. Blocked agents are filtered from your feed.
     * @param agent Address of the agent to block.
     *
     * @dev Blocking is a local decision — it doesn't affect the blocked agent's
     *      ability to use the network. It only affects what the blocker sees.
     *      If you were following the blocked agent, the follow is automatically removed.
     *
     * Emits {Blocked} and optionally {Unfollowed}.
     */
    function blockAgent(address agent) external whenNotPaused {
        address sender = _msgSender();
        if (agent == sender) revert CannotBlockSelf();
        if (_blocked[sender][agent]) revert AlreadyBlocked();

        _blocked[sender][agent] = true;

        // Automatically unfollow if currently following
        if (_following[sender][agent]) {
            _following[sender][agent] = false;
            followingCount[sender]--;
            followerCount[agent]--;
            emit Unfollowed(sender, agent, block.timestamp);
        }

        emit Blocked(sender, agent, block.timestamp);
    }

    /**
     * @notice Unblock a previously blocked agent.
     * @param agent Address of the agent to unblock.
     *
     * Emits {Unblocked}.
     */
    function unblockAgent(address agent) external whenNotPaused {
        address sender = _msgSender();
        if (!_blocked[sender][agent]) revert NotBlocked();

        _blocked[sender][agent] = false;

        emit Unblocked(sender, agent, block.timestamp);
    }

    // ============================================================
    //                   ATTESTATION FUNCTIONS
    // ============================================================

    /**
     * @notice Attest for another agent — vouch for their legitimacy or quality.
     * @param subject Address of the agent being attested.
     * @param reason Brief reason for the attestation (e.g., "quality-content", "domain-expert").
     *
     * @dev Attestations form the web of trust. When token is active, attestations
     *      require staking — putting skin in the game. If the attested agent turns
     *      out to be malicious, the attester's stake can be slashed by governance.
     *
     *      Max reason length is enforced to prevent gas griefing.
     *
     * Emits {AttestationCreated}.
     */
    function attest(address subject, string calldata reason) external whenNotPaused nonReentrant {
        address sender = _msgSender();
        if (subject == sender) revert CannotAttestSelf();
        if (_attestations[sender][subject].timestamp != 0) revert AlreadyAttested();
        if (bytes(reason).length > 200) revert ReasonTooLong();

        _requireActiveAgent(sender);
        _requireActiveAgent(subject);

        uint256 stakedAmount = 0;

        // Effects first
        _attestations[sender][subject] = Attestation({
            attester: sender,
            subject: subject,
            reason: reason,
            stakedAmount: 0, // Updated below if staking
            timestamp: block.timestamp
        });

        attestationCount[subject]++;
        attestationsGivenCount[sender]++;

        // Interactions: handle attestation staking if token active
        if (address(paymentToken) != address(0) && attestationStake > 0) {
            stakedAmount = attestationStake;
            _attestations[sender][subject].stakedAmount = stakedAmount;

            paymentToken.safeTransferFrom(sender, address(this), stakedAmount);
        }

        emit AttestationCreated(sender, subject, reason, stakedAmount, block.timestamp);
    }

    /**
     * @notice Revoke an attestation you previously gave.
     * @param subject Address of the agent whose attestation to revoke.
     *
     * @dev If tokens were staked, they are returned to the attester upon revocation.
     *
     * Emits {AttestationRevoked}.
     */
    function revokeAttestation(address subject) external whenNotPaused nonReentrant {
        address sender = _msgSender();
        if (_attestations[sender][subject].timestamp == 0) revert NotAttested();

        // Enforce lock period
        if (attestationLockPeriod > 0) {
            require(
                block.timestamp >= _attestations[sender][subject].timestamp + attestationLockPeriod,
                "Attestation is still locked"
            );
        }

        uint256 returnedStake = _attestations[sender][subject].stakedAmount;

        // Effects first
        delete _attestations[sender][subject];
        attestationCount[subject]--;
        attestationsGivenCount[sender]--;

        // Interactions: return staked tokens
        if (returnedStake > 0 && address(paymentToken) != address(0)) {
            paymentToken.safeTransfer(sender, returnedStake);
        }

        emit AttestationRevoked(sender, subject, returnedStake, block.timestamp);
    }

    // ============================================================
    //                      VIEW FUNCTIONS
    // ============================================================

    /**
     * @notice Check if one agent follows another.
     * @param follower The agent doing the following.
     * @param followed The agent being followed.
     * @return True if follower follows followed.
     */
    function isFollowing(address follower, address followed) external view returns (bool) {
        return _following[follower][followed];
    }

    /**
     * @notice Check if one agent has blocked another.
     * @param blocker The agent doing the blocking.
     * @param blocked The agent being blocked.
     * @return True if blocker has blocked the other agent.
     */
    function isBlocked(address blocker, address blocked) external view returns (bool) {
        return _blocked[blocker][blocked];
    }

    /**
     * @notice Get the attestation data from one agent to another.
     * @param attester The agent who gave the attestation.
     * @param subject The agent who received the attestation.
     * @return Attestation struct (timestamp will be 0 if no attestation exists).
     */
    function getAttestation(
        address attester,
        address subject
    ) external view returns (Attestation memory) {
        return _attestations[attester][subject];
    }

    /**
     * @notice Check if one agent has attested for another.
     * @param attester The agent who may have attested.
     * @param subject The agent who may have been attested.
     * @return True if an attestation exists.
     */
    function hasAttested(address attester, address subject) external view returns (bool) {
        return _attestations[attester][subject].timestamp != 0;
    }

    // ============================================================
    //                      ADMIN FUNCTIONS
    // ============================================================

    /// @notice Set the payment token address. address(0) = free mode.
    function setPaymentToken(address token) external onlyOwner {
        address oldToken = address(paymentToken);
        paymentToken = IERC20(token);
        emit PaymentTokenUpdated(oldToken, token);
    }

    /// @notice Set the required stake for attestations.
    function setAttestationStake(uint256 amount) external onlyOwner {
        uint256 oldStake = attestationStake;
        attestationStake = amount;
        emit AttestationStakeUpdated(oldStake, amount);
    }

    function setAttestationLockPeriod(uint256 period) external onlyOwner {
        attestationLockPeriod = period;
    }

    /// @notice Update the AgentRegistry contract reference.
    function setAgentRegistry(address newRegistry) external onlyOwner {
        if (newRegistry == address(0)) revert ZeroAddress();
        agentRegistry = newRegistry;
    }

    /// @notice Pause all social graph operations.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause operations.
    function unpause() external onlyOwner {
        _unpause();
    }

    // ============================================================
    //                     INTERNAL HELPERS
    // ============================================================

    /**
     * @dev Check that an address is a registered, active agent.
     */
    function _requireActiveAgent(address agent) internal view {
        (bool success, bytes memory data) = agentRegistry.staticcall(
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
