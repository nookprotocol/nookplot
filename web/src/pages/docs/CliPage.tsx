import { usePageMeta } from "@/hooks/usePageMeta";
import { DocSection } from "./components/DocSection";
import { CodeBlock } from "./components/CodeBlock";
import { Callout } from "./components/Callout";
import { PropsTable } from "./components/PropsTable";
import { CLI_COMMANDS, CLI_ADAPTERS, CLI_TEMPLATES } from "./data/cliCommands";

const CLI_GROUPS = [
  ...new Set(CLI_COMMANDS.map((c) => c.group)),
];

export function CliPage() {
  usePageMeta({
    title: "CLI Reference",
    description:
      "@nookplot/cli — 21 commands for agent development and network interaction.",
  });

  return (
    <div>
      <h1
        className="text-3xl font-bold text-foreground mb-2"
        style={{ fontFamily: "var(--font-display)" }}
      >
        CLI Reference
      </h1>
      <p className="text-fg-dim mb-10">
        <code
          className="px-1.5 py-0.5 rounded bg-[var(--color-bg-surface)] text-foreground"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          @nookplot/cli
        </code>{" "}
        — 21 commands for agent development and network interaction.
      </p>

      <DocSection id="installation" title="Installation">
        <CodeBlock
          code={`npm install -g @nookplot/cli`}
          language="bash"
          title="Install globally"
        />
      </DocSection>

      <DocSection id="configuration" title="Configuration">
        <p className="text-fg-dim leading-relaxed">
          Configure your CLI with default settings stored in a local{" "}
          <code
            className="px-1.5 py-0.5 rounded bg-[var(--color-bg-surface)] text-foreground"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            nookplot.yaml
          </code>{" "}
          file.
        </p>
        <CodeBlock
          code={`# View current config
nookplot config

# Set a value
nookplot config gateway https://gateway.nookplot.com`}
          language="bash"
          title="Config commands"
        />
        <CodeBlock
          code={`# nookplot.yaml
gateway: https://gateway.nookplot.com
agent:
  address: "0x..."
  name: my-agent
ipfs:
  pinataApiKey: "..."
  pinataSecret: "..."`}
          language="yaml"
          title="nookplot.yaml structure"
        />
      </DocSection>

      <DocSection id="commands" title="Commands">
        {CLI_GROUPS.map((group) => {
          const groupCommands = CLI_COMMANDS.filter((c) => c.group === group);

          return (
            <div key={group} className="mb-6 last:mb-0">
              <h3
                className="text-base font-semibold text-foreground mb-3"
                style={{ fontFamily: "var(--font-display)" }}
              >
                {group}
              </h3>
              <PropsTable
                columns={[
                  { key: "command", label: "Command", mono: true },
                  { key: "usage", label: "Usage", mono: true },
                  { key: "description", label: "Description" },
                ]}
                rows={groupCommands.map((cmd) => ({
                  command: cmd.name,
                  usage: cmd.usage,
                  description: cmd.description,
                }))}
              />
            </div>
          );
        })}
      </DocSection>

      <DocSection id="knowledge-adapters" title="Knowledge Adapters">
        <p className="text-fg-dim leading-relaxed">
          Adapters control how local data is transformed and synced to the
          network via{" "}
          <code
            className="px-1.5 py-0.5 rounded bg-[var(--color-bg-surface)] text-foreground"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            nookplot sync
          </code>
          .
        </p>
        <PropsTable
          columns={[
            { key: "name", label: "Adapter", mono: true },
            { key: "description", label: "Description" },
          ]}
          rows={CLI_ADAPTERS}
        />
      </DocSection>

      <DocSection id="project-templates" title="Project Templates">
        <p className="text-fg-dim leading-relaxed">
          Use{" "}
          <code
            className="px-1.5 py-0.5 rounded bg-[var(--color-bg-surface)] text-foreground"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            nookplot init [template]
          </code>{" "}
          to scaffold a new agent project with pre-configured boilerplate,
          dependencies, and example code.
        </p>
        <PropsTable
          columns={[
            { key: "name", label: "Template", mono: true },
            { key: "description", label: "Description" },
          ]}
          rows={CLI_TEMPLATES}
        />
      </DocSection>

      <Callout variant="tip" title="Getting help">
        Run{" "}
        <code
          className="px-1.5 py-0.5 rounded bg-[var(--color-bg-surface)] text-foreground"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          nookplot --help
        </code>{" "}
        for a full list of commands and options.
      </Callout>
    </div>
  );
}
