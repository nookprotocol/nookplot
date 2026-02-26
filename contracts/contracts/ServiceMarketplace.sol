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

    /// @notice Maximum platform fee (10%)
    uint256 public constant MAX_FEE_BPS = 1000;

    /// @notice Maximum deadline offset (30 days in seconds)
    uint256 public constant MAX_DEADLINE_OFFSET = 30 days;

    /// @dev Storage gap for future upgrades (UUPS pattern)
    uint256[44] private __gap;

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
        uint256 escrowAmount
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
     * @notice Create a new service agreement (hire an agent).
     * @param listingId ID of the service listing to hire
     * @param termsCid IPFS CID of the agreed terms document
     * @param deadline Unix timestamp by which work must be delivered
     * @param tokenAmount Amount of tokens to escrow (only used when paymentToken is set)
     *
     * @dev Escrow logic (same as BountyContract):
     *      - paymentToken == address(0) + msg.value > 0 → ETH escrow
     *      - paymentToken == address(0) + msg.value == 0 → reputation-only
     *      - paymentToken != address(0) → token escrow (transferFrom buyer → contract)
     *
     * Emits {AgreementCreated}.
     */
    function createAgreement(
        uint256 listingId,
        string calldata termsCid,
        uint256 deadline,
        uint256 tokenAmount
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
        EscrowType escrow;
        uint256 escrowAmount;

        if (address(paymentToken) != address(0) && tokenAmount > 0) {
            // Token escrow
            escrow = EscrowType.Token;
            escrowAmount = tokenAmount;
            paymentToken.safeTransferFrom(sender, address(this), tokenAmount);
        } else if (msg.value > 0) {
            // ETH escrow
            escrow = EscrowType.ETH;
            escrowAmount = msg.value;
        } else {
            // Reputation-only
            escrow = EscrowType.None;
            escrowAmount = 0;
        }

        _agreements[agreementId] = Agreement({
            listingId: listingId,
            buyer: sender,
            provider: listing.provider,
            termsCid: termsCid,
            deliveryCid: "",
            escrowAmount: escrowAmount,
            escrowType: escrow,
            status: ServiceStatus.Agreed,
            deadline: deadline,
            createdAt: block.timestamp,
            settledAt: 0
        });

        emit AgreementCreated(agreementId, listingId, sender, listing.provider, escrowAmount);
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

        // Interactions — release escrow
        _releaseEscrow(agreement.provider, agreement.escrowAmount, agreement.escrowType);

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
    ) external onlyOwner whenNotPaused nonReentrant {
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

        // Interactions
        if (inFavorOfProvider) {
            _releaseEscrow(agreement.provider, agreement.escrowAmount, agreement.escrowType);
        } else {
            _refundEscrow(agreement.buyer, agreement.escrowAmount, agreement.escrowType);
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

        // Interactions
        _refundEscrow(agreement.buyer, agreement.escrowAmount, agreement.escrowType);

        emit AgreementCancelled(agreementId);
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
    function setPaymentToken(address token) external onlyOwner {
        address oldToken = address(paymentToken);
        paymentToken = IERC20(token);
        emit PaymentTokenUpdated(oldToken, token);
    }

    /// @notice Set the platform fee in basis points (max 1000 = 10%).
    function setPlatformFeeBps(uint256 feeBps) external onlyOwner {
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        uint256 oldFee = platformFeeBps;
        platformFeeBps = feeBps;
        emit PlatformFeeUpdated(oldFee, feeBps);
    }

    /// @notice Update the treasury address.
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        address oldTreasury = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(oldTreasury, newTreasury);
    }

    /// @notice Update the AgentRegistry contract reference.
    function setAgentRegistry(address newRegistry) external onlyOwner {
        if (newRegistry == address(0)) revert ZeroAddress();
        agentRegistry = newRegistry;
    }

    /// @notice Pause all marketplace operations (emergency stop).
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause marketplace operations.
    function unpause() external onlyOwner {
        _unpause();
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
     * @dev Release escrow to the provider (minus platform fee to treasury).
     *      Follows checks-effects-interactions — caller must update state BEFORE calling.
     */
    function _releaseEscrow(
        address recipient,
        uint256 amount,
        EscrowType escrow
    ) internal {
        if (amount == 0 || escrow == EscrowType.None) return;

        uint256 fee = (amount * platformFeeBps) / 10000;
        uint256 payout = amount - fee;

        if (escrow == EscrowType.ETH) {
            if (fee > 0) {
                (bool feeSuccess, ) = treasury.call{value: fee}("");
                if (!feeSuccess) revert EthTransferFailed();
            }
            (bool paySuccess, ) = recipient.call{value: payout}("");
            if (!paySuccess) revert EthTransferFailed();
        } else if (escrow == EscrowType.Token) {
            if (fee > 0) {
                paymentToken.safeTransfer(treasury, fee);
            }
            paymentToken.safeTransfer(recipient, payout);
        }
    }

    /**
     * @dev Refund escrow to the buyer (no fee deducted on refunds).
     *      Follows checks-effects-interactions — caller must update state BEFORE calling.
     */
    function _refundEscrow(
        address recipient,
        uint256 amount,
        EscrowType escrow
    ) internal {
        if (amount == 0 || escrow == EscrowType.None) return;

        if (escrow == EscrowType.ETH) {
            (bool success, ) = recipient.call{value: amount}("");
            if (!success) revert EthTransferFailed();
        } else if (escrow == EscrowType.Token) {
            paymentToken.safeTransfer(recipient, amount);
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

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
