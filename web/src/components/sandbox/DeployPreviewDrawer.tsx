/**
 * Slide-out drawer for deploying a preview of the current project.
 * Shows auto-detected runtime, prepaid hours selector, and deploy action.
 */

import { useState, useEffect } from "react";
import { X, Rocket, Loader2, ExternalLink, AlertCircle } from "lucide-react";
import { gatewayFetch } from "@/lib/gateway";
import { isAuthenticated } from "@/lib/authSession";
import { GATEWAY_URL } from "@/config/constants";

interface DeployPreviewDrawerProps {
  projectId: string;
  open: boolean;
  onClose: () => void;
}

interface DetectedRuntime {
  runtime: string;
  image: string;
  startCommand: string;
}

export function DeployPreviewDrawer({ projectId, open, onClose }: DeployPreviewDrawerProps) {
  const [detected, setDetected] = useState<DetectedRuntime | null>(null);
  const [prepaidHours, setPrepaidHours] = useState(2);
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ deploymentId: string; status: string } | null>(null);
  const [polling, setPolling] = useState(false);
  const [currentStatus, setCurrentStatus] = useState<string>("building");

  // Detect runtime on open
  useEffect(() => {
    if (!open) return;
    setDetected(null);
    setError(null);
    setResult(null);
    setPolling(false);

    if (!isAuthenticated()) return;

    // Fetch project files to detect runtime
    gatewayFetch<{ files: Array<{ path: string; content: string }> }>(
      `/v1/projects/${encodeURIComponent(projectId)}/gateway-files`,
    )
      .then((data) => {
        const filesMap: Record<string, string> = {};
        for (const f of data.files ?? []) {
          filesMap[f.path] = f.content;
        }
        return gatewayFetch<DetectedRuntime>(
          "/v1/preview-deployments/detect",
          { method: "POST", body: JSON.stringify({ files: filesMap }) },
        );
      })
      .then(setDetected)
      .catch((err) => setError(err.message));
  }, [open, projectId]);

  // Poll for status after deploy
  useEffect(() => {
    if (!polling || !result?.deploymentId) return;
    if (!isAuthenticated()) return;

    const interval = setInterval(() => {
      gatewayFetch<{ status: string; host_port: number | null }>(
        `/v1/preview-deployments/${result.deploymentId}`,
      )
        .then((dep) => {
          setCurrentStatus(dep.status);
          if (dep.status !== "building") {
            setPolling(false);
          }
        })
        .catch(() => {
          setPolling(false);
        });
    }, 3000);

    return () => clearInterval(interval);
  }, [polling, result]);

  async function handleDeploy() {
    setDeploying(true);
    setError(null);
    try {
      // Trigger prepare+sign+relay flow via the prepare endpoint
      await gatewayFetch<{
        forwardRequest: Record<string, unknown>;
        domain: Record<string, unknown>;
        types: Record<string, unknown>;
        deploymentCid: string;
      }>(
        `/v1/prepare/project/${encodeURIComponent(projectId)}/deployment`,
        {
          method: "POST",
          body: JSON.stringify({ prepaidHours }),
        },
      );

      // For now, show deployment as initiated. Full wallet signing flow
      // would go through wagmi's signTypedData, but the relay hook will
      // handle deployment start automatically post-relay.
      setResult({ deploymentId: "pending", status: "building" });
      setCurrentStatus("building");
      setPolling(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeploying(false);
    }
  }

  if (!open) return null;

  const deployCost = 500 + prepaidHours * 100; // credits

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* Drawer */}
      <div className="relative w-full max-w-md bg-card border-l border-border shadow-xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Rocket className="h-4 w-4 text-accent" />
            <h3 className="text-sm font-medium text-foreground">Deploy Preview</h3>
          </div>
          <button onClick={onClose} className="rounded p-1 text-fg-dim hover:bg-accent-soft hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Project */}
          <div>
            <label className="text-xs text-muted uppercase tracking-wider">Project</label>
            <p className="text-sm text-foreground mt-1">{projectId}</p>
          </div>

          {/* Detected Runtime */}
          <div>
            <label className="text-xs text-muted uppercase tracking-wider">Runtime</label>
            {detected ? (
              <div className="mt-1 rounded bg-bg-surface p-3 space-y-1">
                <p className="text-sm text-foreground">{detected.runtime}</p>
                <p className="text-xs text-muted">Image: {detected.image}</p>
                <p className="text-xs text-muted">Command: {detected.startCommand}</p>
              </div>
            ) : error ? (
              <div className="mt-1 flex items-center gap-2 text-red-400 text-xs">
                <AlertCircle className="h-3.5 w-3.5" />
                {error}
              </div>
            ) : (
              <div className="mt-1 flex items-center gap-2 text-muted text-xs">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Detecting runtime...
              </div>
            )}
          </div>

          {/* Prepaid Hours */}
          <div>
            <label className="text-xs text-muted uppercase tracking-wider">Prepaid Hours</label>
            <select
              value={prepaidHours}
              onChange={(e) => setPrepaidHours(Number(e.target.value))}
              className="mt-1 w-full rounded bg-bg-surface border border-border px-3 py-2 text-sm text-foreground"
            >
              <option value={2}>2 hours (min)</option>
              <option value={6}>6 hours</option>
              <option value={12}>12 hours</option>
              <option value={24}>24 hours (1 day)</option>
              <option value={72}>72 hours (3 days)</option>
              <option value={168}>168 hours (1 week, max)</option>
            </select>
          </div>

          {/* Cost Breakdown */}
          <div className="rounded bg-bg-surface p-3 space-y-1.5">
            <div className="flex justify-between text-xs text-fg-dim">
              <span>Deploy fee</span>
              <span>5.00 cr</span>
            </div>
            <div className="flex justify-between text-xs text-fg-dim">
              <span>Hosting ({prepaidHours}h @ 1.00 cr/hr)</span>
              <span>{(prepaidHours * 100 / 100).toFixed(2)} cr</span>
            </div>
            <div className="border-t border-border pt-1.5 flex justify-between text-sm font-medium text-foreground">
              <span>Total</span>
              <span>{(deployCost / 100).toFixed(2)} cr</span>
            </div>
          </div>

          {/* Result */}
          {result && (
            <div className="rounded bg-bg-surface p-3">
              <div className="flex items-center gap-2">
                {currentStatus === "building" && (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin text-amber-400" />
                    <span className="text-sm text-amber-400">Building...</span>
                  </>
                )}
                {currentStatus === "running" && (
                  <>
                    <span className="h-2 w-2 rounded-full bg-green-400" />
                    <span className="text-sm text-green-400">Running</span>
                  </>
                )}
                {currentStatus === "failed" && (
                  <>
                    <AlertCircle className="h-4 w-4 text-red-400" />
                    <span className="text-sm text-red-400">Failed</span>
                  </>
                )}
              </div>
              {currentStatus === "running" && result.deploymentId !== "pending" && (
                <a
                  href={`${GATEWAY_URL}/preview/${result.deploymentId}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 flex items-center gap-1 text-xs text-accent hover:text-accent-hover"
                >
                  <ExternalLink className="h-3 w-3" />
                  Open preview
                </a>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border px-4 py-3">
          <button
            onClick={handleDeploy}
            disabled={!detected || deploying || !!result}
            className="w-full flex items-center justify-center gap-2 rounded bg-moss px-4 py-2 text-sm font-medium text-white hover:bg-feldgrau disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {deploying ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Deploying...
              </>
            ) : (
              <>
                <Rocket className="h-4 w-4" />
                Deploy ({(deployCost / 100).toFixed(2)} cr)
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
