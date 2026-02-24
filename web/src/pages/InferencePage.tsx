import { useState, useRef, useEffect } from "react";
import { Bot, Send, Key, Trash2, Zap } from "lucide-react";
import { GATEWAY_URL } from "@/config/constants";

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ModelInfo {
  provider: string;
  model: string;
  displayName: string;
  contextWindow: number;
  promptPricePerMToken: number;
  completionPricePerMToken: number;
}

interface ByokEntry {
  provider: string;
  createdAt: string;
}

export function InferencePage() {
  const [apiKey, setApiKey] = useState("");
  const [connected, setConnected] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [lastCost, setLastCost] = useState<number | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [byokProviders, setByokProviders] = useState<ByokEntry[]>([]);
  const [byokProvider, setByokProvider] = useState("");
  const [byokKey, setByokKey] = useState("");
  const [byokStatus, setByokStatus] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const fetchModels = async () => {
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/inference/models`);
      const data = await res.json() as { models: ModelInfo[] };
      setModels(data.models);
      if (data.models.length > 0) {
        setSelectedProvider(data.models[0].provider);
        setSelectedModel(data.models[0].model);
      }
    } catch {
      // silently fail
    }
  };

  const fetchByok = async () => {
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/byok`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const data = await res.json() as { providers: ByokEntry[] };
      setByokProviders(data.providers);
    } catch {
      // silently fail
    }
  };

  const handleConnect = () => {
    if (!apiKey.trim()) return;
    setConnected(true);
    fetchModels();
    fetchByok();
  };

  const providerModels = models.filter((m) => m.provider === selectedProvider);
  const providers = [...new Set(models.map((m) => m.provider))];

  const handleSend = async () => {
    if (!input.trim() || isStreaming) return;

    const userMessage: Message = { role: "user", content: input.trim() };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput("");
    setIsStreaming(true);
    setLastCost(null);

    try {
      const res = await fetch(`${GATEWAY_URL}/v1/inference/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          provider: selectedProvider,
          model: selectedModel,
          messages: updatedMessages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
        setMessages([...updatedMessages, { role: "assistant", content: `Error: ${err.error ?? "Unknown error"}` }]);
        setIsStreaming(false);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";
      let assistantContent = "";

      setMessages([...updatedMessages, { role: "assistant", content: "" }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") continue;

          try {
            const chunk = JSON.parse(payload) as { delta?: string; done?: boolean; usage?: { promptTokens: number; completionTokens: number }; error?: string };
            if (chunk.error) {
              assistantContent += `\n[Error: ${chunk.error}]`;
            } else if (chunk.delta) {
              assistantContent += chunk.delta;
            }
            if (chunk.usage) {
              // Find model pricing to compute cost display
              const modelInfo = models.find((m) => m.model === selectedModel);
              if (modelInfo) {
                const cost = Math.ceil(
                  (chunk.usage.promptTokens / 1_000_000) * modelInfo.promptPricePerMToken +
                  (chunk.usage.completionTokens / 1_000_000) * modelInfo.completionPricePerMToken,
                );
                setLastCost(cost);
              }
            }
            setMessages([...updatedMessages, { role: "assistant", content: assistantContent }]);
          } catch {
            // skip malformed
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      setMessages([...updatedMessages, { role: "assistant", content: `Error: ${msg}` }]);
    } finally {
      setIsStreaming(false);
      // Refresh balance
      try {
        const balRes = await fetch(`${GATEWAY_URL}/v1/credits/balance`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        const balData = await balRes.json() as { balance: number };
        setBalance(balData.balance);
      } catch {
        // silently fail
      }
    }
  };

  const handleByokStore = async () => {
    if (!byokProvider || !byokKey) return;
    setByokStatus("Storing...");
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/byok`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ provider: byokProvider, apiKey: byokKey }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        setByokStatus(err.error ?? "Failed");
        return;
      }
      setByokStatus("Stored!");
      setByokKey("");
      fetchByok();
    } catch {
      setByokStatus("Failed");
    }
  };

  const handleByokRemove = async (provider: string) => {
    try {
      await fetch(`${GATEWAY_URL}/v1/byok/${provider}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      fetchByok();
    } catch {
      // silently fail
    }
  };

  if (!connected) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Bot className="h-6 w-6 text-accent" />
          <h1 className="text-2xl font-bold">Inference</h1>
        </div>
        <div className="max-w-md space-y-4">
          <p className="text-sm text-muted-foreground">
            Chat with AI models using your agent credits. Enter your gateway API key to begin.
          </p>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="nk_..."
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
            onKeyDown={(e) => e.key === "Enter" && handleConnect()}
          />
          <button
            onClick={handleConnect}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90"
          >
            Connect
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Bot className="h-6 w-6 text-accent" />
          <h1 className="text-2xl font-bold">Inference</h1>
        </div>
        {balance !== null && (
          <span className="rounded-full border border-border px-3 py-1 text-sm text-muted-foreground">
            Balance: {balance.toLocaleString()} credits
          </span>
        )}
      </div>

      {/* Model Selector */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={selectedProvider}
          onChange={(e) => {
            setSelectedProvider(e.target.value);
            const firstModel = models.find((m) => m.provider === e.target.value);
            if (firstModel) setSelectedModel(firstModel.model);
          }}
          className="rounded-lg border border-border bg-card px-3 py-2 text-sm"
        >
          {providers.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <select
          value={selectedModel}
          onChange={(e) => setSelectedModel(e.target.value)}
          className="rounded-lg border border-border bg-card px-3 py-2 text-sm"
        >
          {providerModels.map((m) => (
            <option key={m.model} value={m.model}>{m.displayName}</option>
          ))}
        </select>
        {lastCost !== null && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Zap className="h-3 w-3" /> {lastCost.toLocaleString()} credits
          </span>
        )}
      </div>

      {/* Chat Messages */}
      <div className="rounded-xl border border-border bg-card min-h-[300px] max-h-[500px] overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-8">Send a message to start chatting.</p>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[80%] rounded-lg px-4 py-2 text-sm whitespace-pre-wrap ${
              msg.role === "user"
                ? "bg-accent text-white"
                : "bg-muted text-foreground"
            }`}>
              {msg.content || (isStreaming && i === messages.length - 1 ? "..." : "")}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
          placeholder="Type a message..."
          disabled={isStreaming}
          className="flex-1 rounded-lg border border-border bg-card px-4 py-2 text-sm disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={isStreaming || !input.trim()}
          className="rounded-lg bg-accent px-4 py-2 text-white hover:bg-accent/90 disabled:opacity-50"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>

      {/* BYOK Management */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Key className="h-4 w-4 text-accent" />
          <h3 className="font-semibold">Bring Your Own Key (BYOK)</h3>
        </div>
        <p className="text-xs text-muted-foreground">
          Store your own API keys to use instead of gateway defaults. Keys are encrypted at rest.
        </p>

        {byokProviders.length > 0 && (
          <div className="space-y-2">
            {byokProviders.map((b) => (
              <div key={b.provider} className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-2">
                <span className="text-sm font-medium">{b.provider}</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{new Date(b.createdAt).toLocaleDateString()}</span>
                  <button onClick={() => handleByokRemove(b.provider)} className="text-red-400 hover:text-red-300">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <select
            value={byokProvider}
            onChange={(e) => setByokProvider(e.target.value)}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
          >
            <option value="">Provider...</option>
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="minimax">MiniMax</option>
          </select>
          <input
            type="password"
            value={byokKey}
            onChange={(e) => setByokKey(e.target.value)}
            placeholder="sk-..."
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm"
          />
          <button onClick={handleByokStore} className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted">
            Store
          </button>
        </div>
        {byokStatus && <p className="text-xs text-muted-foreground">{byokStatus}</p>}
      </div>
    </div>
  );
}
