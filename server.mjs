#!/usr/bin/env node
/*
 * Serveur de l'appli de stratégie karting.
 * Aucune dépendance : Node.js 22 ou plus.  Lancer : node server.mjs   (port 3000 par défaut)
 *
 * Variables d'environnement :
 *   PORT           port HTTP (défaut 3000)
 *   DATA_FILE      fichier de sauvegarde des salles (défaut ./data/rooms.json)
 *   TIMING_HOSTS   domaines de chrono autorisés, séparés par des virgules (défaut apex-timing.com) ; "*" = tous
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { TimingSource } from './timing.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = +process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(DIR, 'data', 'rooms.json');
const TIMING_HOSTS = (process.env.TIMING_HOSTS || 'apex-timing.com').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const PUBLIC = path.join(DIR, 'public');
const ROOM_TTL = 48 * 3600e3, MAX_ROOMS = 500;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ---------- salles ---------- */
const rooms = new Map();
const hash = k => crypto.createHash('sha256').update(String(k)).digest('hex');
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => { let c; do { c = [...crypto.randomBytes(6)].map(b => ALPHA[b % ALPHA.length]).join(''); } while (rooms.has(c)); return c; };
function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    arr.forEach(r => rooms.set(r.code, { ...r, clients: new Set(), timing: null, rate: {} }));
    log(`${rooms.size} salle(s) rechargée(s)`);
  } catch (e) { /* première exécution */ }
}
let dirty = false;
function save() {
  if (!dirty) return; dirty = false;
  const arr = [...rooms.values()].map(({ code, keyHash, created, active, live, radio, replies }) => ({ code, keyHash, created, active, live, radio, replies }));
  try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(arr)); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); }
  catch (e) { log('sauvegarde impossible :', e.message); }
}
function cleanup() {
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (now - r.active > ROOM_TTL && !r.clients.size) { if (r.timing) r.timing.stop(); rooms.delete(code); dirty = true; }
    else if (r.timing && now - r.active > 6 * 3600e3) { r.timing.stop(); r.timing = null; }
  }
}
setInterval(save, 15000).unref();
setInterval(cleanup, 600000).unref();

/* ---------- utilitaires HTTP ---------- */
class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const sendJSON = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
function readBody(req, limit = 300 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'BODY_TOO_LARGE', 'Requête trop volumineuse')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(j && typeof j === 'object' && !Array.isArray(j) ? j : {}); } catch (e) { reject(new HttpError(400, 'BAD_JSON', 'JSON invalide')); } });
    req.on('error', reject);
  });
}
const getRoom = code => { const r = rooms.get(String(code).toUpperCase()); if (!r) throw new HttpError(404, 'ROOM_NOT_FOUND', 'Salle introuvable (code erroné ou salle expirée)'); r.active = Date.now(); return r; };
const isManager = (req, r) => { const k = req.headers['x-key']; return !!k && crypto.timingSafeEqual(Buffer.from(hash(k)), Buffer.from(r.keyHash)); };
const needManager = (req, r) => { if (!isManager(req, r)) throw new HttpError(401, 'NOT_MANAGER', 'Réservé au team manager (clé de salle requise)'); };
const str = (v, max) => String(v == null ? '' : v).slice(0, max);
const num = v => (Number.isFinite(+v) ? +v : null);
function broadcast(r, event, data) { const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of r.clients) c.write(msg); }
const hits = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now(), h = hits.get(key) || [];
  const recent = h.filter(t => now - t < windowMs); recent.push(now); hits.set(key, recent);
  if (recent.length > max) throw new HttpError(429, 'RATE_LIMITED', 'Trop de requêtes, réessayez dans un instant');
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (!h.some(t => now - t < 600000)) hits.delete(k); }, 600000).unref();
function timingUrlAllowed(u) {
  let url; try { url = new URL(u); } catch (e) { return false; }
  if (!/^(https?|wss?):$/.test(url.protocol)) return false;
  if (TIMING_HOSTS.includes('*')) return true;
  const h = url.hostname.toLowerCase();
  return TIMING_HOSTS.some(d => h === d || h.endsWith('.' + d));
}

/* ---------- API ---------- */
async function api(req, res, parts, query) {
  const ip = req.socket.remoteAddress || '';
  // POST /api/rooms
  if (parts.length === 1 && req.method === 'POST') {
    rateLimit('create:' + ip, 10, 3600e3);
    if (rooms.size >= MAX_ROOMS) cleanup();
    if (rooms.size >= MAX_ROOMS) throw new HttpError(503, 'FULL', 'Serveur plein, réessayez plus tard');
    const code = newCode(), key = crypto.randomBytes(12).toString('hex');
    rooms.set(code, { code, keyHash: hash(key), created: Date.now(), active: Date.now(), live: null, radio: [], replies: [], clients: new Set(), timing: null, rate: {} });
    dirty = true; log('salle créée', code);
    return sendJSON(res, 201, { room: code, key });
  }
  const r = getRoom(parts[1]), sub = parts[2] || '';
  if (!sub && req.method === 'GET') return sendJSON(res, 200, { exists: true, manager: isManager(req, r), clients: r.clients.size, hasLive: !!r.live });
  if (sub === 'events' && req.method === 'GET') {
    if (r.clients.size >= 60) throw new HttpError(503, 'TOO_MANY_CLIENTS', 'Trop d\'écrans connectés à cette salle');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ now: Date.now() })}\n\n`);
    if (r.live) res.write(`event: live\ndata: ${JSON.stringify(r.live)}\n\n`);
    res.write(`event: radio\ndata: ${JSON.stringify(r.radio.slice(0, 40))}\n\n`);
    res.write(`event: replies\ndata: ${JSON.stringify(r.replies.slice(0, 40))}\n\n`);
    r.clients.add(res);
    const ping = setInterval(() => res.write(`event: hello\ndata: ${JSON.stringify({ now: Date.now() })}\n\n`), 20000);
    req.on('close', () => { clearInterval(ping); r.clients.delete(res); });
    return;
  }
  if (sub === 'live' && req.method === 'PUT') {
    needManager(req, r); rateLimit('live:' + r.code, 120, 60000);
    const b = await readBody(req, 64 * 1024);
    r.live = { ...b, at: Date.now() }; dirty = true;
    broadcast(r, 'live', r.live);
    return sendJSON(res, 200, { ok: true });
  }
  if (sub === 'radio' && req.method === 'POST') {
    needManager(req, r); rateLimit('radio:' + r.code, 30, 60000);
    const b = await readBody(req, 4096), text = str(b.text, 140).trim();
    if (!text) throw new HttpError(400, 'EMPTY_MESSAGE', 'Message vide');
    const m = { id: crypto.randomBytes(6).toString('hex'), raceId: str(b.raceId, 40), kind: str(b.kind, 16), text, T: num(b.T), driver: num(b.driver), at: Date.now() };
    r.radio.unshift(m); r.radio.length = Math.min(r.radio.length, 100); dirty = true;
    broadcast(r, 'radio', r.radio.slice(0, 40));
    return sendJSON(res, 201, m);
  }
  if (sub === 'replies' && req.method === 'POST') {
    rateLimit('reply:' + r.code + ':' + ip, 20, 60000);
    const b = await readBody(req, 2048), text = str(b.text, 60).trim();
    if (!text) throw new HttpError(400, 'EMPTY_MESSAGE', 'Réponse vide');
    const m = { id: crypto.randomBytes(6).toString('hex'), raceId: str(b.raceId, 40), msgId: b.msgId ? str(b.msgId, 40) : null, text, driver: num(b.driver), at: Date.now() };
    r.replies.unshift(m); r.replies.length = Math.min(r.replies.length, 100); dirty = true;
    broadcast(r, 'replies', r.replies.slice(0, 40));
    return sendJSON(res, 201, m);
  }
  if (sub === 'timing' && req.method === 'GET') {
    needManager(req, r);
    const since = num(query.get('since')) || 0, max = Math.min(5000, num(query.get('max')) || 4000);
    if (!r.timing) return sendJSON(res, 200, { source: null, connected: false, rows: [], events: [], seq: 0, now: Date.now(), rate: 1, hasPitInfo: false, error: 'Aucune source de chrono configurée pour cette salle' });
    return sendJSON(res, 200, r.timing.snapshot(since, max));
  }
  if (sub === 'timing' && req.method === 'POST') {
    needManager(req, r); rateLimit('timing:' + r.code, 10, 60000);
    const b = await readBody(req, 4096), source = b.source === 'apex' ? 'apex' : 'demo', url = str(b.url, 500).trim();
    if (source === 'apex' && !timingUrlAllowed(url)) throw new HttpError(400, 'TIMING_URL_REFUSED', `Adresse refusée. Domaines autorisés sur ce serveur : ${TIMING_HOSTS.join(', ')}`);
    if (r.timing) r.timing.stop();
    r.timing = new TimingSource({ source, url, speed: b.speed, log: m => log(`[${r.code}] ${m}`) });
    const st = await r.timing.start();
    log(`[${r.code}] source chrono : ${source} ${url}`);
    return sendJSON(res, 200, st);
  }
  throw new HttpError(404, 'NOT_FOUND', 'Route inconnue');
}

/* ---------- fichiers statiques ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  let p = decodeURIComponent(pathname); if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Introuvable'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': p.endsWith('.html') ? 'no-cache' : 'public, max-age=3600' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/healthz') return sendJSON(res, 200, { ok: true, rooms: rooms.size });
    if (u.pathname === '/manifest.webmanifest') {
      const code = String(u.searchParams.get('salle') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      res.writeHead(200, { 'content-type': 'application/manifest+json', 'cache-control': 'no-cache' });
      return res.end(JSON.stringify({ name: 'Stratégie karting', short_name: 'Karting', start_url: code ? `/?salle=${code}&role=pilote` : '/', scope: '/', display: 'fullscreen', orientation: 'any', background_color: '#161C22', theme_color: '#F2C230', icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }] }));
    }
    if (u.pathname.startsWith('/api/')) {
      const parts = u.pathname.slice(5).split('/').filter(Boolean);
      if (parts[0] !== 'rooms') throw new HttpError(404, 'NOT_FOUND', 'Route inconnue');
      return await api(req, res, parts, u.searchParams);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveStatic(req, res, u.pathname);
  } catch (e) {
    if (e instanceof HttpError) return sendJSON(res, e.status, { code: e.code, message: e.message });
    log('erreur', e); sendJSON(res, 500, { code: 'SERVER_ERROR', message: 'Erreur interne du serveur' });
  }
});

load();
server.listen(PORT, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  log(`Appli de stratégie karting prête : http://localhost:${PORT}`);
  ips.forEach(ip => log(`Sur le même réseau Wi-Fi (téléphones) : http://${ip}:${PORT}`));
});
const shutdown = () => { dirty = true; save(); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
