// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/metatx/ERC2771ContextUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title ServiceMarketplace
 * @author Nookplot
 * @notice On-chain A2A (Agent-to-Agent) service marketplace for the Nookplot
 *         decentralized AI agent network. Agents can list services, buyers can
 *         create agreements with escrow, providers deliver work, buyers settle.
 *
 * @dev Uses UUPS proxy pattern. Full lifecycle: Listed → Agreed → Delivered → Settled.
 *      Escrow held in this contract until work is settled or agreement is cancelled.
 *      Token strategy follows "wired in, not turned on" — paymentToken == address(0)
 *      means ETH-only or reputation-only agreements.
 *
 * Security: ReentrancyGuard on all escrow-releasing functions, Pausable for emergency
 *           stops, checks-effects-interactions on all ETH/token transfers.
 */
contract ServiceMarketplace is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    AccessControlUpgradeable,
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

    /// @notice Thrown when a required string is empty
    error EmptyString();

    /// @notice Thrown when the caller is not a registered agent
    error NotRegisteredAgent();

    /// @notice Thrown when the listing does not exist
    error ListingNotFound();

    /// @notice Thrown when the agreement does not exist
    error AgreementNotFound();

    /// @notice Thrown when the listing/agreement is not in the expected status
    error InvalidStatus();

    /// @notice Thrown when the caller is not the listing provider
    error NotProvider();

    /// @notice Thrown when the caller is not the agreement buyer
    error NotBuyer();

    /// @notice Thrown when the caller is not the agreement buyer or provider
    error NotParty();

    /// @notice Thrown when the caller tries to hire themselves
    error CannotHireSelf();

    /// @notice Thrown when the listing is not active
    error ListingNotActive();

    /// @notice Thrown when the deadline is not in the future
    error DeadlineNotInFuture();

    /// @notice Thrown when the deadline is too far in the future (>30 days)
    error DeadlineTooFar();

    /// @notice Thrown when an ETH transfer fails
    error EthTransferFailed();

    /// @notice Thrown when a token transfer fails
    error TokenTransferFailed();

    /// @notice Thrown when platform fee basis points exceed max (1000 = 10%)
    error FeeTooHigh();

    /// @notice Thrown when the provided token is not in the allowedTokens whitelist
    error TokenNotAllowed();

    /// @notice Thrown when emergency withdraw amount is zero
    error ZeroAmount();

    /// @notice Thrown when trying to expire an agreement before deadline + grace period
    error NotExpired();

    /// @notice Thrown when trying to expire a dispute before the timeout period
    error DisputeNotExpired();

    /// @notice Thrown when the agreement is not in Disputed status
    error NotDisputed();

    /// @notice Thrown when the cancellation fee exceeds MAX_FEE_BPS
    error CancellationFeeTooHigh();

    // ============================================================
    //                        ROLES
    // ============================================================

    /// @notice Guardian role — can pause but NOT unpause
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    // ============================================================
    //                          ENUMS
    // ============================================================

    /// @notice Status of a service agreement through its lifecycle
    enum ServiceStatus {
        Listed,     // 0 — Service is available (listing-level, not used in Agreement)
        Agreed,     // 1 — Buyer and provider have an active agreement
        Delivered,  // 2 — Provider has submitted deliverables
        Settled,    // 3 — Buyer approved and escrow released
        Disputed,   // 4 — Either party raised a dispute
        Cancelled   // 5 — Buyer cancelled before delivery
    }

    /// @notice Pricing model for the service listing
    enum PricingModel {
        PerTask,        // 0 — Fixed price per task
        Hourly,         // 1 — Hourly rate
        Subscription,   // 2 — Recurring subscription
        Custom          // 3 — Custom/negotiable pricing
    }

    /// @notice Type of escrow held for an agreement
    enum EscrowType {
        None,   // 0 — Reputation-only (no financial escrow)
        ETH,    // 1 — ETH held in contract
        Token   // 2 — ERC-20 token held in contract
    }

    // ============================================================
    //                          STRUCTS
    // ============================================================

    /**
     * @notice On-chain record of a service listing.
     * @param provider Address of the agent offering the service
     * @param metadataCid IPFS CID of the full service description
     * @param category Service category (e.g. "research", "coding", "analysis")
     * @param pricingModel How the service is priced
     * @param priceAmount Suggested price in wei or token units (0 = negotiable)
     * @param active Whether the listing is currently accepting agreements
     * @param totalCompleted Number of settled agreements
     * @param totalDisputed Number of disputed agreements
     * @param createdAt Block timestamp when listing was created
     * @param updatedAt Block timestamp of last update
     */
    struct ServiceListing {
        address provider;
        string metadataCid;
        string category;
        PricingModel pricingModel;
        uint256 priceAmount;
        bool active;
        uint256 totalCompleted;
        uint256 totalDisputed;
        uint256 createdAt;
        uint256 updatedAt;
    }

    /**
     * @notice On-chain record of a service agreement between buyer and provider.
     * @param listingId ID of the associated service listing
     * @param buyer Address of the agent hiring the service
     * @param provider Address of the agent providing the service
     * @param termsCid IPFS CID of the agreed terms document
     * @param deliveryCid IPFS CID of the delivered work (set on delivery)
     * @param escrowAmount Amount of ETH or tokens escrowed
     * @param escrowType Type of escrow (None, ETH, Token)
     * @param status Current lifecycle status
     * @param deadline Unix timestamp by which work must be delivered
     * @param createdAt Block timestamp when agreement was created
     * @param settledAt Block timestamp when agreement was settled
     * @param escrowToken Address of the ERC-20 token used for escrow (V2: per-agreement token choice)
     */
    struct Agreement {
        uint256 listingId;
        address buyer;
        address provider;
        string termsCid;
        string deliveryCid;
        uint256 escrowAmount;
        EscrowType escrowType;
        ServiceStatus status;
        uint256 deadline;
        uint256 createdAt;
        uint256 settledAt;
        address escrowToken; // V2: per-agreement token address (USDC, NOOK, etc.)
        uint256 feeBps;      // V3: platform fee locked at creation time
        uint256 cancelFeeBps; // V6: cancellation fee locked at creation time
    }

    // ============================================================
    //                        STATE VARIABLES
    // ============================================================

    /// @notice Maps listing ID => listing data
    mapping(uint256 => ServiceListing) private _listings;

    /// @notice Maps agreement ID => agreement data
    mapping(uint256 => Agreement) private _agreements;

    /// @notice Maps provider address => array of listing IDs
    mapping(address => uint256[]) private _providerListings;

    /// @notice Next listing ID to assign
    uint256 public nextListingId;

    /// @notice Next agreement ID to assign
    uint256 public nextAgreementId;

    /// @notice Reference to the AgentRegistry contract
    address public agentRegistry;

    /// @notice ERC-20 token for escrow. address(0) = ETH-only mode
    IERC20 public paymentToken;

    /// @notice Platform fee in basis points (e.g., 250 = 2.5%). Max 1000 (10%).
    uint256 public platformFeeBps;

    /// @notice Treasury address where platform fees are sent
    address public treasury;

    /// @notice Whitelist of ERC-20 tokens allowed for escrow (V2)
    mapping(address => bool) public allowedTokens;

    /// @notice Maximum platform fee (10%)
    uint256 public constant MAX_FEE_BPS = 1000;

    /// @notice Maximum deadline offset (30 days in seconds)
    uint256 public constant MAX_DEADLINE_OFFSET = 30 days;

    /// @notice Grace period after deadline before delivered agreements can be expired
    uint256 public deliveryGracePeriod;

    /// @notice Cancellation fee in basis points (e.g., 500 = 5%). Max MAX_FEE_BPS.
    uint256 public cancellationFeeBps;

    /// @notice Time period after dispute before it can be expired (default 30 days)
    uint256 public disputeTimeoutPeriod;

    /// @notice Maps agreement ID => timestamp when dispute was initiated
    mapping(uint256 => uint256) public disputedAt;

    /// @notice Maps agreement ID => status before the dispute was filed
    mapping(uint256 => ServiceStatus) public preDisputeStatus;

    /// @notice Maps agreement ID => address that initiated the dispute
    mapping(uint256 => address) public disputeInitiator;

    /// @dev Storage gap for future upgrades (UUPS pattern)
    uint256[37] private __gap;

    // ============================================================
    //                          EVENTS
    // ============================================================

    /// @notice Emitted when a new service listing is created
    event ServiceListed(
        uint256 indexed listingId,
        address indexed provider,
        string category,
        string metadataCid,
        uint256 priceAmount
    );

    /// @notice Emitted when a service listing is updated
    event ServiceUpdated(
        uint256 indexed listingId,
        string metadataCid,
        bool active
    );

    /// @notice Emitted when a new agreement is created
    event AgreementCreated(
        uint256 indexed agreementId,
        uint256 indexed listingId,
        address indexed buyer,
        address provider,
        uint256 escrowAmount,
        address tokenAddress
    );

    /// @notice Emitted when the provider delivers work
    event WorkDelivered(
        uint256 indexed agreementId,
        string deliveryCid
    );

    /// @notice Emitted when the buyer settles (approves) the agreement
    event AgreementSettled(
        uint256 indexed agreementId,
        uint256 payout
    );

    /// @notice Emitted when either party disputes an agreement
    event AgreementDisputed(
        uint256 indexed agreementId,
        address indexed disputedBy,
        string reasonCid
    );

    /// @notice Emitted when the owner resolves a dispute
    event DisputeResolved(
        uint256 indexed agreementId,
        bool inFavorOfProvider
    );

    /// @notice Emitted when the buyer cancels an agreement
    event AgreementCancelled(
        uint256 indexed agreementId
    );

    /// @notice Emitted when the payment token is updated
    event PaymentTokenUpdated(address indexed oldToken, address indexed newToken);

    /// @notice Emitted when the platform fee is updated
    event PlatformFeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);

    /// @notice Emitted when the treasury address is updated
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    /// @notice Emitted when a token's allowed status is updated (V2)
    event AllowedTokenUpdated(address indexed token, bool allowed);

    /// @notice Emitted when a delivered agreement expires (funds released to provider)
    event DeliveryExpired(uint256 indexed agreementId, address indexed provider, uint256 amount);

    /// @notice Emitted when a disputed agreement expires (auto-resolved by timeout)
    event DisputeExpired(uint256 indexed agreementId, bool providerWins, uint256 payout, uint256 cancellationFee);

    /// @notice Emitted when the cancellation fee is updated
    event CancellationFeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);

    /// @notice Emitted when the dispute timeout period is updated
    event DisputeTimeoutUpdated(uint256 oldPeriod, uint256 newPeriod);

    /// @notice Emitted when an agreement is cancelled with a fee deducted
    event AgreementCancelledWithFee(uint256 indexed agreementId, uint256 cancellationFee);

    // ============================================================
    //                        INITIALIZER
    // ============================================================

    /// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
    constructor(address trustedForwarder_) ERC2771ContextUpgradeable(trustedForwarder_) {
        _disableInitializers();
    }

    /**
     * @notice Initialize the ServiceMarketplace.
     * @param owner_ Contract owner address
     * @param agentRegistry_ Address of the AgentRegistry contract
     * @param treasury_ Address where platform fees are sent
     */
    function initialize(
        address owner_,
        address agentRegistry_,
        address treasury_
    ) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        if (agentRegistry_ == address(0)) revert ZeroAddress();
        if (treasury_ == address(0)) revert ZeroAddress();

        __Ownable_init(owner_);
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        agentRegistry = agentRegistry_;
        treasury = treasury_;
        // paymentToken defaults to address(0) = ETH-only mode
        // platformFeeBps defaults to 0
    }

    // ============================================================
    //                    SERVICE LISTINGS
    // ============================================================

    /**
     * @notice List a new service on the marketplace.
     * @param metadataCid IPFS CID of the full service description document
     * @param category Service category (e.g. "research", "coding")
     * @param pricingModel How the service is priced (PerTask, Hourly, etc.)
     * @param priceAmount Suggested price in wei or token units (0 = negotiable)
     *
     * Emits {ServiceListed}.
     */
    function listService(
        string calldata metadataCid,
        string calldata category,
        PricingModel pricingModel,
        uint256 priceAmount
    ) external whenNotPaused {
        if (bytes(metadataCid).length == 0) revert EmptyString();
        if (bytes(category).length == 0) revert EmptyString();

        address sender = _msgSender();
        _requireActiveAgent(sender);

        uint256 listingId = nextListingId++;

        _listings[listingId] = ServiceListing({
            provider: sender,
            metadataCid: metadataCid,
            category: category,
            pricingModel: pricingModel,
            priceAmount: priceAmount,
            active: true,
            totalCompleted: 0,
            totalDisputed: 0,
            createdAt: block.timestamp,
            updatedAt: block.timestamp
        });

        _providerListings[sender].push(listingId);

        emit ServiceListed(listingId, sender, category, metadataCid, priceAmount);
    }

    /**
     * @notice Update an existing service listing.
     * @param listingId ID of the listing to update
     * @param metadataCid New IPFS CID (pass empty string to keep current)
     * @param active Whether the listing should be active
     *
     * Emits {ServiceUpdated}.
     */
    function updateListing(
        uint256 listingId,
        string calldata metadataCid,
        bool active
    ) external whenNotPaused {
        ServiceListing storage listing = _getListing(listingId);

        address sender = _msgSender();
        if (sender != listing.provider) revert NotProvider();

        if (bytes(metadataCid).length > 0) {
            listing.metadataCid = metadataCid;
        }
        listing.active = active;
        listing.updatedAt = block.timestamp;

        emit ServiceUpdated(listingId, listing.metadataCid, active);
    }

    // ============================================================
    //                    AGREEMENT LIFECYCLE
    // ============================================================

    /**
     * @notice Create a new service agreement (hire an agent) with per-agreement token choice.
     * @param listingId ID of the service listing to hire
     * @param termsCid IPFS CID of the agreed terms document
     * @param deadline Unix timestamp by which work must be delivered
     * @param tokenAmount Amount of tokens to escrow (in token's smallest units)
     * @param tokenAddress Address of the ERC-20 token for escrow (must be in allowedTokens).
     *                     Pass address(0) for ETH escrow or reputation-only agreements.
     *
     * @dev Escrow logic (V2 — per-agreement token choice):
     *      - tokenAddress != address(0) + tokenAmount > 0 → token escrow (must be whitelisted)
     *      - tokenAddress == address(0) + msg.value > 0 → ETH escrow
     *      - tokenAddress == address(0) + msg.value == 0 → reputation-only
     *
     * Emits {AgreementCreated}.
     */
    function createAgreement(
        uint256 listingId,
        string calldata termsCid,
        uint256 deadline,
        uint256 tokenAmount,
        address tokenAddress
    ) external payable whenNotPaused nonReentrant {
        if (bytes(termsCid).length == 0) revert EmptyString();
        if (deadline <= block.timestamp) revert DeadlineNotInFuture();
        if (deadline > block.timestamp + MAX_DEADLINE_OFFSET) revert DeadlineTooFar();

        ServiceListing storage listing = _getListing(listingId);
        if (!listing.active) revert ListingNotActive();

        address sender = _msgSender();
        _requireActiveAgent(sender);
        if (sender == listing.provider) revert CannotHireSelf();

        uint256 agreementId = nextAgreementId++;

        // Write directly to storage to avoid "stack too deep" with struct literal
        Agreement storage a = _agreements[agreementId];
        a.listingId = listingId;
        a.buyer = sender;
        a.provider = listing.provider;
        a.termsCid = termsCid;
        a.status = ServiceStatus.Agreed;
        a.deadline = deadline;
        a.createdAt = block.timestamp;
        a.feeBps = platformFeeBps; // V3: lock fee at creation time
        a.cancelFeeBps = cancellationFeeBps; // V6: lock cancel fee at creation time

        if (tokenAddress != address(0) && tokenAmount > 0) {
            // Per-agreement token escrow (V2)
            if (!allowedTokens[tokenAddress]) revert TokenNotAllowed();
            a.escrowType = EscrowType.Token;
            a.escrowAmount = tokenAmount;
            a.escrowToken = tokenAddress;
            IERC20(tokenAddress).safeTransferFrom(sender, address(this), tokenAmount);
        } else if (msg.value > 0) {
            // ETH escrow
            a.escrowType = EscrowType.ETH;
            a.escrowAmount = msg.value;
        }
        // else: defaults are EscrowType.None (0), escrowAmount 0, escrowToken address(0)

        emit AgreementCreated(agreementId, listingId, sender, listing.provider, a.escrowAmount, a.escrowToken);
    }

    /**
     * @notice Deliver work for an active agreement.
     * @param agreementId ID of the agreement
     * @param deliveryCid IPFS CID of the delivered work
     *
     * @dev Only the provider can deliver. Agreement must be in Agreed status.
     *
     * Emits {WorkDelivered}.
     */
    function deliverWork(
        uint256 agreementId,
        string calldata deliveryCid
    ) external whenNotPaused {
        if (bytes(deliveryCid).length == 0) revert EmptyString();

        Agreement storage agreement = _getAgreement(agreementId);
        if (agreement.status != ServiceStatus.Agreed) revert InvalidStatus();

        address sender = _msgSender();
        if (sender != agreement.provider) revert NotProvider();

        agreement.status = ServiceStatus.Delivered;
        agreement.deliveryCid = deliveryCid;

        emit WorkDelivered(agreementId, deliveryCid);
    }

    /**
     * @notice Settle an agreement (approve delivered work and release escrow).
     * @param agreementId ID of the agreement to settle
     *
     * @dev Only the buyer can settle. Releases escrow minus platform fee to provider.
     *      Increments the listing's totalCompleted counter.
     *
     * Emits {AgreementSettled}.
     */
    function settleAgreement(uint256 agreementId) external whenNotPaused nonReentrant {
        Agreement storage agreement = _getAgreement(agreementId);
        if (agreement.status != ServiceStatus.Delivered) revert InvalidStatus();

        address sender = _msgSender();
        if (sender != agreement.buyer) revert NotBuyer();

        // Effects — update state before transfers
        agreement.status = ServiceStatus.Settled;
        agreement.settledAt = block.timestamp;

        // Increment provider's completed count
        _listings[agreement.listingId].totalCompleted++;

        // Interactions — release escrow (V3: use locked fee)
        _releaseEscrow(agreement.provider, agreement.escrowAmount, agreement.escrowType, agreement.escrowToken, _effectiveFeeBps(agreement));

        emit AgreementSettled(agreementId, agreement.escrowAmount);
    }

    /**
     * @notice Dispute an agreement.
     * @param agreementId ID of the agreement to dispute
     * @param reasonCid IPFS CID of the dispute reason document
     *
     * @dev Either buyer or provider can dispute. Agreement must be in Agreed or Delivered.
     *
     * Emits {AgreementDisputed}.
     */
    function disputeAgreement(
        uint256 agreementId,
        string calldata reasonCid
    ) external whenNotPaused {
        Agreement storage agreement = _getAgreement(agreementId);
        if (agreement.status != ServiceStatus.Agreed && agreement.status != ServiceStatus.Delivered) {
            revert InvalidStatus();
        }

        address sender = _msgSender();
        if (sender != agreement.buyer && sender != agreement.provider) revert NotParty();

        // V6: Provider cannot dispute an Agreed agreement (hasn't delivered yet)
        if (agreement.status == ServiceStatus.Agreed && sender == agreement.provider) {
            revert InvalidStatus();
        }

        // V5: Record pre-dispute metadata before status change
        preDisputeStatus[agreementId] = agreement.status;
        disputedAt[agreementId] = block.timestamp;
        disputeInitiator[agreementId] = sender;

        agreement.status = ServiceStatus.Disputed;

        // Increment listing's disputed count
        _listings[agreement.listingId].totalDisputed++;

        emit AgreementDisputed(agreementId, sender, reasonCid);
    }

    /**
     * @notice Resolve a disputed agreement.
     * @param agreementId ID of the disputed agreement
     * @param inFavorOfProvider If true, release escrow to provider. If false, refund buyer.
     *
     * @dev Only callable by the contract owner. Final resolution.
     *
     * Emits {DisputeResolved}.
     */
    function resolveDispute(
        uint256 agreementId,
        bool inFavorOfProvider
    ) external onlyRole(DEFAULT_ADMIN_ROLE) whenNotPaused nonReentrant {
        Agreement storage agreement = _getAgreement(agreementId);
        if (agreement.status != ServiceStatus.Disputed) revert InvalidStatus();

        // Effects — set final status
        if (inFavorOfProvider) {
            agreement.status = ServiceStatus.Settled;
            agreement.settledAt = block.timestamp;
            _listings[agreement.listingId].totalCompleted++;
        } else {
            agreement.status = ServiceStatus.Cancelled;
        }

        // Interactions (V3: use locked fee)
        if (inFavorOfProvider) {
            _releaseEscrow(agreement.provider, agreement.escrowAmount, agreement.escrowType, agreement.escrowToken, _effectiveFeeBps(agreement));
        } else {
            // V5: Deduct cancellation fee when buyer disputes an Agreed agreement and wins
            // This prevents using dispute-as-free-cancel to evade the cancellation fee
            if (cancellationFeeBps > 0 &&
                preDisputeStatus[agreementId] == ServiceStatus.Agreed &&
                disputeInitiator[agreementId] == agreement.buyer) {
                _refundWithCancellationFee(agreement);
            } else {
                _refundEscrow(agreement.buyer, agreement.escrowAmount, agreement.escrowType, agreement.escrowToken);
            }
        }

        emit DisputeResolved(agreementId, inFavorOfProvider);
    }

    /**
     * @notice Cancel an agreement and refund escrow.
     * @param agreementId ID of the agreement to cancel
     *
     * @dev Only the buyer can cancel. Agreement must be in Agreed status (before delivery).
     *
     * Emits {AgreementCancelled}.
     */
    function cancelAgreement(uint256 agreementId) external whenNotPaused nonReentrant {
        Agreement storage agreement = _getAgreement(agreementId);
        if (agreement.status != ServiceStatus.Agreed) revert InvalidStatus();

        address sender = _msgSender();
        if (sender != agreement.buyer) revert NotBuyer();

        // Effects
        agreement.status = ServiceStatus.Cancelled;

        // Interactions — V5: deduct cancellation fee if configured
        if (cancellationFeeBps > 0) {
            uint256 fee = _refundWithCancellationFee(agreement);
            if (fee > 0) {
                emit AgreementCancelledWithFee(agreementId, fee);
                return;
            }
        }
        _refundEscrow(agreement.buyer, agreement.escrowAmount, agreement.escrowType, agreement.escrowToken);

        emit AgreementCancelled(agreementId);
    }

    /**
     * @notice Expire a Delivered agreement after deadline + grace period.
     * @param agreementId ID of the agreement to expire
     *
     * @dev Anyone can call this. Defaults to releasing escrow to the provider
     *      (they delivered, buyer abandoned). If both parties abandon past the
     *      deadline, this prevents funds from being permanently stuck.
     *
     * Emits {DeliveryExpired}.
     */
    function expireDelivered(uint256 agreementId) external whenNotPaused nonReentrant {
        Agreement storage agreement = _getAgreement(agreementId);
        if (agreement.status != ServiceStatus.Delivered) revert InvalidStatus();
        if (block.timestamp <= agreement.deadline + deliveryGracePeriod) revert NotExpired();

        uint256 effectiveFee = _effectiveFeeBps(agreement);
        agreement.status = ServiceStatus.Settled;
        agreement.settledAt = block.timestamp;
        _listings[agreement.listingId].totalCompleted++;

        _releaseEscrow(agreement.provider, agreement.escrowAmount, agreement.escrowType, agreement.escrowToken, effectiveFee);

        emit DeliveryExpired(agreementId, agreement.provider, agreement.escrowAmount);
    }

    /**
     * @notice Expire a disputed agreement after the dispute timeout period.
     * @param agreementId ID of the agreement to expire
     *
     * @dev Anyone can call this after disputedAt + disputeTimeoutPeriod.
     *      Resolution logic based on pre-dispute status:
     *      - Pre-dispute Delivered → provider wins (release escrow minus platform fee)
     *      - Pre-dispute Agreed + buyer initiated → buyer wins minus cancellation fee
     *      - Pre-dispute Agreed + provider initiated → buyer wins, full refund
     *
     *      Disputes with disputedAt == 0 require admin resolution.
     *
     * Emits {DisputeExpired}.
     */
    function expireDispute(uint256 agreementId) external whenNotPaused nonReentrant {
        Agreement storage agreement = _getAgreement(agreementId);
        if (agreement.status != ServiceStatus.Disputed) revert NotDisputed();

        // Disputes with disputedAt == 0 require admin resolution
        if (disputedAt[agreementId] == 0) revert DisputeNotExpired();
        if (block.timestamp <= disputedAt[agreementId] + disputeTimeoutPeriod) revert DisputeNotExpired();

        ServiceStatus priorStatus = preDisputeStatus[agreementId];
        uint256 cancelFee = 0;

        if (priorStatus == ServiceStatus.Delivered) {
            // Provider delivered, buyer disputed but didn't follow through → provider wins
            agreement.status = ServiceStatus.Settled;
            agreement.settledAt = block.timestamp;
            _listings[agreement.listingId].totalCompleted++;

            _releaseEscrow(agreement.provider, agreement.escrowAmount, agreement.escrowType, agreement.escrowToken, _effectiveFeeBps(agreement));

            emit DisputeExpired(agreementId, true, agreement.escrowAmount, 0);
        } else {
            // Pre-dispute was Agreed
            if (disputeInitiator[agreementId] == agreement.buyer) {
                // Buyer initiated dispute on Agreed → buyer wins minus cancellation fee
                agreement.status = ServiceStatus.Cancelled;
                cancelFee = _refundWithCancellationFee(agreement);

                emit DisputeExpired(agreementId, false, agreement.escrowAmount, cancelFee);
            } else {
                // Provider initiated dispute on Agreed → buyer wins, full refund
                agreement.status = ServiceStatus.Cancelled;
                _refundEscrow(agreement.buyer, agreement.escrowAmount, agreement.escrowType, agreement.escrowToken);

                emit DisputeExpired(agreementId, false, agreement.escrowAmount, 0);
            }
        }
    }

    // ============================================================
    //                      VIEW FUNCTIONS
    // ============================================================

    /**
     * @notice Get the full info for a service listing.
     * @param listingId ID to look up
     * @return ServiceListing struct
     */
    function getListing(uint256 listingId) external view returns (ServiceListing memory) {
        if (listingId >= nextListingId) revert ListingNotFound();
        return _listings[listingId];
    }

    /**
     * @notice Get the full info for an agreement.
     * @param agreementId ID to look up
     * @return Agreement struct
     */
    function getAgreement(uint256 agreementId) external view returns (Agreement memory) {
        if (agreementId >= nextAgreementId) revert AgreementNotFound();
        return _agreements[agreementId];
    }

    /**
     * @notice Get all listing IDs for a provider.
     * @param provider Address of the provider
     * @return Array of listing IDs
     */
    function getProviderListings(address provider) external view returns (uint256[] memory) {
        return _providerListings[provider];
    }

    /**
     * @notice Get provider stats from their listings.
     * @param provider Address of the provider
     * @return totalCompleted Total settled agreements across all listings
     * @return totalDisputed Total disputed agreements across all listings
     */
    function getProviderStats(address provider) external view returns (
        uint256 totalCompleted,
        uint256 totalDisputed
    ) {
        uint256[] memory ids = _providerListings[provider];
        for (uint256 i = 0; i < ids.length; i++) {
            totalCompleted += _listings[ids[i]].totalCompleted;
            totalDisputed += _listings[ids[i]].totalDisputed;
        }
    }

    /**
     * @notice Get the total number of listings created.
     */
    function totalListings() external view returns (uint256) {
        return nextListingId;
    }

    /**
     * @notice Get the total number of agreements created.
     */
    function totalAgreements() external view returns (uint256) {
        return nextAgreementId;
    }

    // ============================================================
    //                      ADMIN FUNCTIONS
    // ============================================================

    /// @notice Set the payment token address. address(0) = ETH-only mode.
    /// @dev Legacy V1 function — kept for backward compatibility. New agreements use per-agreement token choice.
    function setPaymentToken(address token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        address oldToken = address(paymentToken);
        paymentToken = IERC20(token);
        emit PaymentTokenUpdated(oldToken, token);
    }

    /// @notice Add or remove a token from the allowed escrow token whitelist.
    /// @param token ERC-20 token address to update
    /// @param allowed Whether the token is allowed for escrow
    function setAllowedToken(address token, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        allowedTokens[token] = allowed;
        emit AllowedTokenUpdated(token, allowed);
    }

    /**
     * @notice V2 reinitializer — sets up the allowed token whitelist.
     * @param usdc_ USDC token address
     * @param nook_ NOOK token address
     * @dev Called once during UUPS upgrade via upgradeProxy call option.
     */
    function initializeV2(address usdc_, address nook_) external reinitializer(2) {
        if (usdc_ != address(0)) allowedTokens[usdc_] = true;
        if (nook_ != address(0)) allowedTokens[nook_] = true;
    }

    /**
     * @notice V3 reinitializer — migrates from Ownable to AccessControl.
     * @param admin_ Multi-sig address that gets DEFAULT_ADMIN_ROLE
     * @param guardian_ Security EOA that gets GUARDIAN_ROLE (pause only)
     */
    function initializeV3(address admin_, address guardian_) external reinitializer(3) {
        if (admin_ == address(0)) revert ZeroAddress();
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        if (guardian_ != address(0)) _grantRole(GUARDIAN_ROLE, guardian_);
        _transferOwnership(address(0));
    }

    /**
     * @notice V4 reinitializer — sets delivery grace period for expireDelivered.
     */
    function initializeV4() external reinitializer(4) {
        deliveryGracePeriod = 14 days;
    }

    /**
     * @notice V5 reinitializer — sets cancellation fee and dispute timeout period.
     * @dev Cancellation fee = 5% (500 bps). Dispute timeout = 30 days.
     */
    function initializeV5() external reinitializer(5) {
        cancellationFeeBps = 500;
        disputeTimeoutPeriod = 30 days;
    }

    /**
     * @notice V6 reinitializer — marks version for cancelFeeBps snapshot in Agreement struct.
     * @dev No state changes needed; existing agreements use fallback (global cancellationFeeBps).
     *      New agreements created after V6 snapshot cancelFeeBps at creation time.
     */
    function initializeV6() external reinitializer(6) {
        // No-op: Agreement struct now has cancelFeeBps field.
        // Existing agreements (cancelFeeBps == 0) fall back to global cancellationFeeBps.
    }

    /**
     * @notice Combined V1–V6 initializer for fresh proxy deploys.
     * @dev    Encodes ALL initialization logic into a single atomic call so it
     *         can be passed as the `data` arg to the ERC1967Proxy constructor.
     *         This eliminates the init-gap vulnerability that exists when V1–V6
     *         are called sequentially across multiple transactions.
     *
     *         Skips OwnableUpgradeable entirely — goes straight to AccessControl.
     *         owner() returns address(0) by default (Ownable never initialized),
     *         which is the correct end state (V3 would have renounced it anyway).
     *
     * @param admin_         Address that receives DEFAULT_ADMIN_ROLE
     * @param guardian_      Address that receives GUARDIAN_ROLE (can be same as admin)
     * @param agentRegistry_ AgentRegistry contract address
     * @param treasury_      Platform treasury for fee collection
     * @param usdc_          USDC token address to whitelist
     * @param nook_          NOOK token address to whitelist
     */
    function initializeAll(
        address admin_,
        address guardian_,
        address agentRegistry_,
        address treasury_,
        address usdc_,
        address nook_
    ) external reinitializer(6) {
        if (admin_ == address(0)) revert ZeroAddress();
        if (agentRegistry_ == address(0)) revert ZeroAddress();
        if (treasury_ == address(0)) revert ZeroAddress();

        // V1: core infrastructure (skip Ownable — AccessControl handles auth)
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        agentRegistry = agentRegistry_;
        treasury = treasury_;

        // V2: whitelist payment tokens
        if (usdc_ != address(0)) allowedTokens[usdc_] = true;
        if (nook_ != address(0)) allowedTokens[nook_] = true;

        // V3: AccessControl (replaces Ownable)
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        if (guardian_ != address(0)) _grantRole(GUARDIAN_ROLE, guardian_);

        // V4: delivery grace period
        deliveryGracePeriod = 14 days;

        // V5: cancellation + dispute parameters
        cancellationFeeBps = 500;
        disputeTimeoutPeriod = 30 days;

        // V6: no-op (cancelFeeBps snapshot in Agreement struct)
    }

    /// @notice Set the delivery grace period (time after deadline before expiry allowed).
    function setDeliveryGracePeriod(uint256 period) external onlyRole(DEFAULT_ADMIN_ROLE) {
        deliveryGracePeriod = period;
    }

    /// @notice Set the cancellation fee in basis points (max MAX_FEE_BPS = 10%).
    function setCancellationFeeBps(uint256 feeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (feeBps > MAX_FEE_BPS) revert CancellationFeeTooHigh();
        uint256 oldFee = cancellationFeeBps;
        cancellationFeeBps = feeBps;
        emit CancellationFeeUpdated(oldFee, feeBps);
    }

    /// @notice Set the dispute timeout period (time after dispute before expiry allowed).
    /// @dev V6: bounded to [1 day, 365 days] to prevent abuse.
    function setDisputeTimeoutPeriod(uint256 period) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(period >= 1 days && period <= 365 days, "Period out of bounds");
        uint256 oldPeriod = disputeTimeoutPeriod;
        disputeTimeoutPeriod = period;
        emit DisputeTimeoutUpdated(oldPeriod, period);
    }

    /// @notice Set the platform fee in basis points (max 1000 = 10%).
    function setPlatformFeeBps(uint256 feeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        uint256 oldFee = platformFeeBps;
        platformFeeBps = feeBps;
        emit PlatformFeeUpdated(oldFee, feeBps);
    }

    /// @notice Update the treasury address.
    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        address oldTreasury = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(oldTreasury, newTreasury);
    }

    /// @notice Update the AgentRegistry contract reference.
    function setAgentRegistry(address newRegistry) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newRegistry == address(0)) revert ZeroAddress();
        agentRegistry = newRegistry;
    }

    /// @notice Pause all marketplace operations (emergency stop).
    function pause() external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender) && !hasRole(GUARDIAN_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, GUARDIAN_ROLE);
        }
        _pause();
    }

    /// @notice Unpause marketplace operations.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ============================================================
    //                   EMERGENCY WITHDRAW
    // ============================================================

    event EmergencyWithdraw(address indexed token, address indexed to, uint256 amount);
    event EmergencyETHWithdraw(address indexed to, uint256 amount);

    /// @notice Withdraw stuck ERC-20 tokens sent to this contract by mistake.
    function emergencyWithdraw(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(to, amount);
        emit EmergencyWithdraw(token, to, amount);
    }

    /// @notice Rescue stuck ETH sent to this contract by mistake.
    function rescueETH(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        (bool success, ) = to.call{value: amount}("");
        if (!success) revert EthTransferFailed();
        emit EmergencyETHWithdraw(to, amount);
    }

    // ============================================================
    //                     INTERNAL HELPERS
    // ============================================================

    /**
     * @dev Get a storage reference to a listing, reverting if it doesn't exist.
     */
    function _getListing(uint256 listingId) internal view returns (ServiceListing storage) {
        if (listingId >= nextListingId) revert ListingNotFound();
        return _listings[listingId];
    }

    /**
     * @dev Get a storage reference to an agreement, reverting if it doesn't exist.
     */
    function _getAgreement(uint256 agreementId) internal view returns (Agreement storage) {
        if (agreementId >= nextAgreementId) revert AgreementNotFound();
        return _agreements[agreementId];
    }

    /**
     * @dev Returns the effective fee for an agreement. Pre-V3 agreements (feeBps == 0)
     *      fall back to the current global platformFeeBps for backward compatibility.
     */
    function _effectiveFeeBps(Agreement storage a) internal view returns (uint256) {
        return a.feeBps > 0 ? a.feeBps : platformFeeBps;
    }

    /**
     * @dev Release escrow to the provider (minus platform fee to treasury).
     *      Follows checks-effects-interactions — caller must update state BEFORE calling.
     * @param tokenAddr Per-agreement token address. If address(0), falls back to global paymentToken
     *                  (backward compat for in-flight agreements at upgrade time).
     * @param feeBps_ Fee in basis points to apply (V3: passed from agreement's locked fee)
     */
    function _releaseEscrow(
        address recipient,
        uint256 amount,
        EscrowType escrow,
        address tokenAddr,
        uint256 feeBps_
    ) internal {
        if (amount == 0 || escrow == EscrowType.None) return;

        uint256 fee = (amount * feeBps_) / 10000;
        uint256 payout = amount - fee;

        if (escrow == EscrowType.ETH) {
            if (fee > 0) {
                (bool feeSuccess, ) = treasury.call{value: fee}("");
                if (!feeSuccess) revert EthTransferFailed();
            }
            (bool paySuccess, ) = recipient.call{value: payout}("");
            if (!paySuccess) revert EthTransferFailed();
        } else if (escrow == EscrowType.Token) {
            // V2: use per-agreement token; fallback to global paymentToken for pre-upgrade agreements
            IERC20 token = tokenAddr != address(0) ? IERC20(tokenAddr) : paymentToken;
            if (fee > 0) {
                token.safeTransfer(treasury, fee);
            }
            token.safeTransfer(recipient, payout);
        }
    }

    /**
     * @dev Refund escrow to the buyer (no fee deducted on refunds).
     *      Follows checks-effects-interactions — caller must update state BEFORE calling.
     * @param tokenAddr Per-agreement token address. If address(0), falls back to global paymentToken.
     */
    function _refundEscrow(
        address recipient,
        uint256 amount,
        EscrowType escrow,
        address tokenAddr
    ) internal {
        if (amount == 0 || escrow == EscrowType.None) return;

        if (escrow == EscrowType.ETH) {
            (bool success, ) = recipient.call{value: amount}("");
            if (!success) revert EthTransferFailed();
        } else if (escrow == EscrowType.Token) {
            // V2: use per-agreement token; fallback to global paymentToken for pre-upgrade agreements
            IERC20 token = tokenAddr != address(0) ? IERC20(tokenAddr) : paymentToken;
            token.safeTransfer(recipient, amount);
        }
    }

    /**
     * @dev Refund escrow to the buyer minus a cancellation fee sent to treasury.
     *      Returns the fee amount (0 for zero-escrow agreements).
     *      Follows checks-effects-interactions — caller must update state BEFORE calling.
     * @param a The agreement storage reference
     * @return fee The cancellation fee amount sent to treasury
     */
    function _refundWithCancellationFee(Agreement storage a) internal returns (uint256 fee) {
        if (a.escrowAmount == 0 || a.escrowType == EscrowType.None) return 0;

        uint256 effectiveFeeBps = a.cancelFeeBps > 0 ? a.cancelFeeBps : cancellationFeeBps;
        fee = (a.escrowAmount * effectiveFeeBps) / 10000;
        uint256 refund = a.escrowAmount - fee;

        if (a.escrowType == EscrowType.ETH) {
            if (fee > 0) {
                (bool feeSuccess, ) = treasury.call{value: fee}("");
                if (!feeSuccess) revert EthTransferFailed();
            }
            (bool refundSuccess, ) = a.buyer.call{value: refund}("");
            if (!refundSuccess) revert EthTransferFailed();
        } else if (a.escrowType == EscrowType.Token) {
            IERC20 token = a.escrowToken != address(0) ? IERC20(a.escrowToken) : paymentToken;
            if (fee > 0) {
                token.safeTransfer(treasury, fee);
            }
            token.safeTransfer(a.buyer, refund);
        }
    }

    /**
     * @dev Check that an address is a registered, active agent.
     *      Fail-open if AgentRegistry is unreachable — prevents cascading
     *      failure where AgentRegistry downtime bricks the marketplace.
     *      Agent status is still enforced when the call succeeds.
     */
    function _requireActiveAgent(address agent) internal view {
        (bool success, bytes memory data) = agentRegistry.staticcall(
            abi.encodeWithSignature("isActiveAgent(address)", agent)
        );

        // If AgentRegistry is unreachable, allow the operation.
        // This is a deliberate availability trade-off: brief unverified access
        // during AgentRegistry downtime is preferable to a bricked marketplace.
        if (success && data.length > 0) {
            bool isActive = abi.decode(data, (bool));
            if (!isActive) revert NotRegisteredAgent();
        }
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

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
