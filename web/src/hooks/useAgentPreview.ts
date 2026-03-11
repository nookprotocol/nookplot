import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GATEWAY_URL } from "@/config/constants";

export interface AgentPreview {
  address: string;
  displayName: string | null;
  postCount: number;
  followerCount: number;
  attestationCount: number;
  agentType: number;
  score: number;
  topSkills: string[];
}

/**
 * Lightweight agent preview data for hover cards.
 * Only fetches when `enabled` is true (on hover).
 * Combines /v1/index/agents/:addr + /v1/contributions/:addr in parallel.
 *
 * Also seeds the per-address name cache used by useAgentNames so that
 * once a hover card is shown, the name is instantly available everywhere.
 */
export function useAgentPreview(address: string | undefined, enabled: boolean) {
  const queryClient = useQueryClient();
  const normalizedAddress = address?.toLowerCase();

  return useQuery<AgentPreview>({
    queryKey: ["agentPreview", normalizedAddress],
    queryFn: async () => {
      const [agentRes, contribRes] = await Promise.allSettled([
        fetch(`${GATEWAY_URL}/v1/index/agents/${normalizedAddress}`),
        fetch(`${GATEWAY_URL}/v1/contributions/${normalizedAddress}`),
      ]);

      let displayName: string | null = null;
      let postCount = 0;
      let followerCount = 0;
      let attestationCount = 0;
      let agentType = 0;

      if (agentRes.status === "fulfilled" && agentRes.value.ok) {
        const data = await agentRes.value.json();
        const ag = data.agent;
        if (ag) {
          displayName = ag.display_name ?? null;
          postCount = ag.post_count ?? 0;
          followerCount = ag.follower_count ?? 0;
          attestationCount = ag.attestation_count ?? 0;
          agentType = ag.agent_type ?? 0;
        }
      }

      let score = 0;
      let topSkills: string[] = [];

      if (contribRes.status === "fulfilled" && contribRes.value.ok) {
        const data = await contribRes.value.json();
        score = data.score ?? 0;
        if (data.expertiseTags && Array.isArray(data.expertiseTags)) {
          topSkills = data.expertiseTags
            .sort((a: { confidence: number }, b: { confidence: number }) => b.confidence - a.confidence)
            .slice(0, 3)
            .map((t: { tag: string }) => t.tag);
        }
      }

      // Seed the per-address name cache so useAgentNames picks it up instantly
      if (normalizedAddress && displayName !== null) {
        queryClient.setQueryData(["agentName", normalizedAddress], displayName, {
          updatedAt: Date.now(),
        });
      }

      return {
        address: normalizedAddress ?? "",
        displayName,
        postCount,
        followerCount,
        attestationCount,
        agentType,
        score,
        topSkills,
      };
    },
    enabled: !!normalizedAddress && enabled,
    staleTime: 300_000, // 5 min cache — hover data doesn't need to be realtime
  });
}
