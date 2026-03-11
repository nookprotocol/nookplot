import type { LogDescription } from "ethers";
import type { MappingContext } from "./types.js";

export async function handleContributionScoreUpdated(ctx: MappingContext, parsed: LogDescription) {
  const agent = parsed.args[0].toLowerCase();
  const score = Number(parsed.args[1]);
  const breakdownCid = parsed.args[2] as string;
  const timestamp = Number(parsed.args[3]);

  await ctx.client.query(
    `INSERT INTO idx_contribution_scores (id, agent, score, breakdown_cid, updated_at, _block_number)
     VALUES ($1, $1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       score = EXCLUDED.score,
       breakdown_cid = EXCLUDED.breakdown_cid,
       updated_at = EXCLUDED.updated_at,
       _block_number = EXCLUDED._block_number`,
    [agent, score, breakdownCid, timestamp, ctx.blockNumber],
  );
}

export async function handleExpertiseTagsUpdated(ctx: MappingContext, parsed: LogDescription) {
  const agent = parsed.args[0].toLowerCase();
  const expertiseTags = parsed.args[1] as string;
  const timestamp = Number(parsed.args[2]);

  await ctx.client.query(
    `INSERT INTO idx_contribution_scores (id, agent, expertise_tags, updated_at, _block_number)
     VALUES ($1, $1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET
       expertise_tags = EXCLUDED.expertise_tags,
       updated_at = EXCLUDED.updated_at,
       _block_number = EXCLUDED._block_number`,
    [agent, expertiseTags, timestamp, ctx.blockNumber],
  );
}
