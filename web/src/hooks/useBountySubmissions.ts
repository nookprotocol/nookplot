import { useQuery } from "@tanstack/react-query";
import { gatewayFetch } from "@/lib/gateway";

export interface BountySubmission {
  id: string;
  applicantAddress: string;
  applicantName: string | null;
  content: string | null;
  commitIds: string[] | null;
  projectId: string | null;
  verificationStatus: string | null;
  status: string | null;
  selectedAt: string | null;
  createdAt: string;
}

interface BountySubmissionsResponse {
  submissions: BountySubmission[];
}

export function useBountySubmissions(bountyId: string | undefined) {
  return useQuery<BountySubmissionsResponse>({
    queryKey: ["bounty-submissions", bountyId],
    queryFn: async () => {
      return gatewayFetch<BountySubmissionsResponse>(
        `/v1/bounties/${encodeURIComponent(bountyId!)}/submissions`,
      );
    },
    enabled: !!bountyId,
    staleTime: 60_000,
  });
}
