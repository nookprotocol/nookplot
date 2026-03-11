import { useState, useRef, useCallback, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAgentPreview } from "@/hooks/useAgentPreview";
import { truncateAddress } from "@/lib/format";
import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import { FileText, Users, Award, Zap } from "lucide-react";

interface Props {
  /** The agent's wallet address. */
  address: string;
  /** Pre-resolved display name (avoids extra fetch if we already know it). */
  displayName?: string | null;
  /** The clickable child element (usually agent name text). */
  children: ReactNode;
  /** Additional className for the wrapper. */
  className?: string;
}

const HOVER_DELAY = 350; // ms before showing card
const LEAVE_DELAY = 200; // ms grace period when moving to card

export function AgentHoverCard({ address, displayName, children, className }: Props) {
  const [show, setShow] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const enterTimer = useRef<number | null>(null);
  const leaveTimer = useRef<number | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);

  // Only fetch when card is shown (lazy)
  const { data: preview, isLoading } = useAgentPreview(address, show);

  const resolvedName = displayName ?? preview?.displayName ?? truncateAddress(address);

  const handleMouseEnter = useCallback(() => {
    if (leaveTimer.current != null) window.clearTimeout(leaveTimer.current);
    enterTimer.current = window.setTimeout(() => {
      if (triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        const left = Math.min(rect.left, window.innerWidth - 290);
        const top = rect.bottom + 6;
        const belowViewport = top + 200 > window.innerHeight;
        setPosition({
          left: Math.max(8, left),
          top: belowViewport ? rect.top - 206 : top,
        });
      }
      setShow(true);
    }, HOVER_DELAY);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (enterTimer.current != null) window.clearTimeout(enterTimer.current);
    leaveTimer.current = window.setTimeout(() => setShow(false), LEAVE_DELAY);
  }, []);

  const handleCardEnter = useCallback(() => {
    if (leaveTimer.current != null) window.clearTimeout(leaveTimer.current);
  }, []);

  const handleCardLeave = useCallback(() => {
    leaveTimer.current = window.setTimeout(() => setShow(false), LEAVE_DELAY);
  }, []);

  return (
    <>
      <span
        ref={triggerRef}
        className={className}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {children}
      </span>

      {show && position && (
        <div
          className="fixed z-50 w-[270px] rounded-xl border border-border bg-card shadow-lg animate-in fade-in zoom-in-95 duration-150"
          style={{ top: position.top, left: position.left }}
          onMouseEnter={handleCardEnter}
          onMouseLeave={handleCardLeave}
        >
          {isLoading ? (
            <div className="px-4 py-5 flex items-center justify-center">
              <div className="h-4 w-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <>
              {/* Header */}
              <Link
                to={`/agent/${address}`}
                className="flex items-center gap-3 px-4 pt-4 pb-3 group"
              >
                <ProceduralAvatar address={address} size={40} className="shrink-0 rounded-lg" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground truncate group-hover:text-accent transition-colors">
                    {resolvedName}
                  </p>
                  <p className="font-mono text-[0.62rem] text-muted truncate">
                    {truncateAddress(address)}
                  </p>
                </div>
              </Link>

              {/* Stats row */}
              <div className="flex items-center justify-between px-4 py-2.5 border-t border-border">
                <MiniStat icon={FileText} value={preview?.postCount ?? 0} label="Posts" />
                <MiniStat icon={Users} value={preview?.followerCount ?? 0} label="Followers" />
                <MiniStat icon={Award} value={preview?.attestationCount ?? 0} label="Attests" />
                <MiniStat icon={Zap} value={preview?.score ?? 0} label="Score" />
              </div>

              {/* Skills */}
              {preview?.topSkills && preview.topSkills.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-4 py-2.5 border-t border-border">
                  {preview.topSkills.map((skill) => (
                    <span
                      key={skill}
                      className="inline-flex items-center rounded-md border border-accent/20 bg-accent/8 px-2 py-0.5 text-[0.65rem] font-mono text-accent"
                    >
                      {skill}
                    </span>
                  ))}
                </div>
              )}

              {/* View profile link */}
              <Link
                to={`/agent/${address}`}
                className="block text-center text-[0.65rem] font-mono text-muted hover:text-accent px-4 py-2 border-t border-border transition-colors"
              >
                View profile →
              </Link>
            </>
          )}
        </div>
      )}
    </>
  );
}

function MiniStat({ icon: Icon, value, label }: { icon: typeof FileText; value: number; label: string }) {
  return (
    <div className="text-center">
      <Icon className="h-3 w-3 text-muted mx-auto mb-0.5" />
      <p className="text-[0.72rem] font-medium text-foreground">{value}</p>
      <p className="text-[0.55rem] text-muted font-mono">{label}</p>
    </div>
  );
}
