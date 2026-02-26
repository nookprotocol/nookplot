/**
 * Contribution scoring engine for the Agent Gateway.
 *
 * Computes a composite 0-12000 score for each agent based on 6 dimensions
 * derived from their commit_log entries over a rolling 30-day window:
 *   - commits_score  (max 2500) — volume of commits
 *   - exec_score     (always 0) — reserved for future use (CI/test results)
 *   - projects_score (max 2000) — breadth across distinct projects
 *   - lines_score    (max 1500) — total lines changed
 *   - collab_score   (max 2000) — unique collaborators worked with
 *   - bounty_score   (max 2000) — bounty completions in rolling window
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
  bounties: number;
}

/**
 * Computes and persists contribution scores for agents.
 *
 * Uses a rolling 30-day window from the current timestamp. All component
 * scores are clamped to their maximum values and summed for the overall
 * score (max 12000).
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

    // 2. Execution score — reserved for future use (CI/test results)
    const execScore = 0;

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

    // 5. Unique collaborators — agents who share a project with this agent.
    //    Counts both fellow collaborators AND project owners (from projects table).
    let collabScore = 0;
    try {
      const collabRes = await this.pool.query<{ count: string }>(
        `SELECT COUNT(DISTINCT other_agent)::text AS count FROM (
           -- Other collaborators on projects I collaborate on
           SELECT pc2.agent_id AS other_agent
           FROM project_collaborators pc1
           JOIN project_collaborators pc2
             ON pc1.project_id = pc2.project_id
            AND pc2.agent_id <> pc1.agent_id
           WHERE pc1.agent_id = $1
           UNION
           -- Owners of projects I collaborate on
           SELECT p.agent_id AS other_agent
           FROM project_collaborators pc
           JOIN projects p ON p.id = pc.project_id
           WHERE pc.agent_id = $1 AND p.agent_id <> $1
           UNION
           -- Collaborators on projects I own
           SELECT pc.agent_id AS other_agent
           FROM projects p
           JOIN project_collaborators pc ON pc.project_id = p.id
           WHERE p.agent_id = $1 AND pc.agent_id <> $1
         ) sub`,
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

    // 6. Bounty completions in the last 30 days
    let bountyScore = 0;
    try {
      const bountyRes = await this.pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM bounty_completions
         WHERE completer_id = $1
           AND completed_at >= NOW() - INTERVAL '30 days'`,
        [agentId],
      );
      const bountyCount = parseInt(bountyRes.rows[0]?.count ?? "0", 10);
      bountyScore = Math.round(Math.min(bountyCount / 5, 1) * 2000);
    } catch {
      // bounty_completions table may not exist yet — default to 0
      bountyScore = 0;
    }

    const overallScore =
      commitsScore + execScore + projectsScore + linesScore + collabScore + bountyScore;

    return {
      overallScore,
      commits: commitsScore,
      exec: execScore,
      projects: projectsScore,
      lines: linesScore,
      collab: collabScore,
      bounties: bountyScore,
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
           commits_score, exec_score, projects_score, lines_score, collab_score, bounty_score,
           computed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         ON CONFLICT (agent_id) DO UPDATE SET
           address = EXCLUDED.address,
           overall_score = EXCLUDED.overall_score,
           commits_score = EXCLUDED.commits_score,
           exec_score = EXCLUDED.exec_score,
           projects_score = EXCLUDED.projects_score,
           lines_score = EXCLUDED.lines_score,
           collab_score = EXCLUDED.collab_score,
           bounty_score = EXCLUDED.bounty_score,
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
          score.bounties,
        ],
      );

      scored++;
    }

    return scored;
  }
}
