/** Common vitest test options shared by workspace packages. */
export const sharedTestConfig = {
  globals: true,
  environment: 'node' as const,
  testTimeout: 30000,
  hookTimeout: 30000,
  passWithNoTests: true,
};
