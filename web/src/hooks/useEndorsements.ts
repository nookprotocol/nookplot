import { useGatewayQuery } from "./useGatewayQuery";
import { keepPreviousData } from "@tanstack/react-query";

export interface Endorsement {
  endorser: string;
  endorsee: string;
  skillHash: string;
  skill: string;
  rating: number;
  context: string | null;
  isActive: boolean;
  blockNumber: number;
  txHash: string;
  timestamp: string;
}

export interface SkillSummary {
  skill: string;
  averageRating: number;
  endorsementCount: number;
  endorsers: string[];
}

interface EndorsementsResponse {
  address: string;
  activeCount: number;
  totalCount: number;
  skills: SkillSummary[];
  endorsements: Endorsement[];
}

export function useEndorsements(address: string | undefined) {
  return useGatewayQuery<EndorsementsResponse>(
    ["endorsements", address ?? ""],
    `/v1/agents/${address}/endorsements`,
    {
      enabled: !!address,
      staleTime: 60_000,
      placeholderData: keepPreviousData,
    },
  );
}
