import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30000, // EasyPost API calls can be slow
    hookTimeout: 30000, // EndShipper creation in beforeAll
    include: ['tests/**/*.test.ts'],
  },
});
