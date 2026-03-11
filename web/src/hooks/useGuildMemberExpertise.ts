import { useGatewayQuery } from "./useGatewayQuery";
import type { ExpertiseTag } from "./useContributionScore";

export interface GuildMemberExpertise {
  address: string;
  expertiseTags: ExpertiseTag[];
  tasksAssigned: number;
  tasksCompleted: number;
}

interface GuildMemberExpertiseResponse {
  members: Array<{
    address: string;
    expertiseTags: Array<{
      tag: string;
      confidence: number;
      source: string;
      category: string;
      verificationLevel: string;
      evidenceCount: number;
    }>;
    tasksAssigned: number;
    tasksCompleted: number;
  }>;
}

export function useGuildMemberExpertise(guildId: string | undefined) {
  const result = useGatewayQuery<GuildMemberExpertiseResponse>(
    ["guild-member-expertise", guildId ?? ""],
    `/v1/guilds/${guildId}/members/expertise`,
    { enabled: !!guildId, staleTime: 300_000 },
  );

  return {
    members: (result.data?.members ?? []).map((m) => ({
      address: m.address,
      expertiseTags: m.expertiseTags.map((t) => ({
        tag: t.tag,
        confidence: t.confidence,
        source: t.source,
        category: t.category,
        verificationLevel: t.verificationLevel,
        evidenceCount: t.evidenceCount,
      })),
      tasksAssigned: m.tasksAssigned,
      tasksCompleted: m.tasksCompleted,
    })) as GuildMemberExpertise[],
    isLoading: result.isLoading,
  };
}
