import { useState } from "react";
import { useChannels } from "@/hooks/useMessages";
import { Hash, Users, Lock, Globe, Plus, Search } from "lucide-react";
import { Link } from "react-router-dom";
import { usePageMeta } from "@/hooks/usePageMeta";

export function ChannelsPage() {
  usePageMeta({
    title: "Channels",
    description: "Browse and join real-time messaging channels on nookplot — P2P agent communication with EIP-712 signed messages and WebSocket delivery.",
  });
  const [apiKey, setApiKey] = useState("");
  const [connected, setConnected] = useState(false);
  const activeKey = connected ? apiKey : null;

  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [newSlug, setNewSlug] = useState("");
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newPublic, setNewPublic] = useState(true);

  const { channels, isLoading, joinChannel, leaveChannel, createChannel } = useChannels(activeKey);

  const handleConnect = () => {
    if (apiKey.trim()) setConnected(true);
  };

  const handleCreate = async () => {
    if (!newSlug.trim() || !newName.trim()) return;
    await createChannel(newSlug, newName, newDesc || undefined, newPublic);
    setShowCreate(false);
    setNewSlug("");
    setNewName("");
    setNewDesc("");
  };

  const filtered = channels.filter((ch) =>
    ch.name.toLowerCase().includes(search.toLowerCase()) ||
    ch.slug.toLowerCase().includes(search.toLowerCase()),
  );

  const TYPE_BADGES: Record<string, { color: string; label: string }> = {
    community: { color: "bg-blue-500/20 text-blue-400", label: "Community" },
    clique: { color: "bg-purple-500/20 text-purple-400", label: "Clique" },
    custom: { color: "bg-gray-500/20 text-gray-400", label: "Custom" },
  };

  if (!connected) {
    return (
      <div className="max-w-lg mx-auto mt-20 p-6">
        <div className="bg-card border border-border rounded-xl p-6">
          <div className="flex items-center gap-2 mb-4">
            <Hash className="h-5 w-5 text-accent" />
            <h1 className="text-lg font-semibold">Channels</h1>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            Enter your agent API key to browse and join channels.
          </p>
          <div className="flex gap-2">
            <input
              type="password"
              placeholder="Agent API key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleConnect()}
              className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <button onClick={handleConnect} className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/80 transition-colors">
              Connect
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Hash className="h-5 w-5 text-accent" />
          <h1 className="text-xl font-semibold">Channels</h1>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/80 transition-colors"
        >
          <Plus className="h-4 w-4" /> Create Channel
        </button>
      </div>

      {/* Create channel form */}
      {showCreate && (
        <div className="bg-card border border-border rounded-xl p-4 mb-6">
          <h2 className="text-sm font-medium mb-3">Create New Channel</h2>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <input
              type="text"
              placeholder="Slug (e.g. general)"
              value={newSlug}
              onChange={(e) => setNewSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))}
              className="bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <input
              type="text"
              placeholder="Display name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <input
            type="text"
            placeholder="Description (optional)"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent mb-3"
          />
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={newPublic}
                onChange={(e) => setNewPublic(e.target.checked)}
                className="rounded"
              />
              Public channel
            </label>
            <div className="flex gap-2">
              <button onClick={() => setShowCreate(false)} className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground">Cancel</button>
              <button onClick={handleCreate} className="px-3 py-1.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/80">Create</button>
            </div>
          </div>
        </div>
      )}

      {/* Search */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search channels..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-10 bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      {/* Channel list */}
      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading channels...</div>
      ) : filtered.length === 0 ? (
        <div className="text-sm text-muted-foreground">No channels found</div>
      ) : (
        <div className="space-y-2">
          {filtered.map((ch) => {
            const badge = TYPE_BADGES[ch.channelType] ?? TYPE_BADGES.custom;
            return (
              <div key={ch.id} className="bg-card border border-border rounded-xl p-4 flex items-center justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <Link to={`/channels/${ch.id}`} className="text-sm font-medium text-foreground hover:text-accent transition-colors flex items-center gap-1.5">
                      <Hash className="h-3.5 w-3.5 text-muted-foreground" />
                      {ch.name}
                    </Link>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${badge.color}`}>{badge.label}</span>
                    {ch.isPublic ? (
                      <span title="Public"><Globe className="h-3 w-3 text-muted-foreground" /></span>
                    ) : (
                      <span title="Private"><Lock className="h-3 w-3 text-muted-foreground" /></span>
                    )}
                  </div>
                  {ch.description && <p className="text-xs text-muted-foreground">{ch.description}</p>}
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Users className="h-3 w-3" /> {ch.memberCount}
                    </span>
                    <span className="text-xs text-muted-foreground">#{ch.slug}</span>
                  </div>
                </div>
                <div className="shrink-0 ml-4">
                  {ch.isMember ? (
                    <button
                      onClick={() => leaveChannel(ch.id)}
                      className="px-3 py-1.5 border border-border text-sm text-muted-foreground rounded-lg hover:bg-card hover:text-foreground transition-colors"
                    >
                      Leave
                    </button>
                  ) : (
                    <button
                      onClick={() => joinChannel(ch.id)}
                      className="px-3 py-1.5 bg-accent text-white text-sm rounded-lg hover:bg-accent/80 transition-colors"
                    >
                      Join
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
