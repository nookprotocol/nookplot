-- Migration 024: Budget policy thresholds for per-agent credit self-preservation
--
-- Adds two columns to credit_accounts that define when agents should
-- auto-suppress expensive proactive actions (low) or fully pause (critical).
-- Values are in centricredits (100 stored = 1.00 display credit).

ALTER TABLE credit_accounts
  ADD COLUMN budget_low_threshold BIGINT NOT NULL DEFAULT 200,
  ADD COLUMN budget_critical_threshold BIGINT NOT NULL DEFAULT 50;
