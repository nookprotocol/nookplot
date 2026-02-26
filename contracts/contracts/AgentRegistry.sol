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
 * @title AgentRegistry
 * @author Nookplot
 * @notice Core identity contract for the Nookplot decentralized AI agent social network.
 *         Every agent must register here before interacting with the network.
 *         Registration links an Ethereum wallet to an IPFS-stored DID document.
 *
 * @dev Uses UUPS proxy pattern for upgradeability. All state-changing functions emit events
 *      for off-chain indexing (The Graph). Token functionality is "wired in, not activated" —
 *      when paymentToken is address(0), all operations are free.
 *
 * Security: ReentrancyGuard on token-involving functions, Pausable for emergency stops,
 *           Ownable for admin functions. Follows checks-effects-interactions pattern.
 */
contract AgentRegistry is
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

    /// @notice Thrown when an agent tries to register but is already registered
    error AlreadyRegistered();

    /// @notice Thrown when an operation targets an agent that isn't registered
    error NotRegistered();

    /// @notice Thrown when a caller tries to modify another agent's data
    error NotAuthorized();

    /// @notice Thrown when an input string is empty when it shouldn't be
    error EmptyString();

    /// @notice Thrown when the zero address is passed where it shouldn't be
    error ZeroAddress();

    /// @notice Thrown when a token transfer fails
    error TokenTransferFailed();
    error StakedTokensExist();

    /// @notice Thrown when trying to unstake more than the staked amount
    error InsufficientStake();

    /// @notice Thrown when an agent is slashed but has no stake
    error NoStakeToSlash();

    /// @notice Thrown when an invalid agent type is provided (must be 1=Human or 2=Agent)
    error InvalidAgentType();

    // ============================================================
    //                          STRUCTS
    // ============================================================

    /**
     * @notice On-chain record of a registered agent.
     * @param didCid IPFS CID of the agent's DID document (contains public key, model info, capabilities)
     * @param registeredAt Block timestamp when the agent first registered
     * @param updatedAt Block timestamp when the agent last updated their DID
     * @param isVerified Whether the agent has been verified (by owner/DAO in future)
     * @param isActive Whether the agent is currently active (can be deactivated by owner for moderation)
     * @param stakedAmount Amount of tokens staked (0 when token not active)
     */
    struct AgentInfo {
        string didCid;
        uint256 registeredAt;
        uint256 updatedAt;
        bool isVerified;
        bool isActive;
        uint256 stakedAmount;
    }

    // ============================================================
    //                        STATE VARIABLES
    // ============================================================

    /// @notice Maps wallet address to agent info
    mapping(address => AgentInfo) private _agents;

    /// @notice Total number of registered agents
    uint256 public totalAgents;

    /// @notice ERC-20 token used for staking/fees. address(0) = free mode (no token)
    IERC20 public paymentToken;

    /// @notice Amount of tokens required to stake when registering (0 = no stake required)
    uint256 public registrationStake;

    /// @notice Treasury address where slashed stakes go
    address public treasury;

    /// @notice Maps wallet address to account type (0=Unspecified, 1=Human, 2=Agent)
    mapping(address => uint8) private _agentTypes;

    /// @notice Total tokens currently staked across all agents
    uint256 public totalStaked;

    /// @dev Storage gap for future upgrades (UUPS pattern — prevents storage collisions)
    uint256[42] private __gap;

    // ============================================================
    //                          EVENTS
    // ============================================================

    /// @notice Emitted when a new agent registers
    event AgentRegistered(
        address indexed agent,
        string didCid,
        uint256 timestamp
    );

    /// @notice Emitted when an agent updates their DID document
    event AgentUpdated(
        address indexed agent,
        string oldDidCid,
        string newDidCid,
        uint256 timestamp
    );

    /// @notice Emitted when an agent's verification status changes
    event AgentVerificationChanged(
        address indexed agent,
        bool isVerified,
        uint256 timestamp
    );

    /// @notice Emitted when an agent is deactivated (moderation action)
    event AgentDeactivated(
        address indexed agent,
        uint256 timestamp
    );

    /// @notice Emitted when an agent is reactivated
    event AgentReactivated(
        address indexed agent,
        uint256 timestamp
    );

    /// @notice Emitted when an agent stakes tokens
    event AgentStaked(
        address indexed agent,
        uint256 amount,
        uint256 totalStake
    );

    /// @notice Emitted when an agent unstakes tokens
    event AgentUnstaked(
        address indexed agent,
        uint256 amount,
        uint256 remainingStake
    );

    /// @notice Emitted when an agent's stake is slashed (penalty)
    event AgentSlashed(
        address indexed agent,
        uint256 amount,
        uint256 remainingStake
    );

    /// @notice Emitted when the payment token address is changed
    event PaymentTokenUpdated(
        address indexed oldToken,
        address indexed newToken
    );

    /// @notice Emitted when the treasury address is changed
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    /// @notice Emitted when the registration stake amount is changed
    event RegistrationStakeUpdated(
        uint256 oldStake,
        uint256 newStake
    );

    /// @notice Emitted when an agent's type is set or changed (1=Human, 2=Agent)
    event AgentTypeSet(
        address indexed agent,
        uint8 agentType
    );

    // ============================================================
    //                        INITIALIZER
    // ============================================================

    /// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
    constructor(address trustedForwarder_) ERC2771ContextUpgradeable(trustedForwarder_) {
        _disableInitializers();
    }

    /**
     * @notice Initializes the contract (replaces constructor for UUPS proxy pattern).
     * @param owner_ Address that will own this contract (can upgrade, pause, set token, etc.)
     * @param treasury_ Address where slashed stakes are sent
     */
    function initialize(address owner_, address treasury_) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        if (treasury_ == address(0)) revert ZeroAddress();

        __Ownable_init(owner_);
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        treasury = treasury_;
        // paymentToken defaults to address(0) = free mode
        // registrationStake defaults to 0 = no stake required
    }

    // ============================================================
    //                     AGENT FUNCTIONS
    // ============================================================

    /**
     * @notice Register a new agent on the Nookplot network (no type specified — defaults to 0/Unspecified).
     * @param didCid IPFS CID of the agent's DID document. Must be a valid, non-empty string.
     *
     * @dev If paymentToken is set and registrationStake > 0, the caller must have approved
     *      this contract to transfer registrationStake tokens. The tokens are held as stake.
     *      In free mode (paymentToken == address(0)), registration is free.
     *
     * Emits {AgentRegistered} and optionally {AgentStaked}.
     */
    function register(string calldata didCid) external whenNotPaused nonReentrant {
        _register(didCid);
    }

    /**
     * @notice Register a new agent with an explicit account type.
     * @param didCid IPFS CID of the agent's DID document. Must be a valid, non-empty string.
     * @param agentType Account type: 1 = Human, 2 = Agent.
     *
     * @dev Same as register(didCid) but also stores the account type on-chain.
     *      Type 0 (Unspecified) is not allowed — use the single-arg register() for that.
     *
     * Emits {AgentRegistered}, {AgentTypeSet}, and optionally {AgentStaked}.
     */
    function register(string calldata didCid, uint8 agentType) external whenNotPaused nonReentrant {
        if (agentType < 1 || agentType > 2) revert InvalidAgentType();
        _register(didCid);
        address sender = _msgSender();
        _agentTypes[sender] = agentType;
        emit AgentTypeSet(sender, agentType);
    }

    /**
     * @dev Shared registration logic for both register() overloads.
     *
     * NOTE: When paymentToken is active, register() requires a prior ERC-20 approve()
     * from the agent to this contract for `registrationStake`. When using ERC-2771
     * meta-transactions, the agent cannot perform gasless approve() unless the token
     * supports EIP-2612 Permit. This is a known limitation — agents registering via
     * meta-tx in token mode must either hold ETH for the approve() call or the token
     * must implement Permit. Future improvement: add EIP-2612 Permit support.
     */
    function _register(string calldata didCid) internal {
        if (bytes(didCid).length == 0) revert EmptyString();
        address sender = _msgSender();
        if (_agents[sender].registeredAt != 0) revert AlreadyRegistered();

        // Effects: update state BEFORE any external calls (checks-effects-interactions)
        // Determine staked amount before struct creation so the event reflects the correct value
        uint256 stakeAmount = (address(paymentToken) != address(0) && registrationStake > 0)
            ? registrationStake
            : 0;

        _agents[sender] = AgentInfo({
            didCid: didCid,
            registeredAt: block.timestamp,
            updatedAt: block.timestamp,
            isVerified: false,
            isActive: true,
            stakedAmount: stakeAmount
        });

        totalAgents++;

        emit AgentRegistered(sender, didCid, block.timestamp);

        // Interactions: handle token staking if active
        if (stakeAmount > 0) {
            paymentToken.safeTransferFrom(
                sender,
                address(this),
                registrationStake
            );
            totalStaked += registrationStake;

            emit AgentStaked(sender, registrationStake, registrationStake);
        }
    }

    /**
     * @notice Update your agent's DID document (e.g., after changing capabilities or profile).
     * @param newDidCid IPFS CID of the new DID document.
     *
     * @dev Only the agent themselves can update their own DID. The old CID is preserved
     *      in the event log for history (episodic memory).
     *
     * Emits {AgentUpdated}.
     */
    function updateDid(string calldata newDidCid) external whenNotPaused {
        if (bytes(newDidCid).length == 0) revert EmptyString();
        address sender = _msgSender();
        if (_agents[sender].registeredAt == 0) revert NotRegistered();
        if (!_agents[sender].isActive) revert NotAuthorized();

        string memory oldCid = _agents[sender].didCid;
        _agents[sender].didCid = newDidCid;
        _agents[sender].updatedAt = block.timestamp;

        emit AgentUpdated(sender, oldCid, newDidCid, block.timestamp);
    }

    /**
     * @notice Stake additional tokens on your agent registration.
     * @param amount Number of tokens to stake.
     *
     * @dev Only callable when the payment token is active. Agent must have approved
     *      this contract to transfer the specified amount.
     *
     * Emits {AgentStaked}.
     */
    function stake(uint256 amount) external whenNotPaused nonReentrant {
        address sender = _msgSender();
        if (_agents[sender].registeredAt == 0) revert NotRegistered();
        if (address(paymentToken) == address(0)) revert ZeroAddress();
        if (amount == 0) revert InsufficientStake();

        // Effects first
        _agents[sender].stakedAmount += amount;

        // Interactions
        paymentToken.safeTransferFrom(sender, address(this), amount);
        totalStaked += amount;

        emit AgentStaked(sender, amount, _agents[sender].stakedAmount);
    }

    /**
     * @notice Unstake tokens from your agent registration.
     * @param amount Number of tokens to unstake and return to your wallet.
     *
     * @dev Cannot unstake below the registrationStake minimum if one is set.
     *
     * Emits {AgentUnstaked}.
     */
    function unstake(uint256 amount) external whenNotPaused nonReentrant {
        address sender = _msgSender();
        if (_agents[sender].registeredAt == 0) revert NotRegistered();
        if (address(paymentToken) == address(0)) revert ZeroAddress();
        if (amount == 0) revert InsufficientStake();

        AgentInfo storage agent = _agents[sender];
        if (amount > agent.stakedAmount) revert InsufficientStake();

        // Ensure minimum stake is maintained if registrationStake is set
        uint256 remainingStake = agent.stakedAmount - amount;
        if (registrationStake > 0 && remainingStake < registrationStake) {
            revert InsufficientStake();
        }

        // Effects first
        agent.stakedAmount = remainingStake;

        // Interactions
        paymentToken.safeTransfer(sender, amount);
        totalStaked -= amount;

        emit AgentUnstaked(sender, amount, remainingStake);
    }

    // ============================================================
    //                      VIEW FUNCTIONS
    // ============================================================

    /**
     * @notice Get the full info for a registered agent.
     * @param agent Wallet address of the agent to look up.
     * @return AgentInfo struct with all on-chain data for this agent.
     */
    function getAgent(address agent) external view returns (AgentInfo memory) {
        if (_agents[agent].registeredAt == 0) revert NotRegistered();
        return _agents[agent];
    }

    /**
     * @notice Check if an address is a registered agent.
     * @param agent Wallet address to check.
     * @return True if the agent is registered (regardless of active/verified status).
     */
    function isRegistered(address agent) external view returns (bool) {
        return _agents[agent].registeredAt != 0;
    }

    /**
     * @notice Check if an agent is registered AND active.
     * @param agent Wallet address to check.
     * @return True if registered and active (not deactivated by moderation).
     */
    function isActiveAgent(address agent) external view returns (bool) {
        return _agents[agent].registeredAt != 0 && _agents[agent].isActive;
    }

    /**
     * @notice Check if an agent is verified.
     * @param agent Wallet address to check.
     * @return True if registered and verified.
     */
    function isVerified(address agent) external view returns (bool) {
        return _agents[agent].registeredAt != 0 && _agents[agent].isVerified;
    }

    /**
     * @notice Get the DID document CID for an agent.
     * @param agent Wallet address to look up.
     * @return The IPFS CID string of the agent's DID document.
     */
    function getDidCid(address agent) external view returns (string memory) {
        if (_agents[agent].registeredAt == 0) revert NotRegistered();
        return _agents[agent].didCid;
    }

    /**
     * @notice Get the staked token amount for an agent.
     * @param agent Wallet address to look up.
     * @return The number of tokens staked by this agent.
     */
    function getStake(address agent) external view returns (uint256) {
        return _agents[agent].stakedAmount;
    }

    /**
     * @notice Get the account type of a registered agent.
     * @param agent Wallet address to look up.
     * @return 0 = Unspecified (legacy), 1 = Human, 2 = Agent.
     */
    function getAgentType(address agent) external view returns (uint8) {
        return _agentTypes[agent];
    }

    // ============================================================
    //                      ADMIN FUNCTIONS
    // ============================================================

    /**
     * @notice Set or correct the account type of a registered agent.
     * @param agent Wallet address of the agent.
     * @param agentType New account type: 1 = Human, 2 = Agent.
     *
     * @dev Only callable by the contract owner. Used for corrections after registration.
     *
     * Emits {AgentTypeSet}.
     */
    function setAgentType(address agent, uint8 agentType) external onlyOwner {
        if (_agents[agent].registeredAt == 0) revert NotRegistered();
        if (agentType < 1 || agentType > 2) revert InvalidAgentType();
        _agentTypes[agent] = agentType;
        emit AgentTypeSet(agent, agentType);
    }

    /**
     * @notice Set or change the verification status of an agent.
     * @param agent Wallet address of the agent.
     * @param verified New verification status.
     *
     * @dev Only callable by the contract owner (future: DAO governance).
     *      Verification indicates the agent has been vetted (computational proofs,
     *      behavioral analysis, staking, or web-of-trust attestations).
     *
     * Emits {AgentVerificationChanged}.
     */
    function setVerified(address agent, bool verified) external onlyOwner {
        if (_agents[agent].registeredAt == 0) revert NotRegistered();
        _agents[agent].isVerified = verified;
        emit AgentVerificationChanged(agent, verified, block.timestamp);
    }

    /**
     * @notice Deactivate an agent (moderation / emergency action).
     * @param agent Wallet address of the agent to deactivate.
     *
     * @dev Deactivated agents cannot post, vote, or update their DID.
     *      Their data remains on-chain for audit trail purposes.
     *      Only callable by the contract owner.
     *
     * Emits {AgentDeactivated}.
     */
    function deactivateAgent(address agent) external onlyOwner {
        if (_agents[agent].registeredAt == 0) revert NotRegistered();
        _agents[agent].isActive = false;
        emit AgentDeactivated(agent, block.timestamp);
    }

    /**
     * @notice Reactivate a previously deactivated agent.
     * @param agent Wallet address of the agent to reactivate.
     *
     * @dev Only callable by the contract owner.
     *
     * Emits {AgentReactivated}.
     */
    function reactivateAgent(address agent) external onlyOwner {
        if (_agents[agent].registeredAt == 0) revert NotRegistered();
        _agents[agent].isActive = true;
        emit AgentReactivated(agent, block.timestamp);
    }

    /**
     * @notice Slash an agent's stake as a penalty (spam, malicious behavior).
     * @param agent Wallet address of the agent to slash.
     * @param amount Number of tokens to slash from their stake.
     *
     * @dev Slashed tokens are sent to the treasury address.
     *      Only callable by the contract owner (future: automated by governance).
     *
     * Emits {AgentSlashed}.
     */
    function slashAgent(address agent, uint256 amount) external onlyOwner nonReentrant {
        if (_agents[agent].registeredAt == 0) revert NotRegistered();
        if (address(paymentToken) == address(0)) revert ZeroAddress();
        if (_agents[agent].stakedAmount == 0) revert NoStakeToSlash();

        // Cap slash amount to actual stake
        uint256 slashAmount = amount > _agents[agent].stakedAmount
            ? _agents[agent].stakedAmount
            : amount;

        // Effects first
        _agents[agent].stakedAmount -= slashAmount;

        // Interactions: send slashed tokens to treasury
        paymentToken.safeTransfer(treasury, slashAmount);
        totalStaked -= slashAmount;

        emit AgentSlashed(agent, slashAmount, _agents[agent].stakedAmount);
    }

    /**
     * @notice Set the payment token address. address(0) = free mode (no fees/staking).
     * @param token Address of the ERC-20 token, or address(0) to disable.
     *
     * @dev This is the "master switch" for the token economy. Setting this to the
     *      Token address activates staking and fees across the network.
     *      Only callable by the contract owner.
     *
     * Emits {PaymentTokenUpdated}.
     */
    function setPaymentToken(address token) external onlyOwner {
        if (totalStaked > 0) revert StakedTokensExist();
        address oldToken = address(paymentToken);
        paymentToken = IERC20(token);
        emit PaymentTokenUpdated(oldToken, token);
    }

    /**
     * @notice Set the required stake amount for registration.
     * @param amount Number of tokens required to stake when registering.
     *
     * @dev Set to 0 to disable staking requirement. Only affects new registrations.
     *      Only callable by the contract owner.
     *
     * Emits {RegistrationStakeUpdated}.
     */
    function setRegistrationStake(uint256 amount) external onlyOwner {
        uint256 oldStake = registrationStake;
        registrationStake = amount;
        emit RegistrationStakeUpdated(oldStake, amount);
    }

    /**
     * @notice Update the treasury address where slashed stakes are sent.
     * @param newTreasury New treasury address.
     *
     * @dev Only callable by the contract owner.
     */
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        address oldTreasury = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(oldTreasury, newTreasury);
    }

    /**
     * @notice Pause all agent operations (emergency stop).
     * @dev Only callable by the contract owner. Use in case of discovered exploit.
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause all agent operations.
     * @dev Only callable by the contract owner.
     */
    function unpause() external onlyOwner {
        _unpause();
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

    /**
     * @notice Authorization check for UUPS upgrades.
     * @dev Only the contract owner can authorize upgrades. This is critical —
     *      a compromised upgrade function means total contract takeover.
     */
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
