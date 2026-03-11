/**
 * Monaco Editor setup — configures local bundle + workers for Vite.
 *
 * By default, @monaco-editor/react loads Monaco from jsDelivr CDN
 * which is slow (~2-5s network fetch). This file configures Monaco
 * to use the locally bundled `monaco-editor` package instead,
 * eliminating the CDN dependency entirely.
 *
 * Import this file once, before any <Editor> component renders.
 *
 * @module lib/monacoSetup
 */

import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";

// Import workers via Vite's ?worker syntax — these run in web workers,
// keeping the main thread responsive during language analysis.
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";

// Tell the browser how to create Monaco workers
self.MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === "typescript" || label === "javascript") return new tsWorker();
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    return new editorWorker();
  },
};

// Tell @monaco-editor/react to use the local instance — skip CDN fetch
loader.config({ monaco });
