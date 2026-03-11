/**
 * TanStack Query hooks for intent CRUD operations.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useGatewayQuery } from "./useGatewayQuery";
import { gatewayFetch } from "./useSandboxFiles";

/* ---------- Types ---------- */

export interface Intent {
  id: string;
  creator_id: string;
  creator_address: string;
  title: string;
  description: string;
  required_skills: string[];
  budget_amount: string;
  budget_token: string | null;
  deadline: string | null;
  category: string | null;
  tags: string[];
  status: string;
  metadata: Record<string, unknown>;
  accepted_proposal_id: string | null;
  agreement_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface IntentProposal {
  id: string;
  intent_id: string;
  proposer_id: string;
  proposer_address: string;
  description: string;
  approach: string | null;
  estimated_cost: string;
  estimated_duration_hours: number | null;
  status: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/* ---------- Helpers ---------- */

async function gatewayJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await gatewayFetch(path, {
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json() as Promise<T>;
}

/* ---------- List / search ---------- */

export function useIntents(
  status = "",
  category = "",
  q = "",
  page = 0,
  pageSize = 20,
) {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (category) params.set("category", category);
  if (q) params.set("q", q);
  params.set("limit", String(pageSize));
  params.set("offset", String(page * pageSize));

  const result = useGatewayQuery<{ intents: Intent[]; total: number }>(
    ["intents", status, category, q, String(page)],
    `/v1/intents?${params}`,
    { staleTime: 60_000 },
  );

  return {
    intents: result.data?.intents ?? [],
    total: result.data?.total ?? 0,
    isLoading: result.isLoading,
    isError: result.isError,
  };
}

/* ---------- Detail ---------- */

export function useIntent(id: string | undefined) {
  const result = useGatewayQuery<Intent>(
    ["intent", id ?? ""],
    `/v1/intents/${id}`,
    { enabled: !!id, staleTime: 30_000 },
  );

  return {
    intent: result.data ?? null,
    isLoading: result.isLoading,
  };
}

/* ---------- Proposals ---------- */

export function useIntentProposals(intentId: string | undefined) {
  const result = useGatewayQuery<{ proposals: IntentProposal[] }>(
    ["intent-proposals", intentId ?? ""],
    `/v1/intents/${intentId}/proposals`,
    { enabled: !!intentId, staleTime: 30_000 },
  );

  return {
    proposals: result.data?.proposals ?? [],
    isLoading: result.isLoading,
  };
}

/* ---------- Create intent ---------- */

export function useCreateIntent() {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (data: {
      title: string;
      description: string;
      requiredSkills?: string[];
      budgetAmount?: number;
      deadline?: string;
      category?: string;
      tags?: string[];
    }) => gatewayJson<Intent>("POST", "/v1/intents", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["intents"] });
    },
  });

  return {
    createIntent: mutation.mutate,
    isPending: mutation.isPending,
    isSuccess: mutation.isSuccess,
    error: mutation.error,
  };
}

/* ---------- Submit proposal ---------- */

export function useSubmitProposal(intentId: string) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (data: {
      description: string;
      approach?: string;
      estimatedCost?: number;
      estimatedDurationHours?: number;
    }) => gatewayJson<IntentProposal>("POST", `/v1/intents/${intentId}/proposals`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["intent-proposals", intentId] });
    },
  });

  return {
    submitProposal: mutation.mutate,
    isPending: mutation.isPending,
    error: mutation.error,
  };
}

/* ---------- Accept proposal ---------- */

export function useAcceptProposal(intentId: string) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (proposalId: string) =>
      gatewayJson<{ intent: Intent; proposal: IntentProposal }>(
        "POST",
        `/v1/intents/${intentId}/proposals/${proposalId}/accept`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["intent", intentId] });
      qc.invalidateQueries({ queryKey: ["intent-proposals", intentId] });
    },
  });

  return {
    acceptProposal: mutation.mutate,
    isPending: mutation.isPending,
    error: mutation.error,
  };
}

/* ---------- Cancel intent ---------- */

export function useCancelIntent() {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (intentId: string) =>
      gatewayJson<Intent>("POST", `/v1/intents/${intentId}/cancel`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["intents"] });
    },
  });

  return {
    cancelIntent: mutation.mutate,
    isPending: mutation.isPending,
  };
}

/* ---------- Complete intent ---------- */

export function useCompleteIntent() {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (intentId: string) =>
      gatewayJson<Intent>("POST", `/v1/intents/${intentId}/complete`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["intents"] });
    },
  });

  return {
    completeIntent: mutation.mutate,
    isPending: mutation.isPending,
  };
}
