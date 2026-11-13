/* dsh-rewind host half — rewind.js, split out of dsh-rewind-plugin 0.21.0 lib/index.js. */

// src/rewind.ts
var RewindError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "RewindError";
  }
  code;
};
var CANDIDATE_PREVIEW_CHARS = 80;
var DEFAULT_CANDIDATE_LIMIT = 100;
function isUserMessageEvent(event) {
  return event.type === "user/message";
}
function isHumanUserMessageEvent(event) {
  return isUserMessageEvent(event) && event.data.source.kind === "user";
}
function messagePreview(message) {
  const text = message.content.map((block) => block.type === "text" && typeof block.text === "string" ? block.text : "").join("").replace(/\s+/g, " ").trim();
  return text.length <= CANDIDATE_PREVIEW_CHARS ? text : `${text.slice(0, CANDIDATE_PREVIEW_CHARS - 1)}\u2026`;
}
var SEQ_TOKEN = /^@(\d+)$/;
var INDEX_TOKEN = /^(\d+)$/;
function parseRewindTarget(raw) {
  const token = raw.trim();
  const seq = SEQ_TOKEN.exec(token);
  if (seq !== null) {
    const value = Number(seq[1] ?? "");
    return Number.isSafeInteger(value) ? { kind: "seq", seq: value } : void 0;
  }
  const index = INDEX_TOKEN.exec(token);
  if (index !== null) {
    const value = Number(index[1] ?? "");
    return Number.isSafeInteger(value) && value >= 1 ? { kind: "index", index: value } : void 0;
  }
  return void 0;
}
function listRewindCandidates(events, surface, limit = DEFAULT_CANDIDATE_LIMIT) {
  const surfaceIndexes = /* @__PURE__ */ new Map();
  for (let i = 0; i < surface.length; i++) surfaceIndexes.set(surface[i], i);
  const candidates = [];
  for (let i = events.length - 1; i >= 0 && candidates.length < limit; i--) {
    const event = events[i];
    if (!isHumanUserMessageEvent(event)) continue;
    if (!surfaceIndexes.has(event.seq)) continue;
    candidates.push({
      seq: event.seq,
      time: event.time,
      preview: messagePreview(event.data),
      index: candidates.length + 1
    });
  }
  return candidates;
}
function planRewind(events, surface, target) {
  let targetSeq;
  if (target.kind === "seq") {
    targetSeq = target.seq;
  } else {
    const candidate = listRewindCandidates(events, surface, target.index)[target.index - 1];
    if (candidate === void 0) {
      throw new RewindError("invalid-index", `rewind index ${target.index} has no candidate`);
    }
    targetSeq = candidate.seq;
  }
  const targetEvent = events.find((event) => event.seq === targetSeq);
  if (targetEvent === void 0) {
    throw new RewindError("not-a-user-message", `no session event at seq ${targetSeq}`);
  }
  if (!isHumanUserMessageEvent(targetEvent)) {
    throw new RewindError(
      "not-a-user-message",
      `session event at seq ${targetSeq} is not a human user message (${targetEvent.type})`
    );
  }
  const targetIndex = surface.indexOf(targetSeq);
  if (targetIndex === -1) {
    throw new RewindError(
      "not-on-surface",
      `user message at seq ${targetSeq} is no longer in the model context (shadowed by compaction)`
    );
  }
  const shadowedSeqs = surface.slice(targetIndex);
  return {
    targetSeq,
    targetIndex,
    shadowedSeqs,
    surfaceStart: shadowedSeqs[0],
    surfaceEnd: shadowedSeqs[shadowedSeqs.length - 1]
  };
}

export {
  RewindError,
  CANDIDATE_PREVIEW_CHARS,
  DEFAULT_CANDIDATE_LIMIT,
  isUserMessageEvent,
  isHumanUserMessageEvent,
  messagePreview,
  SEQ_TOKEN,
  INDEX_TOKEN,
  parseRewindTarget,
  listRewindCandidates,
  planRewind,
};
