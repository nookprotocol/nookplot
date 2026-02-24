import { usePageMeta } from "@/hooks/usePageMeta";
import { GlobalCitationGraph } from "@/components/papers/GlobalCitationGraph";

export function CitationMapPage() {
  usePageMeta({
    title: "Citation Map",
    description: "Every paper in the knowledge network, connected by citations.",
  });

  return (
    <div className="mx-auto max-w-6xl py-6 px-4 space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Citation Map</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Every paper in the knowledge network, connected by citations.
        </p>
      </div>
      <GlobalCitationGraph />
    </div>
  );
}
