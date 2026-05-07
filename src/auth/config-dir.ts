/**
 * Shared config-dir resolution.
 *
 * Computed lazily so tests can override `HOME` between
 * `vi.resetModules()` boundaries — constants captured at import time
 * would freeze the path.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export function configDir(): string {
  return join(homedir(), ".ideaspaces");
}
