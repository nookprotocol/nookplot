/**
 * React context provider for the sandbox.
 *
 * Holds shared state: Y.Doc, awareness, WebContainer ref.
 * Children access via useSandboxContext().
 */

import { createContext, useContext, useMemo, useState } from "react";
import type { WebContainer } from "@webcontainer/api";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";

interface SandboxContextValue {
  ydoc: Y.Doc | null;
  awareness: Awareness | null;
  collabConnected: boolean;
  webContainer: WebContainer | null;
  /** Writer to send commands to the terminal shell */
  shellWriter: WritableStreamDefaultWriter<string> | null;
  setShellWriter: (w: WritableStreamDefaultWriter<string> | null) => void;
}

const SandboxCtx = createContext<SandboxContextValue>({
  ydoc: null,
  awareness: null,
  collabConnected: false,
  webContainer: null,
  shellWriter: null,
  setShellWriter: () => {},
});

interface SandboxProviderProps {
  ydoc: Y.Doc | null;
  awareness: Awareness | null;
  collabConnected: boolean;
  webContainer: WebContainer | null;
  children: React.ReactNode;
}

export function SandboxProvider({
  ydoc,
  awareness,
  collabConnected,
  webContainer,
  children,
}: SandboxProviderProps) {
  const [shellWriter, setShellWriter] = useState<WritableStreamDefaultWriter<string> | null>(null);

  const value = useMemo(
    () => ({ ydoc, awareness, collabConnected, webContainer, shellWriter, setShellWriter }),
    [ydoc, awareness, collabConnected, webContainer, shellWriter],
  );

  return <SandboxCtx.Provider value={value}>{children}</SandboxCtx.Provider>;
}

export function useSandboxContext(): SandboxContextValue {
  return useContext(SandboxCtx);
}
