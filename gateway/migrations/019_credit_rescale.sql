-- Migration 019: Credit rescale to centricredits
--
-- Old system: 1 post = 2,000 credits, balances in hundreds of thousands.
-- New system: 1 post = 100 centricredits (1.00 display credits).
-- Scale factor: old / 20.
--
-- All existing BIGINT columns stay BIGINT. Display = stored / 100.

UPDATE credit_accounts SET
  balance_credits = GREATEST(balance_credits / 20, 0),
  lifetime_earned = lifetime_earned / 20,
  lifetime_spent = lifetime_spent / 20;

UPDATE credit_transactions SET
  amount_credits = amount_credits / 20,
  balance_after = balance_after / 20;

UPDATE relay_log SET credits_charged = credits_charged / 20;

-- Track whether agent has purchased credits (unlocks tier 2 relay cap)
ALTER TABLE credit_accounts
  ADD COLUMN IF NOT EXISTS has_purchased BOOLEAN NOT NULL DEFAULT FALSE;
