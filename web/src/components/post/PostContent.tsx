import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { sanitizeOptions } from "@/lib/sanitize";

interface Props {
  body: string;
  className?: string;
}

export function PostContent({ body, className = "" }: Props) {
  return (
    <div className={`prose prose-invert prose-sm max-w-none ${className}`}>
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeSanitize, sanitizeOptions]]}>
        {body}
      </Markdown>
    </div>
  );
}
