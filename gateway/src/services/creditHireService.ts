/**
 * Credit-based hiring service for off-chain marketplace agreements.
 *
 * Manages the lifecycle of credit-based agreements: create → accept → deliver → complete.
 * All credit operations use DB transactions for atomicity.
 *
 * @module services/creditHireService
 */

import type pg from "pg";
import { logSecurityEvent } from "../middleware/auditLog.js";

export interface CreditAgreement {
  id: string;
  listing_id: number;
  buyer_agent_id: string;
  provider_agent_id: string | null;
  credit_amount: number;
  terms: string;
  status: string;
  delivery_notes: string | null;
  dispute_reason: string | null;
  created_at: Date;
  accepted_at: Date | null;
  delivered_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  updated_at: Date;
}

export class CreditHireService {
  constructor(private pool: pg.Pool) {}

  /**
   * Create a credit-based agreement.
   * Atomically deducts credits from buyer and creates the agreement record.
   */
  async createAgreement(
    listingId: number,
    buyerAgentId: string,
    terms: string,
    creditAmount: number,
  ): Promise<CreditAgreement> {
    if (creditAmount <= 0) {
      throw new Error("Credit amount must be positive");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Verify listing exists and get provider
      const { rows: listingRows } = await client.query<{ provider_address: string }>(
        `SELECT provider FROM idx_service_listings WHERE listing_id = $1 AND active = true`,
        [listingId],
      );

      // Fallback: check cached marketplace listings if idx table not available
      let providerAddress: string | null = null;
      if (listingRows.length > 0) {
        providerAddress = listingRows[0].provider_address;
      }

      // Block self-hiring
      if (providerAddress) {
        const { rows: providerAgent } = await client.query<{ id: string }>(
          `SELECT id FROM agents WHERE LOWER(address) = LOWER($1)`,
          [providerAddress],
        );
        if (providerAgent.length > 0 && providerAgent[0].id === buyerAgentId) {
          await client.query("ROLLBACK");
          throw new Error("SELF_HIRE_BLOCKED");
        }
      }

      // Check buyer has sufficient credits
      const { rows: creditRows } = await client.query<{ balance_credits: string }>(
        `SELECT balance_credits FROM credit_accounts WHERE agent_id = $1 FOR UPDATE`,
        [buyerAgentId],
      );

      if (creditRows.length === 0) {
        await client.query("ROLLBACK");
        throw new Error("ACCOUNT_NOT_FOUND");
      }

      const balance = Number(creditRows[0].balance_credits);
      if (balance < creditAmount) {
        await client.query("ROLLBACK");
        throw new Error("INSUFFICIENT_CREDITS");
      }

      // Deduct credits from buyer (held in escrow)
      await client.query(
        `UPDATE credit_accounts
         SET balance_credits = balance_credits - $1, lifetime_spent = lifetime_spent + $1, updated_at = NOW()
         WHERE agent_id = $2`,
        [creditAmount, buyerAgentId],
      );

      // Record the credit transaction
      await client.query(
        `INSERT INTO credit_transactions (agent_id, amount_credits, balance_after, type, reference_id)
         VALUES ($1, $2, $3, 'credit_hire_escrow', $4)`,
        [buyerAgentId, -creditAmount, balance - creditAmount, `listing_${listingId}`],
      );

      // Create the agreement
      const { rows: agreement } = await client.query<CreditAgreement>(
        `INSERT INTO credit_agreements (listing_id, buyer_agent_id, credit_amount, terms, status)
         VALUES ($1, $2, $3, $4, 'pending')
         RETURNING *`,
        [listingId, buyerAgentId, creditAmount, terms],
      );

      await client.query("COMMIT");

      logSecurityEvent("info", "credit-agreement-created", {
        agreementId: agreement[0].id,
        buyerAgentId,
        listingId,
        creditAmount,
      });

      return agreement[0];
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Provider accepts the agreement. */
  async acceptAgreement(id: string, providerAgentId: string): Promise<CreditAgreement> {
    const { rows } = await this.pool.query<CreditAgreement>(
      `UPDATE credit_agreements
       SET provider_agent_id = $1, status = 'accepted', accepted_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND status = 'pending'
       RETURNING *`,
      [providerAgentId, id],
    );

    if (rows.length === 0) {
      throw new Error("Agreement not found or not in pending status");
    }

    return rows[0];
  }

  /** Provider delivers work. */
  async deliverWork(id: string, providerAgentId: string, notes: string): Promise<CreditAgreement> {
    const { rows } = await this.pool.query<CreditAgreement>(
      `UPDATE credit_agreements
       SET status = 'delivered', delivery_notes = $1, delivered_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND provider_agent_id = $3 AND status = 'accepted'
       RETURNING *`,
      [notes, id, providerAgentId],
    );

    if (rows.length === 0) {
      throw new Error("Agreement not found or not in accepted status");
    }

    return rows[0];
  }

  /**
   * Buyer approves delivery — credits released to provider.
   */
  async completeAgreement(id: string, buyerAgentId: string): Promise<CreditAgreement> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query<CreditAgreement>(
        `SELECT * FROM credit_agreements WHERE id = $1 AND buyer_agent_id = $2 AND status = 'delivered' FOR UPDATE`,
        [id, buyerAgentId],
      );

      if (rows.length === 0) {
        await client.query("ROLLBACK");
        throw new Error("Agreement not found or not in delivered status");
      }

      const agreement = rows[0];

      if (!agreement.provider_agent_id) {
        await client.query("ROLLBACK");
        throw new Error("No provider assigned");
      }

      // Credit the provider
      // First ensure provider has a credit account
      await client.query(
        `INSERT INTO credit_accounts (agent_id, balance_credits, lifetime_earned)
         VALUES ($1, 0, 0)
         ON CONFLICT (agent_id) DO NOTHING`,
        [agreement.provider_agent_id],
      );

      await client.query(
        `UPDATE credit_accounts
         SET balance_credits = balance_credits + $1, lifetime_earned = lifetime_earned + $1, updated_at = NOW()
         WHERE agent_id = $2`,
        [agreement.credit_amount, agreement.provider_agent_id],
      );

      // Get provider balance for transaction record
      const { rows: provBalRows } = await client.query<{ balance_credits: string }>(
        `SELECT balance_credits FROM credit_accounts WHERE agent_id = $1`,
        [agreement.provider_agent_id],
      );

      await client.query(
        `INSERT INTO credit_transactions (agent_id, amount_credits, balance_after, type, reference_id)
         VALUES ($1, $2, $3, 'credit_hire_payment', $4)`,
        [agreement.provider_agent_id, agreement.credit_amount,
         Number(provBalRows[0]?.balance_credits ?? 0), `agreement_${id}`],
      );

      // Update agreement status
      const { rows: updated } = await client.query<CreditAgreement>(
        `UPDATE credit_agreements
         SET status = 'completed', completed_at = NOW(), updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [id],
      );

      await client.query("COMMIT");

      logSecurityEvent("info", "credit-agreement-completed", {
        agreementId: id,
        providerAgentId: agreement.provider_agent_id,
        creditAmount: agreement.credit_amount,
      });

      return updated[0];
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Cancel agreement — refunds credits to buyer (only before delivery). */
  async cancelAgreement(id: string, agentId: string): Promise<CreditAgreement> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query<CreditAgreement>(
        `SELECT * FROM credit_agreements
         WHERE id = $1 AND (buyer_agent_id = $2 OR provider_agent_id = $2)
         AND status IN ('pending', 'accepted')
         FOR UPDATE`,
        [id, agentId],
      );

      if (rows.length === 0) {
        await client.query("ROLLBACK");
        throw new Error("Agreement not found or cannot be cancelled");
      }

      const agreement = rows[0];

      // Refund buyer
      await client.query(
        `UPDATE credit_accounts
         SET balance_credits = balance_credits + $1, lifetime_spent = lifetime_spent - $1, updated_at = NOW()
         WHERE agent_id = $2`,
        [agreement.credit_amount, agreement.buyer_agent_id],
      );

      const { rows: buyerBalRows } = await client.query<{ balance_credits: string }>(
        `SELECT balance_credits FROM credit_accounts WHERE agent_id = $1`,
        [agreement.buyer_agent_id],
      );

      await client.query(
        `INSERT INTO credit_transactions (agent_id, amount_credits, balance_after, type, reference_id)
         VALUES ($1, $2, $3, 'credit_hire_refund', $4)`,
        [agreement.buyer_agent_id, agreement.credit_amount,
         Number(buyerBalRows[0]?.balance_credits ?? 0), `agreement_${id}`],
      );

      const { rows: updated } = await client.query<CreditAgreement>(
        `UPDATE credit_agreements
         SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [id],
      );

      await client.query("COMMIT");

      return updated[0];
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Dispute agreement — flags for review. */
  async disputeAgreement(id: string, agentId: string, reason: string): Promise<CreditAgreement> {
    const { rows } = await this.pool.query<CreditAgreement>(
      `UPDATE credit_agreements
       SET status = 'disputed', dispute_reason = $1, updated_at = NOW()
       WHERE id = $2 AND (buyer_agent_id = $3 OR provider_agent_id = $3)
       AND status IN ('accepted', 'delivered')
       RETURNING *`,
      [reason, id, agentId],
    );

    if (rows.length === 0) {
      throw new Error("Agreement not found or cannot be disputed");
    }

    return rows[0];
  }

  /** Get agreements for an agent (as buyer or provider). */
  async getAgreements(agentId: string, role?: "buyer" | "provider"): Promise<CreditAgreement[]> {
    let query = `SELECT * FROM credit_agreements WHERE `;
    const params: unknown[] = [agentId];

    if (role === "buyer") {
      query += `buyer_agent_id = $1`;
    } else if (role === "provider") {
      query += `provider_agent_id = $1`;
    } else {
      query += `(buyer_agent_id = $1 OR provider_agent_id = $1)`;
    }

    query += ` ORDER BY created_at DESC`;

    const { rows } = await this.pool.query<CreditAgreement>(query, params);
    return rows;
  }

  /** Get a single agreement by ID. */
  async getAgreementDetail(id: string): Promise<CreditAgreement | null> {
    const { rows } = await this.pool.query<CreditAgreement>(
      `SELECT * FROM credit_agreements WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }
}
