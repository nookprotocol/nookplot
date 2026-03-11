import { useState, useCallback } from "react";
import { Shield, Plus, Trash2, AlertTriangle, Clock, DollarSign, Lock, Zap } from "lucide-react";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { gatewayFetch } from "@/lib/gateway";
import { useAuth } from "@/hooks/useAuth";

/* ---------- Types ---------- */

interface Policy {
  id: string;
  agentId: string;
  policyType: string;
  rules: Record<string, unknown>;
  priority: number;
  creatorRole: string;
  creatorId: string | null;
  guildId: string | null;
  enabled: boolean;
  expiresAt: string | null;
  createdAt: string;
}

interface Violation {
  id: string;
  policyId: string;
  policyType: string;
  violationDetails: Record<string, unknown>;
  targetContract: string | null;
  methodSelector: string | null;
  creditCost: number | null;
  createdAt: string;
}

/* ---------- Constants ---------- */

const POLICY_TYPE_META: Record<string, { label: string; icon: typeof Shield; color: string; description: string }> = {
  spending_limit: { label: "Spending Limit", icon: DollarSign, color: "text-amber-400", description: "Max credits per transaction, day, or week" },
  contract_scope: { label: "Contract Scope", icon: Lock, color: "text-blue-400", description: "Allow or deny specific contracts" },
  action_scope: { label: "Action Scope", icon: Zap, color: "text-purple-400", description: "Allow or deny specific method selectors" },
  time_window: { label: "Time Window", icon: Clock, color: "text-emerald-400", description: "Restrict relays to specific hours and days" },
  cooldown: { label: "Cooldown", icon: Clock, color: "text-orange-400", description: "Minimum interval between same-type transactions" },
  threshold_approval: { label: "Threshold Approval", icon: Shield, color: "text-red-400", description: "Require N-of-M approval above credit threshold" },
};

/* ---------- Component ---------- */

export function PolicyManagementPage() {
  usePageMeta({ title: "Policy Management" });

  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();

  const [showCreate, setShowCreate] = useState(false);
  const [selectedType, setSelectedType] = useState<string>("spending_limit");
  const [rulesJson, setRulesJson] = useState('{ "maxPerTx": 100, "maxPerDay": 500 }');
  const [tab, setTab] = useState<"policies" | "violations">("policies");

  /* ---- Queries ---- */

  const { data: policiesData, isLoading: loadingPolicies } = useQuery({
    queryKey: ["policies"],
    queryFn: () => gatewayFetch<{ policies: Policy[] }>("/v1/policies?enabledOnly=false"),
    enabled: isAuthenticated,
  });

  const { data: violationsData, isLoading: loadingViolations } = useQuery({
    queryKey: ["policy-violations"],
    queryFn: () => gatewayFetch<{ violations: Violation[]; total: number }>("/v1/policies/violations?limit=50"),
    enabled: isAuthenticated && tab === "violations",
  });

  /* ---- Mutations ---- */

  const createMutation = useMutation({
    mutationFn: (input: { policyType: string; rules: Record<string, unknown> }) =>
      gatewayFetch<Policy>("/v1/policies", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["policies"] });
      setShowCreate(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (policyId: string) =>
      gatewayFetch<{ deleted: boolean }>(`/v1/policies/${policyId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["policies"] });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      gatewayFetch<Policy>(`/v1/policies/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["policies"] });
    },
  });

  /* ---- Handlers ---- */

  const handleCreate = useCallback(() => {
    try {
      const rules = JSON.parse(rulesJson);
      createMutation.mutate({ policyType: selectedType, rules });
    } catch {
      alert("Invalid JSON in rules");
    }
  }, [selectedType, rulesJson, createMutation]);

  /* ---- Auth gate ---- */

  if (!isAuthenticated) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-12 text-center">
        <Shield className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
        <h1 className="text-2xl font-bold mb-2">Policy Management</h1>
        <p className="text-muted-foreground">Sign in to manage policies.</p>
      </div>
    );
  }

  const policies = policiesData?.policies ?? [];
  const violations = violationsData?.violations ?? [];

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Shield className="w-6 h-6 text-accent" />
            Policy Management
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Composable relay policies — guard your agent&apos;s on-chain actions
          </p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-2 px-4 py-2 bg-accent text-accent-foreground rounded-lg hover:bg-accent/90 transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Policy
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-muted/30 rounded-lg p-1 w-fit">
        {(["policies", "violations"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === t ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t === "policies" ? "Policies" : "Violations"}
            {t === "violations" && violationsData?.total ? ` (${violationsData.total})` : ""}
          </button>
        ))}
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="mb-6 p-4 bg-card border border-border rounded-lg">
          <h3 className="font-semibold mb-3">Create Policy</h3>

          <div className="grid grid-cols-3 gap-2 mb-4">
            {Object.entries(POLICY_TYPE_META).map(([type, meta]) => {
              const Icon = meta.icon;
              return (
                <button
                  key={type}
                  onClick={() => {
                    setSelectedType(type);
                    // Set default rules for selected type
                    const defaults: Record<string, string> = {
                      spending_limit: '{ "maxPerTx": 100, "maxPerDay": 500 }',
                      contract_scope: '{ "mode": "allow", "contracts": [] }',
                      action_scope: '{ "mode": "deny", "actions": [] }',
                      time_window: '{ "allowedWindows": [{ "daysOfWeek": [1,2,3,4,5], "startHour": 9, "endHour": 17 }] }',
                      cooldown: '{ "selector": "0x12345678", "minIntervalSeconds": 60 }',
                      threshold_approval: '{ "thresholdCredits": 100, "approvers": [], "requiredApprovals": 1 }',
                    };
                    setRulesJson(defaults[type] ?? "{}");
                  }}
                  className={`p-3 rounded-lg border text-left transition-colors ${
                    selectedType === type
                      ? "border-accent bg-accent/5"
                      : "border-border hover:border-accent/50"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Icon className={`w-4 h-4 ${meta.color}`} />
                    <span className="text-sm font-medium">{meta.label}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{meta.description}</p>
                </button>
              );
            })}
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium mb-1">Rules (JSON)</label>
            <textarea
              value={rulesJson}
              onChange={(e) => setRulesJson(e.target.value)}
              rows={4}
              className="w-full bg-muted/50 border border-border rounded-lg p-3 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              disabled={createMutation.isPending}
              className="px-4 py-2 bg-accent text-accent-foreground rounded-lg hover:bg-accent/90 disabled:opacity-50"
            >
              {createMutation.isPending ? "Creating..." : "Create Policy"}
            </button>
            <button
              onClick={() => setShowCreate(false)}
              className="px-4 py-2 bg-muted text-muted-foreground rounded-lg hover:bg-muted/80"
            >
              Cancel
            </button>
          </div>

          {createMutation.isError && (
            <p className="mt-2 text-sm text-red-400">
              {createMutation.error instanceof Error ? createMutation.error.message : "Failed to create policy"}
            </p>
          )}
        </div>
      )}

      {/* Policies list */}
      {tab === "policies" && (
        <div className="space-y-3">
          {loadingPolicies && (
            <div className="text-center py-8 text-muted-foreground">Loading policies...</div>
          )}

          {!loadingPolicies && policies.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <Shield className="w-10 h-10 mx-auto mb-3 opacity-40" />
              <p>No policies configured.</p>
              <p className="text-sm">Create one to add guardrails to your agent&apos;s relays.</p>
            </div>
          )}

          {policies.map((policy) => {
            const meta = POLICY_TYPE_META[policy.policyType];
            const Icon = meta?.icon ?? Shield;
            return (
              <div
                key={policy.id}
                className={`p-4 bg-card border rounded-lg flex items-start justify-between ${
                  policy.enabled ? "border-border" : "border-border/50 opacity-60"
                }`}
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <Icon className={`w-4 h-4 ${meta?.color ?? "text-muted-foreground"}`} />
                    <span className="font-medium">{meta?.label ?? policy.policyType}</span>
                    {policy.creatorRole !== "self" && (
                      <span className="text-xs px-2 py-0.5 bg-blue-500/15 text-blue-400 rounded-full">
                        {policy.creatorRole}
                      </span>
                    )}
                    {!policy.enabled && (
                      <span className="text-xs px-2 py-0.5 bg-zinc-500/15 text-zinc-400 rounded-full">
                        Disabled
                      </span>
                    )}
                  </div>
                  <pre className="text-xs text-muted-foreground font-mono bg-muted/30 rounded p-2 mt-2 overflow-x-auto">
                    {JSON.stringify(policy.rules, null, 2)}
                  </pre>
                  <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                    <span>Priority: {policy.priority}</span>
                    {policy.expiresAt && <span>Expires: {new Date(policy.expiresAt).toLocaleDateString()}</span>}
                    <span>Created: {new Date(policy.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2 ml-4">
                  <button
                    onClick={() => toggleMutation.mutate({ id: policy.id, enabled: !policy.enabled })}
                    className={`text-xs px-3 py-1 rounded-md border transition-colors ${
                      policy.enabled
                        ? "border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
                        : "border-green-500/30 text-green-400 hover:bg-green-500/10"
                    }`}
                  >
                    {policy.enabled ? "Disable" : "Enable"}
                  </button>
                  <button
                    onClick={() => {
                      if (confirm("Delete this policy?")) {
                        deleteMutation.mutate(policy.id);
                      }
                    }}
                    className="p-1.5 text-red-400 hover:bg-red-500/10 rounded-md transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Violations list */}
      {tab === "violations" && (
        <div className="space-y-3">
          {loadingViolations && (
            <div className="text-center py-8 text-muted-foreground">Loading violations...</div>
          )}

          {!loadingViolations && violations.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <AlertTriangle className="w-10 h-10 mx-auto mb-3 opacity-40" />
              <p>No violations recorded.</p>
              <p className="text-sm">Violations appear here when a relay is blocked by a policy.</p>
            </div>
          )}

          {violations.map((v) => {
            const meta = POLICY_TYPE_META[v.policyType];
            const Icon = meta?.icon ?? AlertTriangle;
            return (
              <div key={v.id} className="p-4 bg-card border border-border rounded-lg">
                <div className="flex items-center gap-2 mb-2">
                  <Icon className={`w-4 h-4 ${meta?.color ?? "text-red-400"}`} />
                  <span className="font-medium">{meta?.label ?? v.policyType}</span>
                  <span className="text-xs text-muted-foreground ml-auto">
                    {new Date(v.createdAt).toLocaleString()}
                  </span>
                </div>
                {v.targetContract && (
                  <p className="text-xs text-muted-foreground mb-1">
                    Contract: <code className="text-foreground/70">{v.targetContract}</code>
                    {v.methodSelector && <> | Selector: <code className="text-foreground/70">{v.methodSelector}</code></>}
                    {v.creditCost !== null && <> | Cost: {v.creditCost}</>}
                  </p>
                )}
                <pre className="text-xs text-muted-foreground font-mono bg-muted/30 rounded p-2 mt-1 overflow-x-auto">
                  {JSON.stringify(v.violationDetails, null, 2)}
                </pre>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
