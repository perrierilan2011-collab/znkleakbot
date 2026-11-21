// supabase.js — sauvegarde des données du bot dans Supabase (aucune dépendance : fetch natif)
// Variables Railway : SUPABASE_URL (https://xxxx.supabase.co) et SUPABASE_KEY (clé "service_role")
const URL_ = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY || ''; // les deux noms de variable fonctionnent
const TABLE = 'bot_data', ROW = 'main';
const enabled = !!(URL_ && KEY);
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const st = { enabled, ok: false, writable: false, lastOk: null, lastError: null };
let timer = null, pending = null, running = null;

async function load() {
  const r = await fetch(`${URL_}/rest/v1/${TABLE}?id=eq.${ROW}&select=data`, { headers: H });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
  return (await r.json())[0]?.data || null;
}
async function push(data, id = ROW) {
  const r = await fetch(`${URL_}/rest/v1/${TABLE}?on_conflict=id`, {
    method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ id, data, updated_at: new Date().toISOString() }]),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
}
async function flush() {
  if (!enabled || !st.writable || !pending) return;
  if (running) return running;
  const snap = pending; pending = null;
  if (!Object.keys(snap).length) return; // on n'écrase jamais Supabase avec des données vides
  running = push(snap).then(() => { st.ok = true; st.lastOk = Date.now(); st.lastError = null; })
    .catch((e) => { st.ok = false; st.lastError = e.message; pending ??= snap; console.error('[supabase] envoi impossible :', e.message); })
    .finally(() => { running = null; });
  return running;
}
// Appelé à chaque save() du bot : envoi groupé (au plus 1 fois toutes les 3 s)
function queue(db) {
  if (!enabled) return;
  pending = JSON.parse(JSON.stringify(db));
  clearTimeout(timer);
  timer = setTimeout(flush, 3000);
}
// Au démarrage : Supabase fait foi ; si elle est vide, on y envoie les données locales
async function init(db) {
  if (!enabled) return console.log('[supabase] désactivé (SUPABASE_URL / SUPABASE_KEY absents)');
  let data, err;
  for (let n = 0; n < 4; n++) {
    try { data = await load(); err = null; break; } catch (e) { err = e; await new Promise((r) => setTimeout(r, 1500)); }
  }
  if (err) { st.lastError = err.message; return console.error('[supabase] lecture impossible, sauvegarde distante coupée pour cette session :', err.message); }
  // Test d'écriture : une clé "anon" ou une table protégée se lit sans erreur mais refuse d'écrire
  try { await push({ t: Date.now() }, 'ping'); } catch (e) {
    st.ok = false; st.writable = false; st.lastError = `écriture refusée (utilise la clé service_role) : ${e.message}`;
    return console.error('[supabase]', st.lastError);
  }
  st.ok = true; st.writable = true;
  if (data && Object.keys(data).length) {
    for (const k of Object.keys(db)) delete db[k];
    Object.assign(db, data);
    console.log(`[supabase] données chargées (${Object.keys(db).length} serveur(s))`);
  } else if (Object.keys(db).length) {
    pending = db; await flush(); console.log('[supabase] données locales envoyées pour la première fois');
  } else console.log('[supabase] connecté, base vide');
}
async function pushNow(db) { pending = JSON.parse(JSON.stringify(db)); st.writable = true; await flush(); if (st.lastError) throw new Error(st.lastError); }
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { try { clearTimeout(timer); await flush(); } finally { process.exit(0); } });

module.exports = { init, queue, pushNow, status: () => ({ ...st }) };
