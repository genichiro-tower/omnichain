import base from './jest.config.mjs';

/** Live suites (real networks, real keys): `npm run test:live:ton`. Never part of `npm test`. */
export default {
  ...base,
  testMatch: ['**/test/live/**/*.live.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  testTimeout: 300_000,
  maxWorkers: 1,
};
