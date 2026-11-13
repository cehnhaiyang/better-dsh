/* dsh-rewind host half — index.js, split out of dsh-rewind-plugin 0.21.0 lib/index.js. */

import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { copyFile as copyFile2, rm as rm2, stat as stat2, unlink } from "node:fs/promises";
import z from "@deepseek-ai/schemastery";
import { preferredLocale, translate } from './locales.js';
import { REWIND_MARKER_SOURCE } from './marker.js';
import { RewindError, parseRewindTarget, listRewindCandidates, planRewind } from './rewind.js';
import { DEFAULT_MAX_FILE_BYTES, MAX_ANCHOR_GROUPS, UnknownStoreVersionError, SnapshotStore, reconcileTracked } from './snapshot.js';
import { DEFAULT_CLEANUP_CONFIG, volatileCleanupStore, AUTO_SWEEP_INTERVAL_MS, resolveCleanupStatePath, saveLastSweepAt, runAutoCleanupCheck, parseCleanupCommand } from './snapshot-cleanup.js';

var name = "dsh-rewind";
var inject = ["commands", "tools", "settings"];
var ENGINE_COMMAND = "rewind-plugin";
var REWIND_PREVIEW_PATH = "/api/dsh-rewind/preview";
var REWIND_CANDIDATES_PATH = "/api/dsh-rewind/candidates";
var DEFAULT_FILE_CHECKPOINTING_ENABLED = true;
var Config = z.object({
  snapshotDir: z.string().required(false),
  dshHome: z.string().required(false),
  dedup: z.boolean().default(true),
  maxFileBytes: z.number().step(1).min(0).default(DEFAULT_MAX_FILE_BYTES),
  maxAnchorGroups: z.number().step(1).min(1).default(MAX_ANCHOR_GROUPS),
  autoSweepIntervalMs: z.number().step(1).min(1).default(AUTO_SWEEP_INTERVAL_MS),
  fileCheckpointingEnabled: z.boolean().default(DEFAULT_FILE_CHECKPOINTING_ENABLED).volatile(),
  autoCleanupEnabled: z.boolean().default(DEFAULT_CLEANUP_CONFIG.enabled).volatile(),
  autoCleanupMaxAgeDays: z.number().step(1).min(1).default(DEFAULT_CLEANUP_CONFIG.maxAgeDays).volatile()
});
function isFileCheckpointingEnabled(config) {
  return config?.fileCheckpointingEnabled?.get() !== false;
}
var TRACKED_TOOLS = /* @__PURE__ */ new Set(["write", "edit"]);
function isSubagentSession(session) {
  const header = session.header;
  return header.origin === "subagent" || (header.delegationDepth ?? 0) > 0;
}
var activeLocale = "en";
var LOCALE_ENTRY = "locale";
var LOCALE_FIELD = "preference";
function readHostLocale(ctx) {
  try {
    const row = ctx.settings.describe({ redactSecrets: true }).find((entry) => entry.ns === LOCALE_ENTRY);
    return preferredLocale(row?.value?.[LOCALE_FIELD]);
  } catch {
    return "en";
  }
}
var cleanupStore;
function t(key, params) {
  return translate(activeLocale, key, params);
}
function warnCommandUnavailable(ctx, name2, error) {
  ctx.logger.warn(`[dsh-rewind] command "${name2}" was not registered: ${error instanceof Error ? error.message : String(error)}`);
  if (name2 === ENGINE_COMMAND) {
    ctx.logger.warn(`[dsh-rewind] the internal "${ENGINE_COMMAND}" engine channel is unavailable; rewind execution will not work.`);
  }
}
async function discardCapture(capture) {
  if (capture === void 0 || capture.backup === null) return;
  try {
    await rm2(capture.backup.file, { force: true });
  } catch {
  }
}
function mutationPathOf(exec) {
  const args = exec.arguments;
  if (exec.name === "write" || exec.name === "edit") {
    return typeof args.file_path === "string" ? args.file_path : void 0;
  }
  return void 0;
}
function anchorSeqOf(session, cache) {
  const events = session.snapshotEvents();
  const cached = cache.get(session);
  if (cached !== void 0 && cached.eventsLength === events.length) return cached.anchor;
  let anchor = cached?.anchor;
  for (let i = events.length - 1; i >= (cached?.eventsLength ?? 0); i--) {
    if (events[i].type === "user/message") {
      anchor = events[i].seq;
      break;
    }
  }
  cache.set(session, { anchor, eventsLength: events.length });
  return anchor;
}
async function resolveTarget(fs, path, cwd, signal) {
  try {
    return await fs.resolve(path, { cwd, signal });
  } catch {
    return void 0;
  }
}
function isNotFoundError(error) {
  const code = error?.code;
  return code === "ENOENT" || code === "FS_NOT_FOUND";
}
async function captureBefore(fs, workingDirectory, store, exec, pending) {
  if (!TRACKED_TOOLS.has(exec.name)) return;
  const agent = exec.agent;
  if (agent === void 0) return;
  if (isSubagentSession(agent.session)) return;
  const path = mutationPathOf(exec);
  if (path === void 0) return;
  const cwd = await workingDirectory.ensure(agent, exec.signal);
  const target = await resolveTarget(fs, path, cwd, exec.signal);
  if (target === void 0) return;
  const info = await fs.stat(target, exec.signal).catch((error) => {
    if (isNotFoundError(error)) return void 0;
    throw error;
  });
  if (info !== void 0 && info.type !== "file") return;
  if (info !== void 0 && store.isOverFileCap(info.size)) return;
  const key = `${exec.agent?.id ?? "anon"}:${exec.callId}`;
  if (info === void 0) {
    pending.set(key, { path: target.displayPath, backup: null });
    return;
  }
  const staged = await store.stageCapture(agent.session.id, key);
  let backup;
  try {
    await copyFile2(target.displayPath, staged);
    const st = await stat2(staged);
    const source = await stat2(target.displayPath).catch(() => void 0);
    backup = {
      file: staged,
      size: st.size,
      ...source !== void 0 ? { mode: source.mode & 4095 } : {}
    };
  } catch (error) {
    await rm2(staged, { force: true });
    throw error;
  }
  pending.set(key, { path: target.displayPath, backup });
}
async function commitEntry(store, pending, anchorCache, trackedBySession, exec, result, checkpointingEnabled) {
  const key = `${exec.agent?.id ?? "anon"}:${exec.callId}`;
  const capture = pending.get(key);
  if (capture === void 0) return;
  pending.delete(key);
  if (!checkpointingEnabled) {
    await discardCapture(capture);
    return;
  }
  if (result.isError) {
    await discardCapture(capture);
    return;
  }
  const agent = exec.agent;
  if (agent === void 0) {
    await discardCapture(capture);
    return;
  }
  const anchorSeq = anchorSeqOf(agent.session, anchorCache);
  if (anchorSeq === void 0) {
    await discardCapture(capture);
    return;
  }
  try {
    await store.recordBackup(agent.session.id, {
      callId: exec.callId,
      anchorSeq,
      path: capture.path
    }, capture.backup);
  } catch (error) {
    await discardCapture(capture);
    throw error;
  }
  let tracked = trackedBySession.get(agent.session.id);
  if (tracked === void 0) {
    tracked = /* @__PURE__ */ new Set();
    trackedBySession.set(agent.session.id, tracked);
  }
  tracked.add(capture.path);
}
var REWIND_MARKER_CONTENT = [{ type: "text", text: "(empty message)" }];
function buildMarker() {
  return createUserMessage({
    content: REWIND_MARKER_CONTENT,
    source: REWIND_MARKER_SOURCE
  });
}
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}
function resolveOrError(events, surface, raw) {
  const target = parseRewindTarget(raw);
  if (target === void 0) {
    throw new RewindError("invalid-index", t("error.invalidTarget", { raw }));
  }
  return planRewind(events, surface, target);
}
async function previewImpact(store, session, seq, checkpointingEnabled) {
  const plan = resolveOrError(session.snapshotEvents(), session.surface.nodes, `@${seq}`);
  let impacts;
  try {
    impacts = await store.impactsAfter(session.id, plan.targetSeq);
  } catch (error) {
    if (!(error instanceof UnknownStoreVersionError)) throw error;
    throw new Error(t("storeUnsupported", { version: await store.readStoreVersion(session.id) ?? 0 }));
  }
  const uncovered = await store.uncoveredPaths(session.id).catch(() => []);
  return { files: impacts, uncovered, backupOff: !checkpointingEnabled };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function queryFailure(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}
function queryResponse(result) {
  return Response.json(result);
}
function createRewindQueryHandler(store, agentsOf, checkpointingEnabled, query) {
  return async (request) => {
    try {
      if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        return new Response("content type must be application/json", { status: 415 });
      }
      let payload;
      try {
        payload = await request.json();
      } catch {
        return new Response("body is not JSON", { status: 400 });
      }
      if (!isRecord(payload)) return queryResponse(queryFailure("rewind/bad-request", "invalid payload"));
      const sessionId = payload["sessionId"];
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return queryResponse(queryFailure("rewind/bad-request", "sessionId must be a non-empty string"));
      }
      const agents = agentsOf();
      if (agents === void 0) return queryResponse(queryFailure("rewind/agents-unavailable", "agent registry is unavailable"));
      const agent = agents.get(sessionId);
      if (agent === void 0) return queryResponse(queryFailure("rewind/session-not-found", `session ${sessionId} is not attached`));
      const session = agent.session;
      if (query === "preview") {
        const seq = payload["seq"];
        if (!Number.isSafeInteger(seq)) return queryResponse(queryFailure("rewind/bad-request", "seq must be an integer"));
        return queryResponse({ ok: true, value: await previewImpact(store, session, seq, checkpointingEnabled()) });
      }
      return queryResponse({
        ok: true,
        value: { candidates: listRewindCandidates(session.snapshotEvents(), session.surface.nodes) }
      });
    } catch (error) {
      return queryResponse(queryFailure("rewind/failed", error instanceof Error ? error.message : String(error)));
    }
  };
}
function renderFailures(failed) {
  if (failed.length === 0) return "";
  return t("failures.suffix", {
    count: failed.length,
    list: failed.map((f) => t("failures.item", { path: f.path, message: f.message })).join(t("sep.list"))
  });
}
function renderSkipped(outcome, uncovered, maxFileBytes) {
  const capped = new Set(uncovered.map((item) => item.path));
  const limit = formatBytes(maxFileBytes);
  return outcome.skipped.filter((path) => capped.has(path)).map((path) => t("plan.skip", { path, reason: t("skipReason.oversized", { limit }) })).join("\n");
}
async function resolveObservationTarget(fs, path) {
  try {
    return await fs.resolve(path);
  } catch {
    return void 0;
  }
}
async function syncRestoreObservations(ctx, fs, agent, outcome) {
  if (fs === void 0) return;
  const actor = { agent };
  for (const path of outcome.deleted) {
    const target = await resolveObservationTarget(fs, path);
    if (target === void 0) continue;
    ctx.emit("fs/observed", target, { kind: "absent" }, actor);
  }
  for (const path of outcome.restored) {
    const target = await resolveObservationTarget(fs, path);
    if (target === void 0) continue;
    const info = await fs.stat(target).catch(() => void 0);
    if (info === void 0) continue;
    ctx.emit("fs/observed", target, { kind: "present", version: info.version }, actor);
  }
}
async function waitForAgentIdle(agent, signal, timeoutMs = 15e3) {
  if (signal.aborted) return false;
  let timer;
  let onAbort;
  try {
    await Promise.race([
      agent.whenIdle(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("rewind idle wait timed out")), timeoutMs);
        onAbort = () => reject(new Error("rewind idle wait aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
      })
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer !== void 0) clearTimeout(timer);
    if (onAbort !== void 0) signal.removeEventListener("abort", onAbort);
  }
}
function dropPendingSteering(agent) {
  for (const message of [...agent.inbox.nextStep]) {
    agent.inbox.remove(message.id);
  }
}
async function executeRewind(ctx, store, fs, invocation, rawTarget, mode, inflight, checkpointingEnabled) {
  const { agent } = invocation;
  const sessionId = agent.session.id;
  if (inflight.has(sessionId)) {
    return { kind: "error", text: t("inflight") };
  }
  inflight.add(sessionId);
  try {
    if (agent.status !== "idle") {
      agent.cancel({ kind: "user" }, { keepInbox: true });
      const stopped = await waitForAgentIdle(agent, invocation.signal);
      if (!stopped) {
        return { kind: "error", text: t("stopFailed") };
      }
    }
    dropPendingSteering(agent);
    if (invocation.signal.aborted) {
      return { kind: "error", text: t("cancelled") };
    }
    let plan;
    try {
      plan = resolveOrError(agent.session.snapshotEvents(), agent.session.surface.nodes, rawTarget);
    } catch (error) {
      return rewindErrorResult(error);
    }
    const marker = buildMarker();
    let event;
    try {
      event = agent.session.append("user/message", marker, {
        surfaceOp: { op: "replace", startSeq: plan.surfaceStart, endSeq: plan.surfaceEnd },
        sourceEventSeqs: [...plan.shadowedSeqs]
      });
    } catch (error) {
      return {
        kind: "error",
        text: t("failed", { error: error instanceof Error ? error.message : String(error) })
      };
    }
    let restore = "";
    if (mode === "both") {
      let outcome;
      try {
        outcome = await store.restoreAfter(agent.session.id, plan.targetSeq, (path) => unlink(path));
      } catch (error) {
        if (!(error instanceof UnknownStoreVersionError)) throw error;
        const version = await store.readStoreVersion(agent.session.id);
        restore = `${t("sep.clause")}${t("storeUnsupported", { version: version ?? error.version })}`;
      }
      if (outcome !== void 0) {
        await syncRestoreObservations(ctx, fs, agent, outcome);
        const parts = [];
        if (outcome.restored.length > 0) parts.push(t("restore.count", { count: outcome.restored.length }));
        if (outcome.deleted.length > 0) parts.push(t("delete.count", { count: outcome.deleted.length }));
        if (outcome.skipped.length > 0) {
          parts.push(t("skip.count", { count: outcome.skipped.length }));
          const capped = await store.uncoveredPaths(agent.session.id).catch(() => []);
          const skippedLines = renderSkipped(outcome, capped, store.fileCapBytes);
          if (skippedLines !== "") parts.push(skippedLines);
        }
        if (!checkpointingEnabled) parts.push(t("backupOff"));
        restore = parts.length > 0 ? `${t("sep.clause")}${parts.join(t("sep.list"))}` : t("noRestorable");
        restore += renderFailures(outcome.failed);
      }
    }
    return {
      kind: "success",
      text: t("success", { targetSeq: plan.targetSeq, restore }),
      sourceEventSeq: event.seq
    };
  } finally {
    inflight.delete(sessionId);
  }
}
function rewindErrorResult(error) {
  if (error instanceof RewindError) {
    const text = {
      "no-user-messages": t("noUserMessages"),
      "invalid-index": error.message,
      "not-a-user-message": error.message,
      "not-on-surface": error.message
    }[error.code];
    return { kind: "error", text };
  }
  throw error;
}
async function handleRewind(ctx, store, fs, invocation, inflight, checkpointingEnabled) {
  const session = invocation.agent.session;
  const input = invocation.rawInput.trim();
  if (input === "") {
    const candidates = listRewindCandidates(session.snapshotEvents(), session.surface.nodes, 1);
    if (candidates.length === 0) {
      return { kind: "error", text: t("noUserMessages") };
    }
    return executeRewind(ctx, store, fs, invocation, `@${candidates[0].seq}`, "chat", inflight, checkpointingEnabled);
  }
  const parts = input.split(/\s+/);
  const target = parts[0];
  const mode = parts[1];
  if (mode !== void 0 && mode !== "chat" && mode !== "both") {
    return { kind: "error", text: t("engine.rejected") };
  }
  if (mode === void 0) return { kind: "error", text: t("engine.rejected") };
  return executeRewind(ctx, store, fs, invocation, target, mode, inflight, checkpointingEnabled);
}
var autoSweepChecked = false;
async function maybeRunAutoCleanup(ctx, store, sessionId, dshHome, sweepIntervalMs, signal) {
  if (autoSweepChecked || signal?.aborted === true) return;
  autoSweepChecked = true;
  try {
    await runAutoCleanupCheck({
      pruner: store,
      readConfig: () => readCleanupPolicy(),
      statePath: resolveCleanupStatePath(dshHome),
      log: (msg) => ctx.logger.warn(msg),
      ...sweepIntervalMs === void 0 ? {} : { intervalMs: sweepIntervalMs },
      ...signal === void 0 ? {} : { signal }
    }, sessionId);
  } catch (error) {
    try {
      ctx.logger.warn(`[dsh-rewind] snapshot auto-cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    } catch {
    }
  }
}
async function readCleanupPolicy() {
  if (cleanupStore === void 0) {
    return { ok: false, error: "cleanup policy unavailable; snapshot cleanup policy cannot be read" };
  }
  return { ok: true, config: cleanupStore.load() };
}
async function writeCleanupPolicy(next) {
  if (cleanupStore === void 0) throw new Error("cleanup policy unavailable; snapshot cleanup policy cannot be written");
  await cleanupStore.save(next);
}
function formatCleanupReport(report) {
  const key = report.dryRun ? "cleanup.runDry" : "cleanup.runApply";
  const text = t(key, {
    deleted: report.deleted,
    freed: report.freedBytes,
    kept: report.kept,
    remaining: report.remainingBytes
  });
  return report.skippedActive > 0 ? `${text}
${t("cleanup.skipped", { skipped: report.skippedActive })}` : text;
}
async function handleSnapshotCleanup(store, invocation, dshHome, trackedBySession) {
  const parsed = parseCleanupCommand(invocation.rawInput);
  if ("error" in parsed) return { kind: "error", text: t("cleanup.usage") };
  switch (parsed.action) {
    case "status": {
      const loaded = await readCleanupPolicy();
      if (!loaded.ok) return { kind: "error", text: t("cleanup.cfgInvalid", { detail: loaded.error }) };
      return {
        kind: "success",
        text: t("cleanup.status", {
          state: t(loaded.config.enabled ? "cleanup.enabled" : "cleanup.disabled"),
          days: loaded.config.maxAgeDays
        })
      };
    }
    case "on":
    case "off": {
      const loaded = await readCleanupPolicy();
      const next = { ...loaded.ok ? loaded.config : DEFAULT_CLEANUP_CONFIG, enabled: parsed.action === "on" };
      try {
        await writeCleanupPolicy(next);
      } catch (error) {
        return { kind: "error", text: t("cleanup.saveFailed", { detail: error instanceof Error ? error.message : String(error) }) };
      }
      return { kind: "success", text: t(parsed.action === "on" ? "cleanup.onOk" : "cleanup.offOk") };
    }
    case "max-age": {
      const loaded = await readCleanupPolicy();
      const next = { ...loaded.ok ? loaded.config : DEFAULT_CLEANUP_CONFIG, maxAgeDays: parsed.value };
      try {
        await writeCleanupPolicy(next);
      } catch (error) {
        return { kind: "error", text: t("cleanup.saveFailed", { detail: error instanceof Error ? error.message : String(error) }) };
      }
      return { kind: "success", text: t("cleanup.maxAgeOk", { days: parsed.value }) };
    }
    case "run": {
      const apply2 = parsed.apply;
      if (parsed.target === "current") {
        return handleClearCurrent(store, invocation, apply2, trackedBySession);
      }
      const loaded = await readCleanupPolicy();
      if (!loaded.ok) return { kind: "error", text: t("cleanup.cfgInvalid", { detail: loaded.error }) };
      try {
        const report = await store.pruneStale({
          keepActiveId: invocation.agent.session.id,
          maxAgeDays: loaded.config.maxAgeDays,
          dryRun: !apply2
        });
        if (!report.dryRun) await saveLastSweepAt(resolveCleanupStatePath(dshHome), Date.now());
        return { kind: "success", text: formatCleanupReport(report) };
      } catch (error) {
        return { kind: "error", text: t("cleanup.runFailed", { detail: error instanceof Error ? error.message : String(error) }) };
      }
    }
  }
}
function formatClearReport(report) {
  const key = report.dryRun ? "cleanup.clearDry" : "cleanup.clearApply";
  return t(key, {
    entries: report.entries,
    bytes: report.bytes
  });
}
async function handleClearCurrent(store, invocation, apply2, trackedBySession) {
  const { agent } = invocation;
  const sessionId = agent.session.id;
  if (apply2) {
    if (agent.status !== "idle") {
      agent.cancel({ kind: "user" }, { keepInbox: true });
      const stopped = await waitForAgentIdle(agent, invocation.signal);
      if (!stopped) {
        return { kind: "error", text: t("cleanup.clearActive", { sessionId }) };
      }
    }
    if (invocation.signal.aborted) {
      return { kind: "error", text: t("cleanup.clearCancelled") };
    }
  }
  try {
    const report = await store.clearSession(sessionId, { dryRun: !apply2 });
    if (!report.dryRun) trackedBySession.delete(sessionId);
    return { kind: "success", text: formatClearReport(report) };
  } catch (error) {
    return { kind: "error", text: t("cleanup.clearFailed", { detail: error instanceof Error ? error.message : String(error), sessionId }) };
  }
}
var INCLUDE_ENTRY_PREFIX = "include:";
function rewindConfigKey(ctx) {
  return ctx.fiber?.entry?.id;
}
function profileEntryKey(entryId) {
  if (entryId === void 0) return void 0;
  return entryId.startsWith(INCLUDE_ENTRY_PREFIX) ? entryId.slice(INCLUDE_ENTRY_PREFIX.length) : entryId;
}
function apply(ctx, config) {
  activeLocale = readHostLocale(ctx);
  cleanupStore = void 0;
  autoSweepChecked = false;
  const lifecycle = new AbortController();
  ctx.effect(() => () => {
    lifecycle.abort();
  }, "dsh-rewind lifecycle abort");
  ctx.inject(["settings"], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber), "dsh-rewind page policy");
  });
  const dshHome = config?.dshHome;
  const store = new SnapshotStore(config?.snapshotDir, {
    dedup: config?.dedup,
    dshHome,
    maxFileBytes: config?.maxFileBytes,
    maxAnchorGroups: config?.maxAnchorGroups
  });
  const configKey = profileEntryKey(rewindConfigKey(ctx));
  if (config !== void 0 && configKey !== void 0) {
    const writer = {
      entryId: configKey,
      update: (id, patch) => ctx.settings.update(id, patch),
      clear: (id, fields) => ctx.settings.mutate(id, fields.map((field) => ({ op: "unset", path: [field] })))
    };
    cleanupStore = volatileCleanupStore(config, writer);
  }
  const pending = /* @__PURE__ */ new Map();
  ctx.effect(() => () => {
    const captures = [...pending.values()];
    pending.clear();
    return Promise.all(captures.map((capture) => discardCapture(capture))).then(() => void 0);
  }, "dsh-rewind dispose pending captures");
  const anchorCache = /* @__PURE__ */ new WeakMap();
  const inflight = /* @__PURE__ */ new Set();
  const trackedBySession = /* @__PURE__ */ new Map();
  let fsService;
  ctx.effect(function* () {
    const withHostLocale = (handler) => (invocation) => {
      activeLocale = readHostLocale(ctx);
      return handler(invocation);
    };
    const rewindHandler = withHostLocale(
      (invocation) => handleRewind(ctx, store, fsService, invocation, inflight, isFileCheckpointingEnabled(config))
    );
    const engineHandler = withHostLocale(
      (invocation) => invocation.rawInput.trim() === "" ? Promise.resolve({ kind: "error", text: t("engine.rejected") }) : handleRewind(ctx, store, fsService, invocation, inflight, isFileCheckpointingEnabled(config))
    );
    try {
      yield ctx.commands.register({
        name: "rewind",
        description: t("command.description"),
        handler: rewindHandler
      });
    } catch (error) {
      warnCommandUnavailable(ctx, "rewind", error);
    }
    try {
      yield ctx.commands.register({
        name: "undo",
        description: t("command.undoDescription"),
        handler: rewindHandler
      });
    } catch (error) {
      warnCommandUnavailable(ctx, "undo", error);
    }
    try {
      yield ctx.commands.register({
        name: ENGINE_COMMAND,
        description: t("engine.description"),
        input: { hint: t("engine.inputHint") },
        handler: engineHandler
      });
    } catch (error) {
      warnCommandUnavailable(ctx, ENGINE_COMMAND, error);
    }
    try {
      yield ctx.commands.register({
        name: "snapshot-auto-cleanup",
        description: t("cleanup.description"),
        input: { hint: t("cleanup.inputHint") },
        handler: withHostLocale((invocation) => handleSnapshotCleanup(store, invocation, dshHome, trackedBySession))
      });
    } catch (error) {
      warnCommandUnavailable(ctx, "snapshot-auto-cleanup", error);
    }
  }, "dsh-rewind command");
  ctx.on("agent/created", ({ agent }) => {
    const session = agent.session;
    if (isSubagentSession(session)) return;
    void (async () => {
      try {
        if (lifecycle.signal.aborted) return;
        store.setFormatVersion(session.header.version);
        try {
          await store.assertKnownStoreVersion(session.id);
        } catch (error) {
          ctx.logger.warn(`[dsh-rewind] file restore disabled for ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        if (lifecycle.signal.aborted) return;
        const result = await store.reconcileFormatVersion(session.id, session.header.version);
        if (result.cleared) {
          ctx.logger.warn(`[dsh-rewind] cleared snapshots for ${session.id}: session format changed (v${session.header.version})`);
        }
      } catch (error) {
        ctx.logger.warn(`[dsh-rewind] session-format reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }, { global: true });
  ctx.on("session/event", (session, event) => {
    if (event.type !== "user/message") return;
    if (isSubagentSession(session)) return;
    if (inflight.has(session.id)) return;
    void (async () => {
      try {
        if (lifecycle.signal.aborted) return;
        const sessionId = session.id;
        void maybeRunAutoCleanup(ctx, store, sessionId, dshHome, config?.autoSweepIntervalMs, lifecycle.signal);
        if (!isFileCheckpointingEnabled(config)) return;
        let tracked = trackedBySession.get(sessionId);
        if (tracked === void 0) {
          tracked = await store.trackedPaths(sessionId);
          trackedBySession.set(sessionId, tracked);
        }
        if (tracked.size === 0) return;
        if (lifecycle.signal.aborted) return;
        await reconcileTracked(store, sessionId, event.seq, tracked);
      } catch (error) {
        ctx.logger.warn(`[dsh-rewind] boundary re-check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }, { global: true });
  ctx.inject(["connection"], (scope) => {
    const connection = scope.connection;
    if (connection === void 0) return;
    const agentsOf = () => scope.get("agents");
    const checkpointingEnabled = () => isFileCheckpointingEnabled(config);
    const register = (path, query) => {
      try {
        scope.effect(() => connection.fetch.register({
          path,
          methods: ["POST"],
          requestBody: "buffered",
          fetch: createRewindQueryHandler(store, agentsOf, checkpointingEnabled, query)
        }), `dsh-rewind ${path} route`);
      } catch (error) {
        ctx.logger.error(`[dsh-rewind] route registration failed for ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    register(REWIND_PREVIEW_PATH, "preview");
    register(REWIND_CANDIDATES_PATH, "candidates");
  });
  ctx.inject(["fs", "workingDirectory"], (scope) => {
    const fs = scope.fs;
    const workingDirectory = scope.workingDirectory;
    fsService = fs;
    scope.effect(() => () => {
      fsService = void 0;
    }, "dsh-rewind fs capture");
    scope.on("tools/execute", async (exec, next) => {
      try {
        if (isFileCheckpointingEnabled(config)) {
          await captureBefore(fs, workingDirectory, store, exec, pending);
        }
      } catch (error) {
        ctx.logger.warn(`[dsh-rewind] before-capture failed for ${exec.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return next();
    });
    scope.on("tools/post-execute", async (exec, result, next) => {
      try {
        const session = exec.agent?.session;
        if (session !== void 0 && !isSubagentSession(session)) {
          void maybeRunAutoCleanup(ctx, store, session.id, dshHome, config?.autoSweepIntervalMs, lifecycle.signal);
        }
        await commitEntry(store, pending, anchorCache, trackedBySession, exec, result, isFileCheckpointingEnabled(config));
      } catch (error) {
        ctx.logger.warn(`[dsh-rewind] checkpoint commit failed for ${exec.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return next();
    });
    scope.on("tools/result", (exec) => {
      const key = `${exec.agent?.id ?? "anon"}:${exec.callId}`;
      const capture = pending.get(key);
      pending.delete(key);
      void discardCapture(capture);
      return void 0;
    });
  });
}

export {
  Config,
  DEFAULT_FILE_CHECKPOINTING_ENABLED,
  ENGINE_COMMAND,
  SnapshotStore,
  apply,
  inject,
  name,
  profileEntryKey,
};
