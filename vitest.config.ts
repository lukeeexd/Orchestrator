import { defineConfig } from 'vitest/config';

// Pure-function unit tests live under tests/unit. They never touch
// Electron — anything that imports `electron` directly is mocked at
// the test level (see tests/unit/*.test.ts).
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
  },
});
