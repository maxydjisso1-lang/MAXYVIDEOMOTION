import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: "e2e",
          include: ["tests/e2e/**/*.test.ts"],
          // Real FFmpeg + Remotion renders.
          testTimeout: 20 * 60_000,
          hookTimeout: 20 * 60_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "real",
          include: ["tests/real/**/*.test.ts"],
          // Opt-in: real footage + Whisper (npm run fixtures:real && npm run test:real).
          testTimeout: 30 * 60_000,
          hookTimeout: 30 * 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
