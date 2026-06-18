import { defineConfig } from 'vitest/config';

// 仅单测纯逻辑（app/splitQuality.ts 等）——node 环境，无 jsdom/RTL。
// UI 接线靠 `npx tsc --noEmit` + `npm run build` + 手动走查。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['app/**/*.test.ts', 'components/**/*.test.ts'],
  },
});
