-- GPU Attestations: on-chain benchmark hash commitments from GpuAttestation contract
-- Indexed from AttestationSubmitted, AttestationUpdated, AttestationRevoked events

BEGIN;

CREATE TABLE IF NOT EXISTS idx_gpu_attestations (
    provider_address      TEXT PRIMARY KEY,
    benchmark_hash        TEXT NOT NULL,
    gpu_model             TEXT NOT NULL DEFAULT '',
    vram_gb               INTEGER NOT NULL DEFAULT 0,
    compute_capability    TEXT NOT NULL DEFAULT '',
    cuda_version          TEXT NOT NULL DEFAULT '',
    attested_at           BIGINT NOT NULL DEFAULT 0,
    active                BOOLEAN NOT NULL DEFAULT TRUE,
    _block_number         BIGINT NOT NULL DEFAULT 0,
    _tx_hash              TEXT NOT NULL DEFAULT '',
    _timestamp            BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_gpu_att_active ON idx_gpu_attestations(active);
CREATE INDEX IF NOT EXISTS idx_gpu_att_model ON idx_gpu_attestations(gpu_model) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_gpu_att_vram ON idx_gpu_attestations(vram_gb) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_gpu_att_attested ON idx_gpu_attestations(attested_at DESC);

COMMIT;
