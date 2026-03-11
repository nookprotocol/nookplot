import type { MappingHandler } from "./types.js";

// ── AttestationSubmitted ─────────────────────────────────────
export const handleAttestationSubmitted: MappingHandler = async (ctx, parsed) => {
  const { provider, benchmarkHash, gpuModel, vramGb, computeCapability, cudaVersion } = parsed.args;
  await ctx.client.query(
    `INSERT INTO idx_gpu_attestations
       (provider_address, benchmark_hash, gpu_model, vram_gb, compute_capability,
        cuda_version, attested_at, active, _block_number, _tx_hash, _timestamp)
     VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $9, $7)
     ON CONFLICT (provider_address) DO UPDATE SET
       benchmark_hash = $2,
       gpu_model = $3,
       vram_gb = $4,
       compute_capability = $5,
       cuda_version = $6,
       attested_at = $7,
       active = TRUE,
       _block_number = $8,
       _tx_hash = $9,
       _timestamp = $7`,
    [
      String(provider).toLowerCase(),
      String(benchmarkHash),
      String(gpuModel),
      Number(vramGb),
      String(computeCapability),
      String(cudaVersion),
      ctx.timestamp,
      ctx.blockNumber,
      ctx.transactionHash,
    ],
  );
};

// ── AttestationUpdated ───────────────────────────────────────
export const handleAttestationUpdated: MappingHandler = async (ctx, parsed) => {
  const { provider, benchmarkHash } = parsed.args;
  await ctx.client.query(
    `UPDATE idx_gpu_attestations SET
       benchmark_hash = $2,
       attested_at = $3,
       _block_number = $4,
       _tx_hash = $5,
       _timestamp = $3
     WHERE provider_address = $1`,
    [
      String(provider).toLowerCase(),
      String(benchmarkHash),
      ctx.timestamp,
      ctx.blockNumber,
      ctx.transactionHash,
    ],
  );
};

// ── AttestationRevoked ───────────────────────────────────────
export const handleAttestationRevoked: MappingHandler = async (ctx, parsed) => {
  const { provider } = parsed.args;
  await ctx.client.query(
    `UPDATE idx_gpu_attestations SET
       active = FALSE,
       _block_number = $2,
       _tx_hash = $3,
       _timestamp = $4
     WHERE provider_address = $1`,
    [
      String(provider).toLowerCase(),
      ctx.blockNumber,
      ctx.transactionHash,
      ctx.timestamp,
    ],
  );
};
