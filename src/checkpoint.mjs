// saos-desk checkpoint — append-only hash-chained ledger + resume (R338)
// The record lives in git; every entry carries prevSig so tampering is measurable.
import fs from "node:fs";
import path from "node:path";
import { sig8 } from "./kernel.mjs";

export function statePaths(stateDir) {
  return {
    ledger: path.join(stateDir, "ledger.jsonl"),
    state: path.join(stateDir, "beat.json"),
  };
}

export function loadState(stateDir, seedWeights) {
  const { state } = statePaths(stateDir);
  if (!fs.existsSync(state)) {
    const fresh = {
      beat: 0,
      head: null,
      equity: [],
      weights: seedWeights,
      chainHead: null,
    };
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(state, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  return JSON.parse(fs.readFileSync(state, "utf8"));
}

export function appendLedger(stateDir, artifact) {
  const { ledger, state } = statePaths(stateDir);
  fs.mkdirSync(stateDir, { recursive: true });
  const prevSig = lastSig(ledger) ?? "GENESIS";
  const entry = { ...artifact, prevSig };
  entry.sig = sig8({ ...entry, sig: undefined });
  fs.appendFileSync(ledger, JSON.stringify(entry) + "\n");
  return entry;
}

export function lastSig(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return null;
  const lines = fs.readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
  if (lines.length === 0) return null;
  const last = JSON.parse(lines[lines.length - 1]);
  return last.sig ?? null;
}

export function verifyLedger(stateDir) {
  const { ledger } = statePaths(stateDir);
  if (!fs.existsSync(ledger)) return { ok: true, count: 0, brokenAt: null };
  const lines = fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean);
  let prev = "GENESIS";
  for (let i = 0; i < lines.length; i++) {
    const e = JSON.parse(lines[i]);
    const expect = sig8({ ...e, sig: undefined });
    if (e.sig !== expect || e.prevSig !== prev) return { ok: false, count: i, brokenAt: i };
    prev = e.sig;
  }
  return { ok: true, count: lines.length, brokenAt: null };
}

export function saveSnapshot(stateDir, state) {
  const { state: statePath } = statePaths(stateDir);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// resume check: state.head must match the actual last ledger sig (crash honesty)
export function resumeCheck(stateDir) {
  const { ledger } = statePaths(stateDir);
  const { state } = statePaths(stateDir);
  if (!fs.existsSync(state)) return { ok: true, reason: "fresh" };
  const s = JSON.parse(fs.readFileSync(state, "utf8"));
  const actual = lastSig(ledger);
  if (s.chainHead === actual) return { ok: true, reason: "chain-head-match" };
  return { ok: false, reason: "chain-head-mismatch", stateHead: s.chainHead, ledgerHead: actual };
}
