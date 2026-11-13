/* dsh-rewind host half — snapshot-cleanup.js, split out of dsh-rewind-plugin 0.21.0 lib/index.js. */

import { mkdir as mkdir2, readFile as readFile2, rename as rename2, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname2, join as join2 } from "node:path";
import { resolveDshHome as resolveDshHome2 } from "@deepseek-ai/dsh-home-paths";

// src/snapshot-cleanup.ts

var DEFAULT_MAX_AGE_DAYS = 30;
var DEFAULT_CLEANUP_CONFIG = { enabled: false, maxAgeDays: DEFAULT_MAX_AGE_DAYS };
function volatileCleanupStore(settings, writer) {
  return {
    load: () => ({
      enabled: settings.autoCleanupEnabled.get() ?? DEFAULT_CLEANUP_CONFIG.enabled,
      maxAgeDays: settings.autoCleanupMaxAgeDays.get() ?? DEFAULT_CLEANUP_CONFIG.maxAgeDays
    }),
    save: async (next) => {
      const parsed = parseCleanupConfig({ enabled: next.enabled, maxAgeDays: next.maxAgeDays });
      if (!parsed.ok) throw new RangeError(parsed.error);
      const clear = [];
      const patch = {};
      if (parsed.config.enabled === DEFAULT_CLEANUP_CONFIG.enabled) clear.push("autoCleanupEnabled");
      else patch.autoCleanupEnabled = parsed.config.enabled;
      if (parsed.config.maxAgeDays === DEFAULT_CLEANUP_CONFIG.maxAgeDays) clear.push("autoCleanupMaxAgeDays");
      else patch.autoCleanupMaxAgeDays = parsed.config.maxAgeDays;
      if (clear.length > 0) await writer.clear(writer.entryId, clear);
      if (Object.keys(patch).length > 0) await writer.update(writer.entryId, patch);
    }
  };
}
var AUTO_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1e3;
var STATE_FILENAME = "snapshot-cleanup-last-sweep.json";
function resolveCleanupStatePath(dshHome) {
  return join2(resolveDshHome2(dshHome), STATE_FILENAME);
}
async function loadLastSweepAt(path) {
  try {
    const raw = JSON.parse(await readFile2(path, "utf8"));
    const value = raw["lastSweepAt"];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}
async function saveLastSweepAt(path, ms) {
  const tmp = `${path}.tmp`;
  await mkdir2(dirname2(path), { recursive: true });
  await writeFile2(tmp, JSON.stringify({ lastSweepAt: ms }), "utf8");
  await rename2(tmp, path);
}
function isAborted(signal) {
  return signal?.aborted === true;
}
async function runAutoCleanupCheck(deps, sessionId) {
  try {
    const loaded = await deps.readConfig();
    if (!loaded.ok) {
      deps.log(`[dsh-rewind] snapshot cleanup config invalid; auto-cleanup skipped: ${loaded.error}`);
      return;
    }
    if (!loaded.config.enabled) return;
    if (isAborted(deps.signal)) return;
    if (!shouldRunAutoSweep(await loadLastSweepAt(deps.statePath), Date.now(), deps.intervalMs)) return;
    if (isAborted(deps.signal)) return;
    await deps.pruner.pruneStale({ keepActiveId: sessionId, maxAgeDays: loaded.config.maxAgeDays });
    if (isAborted(deps.signal)) return;
    await saveLastSweepAt(deps.statePath, Date.now());
  } catch (error) {
    deps.log(`[dsh-rewind] snapshot auto-cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function parseCleanupConfig(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "config must be a JSON object" };
  }
  const record = raw;
  let enabled = DEFAULT_CLEANUP_CONFIG.enabled;
  let maxAgeDays = DEFAULT_CLEANUP_CONFIG.maxAgeDays;
  if (record["enabled"] !== void 0) {
    if (typeof record["enabled"] !== "boolean") return { ok: false, error: '"enabled" must be a boolean' };
    enabled = record["enabled"];
  }
  if (record["maxAgeDays"] !== void 0) {
    const value = record["maxAgeDays"];
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      return { ok: false, error: '"maxAgeDays" must be a positive integer' };
    }
    maxAgeDays = value;
  }
  return { ok: true, config: { enabled, maxAgeDays } };
}
function parseCleanupCommand(rawInput) {
  const parts = rawInput.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { action: "status" };
  switch (parts[0]) {
    case "status":
      return parts.length === 1 ? { action: "status" } : { error: "usage: /snapshot-auto-cleanup status" };
    case "on":
      return parts.length === 1 ? { action: "on" } : { error: "usage: /snapshot-auto-cleanup on" };
    case "off":
      return parts.length === 1 ? { action: "off" } : { error: "usage: /snapshot-auto-cleanup off" };
    case "max-age": {
      if (parts.length !== 2) return { error: "usage: /snapshot-auto-cleanup max-age <days>" };
      const days = Number(parts[1]);
      if (!Number.isInteger(days) || days <= 0) return { error: '"max-age" must be a positive integer (days)' };
      return { action: "max-age", value: days };
    }
    case "run-apply":
      return { error: 'the "run-apply" abbreviation was removed; use "run --apply"' };
    case "run": {
      let apply2 = false;
      let current = false;
      for (const rawFlag of parts.slice(1)) {
        if (rawFlag === "--apply") {
          apply2 = true;
        } else if (rawFlag === "--current") {
          current = true;
        } else {
          return { error: `unknown /snapshot-auto-cleanup run flag "${rawFlag}"` };
        }
      }
      return { action: "run", target: current ? "current" : "rules", apply: apply2 };
    }
    default:
      return { error: `unknown /snapshot-auto-cleanup subcommand "${parts[0]}"` };
  }
}
function shouldRunAutoSweep(lastAtMs, nowMs, intervalMs = AUTO_SWEEP_INTERVAL_MS) {
  return nowMs - lastAtMs >= intervalMs;
}

export {
  DEFAULT_MAX_AGE_DAYS,
  DEFAULT_CLEANUP_CONFIG,
  volatileCleanupStore,
  AUTO_SWEEP_INTERVAL_MS,
  STATE_FILENAME,
  resolveCleanupStatePath,
  loadLastSweepAt,
  saveLastSweepAt,
  isAborted,
  runAutoCleanupCheck,
  parseCleanupConfig,
  parseCleanupCommand,
  shouldRunAutoSweep,
};
