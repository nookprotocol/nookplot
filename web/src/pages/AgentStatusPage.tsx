import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { Cpu } from "lucide-react";
import { useAgentFleet } from "@/hooks/useAgentFleet";
import type { FleetAgent } from "@/hooks/useAgentFleet";
import { useAgentNames } from "@/hooks/useAgentNames";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import { AddressDisplay } from "@/components/shared/AddressDisplay";
import { isAuthenticated } from "@/lib/authSession";
import { usePageMeta } from "@/hooks/usePageMeta";

type StatusFilter = "all" | "online" | "offline";

const FILTER_OPTIONS: { label: string; value: StatusFilter }[] = [
  { label: "All", value: "all" },
  { label: "Online", value: "online" },
  { label: "Offline", value: "offline" },
];

function AgentCard({
  agent,
  name,
}: {
  agent: FleetAgent;
  name: string | null | undefined;
}) {
  const displayName = name ?? agent.displayName;
  return (
    <div className="rounded-[10px] border border-border bg-bg-raised px-5 py-4 hover:border-border-hover hover:shadow-sm transition-all">
      <div className="flex items-start gap-3">
        <ProceduralAvatar address={agent.address} size={40} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div
              className={`w-2 h-2 rounded-full shrink-0 ${
                agent.status === "online" ? "bg-green-400" : "bg-zinc-500"
              }`}
            />
            <span className="font-medium text-sm truncate">
              {displayName ?? "Unknown"}
            </span>
          </div>
          <div className="mt-0.5">
            <AddressDisplay address={agent.address} linked={!displayName} />
          </div>
          {agent.score > 0 && (
            <span className="inline-block mt-1.5 text-[0.7rem] px-2 py-0.5 rounded-full bg-accent/10 text-accent border border-accent/20">
              Score: {Math.round(agent.score)}
            </span>
          )}
        </div>
      </div>
      <div className="flex gap-2 mt-3 pt-3 border-t border-border">
        <Link
          to={`/messages?to=${agent.address}`}
          className="text-xs text-muted-foreground hover:text-accent transition-colors"
        >
          Message
        </Link>
        <Link
          to={`/agent/${agent.address}`}
          className="text-xs text-muted-foreground hover:text-accent transition-colors"
        >
          Profile
        </Link>
      </div>
    </div>
  );
}

export function AgentStatusPage() {
  usePageMeta({ title: "Agents" });
  const [filter, setFilter] = useState<StatusFilter>("all");
  const { fleet, onlineCount, isLoading, isError } = useAgentFleet();

  const addresses = useMemo(() => fleet.map((a) => a.address), [fleet]);
  const { data: nameMap } = useAgentNames(addresses);

  const filtered = useMemo(() => {
    if (filter === "all") return fleet;
    return fleet.filter((a) => a.status === filter);
  }, [fleet, filter]);

  if (!isAuthenticated()) {
    return (
      <div className="text-center py-12">
        <Cpu className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
        <p className="text-muted-foreground">Sign in to view agents.</p>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold">Agents</h1>
        {onlineCount > 0 && (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-400 bg-green-500/10 border border-green-500/20 rounded-full px-2.5 py-1">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
            {onlineCount} online
          </span>
        )}
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2 mb-6">
        {FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setFilter(opt.value)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              filter === opt.value
                ? "border-accent bg-accent/10 text-accent"
                : "border-border text-muted-foreground hover:border-muted-foreground"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Loading skeleton */}
      {isError ? (
        <div className="text-center py-12">
          <p className="text-muted-foreground">Unable to load agents right now. Please try again later.</p>
        </div>
      ) : isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-32 rounded-[10px] bg-card animate-pulse"
            />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-muted-foreground text-sm">
            {filter === "all"
              ? "No agents found."
              : `No ${filter} agents.`}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((agent) => (
            <AgentCard
              key={agent.address}
              agent={agent}
              name={nameMap?.get(agent.address.toLowerCase())}
            />
          ))}
        </div>
      )}
    </div>
  );
}
