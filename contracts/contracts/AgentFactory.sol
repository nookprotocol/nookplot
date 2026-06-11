// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/metatx/ERC2771ContextUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IKnowledgeBundle.sol";

/**
 * @title AgentFactory
 * @author Nookplot
 * @notice Agent deployment system for the Nookplot network. Anyone (human or
 *         agent) can deploy a new AI agent by binding it to a knowledge bundle
 *         and a soul.md identity document. Deployment fees are distributed to
 *         knowledge contributors via the receipt chain.
 *
 * @dev Uses UUPS proxy pattern. Agents can spawn child agents, forming a
 *      hierarchical spawn tree. Fee distribution uses configurable basis
 *      points (contributor, treasury, credit pool, curator shares).
 *      Token strategy follows "wired in, not turned on" — paymentToken ==
 *      address(0) means free mode, set to token address to activate fees.
 */
contract AgentFactory is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    ERC2771ContextUpgradeable,
    EIP712Upgradeable
{
    using SafeERC20 for IERC20;
    // ============================================================
    //                        CUSTOM ERRORS
    // ============================================================

    error ZeroAddress();
    error NotRegisteredAgent();
    error BundleNotActive();
    error TokenTransferFailed();
    error DeploymentNotFound();
    error NotDeployedAgent();
    error InvalidFeeShares();
    error AgentAlreadyDeployed();
    error EmptySoulCid();
    error TooManyContributors();
    // Errors for EIP-712 signed deployAgentFor calls.
    error InvalidSignature();
    error SignatureExpired();
    error FeeExceedsMax();
    // Guard: on-chain ceiling on soulCid byte length.
    error SoulCidTooLong();

    // ============================================================
    //                          STRUCTS
    // ============================================================

    struct DeploymentInfo {
        address creator;
        address agentAddress;
        uint256 bundleId;
        string soulCid;
        uint256 deploymentFee;
        uint256 contributorPayout;
        uint256 treasuryPayout;
        uint256 creditPayout;
        uint256 curatorPayout;
        address parentAgent;
        uint256 createdAt;
        // Snapshot of the bundle's contributor list at deploy time. The fee
        // distribution reads from this snapshot, not the live bundle list, so a
        // later setContributorWeights call cannot redirect that deployment's
        // contributor fees to swapped-in addresses. APPENDED
        // at end of struct to preserve storage layout — existing 11 slots
        // unchanged. The contract's __gap is unaffected (this field lives
        // inside the per-mapping-entry struct, not the contract-level slots).
        IKnowledgeBundle.ContributorWeight[] contributorsSnapshot;
    }

    // ============================================================
    //                        STATE VARIABLES
    // ============================================================

    mapping(uint256 => DeploymentInfo) private _deployments;
    mapping(address => uint256[]) private _deploymentsByCreator;
    mapping(uint256 => uint256[]) private _deploymentsByBundle;
    mapping(address => uint256) private _agentDeploymentId;
    mapping(address => bool) private _hasDeployment;
    mapping(address => address[]) private _parentChildren;
    mapping(address => address) private _childParent;

    uint256 private _nextDeploymentId;

    IERC20 public paymentToken;
    address public treasury;
    address public creditPool;
    address private _agentRegistry;
    address private _knowledgeBundle;

    uint16 public contributorShareBps;
    uint16 public treasuryShareBps;
    uint16 public creditShareBps;
    uint16 public curatorShareBps;

    uint256 public constant MAX_CONTRIBUTORS = 50;

    /**
     * @notice On-chain ceiling on soulCid byte
     *         length. Off-chain clients clamp to ≤100; this contract sets 200 to
     *         leave 2x headroom for any future CID encoding (CIDv2, alt
     *         multibase) without needing a contract upgrade. A direct
     *         caller bypassing the client and pushing a huge string would otherwise
     *         blow up event-log size for off-chain consumers and run up storage
     *         cost for every reader of DeploymentInfo.soulCid.
     */
    uint256 public constant MAX_SOUL_CID_LEN = 200;

    address public cliqueRegistry;
    address public guildRegistry;

    // Nonces for EIP-712 signed deployAgentFor calls. Per-creator, monotonic;
    // consumed on every successful signature verification so the same sig
    // cannot replay.
    // Takes 1 slot — __gap shrunk from [34] to [33] accordingly.
    mapping(address => uint256) public deployForNonces;

    /// @dev EIP-712 typehash for DeployAgentForRequest. Hashed once at
    /// compile time. Keep in sync with the off-chain signer.
    bytes32 public constant DEPLOY_AGENT_FOR_TYPEHASH = keccak256(
        "DeployAgentForRequest(address creator,uint256 bundleId,address agentAddress,string soulCid,uint256 maxFee,uint256 deadline,uint256 nonce)"
    );

    /// @dev Storage gap for future upgrades (UUPS pattern)
    uint256[33] private __gap;

    // ============================================================
    //                          EVENTS
    // ============================================================

    event AgentDeployed(
        uint256 indexed deploymentId,
        address indexed creator,
        address indexed agentAddress,
        uint256 bundleId,
        string soulCid,
        uint256 deploymentFee,
        uint256 timestamp
    );

    event AgentSpawned(
        uint256 indexed deploymentId,
        address indexed parentAgent,
        address indexed childAgent,
        uint256 bundleId,
        string soulCid,
        uint256 timestamp
    );

    event FeeDistributed(
        uint256 indexed deploymentId,
        uint256 contributorPayout,
        uint256 treasuryPayout,
        uint256 creditPayout,
        uint256 curatorPayout
    );

    event ContributorPaid(
        uint256 indexed deploymentId,
        address indexed contributor,
        uint256 amount
    );

    /**
     * @notice Emitted when a contributor's share is redirected to the treasury
     *         because the direct transfer reverted (broken token hook, blocked
     *         recipient, etc.). Gives off-chain systems an audit trail for
     *         silent royalty reassignments.
     */
    event ContributorRedirected(
        uint256 indexed deploymentId,
        address indexed contributor,
        address indexed redirectTo,
        uint256 amount,
        string reason
    );

    /**
     * @notice Emitted when the curator share is
     *         redirected to treasury instead of flowing to bundle.creator.
     *         Two reasons today:
     *           "bundle_lookup_failed" — IKnowledgeBundle.getBundle reverted
     *             (e.g. KnowledgeBundle upgrade broke the ABI).
     *           "zero_creator"         — bundle.creator was address(0) at
     *             distribution time (today unreachable; defense in depth).
     *         Mirrors ContributorRedirected for indexer parity so the
     *         diversion always leaves an off-chain trail.
     */
    event CuratorRedirected(
        uint256 indexed deploymentId,
        uint256 indexed bundleId,
        address indexed redirectTo,
        uint256 amount,
        string reason
    );

    event SoulUpdated(
        uint256 indexed deploymentId,
        address indexed agentAddress,
        string oldSoulCid,
        string newSoulCid
    );

    event FeeSharesUpdated(
        uint16 contributorShareBps,
        uint16 treasuryShareBps,
        uint16 creditShareBps,
        uint16 curatorShareBps
    );

    // Emitted on payment-token swaps and stuck-token sweeps for observability.
    event PaymentTokenChanged(address indexed oldToken, address indexed newToken);
    event StuckTokenSwept(address indexed token, address indexed to, uint256 amount);

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
        address knowledgeBundle_,
        address treasury_,
        address creditPool_
    ) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        if (agentRegistry_ == address(0)) revert ZeroAddress();
        if (knowledgeBundle_ == address(0)) revert ZeroAddress();
        if (treasury_ == address(0)) revert ZeroAddress();
        if (creditPool_ == address(0)) revert ZeroAddress();

        __Ownable_init(owner_);
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();
        __EIP712_init("AgentFactory", "1");

        _agentRegistry = agentRegistry_;
        _knowledgeBundle = knowledgeBundle_;
        treasury = treasury_;
        creditPool = creditPool_;
    }

    /**
     * @notice One-shot reinitializer that sets up the EIP-712 domain on
     *         AgentFactory instances that were initialized before the
     *         EIP-712 mixin was added (i.e. the live mainnet proxy).
     * @dev MUST be called atomically with `upgradeToAndCall(newImpl, abi.encodeCall(this.initializeV2, ()))`
     *      to avoid a window where the new impl is live but the EIP-712
     *      domain is uninitialized (which would make `deployAgentFor`
     *      reject every signature). reinitializer(2) prevents double-init.
     */
    function initializeV2() external reinitializer(2) {
        __EIP712_init("AgentFactory", "1");
    }

    // ============================================================
    //                    DEPLOYMENT LIFECYCLE
    // ============================================================

    function deployAgent(
        uint256 bundleId,
        address agentAddress,
        string calldata soulCid,
        uint256 deploymentFee
    ) external whenNotPaused nonReentrant returns (uint256 deploymentId) {
        if (agentAddress == address(0)) revert ZeroAddress();
        if (bytes(soulCid).length == 0) revert EmptySoulCid();
        if (bytes(soulCid).length > MAX_SOUL_CID_LEN) revert SoulCidTooLong();
        _requireActiveAgent(agentAddress);
        _requireActiveBundle(bundleId);
        if (_hasDeployment[agentAddress]) revert AgentAlreadyDeployed();

        deploymentId = _nextDeploymentId++;
        address sender = _msgSender();

        _recordDeployment(deploymentId, sender, agentAddress, bundleId, soulCid, deploymentFee, address(0));

        if (_shouldChargeFees(deploymentFee)) {
            paymentToken.safeTransferFrom(sender, address(this), deploymentFee);
            _distributeFees(deploymentId, deploymentFee, bundleId);
        }

        emit AgentDeployed(deploymentId, sender, agentAddress, bundleId, soulCid, deploymentFee, block.timestamp);
    }

    function spawnAgent(
        uint256 bundleId,
        address childAddress,
        string calldata soulCid,
        uint256 deploymentFee
    ) external whenNotPaused nonReentrant returns (uint256 deploymentId) {
        if (childAddress == address(0)) revert ZeroAddress();
        if (bytes(soulCid).length == 0) revert EmptySoulCid();
        if (bytes(soulCid).length > MAX_SOUL_CID_LEN) revert SoulCidTooLong();

        address parent = _msgSender();
        _requireActiveAgent(parent);
        _requireActiveAgent(childAddress);
        _requireActiveBundle(bundleId);
        if (_hasDeployment[childAddress]) revert AgentAlreadyDeployed();

        deploymentId = _nextDeploymentId++;

        _recordDeployment(deploymentId, parent, childAddress, bundleId, soulCid, deploymentFee, parent);

        // Update spawn tree
        _parentChildren[parent].push(childAddress);
        _childParent[childAddress] = parent;

        if (_shouldChargeFees(deploymentFee)) {
            paymentToken.safeTransferFrom(parent, address(this), deploymentFee);
            _distributeFees(deploymentId, deploymentFee, bundleId);
        }

        emit AgentSpawned(deploymentId, parent, childAddress, bundleId, soulCid, block.timestamp);
    }

    function updateSoul(
        uint256 deploymentId,
        string calldata newSoulCid
    ) external whenNotPaused {
        if (bytes(newSoulCid).length == 0) revert EmptySoulCid();
        if (bytes(newSoulCid).length > MAX_SOUL_CID_LEN) revert SoulCidTooLong();
        if (deploymentId >= _nextDeploymentId) revert DeploymentNotFound();

        DeploymentInfo storage deployment = _deployments[deploymentId];
        if (_msgSender() != deployment.agentAddress) revert NotDeployedAgent();

        string memory oldSoulCid = deployment.soulCid;
        deployment.soulCid = newSoulCid;

        emit SoulUpdated(deploymentId, deployment.agentAddress, oldSoulCid, newSoulCid);
    }

    /**
     * @notice Deploy an agent on behalf of a creator. Only callable by the
     *         CliqueRegistry or GuildRegistry contract for collective spawns.
     *
     * @dev Guard: requires an EIP-712
     *      signature from `creator` authorizing the specific deployment
     *      (bundleId + agentAddress + soulCid + maxFee + deadline + nonce).
     *      Without it, a compromised cliqueRegistry /
     *      guildRegistry could pass any address as `creator` and
     *      pull its NOOK allowance via `paymentToken.safeTransferFrom`.
     *      Requiring the creator's signature reduces the registry's role
     *      to "transport" — even a fully malicious registry impl cannot
     *      forge a deployment without the user's explicit consent.
     *
     * @param creator         The address to charge the deployment fee to.
     *                        Must match the EIP-712 signer.
     * @param bundleId        Knowledge bundle to bind the agent to.
     * @param agentAddress    Wallet of the new agent.
     * @param soulCid         IPFS CID of the soul.md identity document.
     * @param deploymentFee   NOOK to pull from `creator` (≤ maxFee).
     * @param maxFee          Maximum fee the creator authorized at sign time.
     *                        Lets the registry haggle on actual fee without
     *                        invalidating the signature (as long as it stays
     *                        within the cap).
     * @param deadline        Unix timestamp after which the signature is no
     *                        longer valid. Protects against signed requests
     *                        held indefinitely.
     * @param signature       65-byte EIP-712 signature over DeployAgentForRequest.
     */
    function deployAgentFor(
        address creator,
        uint256 bundleId,
        address agentAddress,
        string calldata soulCid,
        uint256 deploymentFee,
        uint256 maxFee,
        uint256 deadline,
        bytes calldata signature
    ) external whenNotPaused nonReentrant returns (uint256 deploymentId) {
        if (_msgSender() != cliqueRegistry && _msgSender() != guildRegistry) revert NotRegisteredAgent();
        if (agentAddress == address(0)) revert ZeroAddress();
        if (bytes(soulCid).length == 0) revert EmptySoulCid();
        if (bytes(soulCid).length > MAX_SOUL_CID_LEN) revert SoulCidTooLong();
        if (block.timestamp > deadline) revert SignatureExpired();
        if (deploymentFee > maxFee) revert FeeExceedsMax();

        // Verify creator's EIP-712 signature. Extracted into
        // a helper to keep the stack depth in this function below the
        // Solidity 16-local cap. Consumes the creator's nonce so a
        // replay attempt fails on next-nonce mismatch.
        _verifyDeployForSignature(creator, bundleId, agentAddress, soulCid, maxFee, deadline, signature);

        _requireActiveAgent(agentAddress);
        _requireActiveBundle(bundleId);
        if (_hasDeployment[agentAddress]) revert AgentAlreadyDeployed();

        deploymentId = _nextDeploymentId++;

        _recordDeployment(deploymentId, creator, agentAddress, bundleId, soulCid, deploymentFee, address(0));

        if (_shouldChargeFees(deploymentFee)) {
            paymentToken.safeTransferFrom(creator, address(this), deploymentFee);
            _distributeFees(deploymentId, deploymentFee, bundleId);
        }

        emit AgentDeployed(deploymentId, creator, agentAddress, bundleId, soulCid, deploymentFee, block.timestamp);
    }

    /// @dev EIP-712 signature verification for `deployAgentFor`. Pulled out
    ///      of the main function body to keep the stack below Solidity's
    ///      16-local depth limit. Always consumes the nonce.
    function _verifyDeployForSignature(
        address creator,
        uint256 bundleId,
        address agentAddress,
        string calldata soulCid,
        uint256 maxFee,
        uint256 deadline,
        bytes calldata signature
    ) internal {
        uint256 nonce = deployForNonces[creator]++;
        bytes32 structHash = keccak256(
            abi.encode(
                DEPLOY_AGENT_FOR_TYPEHASH,
                creator,
                bundleId,
                agentAddress,
                keccak256(bytes(soulCid)),
                maxFee,
                deadline,
                nonce
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        if (ECDSA.recover(digest, signature) != creator) revert InvalidSignature();
    }

    // ============================================================
    //                      VIEW FUNCTIONS
    // ============================================================

    function getDeployment(uint256 deploymentId) external view returns (DeploymentInfo memory) {
        if (deploymentId >= _nextDeploymentId) revert DeploymentNotFound();
        return _deployments[deploymentId];
    }

    function getDeploymentsByCreator(address creator) external view returns (uint256[] memory) {
        return _deploymentsByCreator[creator];
    }

    function getDeploymentsByBundle(uint256 bundleId) external view returns (uint256[] memory) {
        return _deploymentsByBundle[bundleId];
    }

    function getSpawnChildren(address parent) external view returns (address[] memory) {
        return _parentChildren[parent];
    }

    function getSpawnParent(address child) external view returns (address) {
        return _childParent[child];
    }

    function getDeploymentCount() external view returns (uint256) {
        return _nextDeploymentId;
    }

    function getSoulCid(address agentAddress) external view returns (string memory) {
        if (!_hasDeployment[agentAddress]) revert DeploymentNotFound();
        return _deployments[_agentDeploymentId[agentAddress]].soulCid;
    }

    function getAgentDeploymentId(address agentAddress) external view returns (uint256) {
        if (!_hasDeployment[agentAddress]) revert DeploymentNotFound();
        return _agentDeploymentId[agentAddress];
    }

    function agentRegistry() external view returns (address) {
        return _agentRegistry;
    }

    function knowledgeBundleContract() external view returns (address) {
        return _knowledgeBundle;
    }

    // ============================================================
    //                      ADMIN FUNCTIONS
    // ============================================================

    /**
     * @notice Update fee distribution shares. Must sum to exactly 10000 bps
     *         (100%) to enable fee charging, or all be zero to disable it.
     *
     * @dev Behavior note. With shares (0, 0, 0, 0) and
     *      paymentToken != 0, a naive `_distributeFees` would compute
     *      curatorAmount = totalFee - 0 - 0 - 0 = totalFee and route 100%
     *      to the bundle creator. The fee
     *      path in deployAgent / spawnAgent / deployAgentFor is therefore
     *      gated on a single
     *      `_shouldChargeFees(...)` helper that requires BOTH paymentToken
     *      set AND share BPS summing to 10000.
     *
     *      So today the true state machine is:
     *        - paymentToken == 0                         → deploys are free
     *        - paymentToken != 0 AND bps total == 0      → deploys are free
     *        - paymentToken != 0 AND bps total == 10000  → fees charged + split
     *        - paymentToken != 0 AND 0 < bps total < 10000 → invalid; setter
     *          reverts InvalidFeeShares (pre-existing guard)
     *
     *      Setting shares back to (0, 0, 0, 0) is the canonical
     *      "suspend fee charging without un-setting paymentToken" lever.
     */
    function setFeeShares(
        uint16 contributorBps,
        uint16 treasuryBps,
        uint16 creditBps,
        uint16 curatorBps
    ) external onlyOwner {
        uint256 total = uint256(contributorBps) + treasuryBps + creditBps + curatorBps;
        if (total != 10000 && total != 0) revert InvalidFeeShares();

        contributorShareBps = contributorBps;
        treasuryShareBps = treasuryBps;
        creditShareBps = creditBps;
        curatorShareBps = curatorBps;

        emit FeeSharesUpdated(contributorBps, treasuryBps, creditBps, curatorBps);
    }

    /**
     * @dev Single gate consulted by all 3
     *      fee-charging entrypoints (deployAgent / spawnAgent /
     *      deployAgentFor). Returns true iff every condition for a
     *      lawful fee charge is met. Centralising the check here means
     *      the activation order is safe regardless of
     *      whether `setPaymentToken(NOOK)` or `setFeeShares(...)` lands
     *      first — the in-between state where one is set but not the
     *      other gracefully degrades to free-mode rather than mis-routing
     *      100% of the fee to the bundle creator.
     */
    function _shouldChargeFees(uint256 deploymentFee) internal view returns (bool) {
        if (address(paymentToken) == address(0)) return false;
        if (deploymentFee == 0) return false;
        uint256 totalBps = uint256(contributorShareBps)
            + treasuryShareBps + creditShareBps + curatorShareBps;
        return totalBps == 10000;
    }

    /**
     * @notice Set the ERC-20 token used for deployment fees.
     * @dev Emits an event so
     *      off-chain consumers can observe payment-token swaps
     *      (a silent setter would let a `setPaymentToken(NOOK)`
     *      activation slip past every off-chain consumer). The setter
     *      still accepts `address(0)` to allow turning fees off, but the
     *      event records the transition explicitly.
     */
    function setPaymentToken(address token) external onlyOwner {
        address oldToken = address(paymentToken);
        paymentToken = IERC20(token);
        emit PaymentTokenChanged(oldToken, token);
    }

    /**
     * @notice Owner-only escape hatch for any ERC-20 stuck in the contract
     *         that ISN'T the active payment token. Lets ops recover tokens
     *         sent here by accident without exposing a path that drains
     *         in-flight fee distributions.
     * @dev Refuses to sweep
     *      `paymentToken` so a compromised owner key cannot vacuum the
     *      contract during a normal operational window.
     */
    function sweepStuckToken(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (to == address(0)) revert ZeroAddress();
        if (token == address(paymentToken)) revert TokenTransferFailed();
        IERC20(token).safeTransfer(to, amount);
        emit StuckTokenSwept(token, to, amount);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = newTreasury;
    }

    function setCreditPool(address newCreditPool) external onlyOwner {
        if (newCreditPool == address(0)) revert ZeroAddress();
        creditPool = newCreditPool;
    }

    function setCliqueRegistry(address newCliqueRegistry) external onlyOwner {
        if (newCliqueRegistry == address(0)) revert ZeroAddress();
        cliqueRegistry = newCliqueRegistry;
    }

    function setGuildRegistry(address newGuildRegistry) external onlyOwner {
        if (newGuildRegistry == address(0)) revert ZeroAddress();
        guildRegistry = newGuildRegistry;
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

    function _recordDeployment(
        uint256 deploymentId,
        address creator,
        address agentAddress,
        uint256 bundleId,
        string calldata soulCid,
        uint256 deploymentFee,
        address parentAgent
    ) internal {
        // Field-by-field assignment (rather than struct literal) so the
        // dynamic `contributorsSnapshot` array can be populated via
        // storage `.push(...)` below — Solidity won't let a memory→storage
        // copy for arrays inside a literal initializer.
        DeploymentInfo storage d = _deployments[deploymentId];
        d.creator = creator;
        d.agentAddress = agentAddress;
        d.bundleId = bundleId;
        d.soulCid = soulCid;
        d.deploymentFee = deploymentFee;
        // payouts default to 0 until _distributeFees runs
        d.parentAgent = parentAgent;
        d.createdAt = block.timestamp;

        // Freeze contributor list at
        // deploy time. If the call into the bundle fails (e.g. registry
        // upgraded incompatibly), leave the snapshot empty — the dist path
        // will then route contribAmount to treasury via the empty-list
        // fallback. MAX_CONTRIBUTORS cap protects against unbounded gas in
        // the loop even though _validateWeights enforces the cap upstream.
        //
        // Guard: revert if the bundle ever returns
        // more contributors than MAX_CONTRIBUTORS instead of silently
        // truncating. KnowledgeBundle's _validateWeights enforces the cap
        // today, but if it ever drifts (e.g. cap raised on the bundle side
        // without updating the factory), silent truncation would lose
        // royalties for contributors 51..N with no on-chain signal. Hard
        // failure surfaces the drift immediately.
        try IKnowledgeBundle(_knowledgeBundle).getBundleContributors(bundleId) returns (
            IKnowledgeBundle.ContributorWeight[] memory contribs
        ) {
            if (contribs.length > MAX_CONTRIBUTORS) revert TooManyContributors();
            for (uint256 i = 0; i < contribs.length; i++) {
                d.contributorsSnapshot.push(contribs[i]);
            }
        } catch {
            // Empty snapshot — _distributeToContributors handles via treasury
        }

        _deploymentsByCreator[creator].push(deploymentId);
        _deploymentsByBundle[bundleId].push(deploymentId);
        _agentDeploymentId[agentAddress] = deploymentId;
        _hasDeployment[agentAddress] = true;
    }

    function _distributeFees(
        uint256 deploymentId,
        uint256 totalFee,
        uint256 bundleId
    ) internal {
        uint256 contribAmount = (totalFee * contributorShareBps) / 10000;
        uint256 treasuryAmount = (totalFee * treasuryShareBps) / 10000;
        uint256 creditAmount = (totalFee * creditShareBps) / 10000;
        // Curator gets the remainder to avoid rounding dust
        uint256 curatorAmount = totalFee - contribAmount - treasuryAmount - creditAmount;

        // Store payout info
        DeploymentInfo storage d = _deployments[deploymentId];
        d.contributorPayout = contribAmount;
        d.treasuryPayout = treasuryAmount;
        d.creditPayout = creditAmount;
        d.curatorPayout = curatorAmount;

        // Distribute to contributors
        if (contribAmount > 0) {
            _distributeToContributors(deploymentId, contribAmount);
        }

        // Transfer treasury share
        if (treasuryAmount > 0) {
            paymentToken.safeTransfer(treasury, treasuryAmount);
        }

        // Transfer credit pool share
        if (creditAmount > 0) {
            paymentToken.safeTransfer(creditPool, creditAmount);
        }

        // Transfer curator share (to bundle creator)
        if (curatorAmount > 0) {
            _transferCuratorShare(deploymentId, curatorAmount, bundleId);
        }

        emit FeeDistributed(deploymentId, contribAmount, treasuryAmount, creditAmount, curatorAmount);
    }

    function _distributeToContributors(
        uint256 deploymentId,
        uint256 contribAmount
    ) internal {
        // Read from the deploy-time
        // contributor snapshot captured in _recordDeployment, not the live
        // bundle list. A later setContributorWeights call after
        // this deployment was recorded cannot redirect these fees — the
        // snapshot is locked at the deploy TX boundary.
        IKnowledgeBundle.ContributorWeight[] storage contributors = _deployments[deploymentId].contributorsSnapshot;

        // Empty snapshot → treasury. Covers both genuinely
        // empty bundles and the recorder's catch-path where the bundle
        // call failed at deploy time.
        if (contributors.length == 0) {
            paymentToken.safeTransfer(treasury, contribAmount);
            return;
        }
        if (contributors.length > MAX_CONTRIBUTORS) revert TooManyContributors();

        uint256 distributed = 0;
        for (uint256 i = 0; i < contributors.length; i++) {
            uint256 share = (contribAmount * contributors[i].weightBps) / 10000;
            if (share > 0) {
                // Wrap individual transfers in try/catch — if one fails, send to treasury
                try this.transferOnBehalf(contributors[i].contributor, share) {
                    distributed += share;
                    emit ContributorPaid(deploymentId, contributors[i].contributor, share);
                } catch {
                    // Emit ContributorRedirected so indexers / admins can
                    // detect broken-token silent reassignments instead of just
                    // observing treasury balance drifting up.
                    paymentToken.safeTransfer(treasury, share);
                    distributed += share;
                    emit ContributorRedirected(
                        deploymentId,
                        contributors[i].contributor,
                        treasury,
                        share,
                        "transfer_failed"
                    );
                }
            }
        }

        // Dust handling: an unwrapped safeTransfer to contributors[0] would
        // unwind the entire deployment if their
        // ERC-20 path reverts, even though
        // the main distribution loop redirects individual share failures.
        // Dust is bounded by
        // MAX_CONTRIBUTORS - 1 ≈ 49 wei (10⁻¹⁷ NOOK at 18 decimals).
        // Route unconditionally to treasury — same defensive guarantee,
        // no try/catch overhead, no contributors[0] favoritism.
        if (distributed < contribAmount) {
            paymentToken.safeTransfer(treasury, contribAmount - distributed);
        }
    }

    function _transferCuratorShare(
        uint256 deploymentId,
        uint256 amount,
        uint256 bundleId
    ) internal {
        try IKnowledgeBundle(_knowledgeBundle).getBundle(bundleId) returns (
            IKnowledgeBundle.Bundle memory bundle
        ) {
            if (bundle.creator != address(0)) {
                paymentToken.safeTransfer(bundle.creator, amount);
            } else {
                // Defensive else branch.
                // Today unreachable via KnowledgeBundle's createBundle (sets
                // creator = sender, never resets), but if a future
                // KnowledgeBundle ever returns a struct with creator=0,
                // retaining the amount in the contract
                // — and sweepStuckToken refuses the active paymentToken, so
                // it would have been stuck forever. Route to treasury and
                // emit so off-chain consumers can flag the drift.
                paymentToken.safeTransfer(treasury, amount);
                emit CuratorRedirected(
                    deploymentId, bundleId, treasury, amount, "zero_creator"
                );
            }
        } catch {
            // Guard: a silent catch path would
            // divert curator fees with no event — parallel to the
            // contributor path closed with ContributorRedirected.
            paymentToken.safeTransfer(treasury, amount);
            emit CuratorRedirected(
                deploymentId, bundleId, treasury, amount, "bundle_lookup_failed"
            );
        }
    }

    /**
     * @dev External wrapper around safeTransfer so it can be called via
     *      `try this.transferOnBehalf(...)` to catch individual transfer failures.
     *      Only callable by this contract itself.
     */
    function transferOnBehalf(address to, uint256 amount) external {
        require(msg.sender == address(this), "Only self");
        paymentToken.safeTransfer(to, amount);
    }

    function _requireActiveAgent(address agent) internal view {
        (bool success, bytes memory data) = _agentRegistry.staticcall(
            abi.encodeWithSignature("isActiveAgent(address)", agent)
        );
        if (!success || data.length == 0) revert NotRegisteredAgent();
        bool isActive = abi.decode(data, (bool));
        if (!isActive) revert NotRegisteredAgent();
    }

    function _requireActiveBundle(uint256 bundleId) internal view {
        (bool success, bytes memory data) = _knowledgeBundle.staticcall(
            abi.encodeWithSignature("isBundleActive(uint256)", bundleId)
        );
        if (!success || data.length == 0) revert BundleNotActive();
        bool isActive = abi.decode(data, (bool));
        if (!isActive) revert BundleNotActive();
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
    //              FORWARDER-PROOF OWNERSHIP GUARDS
    // ============================================================

    /**
     * @dev Override _checkOwner to use raw msg.sender instead of _msgSender().
     *      Prevents a compromised forwarder from spoofing admin calls.
     *      Matches the pattern used by AgentRegistry, MiningStake, MiningGuild.
     */
    function _checkOwner() internal view override {
        if (msg.sender != owner()) {
            revert OwnableUnauthorizedAccount(msg.sender);
        }
    }

    /**
     * @dev Override transferOwnership to use raw msg.sender for the same reason.
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
     * @dev Uses raw msg.sender — forwarder cannot spoof upgrade authorization.
     */
    function _authorizeUpgrade(address) internal view override {
        require(msg.sender == owner(), "Only owner directly");
    }
}
