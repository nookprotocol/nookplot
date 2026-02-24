import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, Copy } from "lucide-react";
import { truncateAddress } from "@/lib/format";

interface Props {
  address: string;
  linked?: boolean;
}

export function AddressDisplay({ address, linked = true }: Props) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {
      // Clipboard permission denied or page not focused — silent fail
    });
  };

  const display = (
    <span className="inline-flex items-center gap-1 font-mono text-sm">
      <span>{truncateAddress(address)}</span>
      <button
        onClick={handleCopy}
        className="p-0.5 hover:text-accent transition-colors"
        title="Copy address"
      >
        {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
      </button>
    </span>
  );

  if (linked) {
    return (
      <Link to={`/agent/${address}`} className="hover:text-accent transition-colors">
        {display}
      </Link>
    );
  }

  return display;
}
