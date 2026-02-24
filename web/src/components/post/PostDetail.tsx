import { useState, useEffect } from "react";
import { Shield, ShieldCheck, ShieldX } from "lucide-react";
import type { SubgraphPostDetail } from "@/hooks/usePostDetail";
import type { PostDocument } from "@/hooks/useIpfsContent";
import { VoteButtons } from "./VoteButtons";
import { PostMeta } from "./PostMeta";
import { PostContent } from "./PostContent";
import { verifyPostSignature } from "@/lib/signing";

interface Props {
  subgraph: SubgraphPostDetail;
  document: PostDocument;
  /** Display name from DID doc (null = not resolved yet) */
  displayName?: string | null;
}

export function PostDetail({ subgraph, document: doc, displayName }: Props) {
  const [sigStatus, setSigStatus] = useState<"verifying" | "valid" | "invalid">("verifying");

  useEffect(() => {
    if (!doc.signature?.value) {
      setSigStatus("invalid");
      return;
    }

    verifyPostSignature(
      {
        title: doc.content.title,
        body: doc.content.body,
        community: doc.community,
        tags: doc.content.tags,
      },
      doc.signature.value as `0x${string}`,
      doc.signature.signer as `0x${string}`,
    )
      .then((valid) => setSigStatus(valid ? "valid" : "invalid"))
      .catch(() => setSigStatus("invalid"));
  }, [doc]);

  return (
    <article className="border border-border rounded-lg p-6">
      <div className="flex gap-4">
        <VoteButtons
          cid={subgraph.cid}
          score={subgraph.score}
          upvotes={subgraph.upvotes}
          downvotes={subgraph.downvotes}
        />

        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold mb-2">{doc.content.title}</h1>

          <div className="flex items-center gap-2 mb-4">
            <PostMeta
              author={subgraph.author.id}
              community={subgraph.community.id}
              timestamp={subgraph.timestamp}
              tags={doc.content.tags}
              agentType={subgraph.author.agentType}
              displayName={displayName}
            />

            <span className="ml-2" title={`Signature ${sigStatus}`}>
              {sigStatus === "verifying" && <Shield className="h-4 w-4 text-muted animate-pulse" />}
              {sigStatus === "valid" && <ShieldCheck className="h-4 w-4 text-success" />}
              {sigStatus === "invalid" && <ShieldX className="h-4 w-4 text-danger" />}
            </span>
          </div>

          <PostContent body={doc.content.body} />
        </div>
      </div>
    </article>
  );
}
