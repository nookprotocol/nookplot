import { useGatewayQuery } from "./useGatewayQuery";

export interface GuildMember {
  id: string;
  member: { id: string };
  status: number; // 0=None,1=Proposed,2=Approved,3=Rejected,4=Left
  updatedAt: string;
  displayName?: string | null;
}

export interface Guild {
  id: string;
  guildId: string;
  name: string;
  descriptionCid: string;
  proposer: { id: string };
  proposerName?: string | null;
  memberCount: number;
  approvedCount: number;
  status: number; // 0=Proposed, 1=Active, 2=Dissolved
  createdAt: string;
  activatedAt: string | null;
  members?: GuildMember[];
  collectiveSpawns?: Array<{
    id: string;
    childAgent: string;
    bundleId: string;
    initiator: { id: string };
    timestamp: string;
  }>;
}


/** Shape returned by GET /v1/index/guilds */
interface IndexGuildListResponse {
  guilds: Array<{
    id: string;
    guild_id: string;
    name: string;
    description_cid: string;
    proposer_id: string;
    member_count: number;
    approved_count: number;
    status: number;
    created_at: string;
    activated_at: string | null;
    members?: Array<{
      id: string;
      member_id: string;
      status: number;
      updated_at?: string;
    }>;
  }>;
}

/** Shape returned by GET /v1/index/guilds/:id */
interface IndexGuildDetailResponse {
  guild: {
    id: string;
    guild_id: string;
    name: string;
    description_cid: string;
    proposer_id: string;
    proposer_name?: string | null;
    member_count: number;
    approved_count: number;
    status: number;
    created_at: string;
    activated_at: string | null;
    members?: Array<{
      id: string;
      member_id: string;
      status: number;
      updated_at: string;
      display_name?: string | null;
    }>;
    collective_spawns?: Array<{
      id: string;
      child_agent: string;
      bundle_id: string;
      initiator_id: string;
      timestamp: string;
    }>;
  } | null;
}

/** Shape returned by GET /v1/index/agents/:addr/guilds */
interface IndexAgentGuildsResponse {
  memberships: Array<{
    id: string;
    status: number;
    guild: {
      id: string;
      guild_id: string;
      name: string;
      status: number;
      member_count: number;
      approved_count: number;
      created_at: string;
    };
  }>;
}

function toGuild(raw: IndexGuildListResponse["guilds"][number]): Guild {
  return {
    id: raw.id,
    guildId: raw.guild_id,
    name: raw.name,
    descriptionCid: raw.description_cid,
    proposer: { id: raw.proposer_id },
    memberCount: raw.member_count,
    approvedCount: raw.approved_count,
    status: raw.status,
    createdAt: raw.created_at,
    activatedAt: raw.activated_at,
    members: raw.members?.map((m) => ({
      id: m.id,
      member: { id: m.member_id },
      status: m.status,
      updatedAt: m.updated_at ?? "",
    })),
  };
}

function toGuildDetail(raw: IndexGuildDetailResponse["guild"]): Guild | null {
  if (!raw) return null;
  return {
    id: raw.id,
    guildId: raw.guild_id,
    name: raw.name,
    descriptionCid: raw.description_cid,
    proposer: { id: raw.proposer_id },
    proposerName: raw.proposer_name ?? null,
    memberCount: raw.member_count,
    approvedCount: raw.approved_count,
    status: raw.status,
    createdAt: raw.created_at,
    activatedAt: raw.activated_at,
    members: raw.members?.map((m) => ({
      id: m.id,
      member: { id: m.member_id },
      status: m.status,
      updatedAt: m.updated_at,
      displayName: m.display_name ?? null,
    })),
    collectiveSpawns: raw.collective_spawns?.map((s) => ({
      id: s.id,
      childAgent: s.child_agent,
      bundleId: s.bundle_id,
      initiator: { id: s.initiator_id },
      timestamp: s.timestamp,
    })),
  };
}

export function useGuilds(page = 0, pageSize = 20, status?: number | null, sort?: string) {
  const params = new URLSearchParams();
  params.set("first", String(pageSize));
  params.set("skip", String(page * pageSize));
  if (status !== undefined && status !== null) {
    params.set("status", String(status));
  }
  if (sort) {
    params.set("sort", sort);
  }

  const result = useGatewayQuery<IndexGuildListResponse>(
    ["guilds", String(page), String(status ?? "all"), sort ?? "score"],
    `/v1/index/guilds?${params}`,
    { staleTime: 300_000 },
  );

  return {
    guilds: result.data?.guilds?.map(toGuild) ?? [],
    isLoading: result.isLoading,
    isError: result.isError,
  };
}

export function useGuild(guildId: string | undefined) {
  const result = useGatewayQuery<IndexGuildDetailResponse>(
    ["guild", guildId ?? ""],
    `/v1/index/guilds/${guildId}`,
    { enabled: !!guildId, staleTime: 300_000 },
  );

  return {
    guild: toGuildDetail(result.data?.guild ?? null),
    isLoading: result.isLoading,
  };
}

// ---- Guild-Project associations ----

export interface GuildProject {
  projectId: string;
  name: string;
  description: string | null;
  languages: string[];
  tags: string[];
  status: string;
  createdAt: string;
  creatorAddress: string;
  creatorName: string | null;
  linkedAt: string;
  /** If project was created through a guild, the guild's numeric ID. */
  guildId: string | null;
  /** Resolved guild name for attribution display. */
  guildName: string | null;
  /** Task progress stats (enriched by backend LATERAL join). */
  totalTasks: number;
  completedTasks: number;
  inProgressTasks: number;
  lastActivityAt: string | null;
}

interface GuildProjectsResponse {
  projects: GuildProject[];
  total: number;
  limit: number;
  offset: number;
}

export interface ProjectGuild {
  guildId: string;
  name: string;
  status: number;
  memberCount: number;
  linkedAt: string;
}

interface ProjectGuildsResponse {
  guilds: ProjectGuild[];
  total: number;
}

export function useGuildProjects(guildId: string | undefined) {
  const result = useGatewayQuery<GuildProjectsResponse>(
    ["guild-projects", guildId ?? ""],
    `/v1/guilds/${guildId}/projects`,
    { enabled: !!guildId, staleTime: 300_000 },
  );

  return {
    projects: result.data?.projects ?? [],
    total: result.data?.total ?? 0,
    isLoading: result.isLoading,
  };
}

export function useProjectGuilds(projectId: string | undefined) {
  const result = useGatewayQuery<ProjectGuildsResponse>(
    ["project-guilds", projectId ?? ""],
    `/v1/projects/${projectId}/guilds`,
    { enabled: !!projectId, staleTime: 300_000 },
  );

  return {
    guilds: result.data?.guilds ?? [],
    total: result.data?.total ?? 0,
    isLoading: result.isLoading,
  };
}

export function useAgentGuilds(address: string | undefined) {
  const result = useGatewayQuery<IndexAgentGuildsResponse>(
    ["agent-guilds", address ?? ""],
    `/v1/index/agents/${address?.toLowerCase()}/guilds`,
    { enabled: !!address, staleTime: 300_000 },
  );

  const memberships = (result.data?.memberships ?? []).map((m) => ({
    id: m.id,
    status: m.status,
    guild: {
      id: m.guild.id,
      guildId: m.guild.guild_id,
      name: m.guild.name,
      status: m.guild.status,
      memberCount: m.guild.member_count,
      approvedCount: m.guild.approved_count,
      createdAt: m.guild.created_at,
      // Fill required fields with defaults for type compatibility
      descriptionCid: "",
      proposer: { id: "" },
      activatedAt: null,
    } as Guild,
  }));

  return {
    memberships,
    isLoading: result.isLoading,
  };
}
