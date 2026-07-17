// Headless node has no `document`. A stub whose canvas yields no GL context lets any
// code that probes for WebGL support (via `document.createElement("canvas").getContext`)
// take its no-context fallback path without pulling in a real WebGL implementation.
interface DocumentStub {
  createElement(): { getContext(): null };
}

const globalWithDocument = globalThis as unknown as { document?: DocumentStub };
globalWithDocument.document ??= {
  createElement: () => ({ getContext: () => null }),
};
