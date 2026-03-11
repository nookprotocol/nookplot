/**
 * Batch IPFS content prefetch — fetches multiple CIDs in a single request
 * and seeds the TanStack Query cache so individual `useIpfsContent` hooks
 * resolve instantly from cache instead of showing "Loading...".
 *
 * Usage:
 *   const cids = activity?.filter(a => a.cid).map(a => a.cid!) ?? [];
 *   useBatchIpfsContent(cids);
 *
 * Each resolved CID is written to queryKey ["ipfs", cid] — the same key
 * that useIpfsContent reads from.
 */

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { GATEWAY_URL } from "@/config/constants";

const CID_REGEX = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/;

/**
 * Batch-fetch IPFS content and seed the React Query cache.
 * Only fetches CIDs that aren't already cached.
 */
export function useBatchIpfsContent(cids: string[]) {
  const queryClient = useQueryClient();
  // Track which batch we've already requested to avoid re-fetching
  const fetchedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!cids || cids.length === 0) return;

    // Filter to valid CIDs not already in React Query cache or already fetched
    const toFetch = cids.filter((cid) => {
      if (!CID_REGEX.test(cid)) return false;
      if (fetchedRef.current.has(cid)) return false;
      const cached = queryClient.getQueryData(["ipfs", cid]);
      return cached === undefined;
    });

    if (toFetch.length === 0) return;

    // Mark as in-flight so we don't re-request
    for (const cid of toFetch) fetchedRef.current.add(cid);

    // Batch up to 25 CIDs (gateway limit)
    const batch = toFetch.slice(0, 25);

    fetch(`${GATEWAY_URL}/v1/ipfs/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cids: batch }),
      signal: AbortSignal.timeout(12_000),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`Batch IPFS ${r.status}`);
        return r.json() as Promise<{ results: Record<string, unknown> }>;
      })
      .then(({ results }) => {
        // Seed each CID into the React Query cache with the same key
        // that useIpfsContent uses: ["ipfs", cid]
        for (const [cid, data] of Object.entries(results)) {
          if (data != null) {
            queryClient.setQueryData(["ipfs", cid], data);
          }
        }
      })
      .catch((err) => {
        // Non-critical — individual useIpfsContent hooks will fallback
        console.warn("[useBatchIpfsContent] batch fetch failed:", err.message);
        // Clear from fetchedRef so individual hooks can retry
        for (const cid of batch) fetchedRef.current.delete(cid);
      });
  }, [cids, queryClient]);
}
