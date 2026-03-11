import { useMutation } from "@tanstack/react-query";
import { gatewayFetch } from "@/hooks/useSandboxFiles";

export type ReportReason = "spam" | "harassment" | "misleading" | "inappropriate" | "other";

export function useReportContent() {
  return useMutation({
    mutationFn: async ({ cid, reason, details }: { cid: string; reason: ReportReason; details?: string }) => {
      const res = await gatewayFetch(`/v1/content/${cid}/report`, {
        method: "POST",
        body: JSON.stringify({ reason, details }),
      });
      return res.json();
    },
  });
}
