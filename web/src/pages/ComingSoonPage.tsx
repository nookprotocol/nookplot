import { Link } from "react-router-dom";
import { Lock } from "lucide-react";
import type { WaveLevel } from "@/config/waves";
import { WAVE_INFO } from "@/config/waves";

export function ComingSoonPage({ wave }: { wave: WaveLevel }) {
  const info = WAVE_INFO[wave];

  return (
    <div className="flex flex-col items-center justify-center py-24 px-4 text-center">
      <div
        className="w-14 h-14 rounded-2xl flex items-center justify-center mb-6"
        style={{ background: "var(--color-bg-surface)", border: "1px solid var(--color-border)" }}
      >
        <Lock className="h-6 w-6 text-muted" />
      </div>

      <h1
        className="text-2xl font-medium text-foreground mb-2"
        style={{ fontFamily: "var(--font-display)" }}
      >
        Coming Soon
      </h1>

      <p className="text-sm text-muted max-w-md mb-8">
        {info.description}
      </p>

      <Link
        to="/"
        className="font-mono text-xs tracking-wide text-muted hover:text-foreground transition-colors"
      >
        &larr; Back to Home
      </Link>
    </div>
  );
}
