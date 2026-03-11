import type { LogDescription } from "ethers";
import { ensureAgent, type MappingContext } from "./types.js";

export async function handleAgentRegistered(ctx: MappingContext, parsed: LogDescription) {
  const agent = parsed.args[0].toLowerCase(); // indexed address
  const didCid = parsed.args[1] as string;
  const timestamp = Number(parsed.args[2]);

  await ctx.client.query(
    `INSERT INTO idx_agents (id, did_cid, registered_at, updated_at, is_active, _block_number)
     VALUES ($1, $2, $3, $3, TRUE, $4)
     ON CONFLICT (id) DO UPDATE SET
       did_cid = EXCLUDED.did_cid,
       registered_at = CASE WHEN idx_agents.registered_at = 0 THEN EXCLUDED.registered_at ELSE idx_agents.registered_at END,
       updated_at = EXCLUDED.updated_at,
       is_active = TRUE,
       _block_number = EXCLUDED._block_number`,
    [agent, didCid, timestamp, ctx.blockNumber],
  );

  // Increment total agents only if this is a new agent (registered_at was 0)
  await ctx.client.query(
    `UPDATE idx_global_stats SET total_agents = total_agents + 1, _block_number = $1
     WHERE id = 1 AND NOT EXISTS (
       SELECT 1 FROM idx_agents WHERE id = $2 AND registered_at != 0 AND registered_at != $3
     )`,
    [ctx.blockNumber, agent, timestamp],
  );
}

export async function handleAgentUpdated(ctx: MappingContext, parsed: LogDescription) {
  const agent = parsed.args[0].toLowerCase();
  const didCid = parsed.args[1] as string;
  // args[2] = previousCid (unused)
  const timestamp = Number(parsed.args[3]);

  await ensureAgent(ctx.client, agent, ctx.blockNumber);
  await ctx.client.query(
    `UPDATE idx_agents SET did_cid = $1, updated_at = $2, _block_number = $3 WHERE id = $4`,
    [didCid, timestamp, ctx.blockNumber, agent],
  );
}

export async function handleAgentVerificationChanged(ctx: MappingContext, parsed: LogDescription) {
  const agent = parsed.args[0].toLowerCase();
  const isVerified = parsed.args[1] as boolean;

  await ensureAgent(ctx.client, agent, ctx.blockNumber);
  await ctx.client.query(
    `UPDATE idx_agents SET is_verified = $1, _block_number = $2 WHERE id = $3`,
    [isVerified, ctx.blockNumber, agent],
  );
}

export async function handleAgentDeactivated(ctx: MappingContext, parsed: LogDescription) {
  const agent = parsed.args[0].toLowerCase();

  await ensureAgent(ctx.client, agent, ctx.blockNumber);
  await ctx.client.query(
    `UPDATE idx_agents SET is_active = FALSE, _block_number = $1 WHERE id = $2`,
    [ctx.blockNumber, agent],
  );
}

export async function handleAgentReactivated(ctx: MappingContext, parsed: LogDescription) {
  const agent = parsed.args[0].toLowerCase();

  await ensureAgent(ctx.client, agent, ctx.blockNumber);
  await ctx.client.query(
    `UPDATE idx_agents SET is_active = TRUE, _block_number = $1 WHERE id = $2`,
    [ctx.blockNumber, agent],
  );
}

export async function handleAgentStaked(ctx: MappingContext, parsed: LogDescription) {
  const agent = parsed.args[0].toLowerCase();
  const newTotal = parsed.args[2].toString(); // totalStaked

  await ensureAgent(ctx.client, agent, ctx.blockNumber);
  await ctx.client.query(
    `UPDATE idx_agents SET staked_amount = $1, _block_number = $2 WHERE id = $3`,
    [newTotal, ctx.blockNumber, agent],
  );
}

export async function handleAgentUnstaked(ctx: MappingContext, parsed: LogDescription) {
  const agent = parsed.args[0].toLowerCase();
  const remaining = parsed.args[2].toString(); // remainingStake

  await ensureAgent(ctx.client, agent, ctx.blockNumber);
  await ctx.client.query(
    `UPDATE idx_agents SET staked_amount = $1, _block_number = $2 WHERE id = $3`,
    [remaining, ctx.blockNumber, agent],
  );
}

export async function handleAgentSlashed(ctx: MappingContext, parsed: LogDescription) {
  const agent = parsed.args[0].toLowerCase();
  const remaining = parsed.args[2].toString(); // remainingStake

  await ensureAgent(ctx.client, agent, ctx.blockNumber);
  await ctx.client.query(
    `UPDATE idx_agents SET staked_amount = $1, _block_number = $2 WHERE id = $3`,
    [remaining, ctx.blockNumber, agent],
  );
}

export async function handleAgentTypeSet(ctx: MappingContext, parsed: LogDescription) {
  const agent = parsed.args[0].toLowerCase();
  const agentType = Number(parsed.args[1]);

  await ensureAgent(ctx.client, agent, ctx.blockNumber);
  await ctx.client.query(
    `UPDATE idx_agents SET agent_type = $1, _block_number = $2 WHERE id = $3`,
    [agentType, ctx.blockNumber, agent],
  );
}
