import { buildWorker } from './build-worker.mjs';

// Keep test output separate from deployable assets. Release restoration and
// immutability are covered with fixture archives in test/releases.test.mjs.
await buildWorker({}, new URL('./.test-dist/', import.meta.url));
