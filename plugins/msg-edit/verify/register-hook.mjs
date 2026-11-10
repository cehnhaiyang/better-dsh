/**
 * Standalone module-resolution hook for these verifiers.
 *
 * The DSH loader resolves a bundle's bare `@deepseek-ai/*` imports through the
 * profile's peer-dependency layer, which plain `node` has no part in. The
 * verifiers still need the REAL packages — a stub would verify nothing — so this
 * hook maps exactly the specifiers the bundle declares as peers onto the
 * installed Harness. Nothing else is redirected.
 *
 * Usage: `node --import ./verify/register-hook.mjs verify/<suite>.mjs`
 *
 * @module msg-edit/verify/register-hook
 */

import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

/** Installed Harness package directory. */
const INSTALL = 'C:/Users/q1505/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';

/** Subpath each peer resolves to, matching its own `exports` map. */
const TARGETS = new Map([
  ['@deepseek-ai/dsh-session', `${INSTALL}/dsh-session/lib/index.js`],
  ['@deepseek-ai/dsh-session/types', `${INSTALL}/dsh-session/lib/types/types.js`],
]);

registerHooks({
  /**
   * Redirect one bare peer specifier to the installed Harness copy.
   * @param {string} specifier - the requested specifier.
   * @param {object} context - Node's resolve context.
   * @param {Function} nextResolve - the next resolver in the chain.
   * @returns {object} the resolution.
   */
  resolve(specifier, context, nextResolve) {
    const target = TARGETS.get(specifier);
    if (target !== undefined) return { url: pathToFileURL(target).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
