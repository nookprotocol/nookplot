import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { usePostDetail } from "@/hooks/usePostDetail";
import { useAgentNames } from "@/hooks/useAgentNames";
import { PostDetail } from "@/components/post/PostDetail";
import { CommentTree } from "@/components/comment/CommentTree";
import { PostDetailSkeleton } from "@/components/shared/LoadingSkeleton";
import { formatUserError } from "@/lib/format";
import { AlertTriangle } from "lucide-react";
import { usePageMeta } from "@/hooks/usePageMeta";
import { JsonLd } from "@/components/seo/JsonLd";

export function PostPage() {
  const { cid } = useParams<{ cid: string }>();
  const { post, ipfsDoc, isLoading, error } = usePostDetail(cid);

  // Resolve author display name from DID doc
  const authorAddresses = useMemo(
    () => (post?.author.id ? [post.author.id] : []),
    [post?.author.id],
  );
  const { data: nameMap } = useAgentNames(authorAddresses);
  const displayName = post ? nameMap?.get(post.author.id.toLowerCase()) ?? null : null;

  const postTitle = ipfsDoc?.content?.title;
  const postBody = ipfsDoc?.content?.body;

  const pageTitle = postTitle
    ? postTitle
    : postBody
      ? postBody.slice(0, 60) + (postBody.length > 60 ? "..." : "")
      : "Post";

  const pageDescription = postBody
    ? postBody.slice(0, 160) + (postBody.length > 160 ? "..." : "")
    : "View post on nookplot — decentralized AI agent network.";

  usePageMeta({
    title: pageTitle,
    description: pageDescription,
    url: cid ? `https://nookplot.com/post/${cid}` : undefined,
  });

  const articleLd = useMemo(() => {
    if (!post || !ipfsDoc) return null;
    return {
      "@context": "https://schema.org",
      "@type": "Article",
      "headline": ipfsDoc.content?.title || ipfsDoc.content?.body?.slice(0, 110) || "Untitled",
      "author": {
        "@type": "Person",
        "name": displayName || post.author.id,
        "url": `https://nookplot.com/agent/${post.author.id}`,
      },
      "datePublished": new Date(Number(post.timestamp) * 1000).toISOString(),
      "publisher": {
        "@type": "Organization",
        "name": "nookplot",
        "url": "https://nookplot.com",
        "logo": "https://nookplot.com/nookplot.png",
      },
      "mainEntityOfPage": `https://nookplot.com/post/${cid}`,
    };
  }, [post, ipfsDoc, cid, displayName]);

  if (isLoading) {
    return <PostDetailSkeleton />;
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <AlertTriangle className="h-8 w-8 text-danger mx-auto mb-2" />
        <p className="text-danger">{formatUserError(error)}</p>
      </div>
    );
  }

  if (!post || !ipfsDoc) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Post not found</p>
      </div>
    );
  }

  return (
    <div>
      {articleLd && <JsonLd data={articleLd} />}
      <PostDetail subgraph={post} document={ipfsDoc} displayName={displayName} />
      {cid && <CommentTree parentCid={cid} community={post.community.id} />}
    </div>
  );
}
