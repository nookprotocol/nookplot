/**
 * Hooks for bounty application lifecycle (apply, approve, reject, list).
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { gatewayFetch } from "@/hooks/useSandboxFiles";
import { GATEWAY_URL } from "@/config/constants";

export interface BountyApplication {
  id: string;
  onchainBountyId: number;
  applicantId: string;
  applicantAddress: string;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  message: string | null;
  resolvedAt: string | null;
  createdAt: string;
  applicantName: string | null;
}

interface ApplicationsResponse {
  applications: BountyApplication[];
  first: number;
  skip: number;
}

interface MyApplication extends BountyApplication {
  creatorAddress: string;
  submissionStatus: string | null;
}

interface MyApplicationsResponse {
  applications: MyApplication[];
  first: number;
  skip: number;
}

/** List applications for a bounty (public) */
export function useBountyApplications(bountyId: string | undefined) {
  return useQuery<ApplicationsResponse>({
    queryKey: ["bounty-applications", bountyId],
    queryFn: async () => {
      const res = await fetch(`${GATEWAY_URL}/v1/bounties/${bountyId}/applications?first=100`, {
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error(`Failed to fetch applications: ${res.status}`);
      return res.json();
    },
    enabled: !!bountyId,
    staleTime: 30_000,
  });
}

/** Apply to work on a bounty */
export function useApplyToBounty() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ bountyId, message }: { bountyId: string; message: string }) => {
      const res = await gatewayFetch(`/v1/bounties/${bountyId}/apply`, {
        method: "POST",
        body: JSON.stringify({ message }),
      });
      return res.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["bounty-applications", variables.bountyId] });
      queryClient.invalidateQueries({ queryKey: ["my-bounty-applications"] });
    },
  });
}

/** Approve an application (creator only) */
export function useApproveApplication() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ bountyId, appId }: { bountyId: string; appId: string }) => {
      const res = await gatewayFetch(`/v1/bounties/${bountyId}/applications/${appId}/approve`, {
        method: "POST",
      });
      return res.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["bounty-applications", variables.bountyId] });
    },
  });
}

/** Reject an application (creator only) */
export function useRejectApplication() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ bountyId, appId }: { bountyId: string; appId: string }) => {
      const res = await gatewayFetch(`/v1/bounties/${bountyId}/applications/${appId}/reject`, {
        method: "POST",
      });
      return res.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["bounty-applications", variables.bountyId] });
    },
  });
}

/** View own applications (authenticated) */
export function useMyBountyApplications() {
  return useQuery<MyApplicationsResponse>({
    queryKey: ["my-bounty-applications"],
    queryFn: async () => {
      const res = await gatewayFetch("/v1/agents/me/bounty-applications?first=100");
      return res.json();
    },
    staleTime: 30_000,
  });
}
