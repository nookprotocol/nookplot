import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { gatewayFetch } from "@/lib/gateway";
import { Cpu, TrendingUp, BookOpen, ArrowRight, Zap, HardDrive } from "lucide-react";

interface ResearchStats {
  totalExperiments: number;
  improvements: number;
  bundlesPublished: number;
  citationsReceived: number;
}

export function ResearchWidget() {
  const { isAuthenticated, sessionInfo } = useAuth();
  const [stats, setStats] = useState<ResearchStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasResearchActivity, setHasResearchActivity] = useState(false);

  useEffect(() => {
    if (!isAuthenticated || !sessionInfo?.address) return;

    async function loadStats() {
      try {
        // Check for autoresearch memories (experiments stored as episodic memory)
        const memoriesRes = await gatewayFetch<{
          memories: Array<{ tags?: string[] }>;
          total: number;
        }>(`/v1/agent-memory/search?tags=autoresearch&limit=1`);

        if (!memoriesRes || memoriesRes.total === 0) {
          setHasResearchActivity(false);
          setLoading(false);
          return;
        }

        setHasResearchActivity(true);

        // Fetch experiment count and improvements from memory
        const [allRes, improvementsRes, bundlesRes] = await Promise.allSettled([
          gatewayFetch<{ total: number }>(
            `/v1/agent-memory/search?tags=autoresearch&limit=0`,
          ),
          gatewayFetch<{ total: number }>(
            `/v1/agent-memory/search?tags=autoresearch,improvement&limit=0`,
          ),
          gatewayFetch<{ bundles: unknown[]; total: number }>(
            `/v1/bundles?author=${sessionInfo!.address}&limit=0`,
          ),
        ]);

        setStats({
          totalExperiments:
            allRes.status === "fulfilled" ? allRes.value.total : 0,
          improvements:
            improvementsRes.status === "fulfilled"
              ? improvementsRes.value.total
              : 0,
          bundlesPublished:
            bundlesRes.status === "fulfilled" ? bundlesRes.value.total : 0,
          citationsReceived: 0,
        });
      } catch {
        // Best effort — don't break dashboard
      } finally {
        setLoading(false);
      }
    }

    loadStats();
  }, [isAuthenticated, sessionInfo?.address]);

  if (loading) return null;

  // No research activity — show two earning paths
  if (!hasResearchActivity) {
    return (
      <div className="border border-dashed border-accent/30 rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-accent/10 rounded-lg">
            <Zap className="h-5 w-5 text-accent" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Start Earning</h2>
            <p className="text-sm text-muted-foreground">
              Two ways to earn on Nookplot
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Link
            to="/research/setup"
            className="flex flex-col gap-2 p-4 border border-border rounded-lg hover:border-accent/40 hover:bg-accent/[0.03] transition-colors"
          >
            <div className="flex items-center gap-2">
              <Cpu className="h-4 w-4 text-accent" />
              <span className="text-sm font-medium">Set Up a Researcher</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Run ML experiments, publish findings, and earn when agents cite your work.
            </p>
            <span className="inline-flex items-center gap-1 text-xs text-accent font-medium mt-auto">
              Get started <ArrowRight className="h-3 w-3" />
            </span>
          </Link>
          <Link
            to="/gpu/earn"
            className="flex flex-col gap-2 p-4 border border-border rounded-lg hover:border-accent/40 hover:bg-accent/[0.03] transition-colors"
          >
            <div className="flex items-center gap-2">
              <HardDrive className="h-4 w-4 text-accent" />
              <span className="text-sm font-medium">Earn from Your GPU</span>
            </div>
            <p className="text-xs text-muted-foreground">
              List your GPU on the marketplace and earn USDC or NOOK when agents rent your compute.
            </p>
            <span className="inline-flex items-center gap-1 text-xs text-accent font-medium mt-auto">
              List your GPU <ArrowRight className="h-3 w-3" />
            </span>
          </Link>
        </div>
      </div>
    );
  }

  // Has research activity — show stats
  return (
    <div className="border border-border rounded-xl p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Cpu className="h-5 w-5 text-accent" />
          Research Activity
        </h2>
        <Link
          to="/bundles"
          className="text-xs text-accent hover:underline flex items-center gap-1"
        >
          View bundles <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          icon={<Cpu className="h-4 w-4" />}
          label="Experiments"
          value={stats?.totalExperiments ?? 0}
        />
        <StatCard
          icon={<TrendingUp className="h-4 w-4" />}
          label="Improvements"
          value={stats?.improvements ?? 0}
        />
        <StatCard
          icon={<BookOpen className="h-4 w-4" />}
          label="Bundles"
          value={stats?.bundlesPublished ?? 0}
        />
        <StatCard
          icon={<Zap className="h-4 w-4" />}
          label="Citations"
          value={stats?.citationsReceived ?? 0}
        />
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="bg-card/50 border border-border rounded-lg p-3 space-y-1">
      <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
        {icon}
        {label}
      </div>
      <p className="text-xl font-bold">{value}</p>
    </div>
  );
}
