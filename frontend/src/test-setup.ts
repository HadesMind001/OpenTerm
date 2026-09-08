// Minimal browser-API stand-ins so modules that touch `window` remain
// importable under the node test environment. This is NOT jsdom — tests
// here target pure logic (framing, state reducers), and that split is on
// purpose: no component render tests, no fake DOM theater.
const g = globalThis as unknown as Record<string, unknown>
if (!g.window) {
  g.window = g
  g.setTimeout = setTimeout
  g.localStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  }
}
