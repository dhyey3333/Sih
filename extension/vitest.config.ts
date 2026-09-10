import { defineConfig } from 'vitest/config';

// The PII engine is deliberately DOM-free so it can be tested in plain Node and
// reused by the offline data generator. DOM-dependent modules (renderer, snapshot)
// are covered by the browser-level checks in eval/ instead.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
