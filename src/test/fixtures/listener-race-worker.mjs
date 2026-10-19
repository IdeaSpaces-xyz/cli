// Separate Node process using the built CLI modules, not a mocked in-process lock.
import { existsSync, writeFileSync } from 'node:fs';
import { setListenerEnabled, reconcileListener } from '../../../dist/local/listener.js';

const [mode, thread, barrier] = process.argv.slice(2);
const mark = (suffix, value = '') => writeFileSync(`${barrier}.${suffix}`, value, { flag: 'wx' });
const wait = (suffix) => {
  const end = Date.now() + 8000;
  while (!existsSync(`${barrier}.${suffix}`)) {
    if (Date.now() >= end) throw new Error(`Timed out waiting for ${suffix}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
};
try {
  let result;
  if (mode === 'scan') {
    result = await reconcileListener(thread, async () => { throw new Error('must not retry after a crash'); });
  } else if (mode === 'append' || mode === 'model') {
    result = await reconcileListener(thread, async () => {
      if (mode === 'model') { mark('model-ready'); wait('model-release'); }
      return 'Worker summary';
    }, false, undefined, () => { mark('verified'); wait('release'); });
  } else {
    mark('started');
    result = setListenerEnabled(thread, mode === 'enable');
  }
  mark('done', JSON.stringify(result));
} catch (error) { mark('error', String(error)); process.exitCode = 1; }
