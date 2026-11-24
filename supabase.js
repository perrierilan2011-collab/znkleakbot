// supabase.js — sauvegarde AUTOMATIQUE des données du bot dans Supabase (SQL), sans dépendance : fetch natif
// Variables Railway : SUPABASE_URL (https://xxxx.supabase.co) et SUPABASE_KEY (clé "service_role")
// Table à créer une seule fois : exécute le fichier supabase.sql dans Supabase > SQL Editor.
//
// Fonctionnement :
//  • 1 ligne SQL par serveur Discord (id = ID du serveur, data = tout ce qui le concerne : tickets, panels, sous-panels...)
//  • à chaque save() du bot, seuls les serveurs modifiés sont envoyés (groupés, 2 s après la dernière modification)
//  • en cas d'erreur (réseau, Supabase en panne...), l'envoi est retenté tout seul toutes les 15 s : rien n'est perdu
//  • au démarrage, Supabase fait foi ; les serveurs qui n'existent que localement y sont envoyés
const crypto = require('crypto');
const URL_ = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const KEY = (process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim(); // les deux noms de variable fonctionnent
const TABLE = 'bot_data';
const enabled = !!(URL_ && KEY);
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const st = { enabled, ok: false, writable: false, lastOk: null, lastError: null, pending: 0, guilds: 0 };

let dbRef = null;                 // l'objet db du bot (même référence)
let timer = null, retryTimer = null, running = null;
const dirty = new Set();          // serveurs à envoyer
const sent = new Map();           // serveur -> empreinte du dernier contenu envoyé
const remoteLen = new Map();      // serveur -> taille (caractères) des données connues dans Supabase
const ALLOW_SHRINK = process.env.SUPABASE_ALLOW_SHRINK === '1';
const forced = new Set();         // serveurs dont le garde-fou est levé (suppression / restauration voulue)
const isGuildId = (id) => /^\d{5,}$/.test(id);
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function explain(status, text) {
  if (status === 404 || /PGRST205|does not exist|relation/i.test(text)) return 'table « bot_data » introuvable : exécute supabase.sql dans Supabase > SQL Editor';
  if (/PGRST204|column/i.test(text)) return 'colonne manquante dans « bot_data » : relance supabase.sql dans Supabase > SQL Editor';
  if (status === 401 || status === 403) return 'clé refusée : utilise la clé « service_role » (Project Settings > API), pas la clé « anon »';
  return `HTTP ${status} ${text.slice(0, 160)}`;
}
async function req(path, opt = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { ...opt, headers: { ...H, ...(opt.headers || {}) } });
  if (!r.ok) throw new Error(explain(r.status, await r.text().catch(() => '')));
  return r;
}
const load = async () => (await req(`${TABLE}?select=id,data&order=id`)).json();
const upsert = (rows) => req(`${TABLE}?on_conflict=id`, {
  method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows),
});

// Vérifie qu'on peut LIRE et ÉCRIRE (une clé "anon" ou une table protégée lit sans erreur mais refuse d'écrire)
async function connect() {
  await req(`${TABLE}?select=id&limit=1`);
  await upsert([{ id: '_ping', data: { t: Date.now() } }]);
  st.writable = true;
}

function scheduleRetry(ms = 15000) {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; flush().catch(() => {}); }, ms);
  retryTimer.unref?.();
}

async function flush() {
  if (!enabled || !dbRef) return;
  if (running) return running;
  running = (async () => {
    try {
      if (!st.writable) await connect();
      while (dirty.size) {
        const ids = [...dirty]; dirty.clear();
        const rows = [], marks = new Map();
        for (const id of ids) {
          const g = dbRef[id];
          if (!g || !Object.keys(g).length) continue; // on n'écrase jamais Supabase avec des données vides
          const json = JSON.stringify(g);
          // GARDE-FOU : on refuse d'écraser des données Supabase par une version beaucoup plus petite (squelette vide, config perdue)
          const known = remoteLen.get(id) || 0;
          if (!ALLOW_SHRINK && !forced.has(id) && !forced.has('*') && known > 1500 && json.length < known * 0.5) {
            console.error(`[supabase] ENVOI BLOQUÉ pour ${id} : ${json.length} caractères en local contre ${known} dans Supabase. Rien n'est écrasé. Vérifie les données, ou mets SUPABASE_ALLOW_SHRINK=1 si c'est voulu.`);
            st.lastError = `envoi bloqué pour ${id} (données locales bien plus petites que Supabase)`;
            continue;
          }
          marks.set(id, hash(json));
          rows.push({ id, data: JSON.parse(json) });
        }
        try {
          for (let n = 0; n < rows.length; n += 5) await upsert(rows.slice(n, n + 5));
        } catch (e) { ids.forEach((id) => dirty.add(id)); throw e; }
        for (const [id, h] of marks) sent.set(id, h);
        for (const r of rows) remoteLen.set(r.id, JSON.stringify(r.data).length);
        st.ok = true; st.lastOk = Date.now(); st.lastError = null;
      }
    } catch (e) {
      st.ok = false; st.lastError = e.message;
      if (/introuvable|refusée/.test(e.message)) st.writable = false;
      console.error('[supabase] envoi impossible (nouvel essai dans 15 s) :', e.message);
      scheduleRetry();
    } finally {
      st.pending = dirty.size; st.guilds = sent.size; running = null;
      if (!dirty.size) forced.clear();
      if (dirty.size && st.ok) scheduleRetry(500); // modifications arrivées pendant l'envoi
    }
  })();
  return running;
}

// Appelé à chaque save() du bot : repère les serveurs modifiés et programme un envoi groupé
function queue(db) {
  if (!enabled) return;
  dbRef = db;
  for (const id of Object.keys(db)) {
    if (!isGuildId(id)) continue;
    if (sent.get(id) !== hash(JSON.stringify(db[id]))) dirty.add(id);
  }
  st.pending = dirty.size;
  if (!dirty.size) return;
  clearTimeout(timer);
  timer = setTimeout(() => flush().catch(() => {}), 2000);
}

// Intègre les données lues dans Supabase. remoteWins = true au démarrage ; sinon on ne comble que les serveurs manquants.
function apply(db, rows, remoteWins) {
  let n = 0;
  const guilds = rows.filter((r) => isGuildId(r.id) && r.data && Object.keys(r.data).length);
  const legacy = rows.find((r) => r.id === 'main' && r.data && Object.keys(r.data).length); // ancien format : 1 seule ligne
  const list = guilds.length ? guilds : legacy ? Object.entries(legacy.data).map(([id, data]) => ({ id, data, legacy: true })) : [];
  for (const r of list) {
    if (!isGuildId(r.id) || !r.data || typeof r.data !== 'object') continue;
    const rl = JSON.stringify(r.data).length;
    remoteLen.set(r.id, rl);
    if (db[r.id] && !remoteWins && JSON.stringify(db[r.id]).length >= rl) continue; // on ne remplace le local que si Supabase est plus complet
    db[r.id] = r.data; n++;
    if (r.legacy) dirty.add(r.id); else sent.set(r.id, hash(JSON.stringify(r.data)));
  }
  return n;
}

// Au démarrage : Supabase fait foi ; les serveurs présents seulement en local lui sont envoyés
async function init(db) {
  dbRef = db;
  if (!enabled) return console.log('[supabase] désactivé (SUPABASE_URL / SUPABASE_KEY absents)');
  let rows, err;
  for (let n = 0; n < 4; n++) {
    try { rows = await load(); await connect(); err = null; break; } catch (e) { err = e; await sleep(1500); }
  }
  if (err) {
    st.lastError = err.message;
    console.error('[supabase] connexion impossible au démarrage (nouvel essai automatique) :', err.message);
    // Les données locales restent utilisées ; dès que Supabase répond, on comble les serveurs manquants puis on envoie
    const again = async () => {
      try { const r = await load(); await connect(); apply(db, r, false); queue(db); st.ok = true; st.lastError = null; console.log('[supabase] connecté'); }
      catch (e) { st.lastError = e.message; setTimeout(again, 30000).unref?.(); }
    };
    return void setTimeout(again, 15000).unref?.();
  }
  const n = apply(db, rows, true);
  st.ok = true;
  if (n) console.log(`[supabase] ${n} serveur(s) chargé(s) depuis Supabase`);
  else console.log('[supabase] connecté, base vide');
  queue(db); // envoie ce qui n'existe qu'en local (première fois, migration de l'ancien format...)
  await flush();
}

// Bouton « Envoyer maintenant » du panel
async function pushNow(db) {
  dbRef = db;
  for (const id of Object.keys(db)) if (isGuildId(id)) dirty.add(id);
  st.writable = false; // on revérifie la connexion
  await flush();
  if (st.lastError) throw new Error(st.lastError);
}

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => {
  try { clearTimeout(timer); if (dbRef) queue(dbRef); await Promise.race([flush(), sleep(8000)]); } finally { process.exit(0); }
});

module.exports = { init, queue, pushNow, forceNext: (id) => { forced.add(id ? String(id) : '*'); }, status: () => ({ ...st, pending: dirty.size, guilds: sent.size }) };
