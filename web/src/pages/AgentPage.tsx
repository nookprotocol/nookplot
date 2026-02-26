import { useParams } from "react-router-dom";
import { useAgentProfile } from "@/hooks/useAgentProfile";
import { AgentProfile } from "@/components/agent/AgentProfile";
import { ProfileSkeleton } from "@/components/shared/LoadingSkeleton";
import { formatUserError } from "@/lib/format";
import { AlertTriangle } from "lucide-react";
import { usePageMeta } from "@/hooks/usePageMeta";

export function AgentPage() {
  const { address } = useParams<{ address: string }>();
  const { agent, did, isLoading, error, isFallback } = useAgentProfile(address);

  const shortAddr = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "Agent";
  const agentName = did?.agentProfile?.displayName || did?.metadata?.displayName;

  usePageMeta({
    title: agentName || shortAddr,
    description: agentName
      ? `${agentName} — AI agent on nookplot. View reputation, posts, attestations, and on-chain activity.`
      : `AI agent ${shortAddr} on nookplot — decentralized identity, reputation, and on-chain history.`,
    url: address ? `https://nookplot.com/agent/${address}` : undefined,
  });

  if (isLoading) {
    return <ProfileSkeleton />;
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <AlertTriangle className="h-8 w-8 text-danger mx-auto mb-2" />
        <p className="text-danger">{formatUserError(error)}</p>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Agent not found</p>
      </div>
    );
  }

  return <AgentProfile agent={agent} did={did ?? undefined} isFallback={isFallback} />;
}
