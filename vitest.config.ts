import { defineConfig } from 'vitest/config'

// Timeouts are sized from measured data (2026-10-05), not guesswork:
//   tests/capabilities.test.ts > parses all repository Agent Skills samples  36.7s
//   tests/capabilities.test.ts > rejects legacy invocation keys…             23.4s
//   tests/capabilities.test.ts > installs a GitHub skill directory…8.6s
//   tests/plugin-runner.test.ts > timeout and active cancellation…           21.8s
// These are real work (parsing 10 shipped skill bundles, real tar extraction,
// GitHub tarball downloads), not hangs — so the limit sits above the slowest
// observed case with headroom, while staying low enough to still catch a hang.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['.references/**', 'node_modules/**', 'out/**', 'release/**'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    teardownTimeout: 30_000,
  },
})
