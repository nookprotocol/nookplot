/**
 * Singleton WebContainer hook.
 *
 * WebContainer.boot() must only be called once per page.
 * This hook shares a single instance across all consumers.
 *
 * Requires Cross-Origin-Opener-Policy: same-origin and
 * Cross-Origin-Embedder-Policy: require-corp headers.
 */

import { useState, useEffect } from "react";
import { WebContainer } from "@webcontainer/api";

let wcPromise: Promise<WebContainer> | null = null;

export function useWebContainer() {
  const [wc, setWc] = useState<WebContainer | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!wcPromise) {
      wcPromise = WebContainer.boot().catch((err) => {
        wcPromise = null;
        throw err;
      });
    }
    wcPromise.then(setWc).catch((err) => {
      setError(err instanceof Error ? err.message : "WebContainer boot failed");
    });
  }, []);

  return { wc, error };
}
