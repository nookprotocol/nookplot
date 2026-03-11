// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

/**
 * @title GpuAttestation
 * @author Nookplot
 * @notice On-chain benchmark hash commitment for GPU providers.
 *         Providers run a standardized benchmark via `nookplot gpu benchmark`,
 *         then submit the hash on-chain as a tamper-proof record of their
 *         claimed GPU capabilities. Buyers can verify claims via buyer-initiated
 *         challenges; discrepancies are grounds for dispute.
 *
 *         Self-sovereign: only the provider can manage their own attestation.
 *         Owner can only pause/unpause and authorize upgrades.
 *
 * @dev UUPS proxy. No ERC-2771 — attestation is a direct wallet tx.
 */
contract GpuAttestation is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    PausableUpgradeable
{
    // ============================================================
    //                        CUSTOM ERRORS
    // ============================================================

    error ZeroHash();
    error EmptyModel();
    error ZeroVram();
    error NoAttestation();
    error AlreadyAttested();
    error NotActive();

    // ============================================================
    //                          TYPES
    // ============================================================

    struct Attestation {
        bytes32 benchmarkHash;       // keccak256 of benchmark output JSON
        string gpuModel;             // e.g. "NVIDIA A100"
        uint16 vramGb;               // e.g. 40, 80
        string computeCapability;    // e.g. "8.0"
        string cudaVersion;          // e.g. "12.1"
        uint64 attestedAt;           // block.timestamp of last attestation
        bool active;                 // provider can revoke
    }

    // ============================================================
    //                         EVENTS
    // ============================================================

    event AttestationSubmitted(
        address indexed provider,
        bytes32 benchmarkHash,
        string gpuModel,
        uint16 vramGb,
        string computeCapability,
        string cudaVersion,
        uint256 timestamp
    );

    event AttestationUpdated(
        address indexed provider,
        bytes32 benchmarkHash,
        uint256 timestamp
    );

    event AttestationRevoked(
        address indexed provider,
        uint256 timestamp
    );

    // ============================================================
    //                        STORAGE
    // ============================================================

    /// @notice provider address => attestation data
    mapping(address => Attestation) public attestations;

    /// @notice Total unique providers who have ever attested
    uint256 public attestationCount;

    uint256[48] private __gap;

    // ============================================================
    //                      INITIALIZER
    // ============================================================

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_) external initializer {
        if (owner_ == address(0)) revert EmptyModel(); // reuse error for zero addr
        __Ownable_init(owner_);
        __Pausable_init();
        __UUPSUpgradeable_init();
    }

    // ============================================================
    //                   ATTESTATION LIFECYCLE
    // ============================================================

    /**
     * @notice Submit a first-time GPU benchmark attestation.
     * @param benchmarkHash_ keccak256 of the canonical benchmark output JSON.
     * @param gpuModel_ GPU model string (e.g. "NVIDIA A100 40GB").
     * @param vramGb_ GPU VRAM in gigabytes.
     * @param computeCapability_ CUDA compute capability (e.g. "8.0").
     * @param cudaVersion_ CUDA toolkit version (e.g. "12.1").
     */
    function submitAttestation(
        bytes32 benchmarkHash_,
        string calldata gpuModel_,
        uint16 vramGb_,
        string calldata computeCapability_,
        string calldata cudaVersion_
    ) external whenNotPaused {
        if (benchmarkHash_ == bytes32(0)) revert ZeroHash();
        if (bytes(gpuModel_).length == 0) revert EmptyModel();
        if (vramGb_ == 0) revert ZeroVram();
        if (attestations[msg.sender].attestedAt != 0) revert AlreadyAttested();

        attestations[msg.sender] = Attestation({
            benchmarkHash: benchmarkHash_,
            gpuModel: gpuModel_,
            vramGb: vramGb_,
            computeCapability: computeCapability_,
            cudaVersion: cudaVersion_,
            attestedAt: uint64(block.timestamp),
            active: true
        });

        attestationCount++;

        emit AttestationSubmitted(
            msg.sender,
            benchmarkHash_,
            gpuModel_,
            vramGb_,
            computeCapability_,
            cudaVersion_,
            block.timestamp
        );
    }

    /**
     * @notice Update an existing attestation with a new benchmark hash.
     *         Resets the attestedAt timestamp. Use after re-running benchmark.
     * @param benchmarkHash_ New keccak256 of benchmark output JSON.
     */
    function updateAttestation(bytes32 benchmarkHash_) external whenNotPaused {
        if (benchmarkHash_ == bytes32(0)) revert ZeroHash();
        Attestation storage att = attestations[msg.sender];
        if (att.attestedAt == 0) revert NoAttestation();
        if (!att.active) revert NotActive();

        att.benchmarkHash = benchmarkHash_;
        att.attestedAt = uint64(block.timestamp);

        emit AttestationUpdated(msg.sender, benchmarkHash_, block.timestamp);
    }

    /**
     * @notice Revoke your attestation (voluntarily delist).
     */
    function revokeAttestation() external {
        Attestation storage att = attestations[msg.sender];
        if (att.attestedAt == 0) revert NoAttestation();
        if (!att.active) revert NotActive();

        att.active = false;

        emit AttestationRevoked(msg.sender, block.timestamp);
    }

    // ============================================================
    //                         VIEW
    // ============================================================

    /**
     * @notice Get full attestation data for a provider.
     */
    function getAttestation(address provider) external view returns (Attestation memory) {
        Attestation memory att = attestations[provider];
        if (att.attestedAt == 0) revert NoAttestation();
        return att;
    }

    /**
     * @notice Check if a provider has a valid (active + recent) attestation.
     * @param provider The provider address.
     * @param maxAgeSec Maximum age in seconds (0 = no age check).
     */
    function isAttestationValid(
        address provider,
        uint256 maxAgeSec
    ) external view returns (bool) {
        Attestation memory att = attestations[provider];
        if (att.attestedAt == 0 || !att.active) return false;
        if (maxAgeSec > 0 && block.timestamp - att.attestedAt > maxAgeSec) return false;
        return true;
    }

    /**
     * @notice Check if a provider has ever attested (regardless of active status).
     */
    function hasAttestation(address provider) external view returns (bool) {
        return attestations[provider].attestedAt != 0;
    }

    // ============================================================
    //                      ADMIN
    // ============================================================

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ============================================================
    //                      UUPS
    // ============================================================

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
