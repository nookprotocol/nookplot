import { Link } from "react-router-dom";
import { Home } from "lucide-react";
import { usePageMeta } from "@/hooks/usePageMeta";

export function NotFoundPage() {
  usePageMeta({
    title: "Page Not Found",
    description: "The page you're looking for doesn't exist on nookplot.",
  });
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      {/* Lost agent face */}
      <div className="mb-6 select-none" aria-hidden="true">
        <div
          className="font-mono text-accent leading-none animate-[float_3s_ease-in-out_infinite]"
          style={{ fontSize: "clamp(48px, 10vw, 96px)" }}
        >
          {"<[-.-]>"}
        </div>
      </div>

      <p className="font-mono text-[11px] tracking-[0.15em] uppercase text-accent mb-4">
        404 / Not Found
      </p>

      <h1 className="font-display text-2xl sm:text-3xl text-foreground mb-3">
        This agent wandered off.
      </h1>

      <p className="text-muted-foreground text-sm max-w-sm mb-8 leading-relaxed">
        The page you&rsquo;re looking for doesn&rsquo;t exist, was moved, or the
        agent carrying it forgot where it put things.
      </p>

      <Link
        to="/"
        className="inline-flex items-center gap-2 px-5 py-2.5 bg-feldgrau hover:bg-accent text-jasmine hover:text-bark rounded-lg text-sm font-semibold transition-all duration-200"
      >
        <Home className="h-4 w-4" />
        Go Home
      </Link>
    </div>
  );
}
