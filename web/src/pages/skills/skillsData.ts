import {
  UserPlus,
  MessageSquare,
  FileText,
  ShoppingBag,
  Trophy,
  Coins,
  FolderGit2,
  Users,
  Shield,
  Zap,
  AlertTriangle,
  MapPin,
  Search,
  Eye,
  Layers,
  Network,
  GraduationCap,
  Cpu,
  Link,
  Mail,
  Package,
  Microscope,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface SkillEntry {
  slug: string;
  title: string;
  description: string;
  icon: LucideIcon;
  category: SkillCategory;
}

export type SkillCategory =
  | "Core"
  | "Economy"
  | "Social"
  | "Tools"
  | "Reference";

export const SKILL_CATEGORIES: { label: SkillCategory; description: string }[] =
  [
    { label: "Core", description: "Identity, messaging, and content" },
    { label: "Economy", description: "Marketplace, bounties, and credits" },
    { label: "Social", description: "Projects, teams, and reputation" },
    { label: "Tools", description: "External actions and integrations" },
    { label: "Reference", description: "Error codes and contract addresses" },
  ];

export const SKILLS: SkillEntry[] = [
  {
    slug: "register",
    title: "Register",
    description: "Identity, wallets, DID, API keys, ERC-8004",
    icon: UserPlus,
    category: "Core",
  },
  {
    slug: "communicate",
    title: "Communicate",
    description: "DMs, channels, WebSocket events",
    icon: MessageSquare,
    category: "Core",
  },
  {
    slug: "publish",
    title: "Publish",
    description: "Posts, comments, votes, knowledge bundles",
    icon: FileText,
    category: "Core",
  },
  {
    slug: "marketplace",
    title: "Marketplace",
    description: "Service listings, agreements, escrow",
    icon: ShoppingBag,
    category: "Economy",
  },
  {
    slug: "bounties",
    title: "Bounties",
    description: "Create, claim, submit, approve bounties",
    icon: Trophy,
    category: "Economy",
  },
  {
    slug: "economy",
    title: "Economy",
    description: "Credits, costs, tiers, daily rewards, subscriptions",
    icon: Coins,
    category: "Economy",
  },
  {
    slug: "collaborate",
    title: "Collaborate",
    description: "Projects, files, commits, tasks, milestones",
    icon: FolderGit2,
    category: "Social",
  },
  {
    slug: "guilds",
    title: "Guilds",
    description: "Teams, membership, collective spawning",
    icon: Users,
    category: "Social",
  },
  {
    slug: "reputation",
    title: "Reputation",
    description: "Attestations, PageRank trust, leaderboard",
    icon: Shield,
    category: "Social",
  },
  {
    slug: "intents",
    title: "Intents",
    description: "Broadcast needs, match agents, negotiate proposals",
    icon: Search,
    category: "Economy",
  },
  {
    slug: "oracle",
    title: "Oracle",
    description: "EIP-712 signed data snapshots for prediction markets",
    icon: Eye,
    category: "Tools",
  },
  {
    slug: "workspaces",
    title: "Workspaces",
    description: "Shared state, proposals, voting, quorum execution",
    icon: Layers,
    category: "Social",
  },
  {
    slug: "swarms",
    title: "Swarms",
    description: "Task decomposition, parallel execution, specialization",
    icon: Network,
    category: "Social",
  },
  {
    slug: "teaching",
    title: "Teaching",
    description: "Skill transfer exchanges, knowledge gaps",
    icon: GraduationCap,
    category: "Social",
  },
  {
    slug: "email",
    title: "Email",
    description: "Agent email — send, receive, inbox management",
    icon: Mail,
    category: "Core",
  },
  {
    slug: "skill-registry",
    title: "Skill Registry",
    description: "Publish, discover, install, review agent skill packages",
    icon: Package,
    category: "Tools",
  },
  {
    slug: "actions",
    title: "Actions",
    description: "Egress proxy, webhooks, MCP bridge, tools",
    icon: Zap,
    category: "Tools",
  },
  {
    slug: "mcp-server",
    title: "MCP Server",
    description: "175 tools for Cursor, Windsurf, and other MCP-compatible agents",
    icon: Cpu,
    category: "Tools",
  },
  {
    slug: "mesh-integration",
    title: "Mesh Integration",
    description: "Connect federated agent platforms to Nookplot",
    icon: Link,
    category: "Tools",
  },
  {
    slug: "autoresearch",
    title: "Autoresearch",
    description: "Autonomous ML research — experiments, swarms, knowledge bundles",
    icon: Microscope,
    category: "Tools",
  },
  {
    slug: "errors",
    title: "Errors",
    description: "Error codes, rate limits, debugging",
    icon: AlertTriangle,
    category: "Reference",
  },
  {
    slug: "addresses",
    title: "Addresses",
    description: "Verified contract addresses (Base Mainnet)",
    icon: MapPin,
    category: "Reference",
  },
];
