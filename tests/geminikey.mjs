// Unit tests for js/geminikey.js: Quark chatting with Gemini directly, using the user's own key. Run: node tests/geminikey.mjs
// A fake "Google" stands in for the network, so every failure can be produced on demand.

const KEY = 'AIzaFAKEfakeFAKEfake_test_key_00000000';
const consoleCalls = [];
for (const k of ['log', 'info', 'warn', 'error', 'debug']) console[k] = (...a) => consoleCalls.push([k, a]);        // nothing in the client may log
const out = (s) => process.stdout.write(s + '\n');

// ---- fake browser storage
const store = new Map();
let storageBroken = false;
globalThis.localStorage = {
  getItem(k) { if (storageBroken) throw new Error('blocked'); return store.has(k) ? store.get(k) : null; },
  setItem(k, v) { if (storageBroken) throw new Error('blocked'); store.set(k, String(v)); },
  removeItem(k) { if (storageBroken) throw new Error('blocked'); store.delete(k); },
};

// ---- fake Google
const calls = [];                                         // { url, method, headers, body, aborted }
const MODELS = { models: [
  { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.1-flash-lite', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.5-flash-lite-preview-x', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
] };
const REPLY = { emotion: 'smug', intensity: 72, gesture: 'nod', sound: 'smug', reply: 'Told you so, champ. I am never wrong.', memory_update: { summary: 'The user admitted it.', facts_add: [], name: '', topic: 'bragging' } };
const enc = new TextEncoder();
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const apiError = (status, code, message, details = []) => json(status, { error: { code: status, status: code, message, details } });

/** A server-sent-events body: the reply's JSON text cut into small events, then the bytes cut into awkward chunks. */
function sseBody(obj, { eventSize = 14, byteChunk = 23, crlf = true, extra = [] } = {}) {
  const text = JSON.stringify(obj);
  const events = [];
  for (let i = 0; i < text.length; i += eventSize) events.push({ candidates: [{ content: { parts: [{ text: text.slice(i, i + eventSize) }] } }] });
  events.push(...extra);
  const nl = crlf ? '\r\n\r\n' : '\n\n';
  const bytes = enc.encode(events.map((e) => 'data: ' + JSON.stringify(e) + nl).join(''));
  return new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += byteChunk) c.enqueue(bytes.slice(i, i + byteChunk)); c.close(); } });
}
const sseResponse = (obj, o) => new Response(sseBody(obj, o), { status: 200, headers: { 'content-type': 'text/event-stream' } });

/** Like a real browser: when the request is aborted, reading its body fails. */
function bindAbort(res, signal) {
  if (!res || !res.body || !signal) return res;
  const reader = res.body.getReader();
  const gone = new Promise((_, rej) => { const f = () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); if (signal.aborted) f(); else signal.addEventListener('abort', f, { once: true }); });
  gone.catch(() => {});
  const body = new ReadableStream({
    async pull(c) { const { value, done } = await Promise.race([reader.read(), gone]); if (done) c.close(); else c.enqueue(value); },
    cancel() { return reader.cancel(); },
  });
  return new Response(body, { status: res.status, headers: res.headers });
}

let behave = {};                                          // model name -> (call, init) => Response | Promise<Response>
let listBehave = () => json(200, MODELS);
globalThis.fetch = (url, init = {}) => {
  const u = String(url);
  const call = { url: u, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null, aborted: false, signal: init.signal };
  calls.push(call);
  if (init.signal) init.signal.addEventListener('abort', () => { call.aborted = true; });
  const wait = (p) => new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (init.signal) { if (init.signal.aborted) return onAbort(); init.signal.addEventListener('abort', onAbort); }
    Promise.resolve(p).then((r) => resolve(bindAbort(r, init.signal)), reject);
  });
  if (/\/models\?/.test(u)) return wait(listBehave(call));
  const m = /\/models\/([^:]+):streamGenerateContent/.exec(u);
  if (m) { const f = behave[m[1]] || behave['*']; if (!f) return Promise.reject(new TypeError('no behaviour for ' + m[1])); return wait(f(call, init)); }
  return Promise.reject(new TypeError('unexpected url ' + u));
};

const { ownKey, converse, testKey, REASON } = await import('../js/geminikey.js');
const { buildSystem, MODE_KID } = await import('../js/persona.js');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else { fail++; out(`FAIL  ${name}${detail ? '  — ' + detail : ''}`); } };
const reset = () => { calls.length = 0; behave = {}; listBehave = () => json(200, MODELS); };
const body = (o = {}) => ({ message: 'ok you win', history: [], hints: [], context: { robotName: 'Quark', userName: 'Dhwaj', emotion: { name: 'happy', intensity: 50 } }, ...o });
const streamCalls = () => calls.filter((c) => /streamGenerateContent/.test(c.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================= 1. the saved key
check('no key at first', !ownKey.has() && ownKey.status.state === 'none');
check('an empty paste is refused', !ownKey.save('').ok);
check('a short paste is refused', !ownKey.save('abc123').ok);
check('text with curly quotes or other non-ASCII characters is refused (a request header cannot carry it)', !ownKey.save('AIzaFAKE\u201Cfake\u201DFAKEfake_test_key_000').ok);
check('a key that is far too long is refused', !ownKey.save('A'.repeat(301)).ok);
{
  const r = ownKey.save('AQ.Ab8RN6FAKEfakeFAKEfake_test_key-0000000000');      // Google's newer key format has a dot in it
  check('the newer "AQ." key format (with a dot) is accepted', r.ok && ownKey.has() && ownKey.tail() === '0000');
  ownKey.remove();
}
{
  const r = ownKey.save('here is my key AIzaFAKEfakeFAKEfake_test_key_000 ok thanks');
  check('words around the key are not our business: Google decides if it is a key', r.ok);
  ownKey.remove();
}
{
  const r = ownKey.save(`  "${KEY}"  \n`);
  check('a key pasted with spaces and quotes is cleaned and saved', r.ok && ownKey.has());
  check('only the last 4 characters are ever exposed', ownKey.tail() === '0000' && !JSON.stringify(ownKey.status).includes(KEY));
  check('it is stored under its own record (and no other)', [...store.keys()].join() === 'quark:geminikey' && store.get('quark:geminikey') === KEY);
  check('after saving the status is "saved" (not yet tested)', ownKey.status.state === 'saved');
}

// ============================================================= 2. a normal reply streams in order
{
  reset();
  behave['*'] = () => sseResponse(REPLY);
  const metas = [], deltas = [];
  const r = await converse(body({ history: [{ role: 'user', text: 'hey' }, { role: 'quark', text: 'hello you' }, { role: 'user', text: 'ok you win' }] }), { onMeta: (m) => metas.push(m), onDelta: (d) => deltas.push(d) });
  check('the reply succeeds', r.ok, JSON.stringify(r).slice(0, 120));
  check('the face hears first: emotion, intensity, gesture and sound, once', metas.length === 1 && metas[0].emotion === 'smug' && metas[0].intensity === 72 && metas[0].gesture === 'nod' && metas[0].sound === 'smug', JSON.stringify(metas));
  check('the words arrive in pieces and add up to the reply', deltas.length > 1 && deltas.join('') === REPLY.reply, deltas.join('|'));
  check('the final reply is validated', r.final.emotion === 'smug' && r.final.reply === REPLY.reply && r.final.memory_update.topic === 'bragging');
  check('the status becomes "working"', ownKey.status.state === 'ok');
  const sc = streamCalls();
  check('the best model is asked first (the latest alias)', sc[0] && /models\/gemini-flash-latest:streamGenerateContent\?alt=sse$/.test(sc[0].url), sc[0] && sc[0].url);
  const c = sc[0];
  check('the key is only in the x-goog-api-key header', c.headers['x-goog-api-key'] === KEY && !calls.some((x) => x.url.includes(KEY) || x.url.includes('key=')));
  check('the personality is the server\'s own text', c.body.systemInstruction.parts[0].text === buildSystem('adult', false));
  check('Gemini is told to answer in JSON with the schema', c.body.generationConfig.responseMimeType === 'application/json' && c.body.generationConfig.responseSchema.properties.emotion.enum.includes('smug'));
  check('fast replies: thinking budget 0, 420 tokens', c.body.generationConfig.thinkingConfig.thinkingBudget === 0 && c.body.generationConfig.maxOutputTokens === 420);
  check('adult mode adds no safety settings', !('safetySettings' in c.body));
  const last = c.body.contents[c.body.contents.length - 1];
  check('the last message carries the context block and what the user said', last.role === 'user' && /CONTEXT/.test(last.parts[0].text) && /USER SAYS: ok you win/.test(last.parts[0].text) && /Your name is Quark/.test(last.parts[0].text));
  check('history is sent with roles user/model, and the duplicate of this message is dropped', c.body.contents.length === 3 && c.body.contents[1].role === 'model' && c.body.contents.filter((x) => x.parts[0].text === 'ok you win').length === 0, JSON.stringify(c.body.contents.map((x) => x.role)));
  check('Gemini is also asked which models the key can use (once)', calls.filter((x) => /\/models\?/.test(x.url)).length === 1);
}
{
  reset();
  behave['*'] = () => sseResponse(REPLY, { crlf: false, byteChunk: 5, eventSize: 3 });
  const deltas = [];
  const r = await converse(body(), { onDelta: (d) => deltas.push(d) });
  check('tiny network chunks and plain \\n\\n separators still parse', r.ok && deltas.join('') === REPLY.reply);
  check('the model list is remembered, not fetched again', calls.filter((x) => /\/models\?/.test(x.url)).length === 0);
}

// ============================================================= 3. kid mode
{
  reset();
  behave['*'] = () => sseResponse({ ...REPLY, emotion: 'happy', sound: 'none' });
  await converse(body({ context: { mode: 'kid', robotName: 'Quark' } }));
  const c = streamCalls()[0];
  check('kid mode: the kid friend rules are in the personality', c.body.systemInstruction.parts[0].text === buildSystem('kid', false) && c.body.systemInstruction.parts[0].text.includes('KID FRIEND AND TEACHER'));
  check('kid mode: Google is asked for stricter filtering on all four categories', c.body.safetySettings.length === 4 && c.body.safetySettings.every((s) => s.threshold === 'BLOCK_MEDIUM_AND_ABOVE'));
  check('kid mode text exists in the generated persona', MODE_KID.length > 100);
}
{
  reset();
  behave['*'] = () => sseResponse({ ...REPLY, reply: '', sound: 'none' });
  await converse(body({ context: { focus: true } }));
  check('focus buddy changes the personality', streamCalls()[0].body.systemInstruction.parts[0].text === buildSystem('adult', true) && /FOCUS BUDDY/.test(streamCalls()[0].body.systemInstruction.parts[0].text));
}

// ============================================================= 4. a wrong key
{
  reset(); ownKey.save('WRONGkey_WRONGkey_WRONGkey_1234');
  const invalid = () => apiError(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }]);
  listBehave = invalid; behave['*'] = invalid;
  const t = await testKey();
  check('"Save & test" with a wrong key says so in plain words', !t.ok && t.error === REASON.badkey, JSON.stringify(t));
  check('and the status line shows the problem', ownKey.status.state === 'error' && ownKey.status.reason === REASON.badkey);
  const r = await converse(body());
  check('chatting with a wrong key reports "badkey"', !r.ok && r.error === 'badkey', JSON.stringify(r));
  check('and no generation request is made once Google has said the key is wrong', streamCalls().length <= 1, String(streamCalls().length));
  const e = JSON.stringify([t, r, ownKey.status]);
  check('the key is not in any message the user would see', !e.includes('WRONGkey'));
  ownKey.save(KEY);
}

// ============================================================= 5. out of messages, too many at once
{
  reset();
  const day = () => apiError(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota.', [{ '@type': 'QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }]);
  behave['*'] = day;
  const r = await converse(body());
  check('a daily quota on every model -> "quota"', !r.ok && r.error === 'quota', JSON.stringify(r));
  check('both models were tried (their quotas are separate)', streamCalls().length === 2);
}
{
  reset();
  behave['*'] = () => apiError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 10, per minute');
  const r = await converse(body());
  check('a per-minute limit is only "rate", not "out for the day"', !r.ok && r.error === 'rate', JSON.stringify(r));
}

// ============================================================= 6. two models race
{
  reset();
  behave['gemini-flash-latest'] = () => new Promise(() => {});                               // never answers
  behave['gemini-3.5-flash-lite'] = () => sseResponse(REPLY);
  const t0 = Date.now();
  const r = await converse(body());
  const ms = Date.now() - t0;
  check('a hanging model is overtaken by the quick one after about 2.5 s', r.ok && r.model === 'gemini-3.5-flash-lite' && ms > 2300 && ms < 4500, `${r.model} ${ms} ms`);
  check('the newest Flash-Lite from the key\'s own model list is the backup (not a preview)', r.model === 'gemini-3.5-flash-lite');
  check('the hanging request was cancelled', streamCalls().find((c) => /gemini-flash-latest/.test(c.url)).aborted);
}
{
  reset();
  behave['gemini-flash-latest'] = () => apiError(503, 'UNAVAILABLE', 'The model is overloaded.');
  behave['gemini-3.5-flash-lite'] = () => sseResponse(REPLY);
  const t0 = Date.now();
  const r = await converse(body());
  check('an overloaded model hands over at once (no 2.5 s wait)', r.ok && r.model === 'gemini-3.5-flash-lite' && Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
}
{
  reset();
  behave['*'] = () => apiError(503, 'UNAVAILABLE', 'overloaded');
  const r = await converse(body());
  check('everything overloaded -> "upstream"', !r.ok && r.error === 'upstream', JSON.stringify(r));
}

// ============================================================= 7. models that refuse "thinking 0" (the Lite ones)
{
  reset();
  behave['gemini-flash-latest'] = (c) => (c.body.generationConfig.thinkingConfig ? apiError(400, 'INVALID_ARGUMENT', 'Thinking budget is not supported for this model.') : sseResponse(REPLY));
  const r1 = await converse(body());
  const first = streamCalls().filter((c) => /gemini-flash-latest/.test(c.url));
  check('a 400 about thinking is retried without it, on the same model', r1.ok && first.length === 2 && !first[1].body.generationConfig.thinkingConfig, String(first.length));
  calls.length = 0;
  const r2 = await converse(body());
  check('and the next message does not even try it', r2.ok && streamCalls().length === 1 && !streamCalls()[0].body.generationConfig.thinkingConfig);
}

// ============================================================= 8. blocked, offline, wordless, cut off, aborted
{
  reset(); behave['*'] = () => new Response(sseBody({}, { extra: [] }), { status: 200 });
  behave['*'] = () => new Response(enc.encode('data: ' + JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }) + '\r\n\r\n'), { status: 200 });
  const r = await converse(body());
  check('a blocked prompt -> "blocked"', !r.ok && r.error === 'blocked', JSON.stringify(r));
}
{
  reset(); behave['*'] = () => Promise.reject(new TypeError('Failed to fetch'));
  listBehave = () => Promise.reject(new TypeError('Failed to fetch'));
  const r = await converse(body());
  check('no network -> "offline"', !r.ok && r.error === 'offline', JSON.stringify(r));
}
{
  reset();
  behave['*'] = () => sseResponse({ ...REPLY, reply: '', gesture: 'bounce', sound: 'happy' });
  const r = await converse(body({ message: 'thanks' }));
  check('a wordless reaction (just a sound and a bounce) is an answer', r.ok && r.final.reply === '' && r.final.sound === 'happy');
}
{
  reset();
  const cut = JSON.stringify(REPLY).slice(0, 100);                    // the stream breaks halfway through the reply text ("...Told you so")
  behave['*'] = () => new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: cut }] } }] }) + '\r\n\r\n')); setTimeout(() => c.error(new Error('reset')), 25); } }), { status: 200 });
  const deltas = [];
  const r = await converse(body(), { onDelta: (d) => deltas.push(d) });
  check('a stream that breaks after it started still gives what arrived', r.ok && r.final.reply.length > 0 && deltas.join('') === r.final.reply, JSON.stringify(r).slice(0, 140));
}
{
  reset();
  behave['*'] = () => new Response(new ReadableStream({ start() {} }), { status: 200 });          // answers, then goes quiet
  const ctl = new AbortController();
  const p = converse(body(), { signal: ctl.signal });
  await sleep(150); ctl.abort();
  const before = ownKey.status.state;
  const r = await p;
  check('the user interrupting is "aborted", not an error', !r.ok && r.error === 'aborted' && ownKey.status.state === before, JSON.stringify(r));
}

// ============================================================= 9. no key
{
  reset(); ownKey.remove();
  check('removing the key forgets it everywhere', !ownKey.has() && store.size === 0 && ownKey.status.state === 'none');
  const r = await converse(body());
  check('with no key the client does not call Google at all', !r.ok && r.error === 'badkey' && calls.length === 0);
  const t = await testKey();
  check('testing without a key asks for one', !t.ok && /Paste/.test(t.error) && calls.length === 0);
}

// ============================================================= 10. a browser that will not store things
{
  reset(); storageBroken = true;
  const r = ownKey.save(KEY);
  check('if storage is blocked the key still works for this visit, and the user is told', r.ok && r.stored === false && /this visit only/.test(r.error) && ownKey.has());
  behave['*'] = () => sseResponse(REPLY);
  const c = await converse(body());
  check('...and chatting works', c.ok);
  ownKey.remove(); storageBroken = false;
}

// ============================================================= 11. nothing was ever logged
check('nothing in the client wrote to the console', consoleCalls.length === 0, JSON.stringify(consoleCalls).slice(0, 200));
check('the key never appeared in any URL we called', !calls.some((c) => c.url.includes(KEY)));

out(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
