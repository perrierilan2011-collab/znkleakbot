// keys.js — dossiers et listes de clés distribuées par la commande /key.
// Un dossier contient plusieurs listes. Une clé = une ligne.
// La clé envoyée est retirée de sa liste pour ne jamais être envoyée deux fois.

const crypto = require('crypto');

const DEFAULT_MESSAGE = '🔑 Here is your key for **{folder}/{list}**:\n```\n{key}\n```\n-# {remaining} key(s) left';
const MAX_KEYS = 5000;
const MAX_KEY_LENGTH = 1000;
const MAX_MESSAGE = 2000;
const MAX_FOLDERS = 50;
const MAX_LISTS = 100;

// Nom de dossier / de liste utilisable dans /key : minuscules, sans espaces ni accents.
function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

// Identifiant court et stable pour un dossier ou une liste.
function makeId() {
  return crypto.randomBytes(4).toString('hex');
}

// Transforme un texte (une clé par ligne) en tableau propre : lignes vides ignorées,
// doublons retirés, ordre conservé.
function parseLines(text) {
  const out = [];
  const seen = new Set();
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.length > MAX_KEY_LENGTH) {
      throw new Error(`Ligne ${i + 1} trop longue (${MAX_KEY_LENGTH} caractères max).`);
    }
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= MAX_KEYS) break;
  }
  return out;
}

// Clé de comparaison : deux noms qui ne diffèrent que par - ou _ sont considérés identiques.
function nameKey(value) {
  return normalizeName(value).replace(/[-_]/g, '');
}

// Retrouve un dossier par son nom (normalisé, puis sans - / _).
function findFolder(folders, name) {
  const n = normalizeName(name);
  if (!n) return null;
  const k = nameKey(name);
  return (folders || []).find((f) => f.name === n)
    || (folders || []).find((f) => nameKey(f.name) === k)
    || null;
}

// Retrouve une liste dans un dossier par son nom (normalisé, puis sans - / _).
function findList(folder, name) {
  const n = normalizeName(name);
  if (!n) return null;
  const k = nameKey(name);
  const lists = folder?.lists || [];
  return lists.find((l) => l.name === n)
    || lists.find((l) => nameKey(l.name) === k)
    || null;
}

// Retrouve une liste à partir de son dossier et de son identifiant.
function findListById(folders, folderId, listId) {
  const folder = (folders || []).find((f) => f.id === folderId) || null;
  const list = (folder?.lists || []).find((l) => l.id === listId) || null;
  return { folder, list };
}

// Compteurs d'un dossier (ou d'un ensemble de listes).
function listStats(lists) {
  return (lists || []).reduce((acc, l) => {
    acc.remaining += (l.keys || []).length;
    acc.sent += l.sent || 0;
    return acc;
  }, { remaining: 0, sent: 0 });
}

// Remplace les variables du message. Un message vide utilise le message par défaut.
function renderMessage(template, vars = {}) {
  let out = String(template ?? '');
  if (!out.trim()) out = DEFAULT_MESSAGE;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v ?? ''));
  out = out.trim();
  if (out.length > MAX_MESSAGE) {
    // Message trop long (clé très longue ou template bavard) : on renvoie au minimum la clé.
    out = `🔑 ${vars.folder ? vars.folder + '/' : ''}${vars.list || ''}\n\`\`\`\n${vars.key || ''}\n\`\`\``.slice(0, MAX_MESSAGE);
  }
  return out;
}

// Retire la première clé de la liste et incrémente le compteur d'envois.
// Retourne null si la liste est vide.
function takeKey(list) {
  if (!list || !Array.isArray(list.keys) || !list.keys.length) return null;
  const key = list.keys.shift();
  list.sent = (list.sent || 0) + 1;
  return key;
}

module.exports = {
  DEFAULT_MESSAGE, MAX_KEYS, MAX_KEY_LENGTH, MAX_MESSAGE, MAX_FOLDERS, MAX_LISTS,
  normalizeName, nameKey, makeId, parseLines, findFolder, findList, findListById, listStats,
  renderMessage, takeKey,
};
