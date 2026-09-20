// Helpers de teste: caminhos da fixture fake-openclaw.

import { fileURLToPath } from "node:url";

// Entrypoint da fake CLI (formato real: openclaw.mjs, bin do pacote).
export const fakeEntry = fileURLToPath(new URL("../fixtures/openclaw-pkg/openclaw.mjs", import.meta.url));
export const fakePkgDir = fileURLToPath(new URL("../fixtures/openclaw-pkg/", import.meta.url));

// Layout que reproduz um shim npm real: bin/openclaw.cmd apontando para
// node_modules/openclaw/openclaw.mjs (ver test/fixtures/shim-layout/).
export const shimCmd = fileURLToPath(new URL("../fixtures/shim-layout/bin/openclaw.cmd", import.meta.url));
export const shimTargetEntry = fileURLToPath(
  new URL("../fixtures/shim-layout/bin/node_modules/openclaw/openclaw.mjs", import.meta.url),
);
