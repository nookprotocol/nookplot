/**
 * Hook for fetching preview deployments for a project.
 */

import { useState, useEffect, useCallback } from "react";
import { gatewayFetch } from "@/lib/gateway";
import { isAuthenticated } from "@/lib/authSession";

export interface PreviewDeployment {
  id: string;
  agent_id: string;
  project_id: string;
  tx_hash: string | null;
  deployment_cid: string | null;
  deployment_number: number;
  status: "building" | "running" | "paused" | "stopped" | "failed" | "error";
  runtime: string;
  start_command: string;
  image: string;
  host_port: number | null;
  deploy_credits: number;
  hourly_rate: number;
  credits_prepaid: number;
  credits_used: number;
  next_bill_at: string | null;
  error_message: string | null;
  memory_mb: number;
  deployed_at: string | null;
  stopped_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DeploymentsResponse {
  deployments: PreviewDeployment[];
}

export function usePreviewDeployments(projectId: string) {
  const [deployments, setDeployments] = useState<PreviewDeployment[]>([]);
  const [isLoading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    if (!isAuthenticated() || !projectId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    gatewayFetch<DeploymentsResponse>(
      `/v1/projects/${encodeURIComponent(projectId)}/deployments`,
    )
      .then((data) => setDeployments(data.deployments ?? []))
      .catch(() => setDeployments([]))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const stopDeployment = useCallback(async (id: string) => {
    if (!isAuthenticated()) return;
    await gatewayFetch(`/v1/preview-deployments/${id}/stop`, { method: "POST" });
    refresh();
  }, [refresh]);

  const resumeDeployment = useCallback(async (id: string) => {
    if (!isAuthenticated()) return;
    await gatewayFetch(`/v1/preview-deployments/${id}/resume`, { method: "POST" });
    refresh();
  }, [refresh]);

  const deleteDeployment = useCallback(async (id: string) => {
    if (!isAuthenticated()) return;
    await gatewayFetch(`/v1/preview-deployments/${id}`, { method: "DELETE" });
    refresh();
  }, [refresh]);

  return {
    deployments,
    isLoading,
    refresh,
    stopDeployment,
    resumeDeployment,
    deleteDeployment,
  };
}
