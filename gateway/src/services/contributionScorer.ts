/**
 * Contribution scoring engine for the Agent Gateway.
 *
 * Computes a composite 0-10000 score for each agent based on 5 dimensions
 * derived from their commit_log entries over a rolling 30-day window:
 *   - commits_score  (max 2500) — volume of commits
 *   - exec_score     (max 2000) — execution success rate
 *   - projects_score (max 2000) — breadth across distinct projects
 *   - lines_score    (max 1500) — total lines changed
 *   - collab_score   (max 2000) — unique collaborators worked with
 *
 * All queries use parameterized SQL to prevent injection.
 *
 * @module services/contributionScorer
 */

import type { Pool } from "pg";

/** Result of a single agent's contribution score computation. */
export interface ContributionScoreResult {
  overallScore: number;
  commits: number;
  exec: number;
  projects: number;
  lines: number;
  collab: number;
}

/**
 * Computes and persists contribution scores for agents.
 *
 * Uses a rolling 30-day window from the current timestamp. All component
 * scores are clamped to their maximum values and summed for the overall
 * score (max 10000).
 */
export class ContributionScorer {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Compute the contribution score for a single agent.
   *
   * @param agentId - UUID of the agent from the agents table.
   * @returns The 5-component score breakdown and overall score.
   */
  async computeScore(agentId: string): Promise<ContributionScoreResult> {
    // 1. Commits in the last 30 days
    const commitsRes = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM commit_log
       WHERE agent_id = $1
         AND created_at >= NOW() - INTERVAL '30 days'`,
      [agentId],
    );
    const commits30d = parseInt(commitsRes.rows[0]?.count ?? "0", 10);
    const commitsScore = Math.round(Math.min(commits30d / 50, 1) * 2500);

    // 2. Execution success rate (all-time for the agent)
    const execRes = await this.pool.query<{
      total: string;
      successes: string;
    }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE success = TRUE)::text AS successes
       FROM commit_log
       WHERE agent_id = $1`,
      [agentId],
    );
    const totalCount = parseInt(execRes.rows[0]?.total ?? "0", 10);
    const successCount = parseInt(execRes.rows[0]?.successes ?? "0", 10);
    const execScore =
      totalCount > 0
        ? Math.round((successCount / totalCount) * 2000)
        : 0;

    // 3. Distinct projects in the last 30 days
    const projectsRes = await this.pool.query<{ count: string }>(
      `SELECT COUNT(DISTINCT project_id)::text AS count
       FROM commit_log
       WHERE agent_id = $1
         AND created_at >= NOW() - INTERVAL '30 days'
         AND project_id IS NOT NULL`,
      [agentId],
    );
    const distinctProjects = parseInt(projectsRes.rows[0]?.count ?? "0", 10);
    const projectsScore = Math.round(Math.min(distinctProjects / 5, 1) * 2000);

    // 4. Total lines changed in the last 30 days (added + removed)
    const linesRes = await this.pool.query<{
      added: string;
      removed: string;
    }>(
      `SELECT
         COALESCE(SUM(lines_added), 0)::text AS added,
         COALESCE(SUM(lines_removed), 0)::text AS removed
       FROM commit_log
       WHERE agent_id = $1
         AND created_at >= NOW() - INTERVAL '30 days'`,
      [agentId],
    );
    const totalLines =
      parseInt(linesRes.rows[0]?.added ?? "0", 10) +
      parseInt(linesRes.rows[0]?.removed ?? "0", 10);
    const linesScore = Math.round(Math.min(totalLines / 5000, 1) * 1500);

    // 5. Unique collaborators — agents who share a project with this agent
    //    Uses the project_collaborators table if it exists; defaults to 0
    let collabScore = 0;
    try {
      const collabRes = await this.pool.query<{ count: string }>(
        `SELECT COUNT(DISTINCT pc2.agent_id)::text AS count
         FROM project_collaborators pc1
         JOIN project_collaborators pc2
           ON pc1.project_id = pc2.project_id
          AND pc2.agent_id <> pc1.agent_id
         WHERE pc1.agent_id = $1`,
        [agentId],
      );
      const uniqueCollaborators = parseInt(
        collabRes.rows[0]?.count ?? "0",
        10,
      );
      collabScore = Math.round(Math.min(uniqueCollaborators / 10, 1) * 2000);
    } catch {
      // project_collaborators table may not exist — default to 0
      collabScore = 0;
    }

    const overallScore =
      commitsScore + execScore + projectsScore + linesScore + collabScore;

    return {
      overallScore,
      commits: commitsScore,
      exec: execScore,
      projects: projectsScore,
      lines: linesScore,
      collab: collabScore,
    };
  }

  /**
   * Batch-compute contribution scores for all active agents and UPSERT
   * into the contribution_scores table.
   *
   * @returns The number of agents scored.
   */
  async computeAllScores(): Promise<number> {
    // Get all active agents
    const agentsRes = await this.pool.query<{
      id: string;
      address: string;
    }>(
      `SELECT id, address FROM agents WHERE status = 'active' AND did_cid IS NOT NULL`,
    );

    let scored = 0;

    for (const agent of agentsRes.rows) {
      const score = await this.computeScore(agent.id);

      await this.pool.query(
        `INSERT INTO contribution_scores (
           agent_id, address, overall_score,
           commits_score, exec_score, projects_score, lines_score, collab_score,
           computed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (agent_id) DO UPDATE SET
           address = EXCLUDED.address,
           overall_score = EXCLUDED.overall_score,
           commits_score = EXCLUDED.commits_score,
           exec_score = EXCLUDED.exec_score,
           projects_score = EXCLUDED.projects_score,
           lines_score = EXCLUDED.lines_score,
           collab_score = EXCLUDED.collab_score,
           computed_at = NOW()`,
        [
          agent.id,
          agent.address,
          score.overallScore,
          score.commits,
          score.exec,
          score.projects,
          score.lines,
          score.collab,
        ],
      );

      scored++;
    }

    return scored;
  }
}
