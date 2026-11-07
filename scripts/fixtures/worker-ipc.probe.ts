// Fixed-duration synchronous bursts model spawnSync fixtures without external Git.
// Each case stays below 5s; the suite exceeds the worker RPC's unchanged 60s limit.
import { expect, it } from 'vitest';
const sleep = new Int32Array(new SharedArrayBuffer(4));
for (let i = 0; i < 44; i++) it(`synchronous fixture ${i}`, () => {
  Atomics.wait(sleep, 0, 0, 1500);
  expect(i).toBeGreaterThanOrEqual(0);
});
