// geminikey.js — "Your own Gemini key": each person pastes their own free Gemini key in Settings and this browser talks to Gemini
// directly. That is how a copy of Quark on a static host (GitHub Pages) chats without a server of its own, and why sharing the link
// never spends the owner's key.
//
//   * The key is kept ONLY in this browser's localStorage, under one key of its own (never in the general settings blob, never in a
//     URL, never in a log or an error message). Only its last 4 characters are ever shown.
//   * It travels only as the `x-goog-api-key` request header, to generativelanguage.googleapis.com, and nowhere else.
//   * The personality, reply format and kid-safety rules are the server's own text (js/persona.js is generated from
//     backend/server.py), and the reply streams exactly as it does from the backend, so the face reacts first and speech starts
//     on the first sentence.
//   * Like the server it races two models (the newest Flash, then a faster Flash-Lite after 2.5 s or on a failure) so one slow or
//     overloaded model never leaves Quark waiting.
//
// Nothing here ever calls console.*.

import { RESPONSE_SCHEMA, KID_SAFETY, buildSystem } from './persona.js';
import { contextBlock } from './ondevice.js';
import { ReplyStream, parseFinal, validateReply } from './streamjson.js';
import { cleanReply } from './moods.js';

const KEY_STORE = 'quark:geminikey';
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const ALIASES = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
const HEDGE_MS = 2500;                // a second model starts if the first has not begun answering by now
const FIRST_BYTE_MS = 12000;          // give up on one model after this
const STALL_MS = 25000;               // and on a stream that goes quiet for this long
const MAX_TOKENS = 420;

/** Plain-language reasons (fixed text: nothing from a request or response is ever put in one). */
export const REASON = {
  badkey: 'Google did not accept that key. Check it and paste it again.',
  quota: 'This key has used up its free messages for now. Try again later, or use a different key.',
  rate: 'Too many messages at once. Give it a moment.',
  offline: 'No internet, or Google cannot be reached.',
  upstream: 'Google is busy right now. Try again in a moment.',
  blocked: 'Google blocked that one.',
  empty: 'The reply came back blank.',
};

// ---------------------------------------------------------------- the saved key
let memKey = '';                                   // used only if this browser will not store it
const readKey = () => { try { return localStorage.getItem(KEY_STORE) || memKey; } catch { return memKey; } };
let status = { state: readKey() ? 'saved' : 'none', reason: '' };
const listeners = new Set();
const setStatus = (state, reason = '') => { status = { state, reason }; listeners.forEach((fn) => { try { fn(status); } catch { /* a listener broke */ } }); };

export const ownKey = {
  has: () => !!readKey(),
  /** Only the last 4 characters, for the screen. */
  tail: () => readKey().slice(-4),
  get status() { return status; },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  /** Validate the shape and save it. Returns { ok, error }. */
  save(raw) {
    const k = String(raw || '').replace(/[\s"'`]/g, '');
    if (!k) return { ok: false, error: 'Paste your Gemini key first.' };
    // Only refuse what could never work (too short, too long, or characters a request header cannot carry). Google's key formats
    // change (newer ones start "AQ." and contain dots), so whether it is a real key is for Google to say, not for us.
    if (k.length < 20 || k.length > 300 || !/^[\x21-\x7e]+$/.test(k)) return { ok: false, error: 'That does not look like a key. Copy the whole key from aistudio.google.com/apikey and paste it again.' };
    memKey = k;
    let stored = true;
    try { localStorage.setItem(KEY_STORE, k); } catch { stored = false; }
    ranked = null;
    setStatus('saved');
    return { ok: true, stored, error: stored ? '' : 'Saved for this visit only: this browser would not store it.' };
  },
  remove() {
    memKey = ''; ranked = null; noThink.clear();
    try { localStorage.removeItem(KEY_STORE); } catch { /* nothing stored */ }
    setStatus('none');
  },
};

// ---------------------------------------------------------------- errors
class GeminiError extends Error {
  constructor(code, retryable = false) { super(REASON[code] || code); this.code = code; this.retryable = retryable; }
}

async function readError(res) {
  try {
    const j = await res.json();
    const e = (j && j.error) || {};
    return `${e.status || ''} ${e.message || ''} ${JSON.stringify(e.details || [])}`.toLowerCase();      // read only here, never shown or logged
  } catch { return ''; }
}

/** Map an HTTP failure to our small set of reasons. Retryable = another model might still answer. */
function classify(http, text) {
  if (http === 401 || http === 403 || /api[_ ]key[_ ]invalid|api key not valid|api key expired|permission_denied|key.*(invalid|expired)/.test(text)) return new GeminiError('badkey', false);
  if (http === 429) return new GeminiError(/perday|per day|daily/.test(text) ? 'quota' : 'rate', true);       // a per-minute limit is only 'rate'
  if (http === 404) return new GeminiError('upstream', true);
  if (http >= 500) return new GeminiError('upstream', true);
  return new GeminiError('upstream', false);
}

// ---------------------------------------------------------------- models
let ranked = null;                                 // [best, faster], found once per session
const noThink = new Set();                         // models that reject "thinking budget 0" (the Lite ones do)
const verRe = (suffix) => new RegExp(`^gemini-(\\d+(?:\\.\\d+)*)-${suffix}$`);

/** Ask Google which models this key can use (this is also the cheapest way to check that the key works). */
export async function listModels(signal) {
  let res;
  try { res = await fetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': readKey() }, signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }); }
  catch { throw new GeminiError(signal && signal.aborted ? 'aborted' : 'offline', true); }
  if (!res.ok) throw classify(res.status, await readError(res));
  const j = await res.json();
  return (Array.isArray(j.models) ? j.models : [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => String(m.name || '').replace(/^models\//, ''));
}

function rank(names) {
  const newest = (re) => names.filter((n) => re.test(n)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  const lite = newest(verRe('flash-lite'));
  return [ALIASES[0], lite || ALIASES[1]];          // the always-valid "latest" alias first, the newest Lite as the quick backup
}

async function models(signal) {
  if (ranked) return ranked;
  try { ranked = rank(await listModels(signal)); } catch (e) { if (e.code === 'badkey') throw e; ranked = ALIASES.slice(); }
  return ranked;
}

// ---------------------------------------------------------------- one request
function requestBody(body, thinking) {
  const ctx = body.context || {};
  const kid = ctx.mode === 'kid';
  const message = String(body.message || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 500);
  const contents = [];
  for (const t of (body.history || []).slice(-15)) {
    const text = String((t && t.text) || '').trim().slice(0, 320);
    if (text) contents.push({ role: t.role === 'user' ? 'user' : 'model', parts: [{ text }] });
  }
  if (message && contents.length && contents[contents.length - 1].role === 'user' && contents[contents.length - 1].parts[0].text === message) contents.pop();
  contents.push({ role: 'user', parts: [{ text: contextBlock(body) }] });
  const gen = { temperature: 1.0, topP: 0.95, maxOutputTokens: MAX_TOKENS, responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA };
  if (thinking) gen.thinkingConfig = { thinkingBudget: 0 };          // fast replies: this is conversation, not reasoning
  const out = { systemInstruction: { parts: [{ text: buildSystem(kid ? 'kid' : 'adult', !kid && !!ctx.focus) }] }, contents, generationConfig: gen };
  if (kid) out.safetySettings = KID_SAFETY;
  return out;
}

/** Open the streaming request on one model. Resolves the open response; rejects with a GeminiError. */
async function openOn(model, body, signal) {
  for (const thinking of noThink.has(model) ? [false] : [true, false]) {
    let res;
    try {
      res = await fetch(`${BASE}/models/${model}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': readKey() },
        body: JSON.stringify(requestBody(body, thinking)),
        signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors',
      });
    } catch { throw new GeminiError(signal.aborted ? 'aborted' : 'offline', true); }
    if (res.ok) { if (!thinking) noThink.add(model); return res; }
    const text = await readError(res);
    const err = classify(res.status, text);
    if (res.status === 400 && thinking && err.code !== 'badkey') continue;     // this model rejects the thinking setting: ask again without it
    throw err;
  }
  throw new GeminiError('upstream', true);
}

/** Race the two models: the best starts now, the quick one after HEDGE_MS or as soon as the first fails. First to answer wins. */
function openRace(list, body, outer) {
  return new Promise((resolve, reject) => {
    const ctls = list.map(() => new AbortController());
    const errors = [];
    let live = 0, started = 0, finished = false, hedge = 0;
    const onOuter = () => done(reject, new GeminiError('aborted'));
    const cleanup = () => { clearTimeout(hedge); outer && outer.removeEventListener('abort', onOuter); };
    const done = (fn, v) => { if (finished) return; finished = true; cleanup(); ctls.forEach((c) => c.abort()); fn(v); };
    outer && outer.addEventListener('abort', onOuter);
    const start = () => {
      if (finished || started >= list.length) return;
      const i = started++;
      live++;
      const timer = setTimeout(() => ctls[i].abort(), FIRST_BYTE_MS);
      openOn(list[i], body, ctls[i].signal).then((res) => {
        clearTimeout(timer);
        if (finished) return;
        finished = true; cleanup();
        ctls.forEach((c, k) => { if (k !== i) c.abort(); });             // the loser stops
        resolve({ res, model: list[i], ctl: ctls[i] });
      }, (e) => {
        clearTimeout(timer);
        live--;
        const err = e instanceof GeminiError ? e : new GeminiError('upstream', true);
        errors.push(err.code === 'aborted' && !(outer && outer.aborted) ? new GeminiError('upstream', true) : err);
        if (finished) return;
        if (!err.retryable && err.code !== 'aborted') return done(reject, err);            // a bad key will not get better on another model
        if (started < list.length) start();
        else if (live === 0) {
          const rank2 = ['badkey', 'quota', 'rate', 'offline', 'upstream'];
          errors.sort((a, b) => rank2.indexOf(a.code) - rank2.indexOf(b.code));
          done(reject, errors[0]);
        }
      });
    };
    start();
    hedge = setTimeout(start, HEDGE_MS);
  });
}

// ---------------------------------------------------------------- one conversational turn
/**
 * The same contract as the backend and the on-device model: resolves { ok:true, final, model } or
 * { ok:false, error } where error is 'badkey' | 'quota' | 'rate' | 'offline' | 'upstream' | 'blocked' | 'empty' | 'aborted'. Never rejects.
 * body: the request brain.js builds. handlers: { onMeta, onDelta, signal }.
 */
export async function converse(body, { onMeta, onDelta, signal } = {}) {
  if (!readKey()) return { ok: false, error: 'badkey' };
  let opened;
  try {
    opened = await openRace(await models(signal), body, signal);
  } catch (e) {
    const code = e instanceof GeminiError ? e.code : 'upstream';
    if (code !== 'aborted') setStatus('error', REASON[code] || REASON.upstream);
    return { ok: false, error: code };
  }
  const { res, model, ctl } = opened;
  const onAbort = () => ctl.abort();
  signal && signal.addEventListener('abort', onAbort);
  let stall = 0;
  const touch = () => { clearTimeout(stall); stall = setTimeout(() => ctl.abort(), STALL_MS); };
  touch();
  const rs = new ReplyStream();
  let full = '', blocked = false;
  try {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      touch();
      buf += dec.decode(value, { stream: true });
      let m;
      while ((m = /\r?\n\r?\n/.exec(buf))) {
        const block = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        for (const line of block.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          let ev;
          try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (ev.promptFeedback && ev.promptFeedback.blockReason) blocked = true;
          const cand = ev.candidates && ev.candidates[0];
          if (!cand) continue;
          if (cand.finishReason && /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/.test(cand.finishReason) && !full) blocked = true;
          for (const p of (cand.content && cand.content.parts) || []) if (typeof p.text === 'string') full += p.text;
          const meta = rs.meta(full);
          if (meta && onMeta) onMeta(meta);
          const delta = rs.feed(full);
          if (delta && onDelta) onDelta(delta);
        }
      }
    }
  } catch {
    if (signal && signal.aborted) return { ok: false, error: 'aborted' };
    if (!full) { setStatus('error', REASON.upstream); return { ok: false, error: 'upstream' }; }      // a stream that broke after it had started: use what arrived
  } finally {
    clearTimeout(stall);
    signal && signal.removeEventListener('abort', onAbort);
  }
  if (!full) return { ok: false, error: blocked ? 'blocked' : 'empty' };
  const final = validateReply(parseFinal(full));
  final.reply = cleanReply(final.reply);
  if (!final.reply && final.sound === 'none' && final.gesture === 'none') return { ok: false, error: blocked ? 'blocked' : 'empty' };
  if (status.state !== 'ok') setStatus('ok');
  return { ok: true, final, model };
}

/** The "Save & test" check: asks Google for the model list with the saved key. Resolves { ok, error }. */
export async function testKey() {
  if (!readKey()) return { ok: false, error: 'Paste your Gemini key first.' };
  ranked = null;
  try {
    ranked = rank(await listModels());
    setStatus('ok');
    return { ok: true };
  } catch (e) {
    const code = e instanceof GeminiError ? e.code : 'upstream';
    setStatus('error', REASON[code] || REASON.upstream);
    return { ok: false, error: REASON[code] || REASON.upstream, code };
  }
}
