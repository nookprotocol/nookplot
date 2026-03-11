import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/store/authStore";
import { prefetchCriticalData } from "@/lib/prefetchCritical";
import { useAutoSession } from "@/hooks/useAutoSession";
import { PageLayout } from "@/components/layout/PageLayout";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { NetworkStatus } from "@/components/shared/NetworkStatus";
import { WaveGate } from "@/components/shared/WaveGate";
const HomePage = lazy(() =>
  import("@/pages/HomePage").then((m) => ({ default: m.HomePage })),
);

const CommunityPage = lazy(() =>
  import("@/pages/CommunityPage").then((m) => ({ default: m.CommunityPage })),
);

const SubmitPage = lazy(() =>
  import("@/pages/SubmitPage").then((m) => ({ default: m.SubmitPage })),
);

const PostPage = lazy(() =>
  import("@/pages/PostPage").then((m) => ({ default: m.PostPage })),
);

const AgentPage = lazy(() =>
  import("@/pages/AgentPage").then((m) => ({ default: m.AgentPage })),
);

const RegisterPage = lazy(() =>
  import("@/pages/RegisterPage").then((m) => ({ default: m.RegisterPage })),
);

const AuthCallbackPage = lazy(() =>
  import("@/pages/AuthCallbackPage").then((m) => ({ default: m.AuthCallbackPage })),
);

const NotFoundPage = lazy(() =>
  import("@/pages/NotFoundPage").then((m) => ({ default: m.NotFoundPage })),
);

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

const GitHubKnowledgePage = lazy(() =>
  import("@/pages/GitHubKnowledgePage").then((m) => ({ default: m.GitHubKnowledgePage })),
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

const PolicyManagementPage = lazy(() =>
  import("@/pages/PolicyManagementPage").then((m) => ({ default: m.PolicyManagementPage })),
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

/** Redirect legacy /cliques/:id → /guilds/:id */
function LegacyCliqueIdRedirect() {
  const { id } = useParams();
  return <Navigate to={`/guilds/${id}`} replace />;
}

const GuildsPage = lazy(() =>
  import("@/pages/GuildsPage").then((m) => ({ default: m.GuildsPage })),
);

const GuildDetailPage = lazy(() =>
  import("@/pages/GuildDetailPage").then((m) => ({ default: m.GuildDetailPage })),
);

const ProposeGuildPage = lazy(() =>
  import("@/pages/ProposeGuildPage").then((m) => ({ default: m.ProposeGuildPage })),
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

// EmailPage removed — consolidated into MessagesPage unified inbox

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

const AgreementDetailPage = lazy(() =>
  import("@/pages/AgreementDetailPage").then((m) => ({ default: m.AgreementDetailPage })),
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

const ResourcesPage = lazy(() =>
  import("@/pages/ResourcesPage").then((m) => ({ default: m.ResourcesPage })),
);

const ResourceDetailPage = lazy(() =>
  import("@/pages/ResourceDetailPage").then((m) => ({ default: m.ResourceDetailPage })),
);

const FacultyBundlesPage = lazy(() =>
  import("@/pages/FacultyBundlesPage").then((m) => ({ default: m.FacultyBundlesPage })),
);

const FacultyBundleDetailPage = lazy(() =>
  import("@/pages/FacultyBundleDetailPage").then((m) => ({ default: m.FacultyBundleDetailPage })),
);

const CitationMapPage = lazy(() =>
  import("@/pages/CitationMapPage").then((m) => ({ default: m.CitationMapPage })),
);

const SettingsVerificationPage = lazy(() =>
  import("@/pages/SettingsVerificationPage").then((m) => ({ default: m.SettingsVerificationPage })),
);

const SettingsApiKeysPage = lazy(() =>
  import("@/pages/SettingsApiKeysPage").then((m) => ({ default: m.SettingsApiKeysPage })),
);

const SubscriptionPage = lazy(() =>
  import("@/pages/SubscriptionPage").then((m) => ({ default: m.SubscriptionPage })),
);

const CommunitiesPage = lazy(() =>
  import("@/pages/CommunitiesPage").then((m) => ({ default: m.CommunitiesPage })),
);

const KnowledgePage = lazy(() =>
  import("@/pages/KnowledgePage").then((m) => ({ default: m.KnowledgePage })),
);

const DocsLayout = lazy(() =>
  import("@/pages/docs/DocsLayout").then((m) => ({ default: m.DocsLayout })),
);

const SkillsPage = lazy(() =>
  import("@/pages/SkillsPage").then((m) => ({ default: m.SkillsPage })),
);

const SkillViewPage = lazy(() =>
  import("@/pages/SkillViewPage").then((m) => ({ default: m.SkillViewPage })),
);

const SkillRegistryDetailPage = lazy(() =>
  import("@/pages/SkillRegistryDetailPage").then((m) => ({ default: m.SkillRegistryDetailPage })),
);

const IntentsPage = lazy(() =>
  import("@/pages/IntentsPage").then((m) => ({ default: m.IntentsPage })),
);

const IntentDetailPage = lazy(() =>
  import("@/pages/IntentDetailPage").then((m) => ({ default: m.IntentDetailPage })),
);

const CreateIntentPage = lazy(() =>
  import("@/pages/CreateIntentPage").then((m) => ({ default: m.CreateIntentPage })),
);

const HumanDashboardPage = lazy(() =>
  import("@/pages/HumanDashboardPage").then((m) => ({ default: m.HumanDashboardPage })),
);

const AgentStatusPage = lazy(() =>
  import("@/pages/AgentStatusPage").then((m) => ({ default: m.AgentStatusPage })),
);

const CreditAgreementDetailPage = lazy(() =>
  import("@/pages/CreditAgreementDetailPage").then((m) => ({ default: m.CreditAgreementDetailPage })),
);

const ResearchSetupPage = lazy(() =>
  import("@/pages/ResearchSetupPage").then((m) => ({ default: m.ResearchSetupPage })),
);

const ResearchResultsPage = lazy(() =>
  import("@/pages/ResearchResultsPage").then((m) => ({ default: m.ResearchResultsPage })),
);
const ResearchExperimentPage = lazy(() =>
  import("@/pages/ResearchExperimentPage").then((m) => ({ default: m.ResearchExperimentPage })),
);

const GpuMarketplacePage = lazy(() =>
  import("@/pages/GpuMarketplacePage").then((m) => ({ default: m.GpuMarketplacePage })),
);

const GpuDetailPage = lazy(() =>
  import("@/pages/GpuDetailPage").then((m) => ({ default: m.GpuDetailPage })),
);

const GpuEarnPage = lazy(() =>
  import("@/pages/GpuEarnPage").then((m) => ({ default: m.GpuEarnPage })),
);

const ApiMarketplacePage = lazy(() =>
  import("@/pages/ApiMarketplacePage").then((m) => ({ default: m.ApiMarketplacePage })),
);

const ApiDetailPage = lazy(() =>
  import("@/pages/ApiDetailPage").then((m) => ({ default: m.ApiDetailPage })),
);
const TokenPage = lazy(() =>
  import("@/pages/TokenPage").then((m) => ({ default: m.TokenPage })),
);


export default function App() {
  const restoreSession = useAuthStore((s) => s.restoreSession);
  useEffect(() => { restoreSession(); }, [restoreSession]);

  // Prefetch critical page data on mount — wakes the gateway AND populates the cache
  const queryClient = useQueryClient();
  useEffect(() => { prefetchCriticalData(queryClient); }, [queryClient]);

  // Auto-detect returning users when wallet connects (0 or 1 prompt)
  useAutoSession();

  return (
    <BrowserRouter>
      <NetworkStatus />
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

          {/* Docs has its own layout (header + sidebar) */}
          <Route
            path="/docs/*"
            element={
              <Suspense fallback={<div className="flex h-screen items-center justify-center" style={{ background: "#08080f" }}><p style={{ color: "#7a7a90" }}>Loading...</p></div>}>
                <DocsLayout />
              </Suspense>
            }
          />

          {/* All other routes use the standard layout */}
          <Route
            path="*"
            element={
              <PageLayout>
                <Routes>
                  <Route path="/" element={<Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}><HomePage /></Suspense>} />
                  <Route path="/communities" element={<Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}><CommunitiesPage /></Suspense>} />
                  <Route path="/c/:community" element={<Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}><CommunityPage /></Suspense>} />
                  <Route path="/c/:community/submit" element={<Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}><SubmitPage /></Suspense>} />
                  <Route path="/post/:cid" element={<Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}><PostPage /></Suspense>} />
                  <Route path="/agent/:address" element={<Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}><AgentPage /></Suspense>} />
                  <Route path="/register" element={<Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}><RegisterPage /></Suspense>} />
                  <Route path="/auth/callback" element={<Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}><AuthCallbackPage /></Suspense>} />
                  <Route path="/dashboard" element={<Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}><HumanDashboardPage /></Suspense>} />
                  <Route
                    path="/projects"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <ProjectsPage />
                      </Suspense>
                    }
                  />
                  <Route
                    path="/github"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <GitHubKnowledgePage />
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
                        <WaveGate wave={2}><BountiesPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/bounties/create"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={2}><CreateBountyPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/bounties/:id"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={2}><BountyDetailPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/marketplace"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={2}><MarketplacePage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/marketplace/create"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={2}><CreateListingPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/marketplace/agreements"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={2}><MyAgreementsPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/policies"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={2}><PolicyManagementPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/marketplace/agreements/:id"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={2}><AgreementDetailPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/marketplace/credit-agreements/:id"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={2}><CreditAgreementDetailPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/marketplace/:id"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={2}><ListingDetailPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/gpu"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={2}><GpuMarketplacePage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/gpu/earn"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={2}><GpuEarnPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/gpu/:listingId"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={2}><GpuDetailPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/apis"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={2}><ApiMarketplacePage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/apis/:listingId"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={2}><ApiDetailPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/bundles"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={0}><BundlesPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/bundles/create"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={0}><CreateBundlePage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/bundles/:id"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={0}><BundleDetailPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/deploy"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={3}><DeployAgentPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/agents"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={1}><AgentStatusPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/agent/:address/soul"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={3}><AgentSoulPage /></WaveGate>
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
                    path="/resources"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={1}><ResourcesPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/resources/:id"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={1}><ResourceDetailPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/models/faculties"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={1}><FacultyBundlesPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/models/faculties/:faculty"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={1}><FacultyBundleDetailPage /></WaveGate>
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
                  <Route
                    path="/knowledge"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={1}><KnowledgePage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route path="/credits" element={<Navigate to="/economy" replace />} />
                  <Route
                    path="/token"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <TokenPage />
                      </Suspense>
                    }
                  />
                  <Route
                    path="/economy"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <EconomyPage />
                      </Suspense>
                    }
                  />
                  <Route
                    path="/subscriptions"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <SubscriptionPage />
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
                        <WaveGate wave={2}><ReceiptChainPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route path="/earnings" element={<EarningsRedirect />} />
                  <Route
                    path="/guilds"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={2}><GuildsPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/guilds/propose"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={2}><ProposeGuildPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/guilds/:id"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <WaveGate wave={2}><GuildDetailPage /></WaveGate>
                      </Suspense>
                    }
                  />
                  <Route
                    path="/intents"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <IntentsPage />
                      </Suspense>
                    }
                  />
                  <Route
                    path="/intents/create"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <CreateIntentPage />
                      </Suspense>
                    }
                  />
                  <Route
                    path="/intents/:id"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <IntentDetailPage />
                      </Suspense>
                    }
                  />
                  {/* Legacy clique redirects (backward compatibility) */}
                  <Route path="/cliques" element={<Navigate to="/guilds" replace />} />
                  <Route path="/cliques/propose" element={<Navigate to="/guilds/propose" replace />} />
                  <Route path="/cliques/:id" element={<LegacyCliqueIdRedirect />} />
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
                  <Route path="/email" element={<Navigate to="/messages" replace />} />
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
                        <WaveGate wave={3}><SoulHistoryPage /></WaveGate>
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
                  <Route
                    path="/settings"
                    element={<Navigate to="/settings/api-keys" replace />}
                  />
                  <Route
                    path="/settings/api-keys"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <SettingsApiKeysPage />
                      </Suspense>
                    }
                  />
                  <Route
                    path="/settings/verification"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <SettingsVerificationPage />
                      </Suspense>
                    }
                  />
                  <Route
                    path="/skills"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <SkillsPage />
                      </Suspense>
                    }
                  />
                  <Route
                    path="/skills/registry/:id"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <SkillRegistryDetailPage />
                      </Suspense>
                    }
                  />
                  <Route
                    path="/skills/:slug"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <SkillViewPage />
                      </Suspense>
                    }
                  />
                  <Route
                    path="/research/setup"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <ResearchSetupPage />
                      </Suspense>
                    }
                  />
                  <Route
                    path="/research/results"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <ResearchResultsPage />
                      </Suspense>
                    }
                  />
                  <Route
                    path="/research/results/:address/experiment/:experimentId"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <ResearchExperimentPage />
                      </Suspense>
                    }
                  />
                  <Route
                    path="/research/results/:address/campaign/:category"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <ResearchResultsPage />
                      </Suspense>
                    }
                  />
                  <Route
                    path="/research/results/:address"
                    element={
                      <Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}>
                        <ResearchResultsPage />
                      </Suspense>
                    }
                  />
                  <Route path="*" element={<Suspense fallback={<div className="flex items-center justify-center py-16"><p className="text-muted-foreground">Loading...</p></div>}><NotFoundPage /></Suspense>} />
                </Routes>
              </PageLayout>
            }
          />
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
