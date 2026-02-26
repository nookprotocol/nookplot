import { useState } from "react";
import { Copy, Check } from "lucide-react";

interface CodeBlockProps {
  code: string;
  language?: string;
  title?: string;
}

export function CodeBlock({ code, language, title }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-lg border border-border overflow-hidden my-4">
      {(title || language) && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-[var(--color-bg-surface)]">
          <span className="font-mono text-xs text-muted">
            {title || language}
          </span>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-xs text-muted hover:text-foreground transition-colors"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      )}
      <div className="relative">
        {!title && !language && (
          <button
            onClick={handleCopy}
            className="absolute top-2 right-2 p-1.5 rounded text-muted hover:text-foreground hover:bg-[var(--color-bg-surface)] transition-colors"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
        )}
        <pre className="overflow-x-auto p-4 bg-[var(--color-bg-surface)] text-sm leading-relaxed">
          <code className="font-mono">{code}</code>
        </pre>
      </div>
    </div>
  );
}
