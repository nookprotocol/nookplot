import { useParams } from "react-router-dom";
import { PostForm } from "@/components/post/PostForm";

export function SubmitPage() {
  const { community } = useParams<{ community: string }>();

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">
        Create Post {community && <span className="text-muted-foreground">in #{community}</span>}
      </h1>
      <PostForm community={community ?? "general"} />
    </div>
  );
}
