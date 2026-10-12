// Test-only fixture check against the installed host; no installs or emitted files.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostRequire, piRoot, piPackage } from "./installed.mjs";

const ts = hostRequire("typescript");
const root = fileURLToPath(new URL("../..", import.meta.url));
const program = ts.createProgram([fileURLToPath(new URL("./tui-fixture.ts", import.meta.url))], {
  strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  paths: {
    [piPackage.name]: [join(piRoot, "dist/index.d.ts")],
    "@earendil-works/pi-ai": [join(piRoot, "node_modules/@earendil-works/pi-ai/dist/index.d.ts")],
  },
  typeRoots: [join(root, "node_modules/@types"), join(piRoot, "node_modules/@types")],
  types: ["node"],
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root,
    getCanonicalFileName: f => f,
    getNewLine: () => "\n",
  }));
  process.exitCode = 1;
} else console.log(`TUI fixture typecheck passed against installed ${piPackage.name} ${piPackage.version}`);
