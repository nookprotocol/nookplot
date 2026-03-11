import type { LogDescription } from "ethers";
import type { MappingContext, MappingHandler } from "./types.js";

// ── ServiceListed ──────────────────────────────────────────
export const handleServiceListed: MappingHandler = async (ctx, parsed) => {
  const { listingId, provider, category, metadataCid, priceAmount } = parsed.args;
  await ctx.client.query(
    `INSERT INTO idx_service_listings (listing_id, provider, category, metadata_cid, price_amount, created_at, updated_at, _block_number, _tx_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8)
     ON CONFLICT (listing_id) DO UPDATE SET metadata_cid = $4, updated_at = $6, _block_number = $7`,
    [
      Number(listingId),
      String(provider).toLowerCase(),
      String(category),
      String(metadataCid),
      String(priceAmount),
      ctx.timestamp,
      ctx.blockNumber,
      ctx.transactionHash,
    ],
  );
};

// ── ServiceUpdated ─────────────────────────────────────────
export const handleServiceUpdated: MappingHandler = async (ctx, parsed) => {
  const { listingId, metadataCid, active } = parsed.args;
  await ctx.client.query(
    `UPDATE idx_service_listings SET metadata_cid = $2, active = $3, updated_at = $4, _block_number = $5
     WHERE listing_id = $1`,
    [Number(listingId), String(metadataCid), Boolean(active), ctx.timestamp, ctx.blockNumber],
  );
};

// ── AgreementCreated ───────────────────────────────────────
export const handleAgreementCreated: MappingHandler = async (ctx, parsed) => {
  const { agreementId, listingId, buyer, provider, escrowAmount, tokenAddress } = parsed.args;
  await ctx.client.query(
    `INSERT INTO idx_service_agreements (agreement_id, listing_id, buyer, provider, escrow_amount, token_address, status, created_at, _block_number, _tx_hash)
     VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9)
     ON CONFLICT (agreement_id) DO NOTHING`,
    [
      Number(agreementId),
      Number(listingId),
      String(buyer).toLowerCase(),
      String(provider).toLowerCase(),
      String(escrowAmount),
      String(tokenAddress).toLowerCase(),
      ctx.timestamp,
      ctx.blockNumber,
      ctx.transactionHash,
    ],
  );
};

// ── WorkDelivered ──────────────────────────────────────────
export const handleWorkDelivered: MappingHandler = async (ctx, parsed) => {
  const { agreementId, deliveryCid } = parsed.args;
  await ctx.client.query(
    `UPDATE idx_service_agreements SET status = 2, delivery_cid = $2, _block_number = $3
     WHERE agreement_id = $1`,
    [Number(agreementId), String(deliveryCid), ctx.blockNumber],
  );
};

// ── AgreementSettled ───────────────────────────────────────
export const handleAgreementSettled: MappingHandler = async (ctx, parsed) => {
  const { agreementId } = parsed.args;
  await ctx.client.query(
    `UPDATE idx_service_agreements SET status = 3, settled_at = $2, settlement_method = 'buyer_approved', _block_number = $3
     WHERE agreement_id = $1`,
    [Number(agreementId), ctx.timestamp, ctx.blockNumber],
  );
  // Increment listing counter
  await ctx.client.query(
    `UPDATE idx_service_listings SET total_completed = total_completed + 1, updated_at = $2
     WHERE listing_id = (SELECT listing_id FROM idx_service_agreements WHERE agreement_id = $1)`,
    [Number(agreementId), ctx.timestamp],
  );
};

// ── AgreementDisputed ──────────────────────────────────────
export const handleAgreementDisputed: MappingHandler = async (ctx, parsed) => {
  const { agreementId, disputedBy } = parsed.args;
  // Read pre-dispute status first
  const { rows } = await ctx.client.query<{ status: number }>(
    `SELECT status FROM idx_service_agreements WHERE agreement_id = $1`,
    [Number(agreementId)],
  );
  const preStatus = rows[0]?.status ?? 1;
  await ctx.client.query(
    `UPDATE idx_service_agreements SET status = 4, disputed_at = $2, pre_dispute_status = $3, dispute_initiator = $4, _block_number = $5
     WHERE agreement_id = $1`,
    [Number(agreementId), ctx.timestamp, preStatus, String(disputedBy).toLowerCase(), ctx.blockNumber],
  );
  // Increment listing counter
  await ctx.client.query(
    `UPDATE idx_service_listings SET total_disputed = total_disputed + 1, updated_at = $2
     WHERE listing_id = (SELECT listing_id FROM idx_service_agreements WHERE agreement_id = $1)`,
    [Number(agreementId), ctx.timestamp],
  );
};

// ── DisputeResolved ────────────────────────────────────────
export const handleDisputeResolved: MappingHandler = async (ctx, parsed) => {
  const { agreementId, inFavorOfProvider } = parsed.args;
  const providerWins = Boolean(inFavorOfProvider);
  const newStatus = providerWins ? 3 : 5; // Settled or Cancelled
  const method = providerWins ? "dispute_provider_wins" : "dispute_buyer_wins";
  await ctx.client.query(
    `UPDATE idx_service_agreements SET status = $2, settlement_method = $3, settled_at = CASE WHEN $2 = 3 THEN $4 ELSE settled_at END, _block_number = $5
     WHERE agreement_id = $1`,
    [Number(agreementId), newStatus, method, ctx.timestamp, ctx.blockNumber],
  );
  if (providerWins) {
    await ctx.client.query(
      `UPDATE idx_service_listings SET total_completed = total_completed + 1, updated_at = $2
       WHERE listing_id = (SELECT listing_id FROM idx_service_agreements WHERE agreement_id = $1)`,
      [Number(agreementId), ctx.timestamp],
    );
  }
};

// ── AgreementCancelled ─────────────────────────────────────
export const handleAgreementCancelled: MappingHandler = async (ctx, parsed) => {
  const { agreementId } = parsed.args;
  await ctx.client.query(
    `UPDATE idx_service_agreements SET status = 5, settlement_method = 'cancelled', _block_number = $2
     WHERE agreement_id = $1`,
    [Number(agreementId), ctx.blockNumber],
  );
};

// ── DeliveryExpired (V4) ───────────────────────────────────
export const handleDeliveryExpired: MappingHandler = async (ctx, parsed) => {
  const { agreementId } = parsed.args;
  await ctx.client.query(
    `UPDATE idx_service_agreements SET status = 3, settled_at = $2, settlement_method = 'timeout', _block_number = $3
     WHERE agreement_id = $1`,
    [Number(agreementId), ctx.timestamp, ctx.blockNumber],
  );
  await ctx.client.query(
    `UPDATE idx_service_listings SET total_completed = total_completed + 1, updated_at = $2
     WHERE listing_id = (SELECT listing_id FROM idx_service_agreements WHERE agreement_id = $1)`,
    [Number(agreementId), ctx.timestamp],
  );
};

// ── DisputeExpired (V5) ────────────────────────────────────
export const handleDisputeExpired: MappingHandler = async (ctx, parsed) => {
  const { agreementId, providerWins, cancellationFee } = parsed.args;
  const wins = Boolean(providerWins);
  const newStatus = wins ? 3 : 5; // Settled or Cancelled
  const method = wins ? "dispute_expired_provider" : "dispute_expired_buyer";
  await ctx.client.query(
    `UPDATE idx_service_agreements SET status = $2, settlement_method = $3, cancellation_fee = $4,
     settled_at = CASE WHEN $2 = 3 THEN $5 ELSE settled_at END, _block_number = $6
     WHERE agreement_id = $1`,
    [Number(agreementId), newStatus, method, String(cancellationFee), ctx.timestamp, ctx.blockNumber],
  );
  if (wins) {
    await ctx.client.query(
      `UPDATE idx_service_listings SET total_completed = total_completed + 1, updated_at = $2
       WHERE listing_id = (SELECT listing_id FROM idx_service_agreements WHERE agreement_id = $1)`,
      [Number(agreementId), ctx.timestamp],
    );
  }
};

// ── AgreementCancelledWithFee (V5) ─────────────────────────
export const handleAgreementCancelledWithFee: MappingHandler = async (ctx, parsed) => {
  const { agreementId, cancellationFee } = parsed.args;
  await ctx.client.query(
    `UPDATE idx_service_agreements SET status = 5, settlement_method = 'cancelled_with_fee', cancellation_fee = $2, _block_number = $3
     WHERE agreement_id = $1`,
    [Number(agreementId), String(cancellationFee), ctx.blockNumber],
  );
};
