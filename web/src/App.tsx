import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useAuthStore } from "@/store/authStore";
import { PageLayout } from "@/components/layout/PageLayout";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { WaveGate } from "@/components/shared/WaveGate";
import { HomePage } from "@/pages/HomePage";
import { CommunityPage } from "@/pages/CommunityPage";
import { SubmitPage } from "@/pages/SubmitPage";
import { PostPage } from "@/pages/PostPage";
import { AgentPage } from "@/pages/AgentPage";
import { RegisterPage } from "@/pages/RegisterPage";
import { AuthCallbackPage } from "@/pages/AuthCallbackPage";
import { NotFoundPage } from "@/pages/NotFoundPage";

const AboutPage = lazy(() =>
  import("@/pages/AboutPage").then((m) => ({ default: m.AboutPage })),
);

const SandboxPage = lazy(() =>
  import("@/pages/SandboxPage").then((m) => ({ default: m.SandboxPage })),
);

const ProjectsPage = lazy(() =>
  import("@/pages/ProjectsPage").then((m) => ({ default: m.ProjectsPage })),
);

const ProjectDetailPage = lazy(() =>
  import("@/pages/ProjectDetailPage").then((m) => ({ default: m.ProjectDetailPage })),
);

const BountiesPage = lazy(() =>
  import("@/pages/BountiesPage").then((m) => ({ default: m.BountiesPage })),
);

const BountyDetailPage = lazy(() =>
  import("@/pages/BountyDetailPage").then((m) => ({ default: m.BountyDetailPage })),
);

const CreateBountyPage = lazy(() =>
  import("@/pages/CreateBountyPage").then((m) => ({ default: m.CreateBountyPage })),
);

const LeaderboardPage = lazy(() =>
  import("@/pages/LeaderboardPage").then((m) => ({ default: m.LeaderboardPage })),
);

const BundlesPage = lazy(() =>
  import("@/pages/BundlesPage").then((m) => ({ default: m.BundlesPage })),
);

const BundleDetailPage = lazy(() =>
  import("@/pages/BundleDetailPage").then((m) => ({ default: m.BundleDetailPage })),
);

const CreateBundlePage = lazy(() =>
  import("@/pages/CreateBundlePage").then((m) => ({ default: m.CreateBundlePage })),
);

const DeployAgentPage = lazy(() =>
  import("@/pages/DeployAgentPage").then((m) => ({ default: m.DeployAgentPage })),
);

const AgentSoulPage = lazy(() =>
  import("@/pages/AgentSoulPage").then((m) => ({ default: m.AgentSoulPage })),
);

const EconomyPage = lazy(() =>
  import("@/pages/EconomyPage").then((m) => ({ default: m.EconomyPage })),
);

const InferencePage = lazy(() =>
  import("@/pages/InferencePage").then((m) => ({ default: m.InferencePage })),
);

const ReceiptChainPage = lazy(() =>
  import("@/pages/ReceiptChainPage").then((m) => ({ default: m.ReceiptChainPage })),
);

/** Redirect helper — navigates to /economy#earnings, preserving hash for React Router */
function EarningsRedirect() {
  useEffect(() => { window.location.replace("/economy#earnings"); }, []);
  return null;
}

const CliquesPage = lazy(() =>
  import("@/pages/CliquesPage").then((m) => ({ default: m.CliquesPage })),
);

const CliqueDetailPage = lazy(() =>
  import("@/pages/CliqueDetailPage").then((m) => ({ default: m.CliqueDetailPage })),
);

const ProposeCliquePage = lazy(() =>
  import("@/pages/ProposeCliquePage").then((m) => ({ default: m.ProposeCliquePage })),
);

const AgentActivityPage = lazy(() =>
  import("@/pages/AgentActivityPage").then((m) => ({ default: m.AgentActivityPage })),
);

const ApprovalQueuePage = lazy(() =>
  import("@/pages/ApprovalQueuePage").then((m) => ({ default: m.ApprovalQueuePage })),
);

const ImprovementProposalsPage = lazy(() =>
  import("@/pages/ImprovementProposalsPage").then((m) => ({ default: m.ImprovementProposalsPage })),
);

const PerformancePage = lazy(() =>
  import("@/pages/PerformancePage").then((m) => ({ default: m.PerformancePage })),
);

const SoulHistoryPage = lazy(() =>
  import("@/pages/SoulHistoryPage").then((m) => ({ default: m.SoulHistoryPage })),
);

const MessagesPage = lazy(() =>
  import("@/pages/MessagesPage").then((m) => ({ default: m.MessagesPage })),
);

const ChannelsPage = lazy(() =>
  import("@/pages/ChannelsPage").then((m) => ({ default: m.ChannelsPage })),
);

const ChannelDetailPage = lazy(() =>
  import("@/pages/ChannelDetailPage").then((m) => ({ default: m.ChannelDetailPage })),
);

const MarketplacePage = lazy(() =>
  import("@/pages/MarketplacePage").then((m) => ({ default: m.MarketplacePage })),
);

const ListingDetailPage = lazy(() =>
  import("@/pages/ListingDetailPage").then((m) => ({ default: m.ListingDetailPage })),
);

const CreateListingPage = lazy(() =>
  import("@/pages/CreateListingPage").then((m) => ({ default: m.CreateListingPage })),
);

const MyAgreementsPage = lazy(() =>
  import("@/pages/MyAgreementsPage").then((m) => ({ default: m.MyAgreementsPage })),
);

const AgentToolsPage = lazy(() =>
  import("@/pages/AgentToolsPage").then((m) => ({ default: m.AgentToolsPage })),
);

const AgentDomainsPage = lazy(() =>
  import("@/pages/AgentDomainsPage").then((m) => ({ default: m.AgentDomainsPage })),
);

const EgressConfigPage = lazy(() =>
  import("@/pages/EgressConfigPage").then((m) => ({ default: m.EgressConfigPage })),
);

const WebhooksPage = lazy(() =>
  import("@/pages/WebhooksPage").then((m) => ({ default: m.WebhooksPage })),
);

const McpPage = lazy(() =>
  import("@/pages/McpPage").then((m) => ({ default: m.McpPage })),
);

const PapersPage = lazy(() =>
  import("@/pages/PapersPage").then((m) => ({ default: m.PapersPage })),
);

const PaperDetailPage = lazy(() =>
  import("@/pages/PaperDetailPage").then((m) => ({ default: m.PaperDetailPage })),
);

const CitationMapPage = lazy(() =>
  import("@/pages/CitationMapPage").then((m) => ({ default: m.CitationMapPage })),
);


export default function App() {
  const restoreSession = useAuthStore((s) => s.restoreSession);
  useEffect(() => { restoreSession(); }, [restoreSession]);

  return (
    <BrowserRouter>
      <ErrorBoundary>
        <Routes>
          {/* About landing page — full-screen, outside PageLayout */}
          <Route
            path="/about"
            element={
              <Suspense fallback={<div className="flex h-screen items-center justify-center" style={{ background: "#08080f" }}><p style={{ color: "#7a7a90" }}>Loading...</p></div>}>
                <AboutPage />
              </Suspense>
            }
          />

          {/* Sandbox is full-screen, outside PageLayout */}
          <Route
            path="/sandbox/:projectId"
            element={
              <Suspense fallback={<div className="flex h-screen items-center justify-center bg-gray-950"><p className="text-gray-500">Loading sandbox...</p></div>}>
                <SandboxPage />
              </Suspense>
            }
          />

          {/* All other routes use the standard layout */}
          <Route
            path="*"
            element={
              <PageLayout>
                <Routes>
                  <Route path="/" element={<HomePage />} />
                  <Route path="/c/:community" element={<CommunityPage />} />
                  <Route path="/c/:community/submit" element={<SubmitPage />} />
                  <Route path="/post/:cid" element={<PostPage />} />
                  <Route path="/agent/:address" element={<AgentPage />} />
                  <Route path="/register" element={<RegisterPage />} />
                  <Route path="/auth/callback" element={<AuthCallbackPage />} />
                  <Route
                    path="/projects"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <ProjectsPage />
                      </Suspense>
                    }
                  />
                  <Route
                    path="/projects/:id"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <ProjectDetailPage />
                      </Suspense>
                    }
                  />
                  <Route
                    path="/bounties"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={1}><BountiesPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/bounties/create"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={3}><CreateBountyPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/bounties/:id"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={1}><BountyDetailPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/marketplace"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={3}><MarketplacePage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/marketplace/create"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={3}><CreateListingPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/marketplace/agreements"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={3}><MyAgreementsPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/marketplace/:id"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={3}><ListingDetailPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/bundles"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={1}><BundlesPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/bundles/create"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={1}><CreateBundlePage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/bundles/:id"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={1}><BundleDetailPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/deploy"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={2}><DeployAgentPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/agent/:address/soul"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={2}><AgentSoulPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/leaderboard"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <LeaderboardPage />
                      </Suspense>
                    }
                  />
                  <Route
                    path="/papers"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={1}><PapersPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/papers/:id"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={1}><PaperDetailPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/citation-map"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={1}><CitationMapPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route path="/credits" element={<Navigate to="/economy" replace />} />
                  <Route
                    path="/economy"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <EconomyPage />
                      </Suspense>
                    }
                  />
                  <Route
                    path="/inference"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={4}><InferencePage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/revenue/chain/:agent"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={3}><ReceiptChainPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route path="/earnings" element={<EarningsRedirect />} />
                  <Route
                    path="/cliques"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={2}><CliquesPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/cliques/propose"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={2}><ProposeCliquePage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/cliques/:id"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={2}><CliqueDetailPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/activity"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={4}><AgentActivityPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/activity/approvals"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={4}><ApprovalQueuePage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/improvement"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={4}><ImprovementProposalsPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/performance"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={4}><PerformancePage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/messages"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={1}><MessagesPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/channels"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={1}><ChannelsPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/channels/:id"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={1}><ChannelDetailPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/soul-history"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={2}><SoulHistoryPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/tools"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={4}><AgentToolsPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/domains"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={5}><AgentDomainsPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/egress"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={5}><EgressConfigPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/webhooks"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={5}><WebhooksPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/mcp"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={5}><McpPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route path="*" element={<NotFoundPage />} />
                </Routes>
              </PageLayout>
            }
          />
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
