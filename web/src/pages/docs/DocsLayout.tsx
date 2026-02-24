import { useState, lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import { DocsHeader } from "./DocsHeader";
import { DocsSidebar } from "./DocsSidebar";

const DocsIndexPage = lazy(() =>
  import("./DocsIndexPage").then((m) => ({ default: m.DocsIndexPage })),
);
const OverviewPage = lazy(() =>
  import("./OverviewPage").then((m) => ({ default: m.OverviewPage })),
);
const GettingStartedPage = lazy(() =>
  import("./GettingStartedPage").then((m) => ({ default: m.GettingStartedPage })),
);
const ArchitecturePage = lazy(() =>
  import("./ArchitecturePage").then((m) => ({ default: m.ArchitecturePage })),
);
const ContractsPage = lazy(() =>
  import("./ContractsPage").then((m) => ({ default: m.ContractsPage })),
);
const SdkPage = lazy(() =>
  import("./SdkPage").then((m) => ({ default: m.SdkPage })),
);
const RuntimePage = lazy(() =>
  import("./RuntimePage").then((m) => ({ default: m.RuntimePage })),
);
const CliPage = lazy(() =>
  import("./CliPage").then((m) => ({ default: m.CliPage })),
);
const ApiPage = lazy(() =>
  import("./ApiPage").then((m) => ({ default: m.ApiPage })),
);
const SubgraphPage = lazy(() =>
  import("./SubgraphPage").then((m) => ({ default: m.SubgraphPage })),
);
const EconomicsPage = lazy(() =>
  import("./EconomicsPage").then((m) => ({ default: m.EconomicsPage })),
);
const SecurityPage = lazy(() =>
  import("./SecurityPage").then((m) => ({ default: m.SecurityPage })),
);
const ReferencePage = lazy(() =>
  import("./ReferencePage").then((m) => ({ default: m.ReferencePage })),
);

function PageLoading() {
  return (
    <div className="flex items-center justify-center py-16">
      <p className="text-muted text-sm">Loading...</p>
    </div>
  );
}

export function DocsLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background">
      <DocsHeader onToggleSidebar={() => setSidebarOpen(!sidebarOpen)} />
      <DocsSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <main className="lg:pl-[260px] pt-[52px]">
        <div className="max-w-[860px] mx-auto px-6 py-8">
          <Suspense fallback={<PageLoading />}>
            <Routes>
              <Route index element={<DocsIndexPage />} />
              <Route path="overview" element={<OverviewPage />} />
              <Route path="getting-started" element={<GettingStartedPage />} />
              <Route path="architecture" element={<ArchitecturePage />} />
              <Route path="contracts" element={<ContractsPage />} />
              <Route path="sdk" element={<SdkPage />} />
              <Route path="runtime" element={<RuntimePage />} />
              <Route path="cli" element={<CliPage />} />
              <Route path="api" element={<ApiPage />} />
              <Route path="subgraph" element={<SubgraphPage />} />
              <Route path="economics" element={<EconomicsPage />} />
              <Route path="security" element={<SecurityPage />} />
              <Route path="reference" element={<ReferencePage />} />
            </Routes>
          </Suspense>
        </div>
      </main>
    </div>
  );
}
