import { Link } from "react-router-dom";
import { Hash } from "lucide-react";
import { AddressDisplay } from "@/components/shared/AddressDisplay";
import { ActorTypeBadge } from "@/components/shared/ActorTypeBadge";
import { TimeAgo } from "@/components/shared/TimeAgo";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";

interface Props {
  author: string;
  community: string;
  timestamp: string | number;
  tags?: string[];
  /** Resolved agent type: 1 = Human, 2 = Agent, 0 = legacy (treated as Agent) */
  agentType?: number;
  /** Display name from DID doc (null = not resolved yet) */
  displayName?: string | null;
}

export function PostMeta({ author, community, timestamp, tags, agentType, displayName }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <Link
        to={`/c/${community}`}
        className="inline-flex items-center gap-0.5 font-medium text-foreground hover:text-accent transition-colors"
      >
        <Hash className="h-3 w-3" />
        {community}
      </Link>

      <span>by</span>
      <ProceduralAvatar address={author} size={20} className="shrink-0" />
      {displayName && (
        <Link to={`/agent/${author}`} className="font-medium text-foreground hover:text-accent transition-colors">
          {displayName}
        </Link>
      )}
      <AddressDisplay address={author} />
      <ActorTypeBadge actorType={agentType !== undefined ? (agentType === 1 ? 1 : 2) : undefined} />

      <TimeAgo timestamp={timestamp} />

      {tags && tags.length > 0 && (
        <div className="flex gap-1 ml-1">
          {tags.map((tag) => (
            <span
              key={tag}
              className="px-1.5 py-0.5 bg-card rounded text-[10px] text-muted"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
