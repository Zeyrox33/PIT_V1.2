/*
 * Sources de chronométrage pour le serveur : Apex Timing (websocket) et démo.
 * Une instance par salle. Événements normalisés : LAP, PIT_IN, PIT_OUT.
 */
const strip = h => String(h || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
export function parseTime(v) {
  if (!v) return null;
  const m = String(v).trim().match(/^(?:(\d+):)?(\d+(?:[.,]\d+)?)$/);
  if (!m) return null;
  const t = (m[1] ? +m[1] * 60 : 0) + parseFloat(m[2].replace(',', '.'));
  return t > 0 && t < 3600 ? t : null;
}
const attrs = tag => { const a = {}; String(tag).replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => { a[k] = v; }); return a; };

export class TimingSource {
  constructor({ source = 'demo', url = '', speed = 1, log = () => { } } = {}) {
    this.source = source; this.url = url; this.speed = Math.max(1, Math.min(50, +speed || 1)); this.log = log;
    this.connected = false; this.lastMessageAt = null; this.error = null; this.hasPitInfo = false;
    this.rows = new Map(); this.events = []; this.seq = 0; this.cols = new Map(); this._stop = null; this.t0 = Date.now();
  }
  now() { return this.source === 'demo' ? this.t0 + (Date.now() - this.t0) * this.speed : Date.now(); }
  push(ev) { ev.seq = ++this.seq; this.events.push(ev); if (this.events.length > 30000) this.events.splice(0, 10000); }
  row(id) {
    let r = this.rows.get(id);
    if (!r) { r = { id, kart: '', team: '', laps: null, lastLapNo: 0, lastLap: null, bestLap: null, inPit: false, pits: null, rank: null }; this.rows.set(id, r); }
    return r;
  }
  async start() { if (this.source === 'demo') this.startDemo(); else await this.startApex(); return this.status(); }
  stop() { if (this._stop) this._stop(); this._stop = null; this.connected = false; }
  status() { return { source: this.source, url: this.url, connected: this.connected, lastMessageAt: this.lastMessageAt, error: this.error, rows: this.rows.size, hasPitInfo: this.hasPitInfo, now: this.now(), rate: this.source === 'demo' ? this.speed : 1, seq: this.seq }; }
  snapshot(since = 0, max = 4000) {
    const evs = this.events.filter(e => e.seq > since);
    return { ...this.status(), rows: [...this.rows.values()].map(r => ({ id: r.id, kart: r.kart, team: r.team, laps: r.laps != null ? r.laps : r.lastLapNo, lastLap: r.lastLap, bestLap: r.bestLap, inPit: r.inPit, pits: r.pits, rank: r.rank })), events: evs.slice(0, max), truncated: evs.length > max };
  }

  /* ----- Apex Timing : lignes "clé|classe|valeur", "grid" = tableau HTML, "r12c5" = cellule ----- */
  handleApex(text) {
    String(text).split('\n').forEach(line => {
      if (!line) return;
      const parts = line.split('|'), key = parts[0], cls = parts[1] || '', val = parts.slice(2).join('|');
      if (key === 'grid') return this.grid(val);
      const m = /^(r\d+)c(\d+)$/.exec(key);
      if (m) this.cell(m[1], this.cols.get('c' + m[2]), cls, val, true);
    });
  }
  grid(html) {
    String(html).split(/<tr/i).slice(1).forEach(tr => {
      const ta = attrs(tr.slice(0, tr.indexOf('>')));
      const tds = [...tr.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/gi)];
      if (ta['data-id'] === 'r0' || /head/.test(ta.class || '')) {
        tds.forEach(([, at]) => { const a = attrs(at); if (a['data-id'] && a['data-type']) this.cols.set(a['data-id'], a['data-type']); });
        this.hasPitInfo = [...this.cols.values()].some(t => t === 'sta' || t === 'pit' || t === 'otr');
        this.log('colonnes : ' + [...this.cols.entries()].map(([c, t]) => c + '=' + t).join(' '));
        return;
      }
      if (!ta['data-id']) return;
      tds.forEach(([, at, inner]) => { const a = attrs(at), m = /^(r\d+)c(\d+)$/.exec(a['data-id'] || ''); if (m) this.cell(m[1], this.cols.get('c' + m[2]), a.class || '', inner, false); });
    });
  }
  cell(rid, type, cls, raw, live) {
    if (!type) return;
    const r = this.row(rid), v = strip(raw), at = this.now();
    switch (type) {
      case 'no': r.kart = v; break;
      case 'dr': if (v) r.team = v; break;
      case 'rk': r.rank = parseInt(v, 10) || r.rank; break;
      case 'tlp': { const n = parseInt(v, 10); if (n >= 0) { r.laps = n; if (!live) r.lastLapNo = n; } break; }
      case 'blp': r.bestLap = parseTime(v) || r.bestLap; break;
      case 'llp': {
        const t = parseTime(v); if (!t) break;
        r.lastLap = t; if (!live) break;
        const lap = Math.max(r.lastLapNo + 1, r.laps || 0); r.lastLapNo = lap;
        this.push({ type: 'LAP', id: rid, lap, time: t, at });
        break;
      }
      case 'pit': { const n = parseInt(v, 10); if (!isNaN(n)) r.pits = n; break; }
      case 'sta': case 'otr': {
        const inPit = /\bsi\b|\bin\b|pit/i.test(cls) || /^(in|pit|stand)$/i.test(v);
        const out = /\bso\b|\bsr\b|\bsu\b|\bsd\b|\bout\b/i.test(cls);
        if (inPit && !r.inPit) { r.inPit = true; if (live) this.push({ type: 'PIT_IN', id: rid, at }); }
        else if (out && r.inPit) { r.inPit = false; if (live) this.push({ type: 'PIT_OUT', id: rid, at }); }
        break;
      }
      default: break;
    }
  }
  async apexUrls() {
    if (/^wss?:\/\//.test(this.url)) return [this.url];
    const urls = [];
    try {
      const html = await (await fetch(this.url, { signal: AbortSignal.timeout(8000) })).text();
      const m = html.match(/configPort\s*=\s*(\d+)/) || html.match(/data-port="(\d+)"/);
      if (m) { const p = +m[1]; urls.push(`wss://www.apex-timing.com:${p + 2}/`, `ws://www.apex-timing.com:${p + 1}/`); }
      else this.error = 'Port websocket introuvable dans la page : copiez l\'adresse wss:// depuis les outils de développement (Réseau, filtre WS).';
    } catch (e) { this.error = 'Page live inaccessible : ' + e.message; }
    return urls;
  }
  async startApex() {
    if (typeof WebSocket === 'undefined') { this.error = 'Node 22 ou plus est requis côté serveur.'; return; }
    let stopped = false, ws = null, attempt = 0, timer = null;
    this._stop = () => { stopped = true; clearTimeout(timer); try { ws && ws.close(); } catch (e) { } };
    const urls = await this.apexUrls();
    if (!urls.length) return;
    const connect = () => {
      if (stopped) return;
      const u = urls[attempt % urls.length]; attempt++;
      this.log('connexion à ' + u);
      try { ws = new WebSocket(u); } catch (e) { this.error = e.message; timer = setTimeout(connect, 3000); return; }
      ws.onopen = () => { this.connected = true; this.error = null; };
      ws.onmessage = m => { this.lastMessageAt = Date.now(); if (typeof m.data === 'string') this.handleApex(m.data); else if (m.data && m.data.text) m.data.text().then(t => this.handleApex(t)); };
      ws.onerror = e => { this.error = 'Erreur websocket' + (e && e.message ? ' : ' + e.message : ''); };
      ws.onclose = () => { this.connected = false; if (!stopped) timer = setTimeout(connect, 3000); };
    };
    connect();
  }

  /* ----- démo : 8 équipes, 7 quick-change + 1 ravito chacune ----- */
  startDemo() {
    const t0 = this.t0 = Date.now();
    let rng = 12345; const rnd = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
    const names = ['Notre équipe', 'Team Médoc', 'Gironde Racing', 'Les Sous-virés', 'Apex 33', 'Team Garonne', 'Blaye Racing', 'Rapid Kart'];
    const D = 10800;
    const teams = names.map((n, i) => {
      const qc = []; for (let k = 1; k <= 7; k++) qc.push(Math.round(D * k / 8 + (rnd() - 0.5) * 300));
      return { id: 'r' + (100 + i), perf: (rnd() - 0.4) * 0.6, next: 52 + i * 0.3, lap: 0, qc, refuel: 4900 + rnd() * 900, refuelDone: false, pitUntil: null, kartEff: (rnd() - 0.5) * 0.8, lastCross: 0, finished: false, name: n, kart: String(i + 1) };
    });
    teams.forEach(t => { const r = this.row(t.id); r.team = t.name; r.kart = t.kart; r.laps = 0; });
    this.hasPitInfo = true; this.connected = true;
    const step = () => {
      const vt = (this.now() - t0) / 1000; this.lastMessageAt = Date.now();
      teams.forEach(t => {
        const r = this.row(t.id);
        for (let guard = 0; guard < 50; guard++) {
          if (t.pitUntil) {
            if (vt < t.pitUntil.end) break;
            this.push({ type: 'PIT_OUT', id: t.id, at: t0 + t.pitUntil.end * 1000 }); r.inPit = false;
            if (t.pitUntil.kind === 'QC') t.kartEff = (rnd() - 0.5) * 0.8;
            t.next = t.pitUntil.end + 10 + 52 + t.perf + t.kartEff; t.pitUntil = null; continue;
          }
          if (t.finished || vt < t.next) break;
          const crossT = t.next, time = +(crossT - t.lastCross).toFixed(3);
          t.lap++; t.lastCross = crossT; r.laps = t.lap; r.lastLapNo = t.lap; r.lastLap = time;
          this.push({ type: 'LAP', id: t.id, lap: t.lap, time, at: t0 + crossT * 1000 });
          if (crossT >= D) { t.finished = true; break; }
          let kind = null;
          if (!t.refuelDone && crossT >= t.refuel && crossT < 6000) { kind = 'REFUEL'; t.refuelDone = true; }
          else if (t.qc.length && crossT >= t.qc[0]) { kind = 'QC'; t.qc.shift(); }
          if (kind) {
            const start = crossT + 5, dur = (kind === 'QC' ? 90 : 120) + rnd() * 3;
            t.pitUntil = { kind, start, end: start + dur };
            this.push({ type: 'PIT_IN', id: t.id, at: t0 + start * 1000 }); r.inPit = true;
          } else t.next = crossT + 52 + t.perf + t.kartEff + (rnd() - 0.5) * 0.3 + (rnd() < 0.01 ? 4 : 0);
        }
      });
    };
    const h = setInterval(step, 250);
    this._stop = () => clearInterval(h);
  }
}
