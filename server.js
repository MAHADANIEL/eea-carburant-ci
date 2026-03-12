/* ═══════════════════════════════════════════════════════════════════
   EEA-CARBURANT-CI — Serveur Node.js + SQLite  (server.js COMPLET)
   Routes incluses :
     CITERNE  : GET/PUT /api/citerne  |  POST /api/reset-citerne
     DISTRIBS : GET/POST/DELETE /api/distributions
     POMPE    : POST /api/pompe/start | GET /api/pompe/status | POST /api/pompe/stop
     CAPTEUR  : GET /api/capteur
     CAMION   : POST /api/truck/location | GET /api/truck/location
     STATS    : GET /api/stats
   Déploiement : Render.com / Railway / VPS
═══════════════════════════════════════════════════════════════════ */
"use strict";
 
const express  = require("express");
const Database = require("better-sqlite3");
const cors     = require("cors");
const path     = require("path");
const http     = require("http");
require("dotenv").config();
 
const app  = express();
const PORT = process.env.PORT || 3000;
 
/* ══ CONFIG ════════════════════════════════════════════════════════ */
const DB_PATH     = process.env.DB_PATH || path.join(__dirname, "eea_carburant.db");
const ESP8266_IP  = process.env.ESP8266_IP  || "192.168.4.1";
const PUMP_RATE_LPS = 3.0 / 60; // 3 litres/min → litres/seconde
 
/* ══ BASE DE DONNÉES SQLite ════════════════════════════════════════ */
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
 
db.exec(`
  CREATE TABLE IF NOT EXISTS citerne (
    id            INTEGER PRIMARY KEY DEFAULT 1,
    initial_L     REAL NOT NULL DEFAULT 10000,
    current_L     REAL NOT NULL DEFAULT 10000,
    distributed_L REAL NOT NULL DEFAULT 0,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO citerne (id, initial_L, current_L, distributed_L)
  VALUES (1, 10000, 10000, 0);
 
  CREATE TABLE IF NOT EXISTS distributions (
    id            TEXT PRIMARY KEY,
    societe       TEXT NOT NULL,
    responsable   TEXT,
    volume_cmd_L  REAL NOT NULL,
    volume_reel_L REAL NOT NULL,
    bon           TEXT,
    latitude      TEXT,
    longitude     TEXT,
    location_city TEXT,
    location_addr TEXT,
    statut        TEXT NOT NULL DEFAULT 'COMPLÉTÉ',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
 
  CREATE TABLE IF NOT EXISTS truck_location (
    id         INTEGER PRIMARY KEY DEFAULT 1,
    latitude   TEXT NOT NULL DEFAULT '5.3600',
    longitude  TEXT NOT NULL DEFAULT '-4.0083',
    city       TEXT NOT NULL DEFAULT 'Abidjan, CI',
    address    TEXT NOT NULL DEFAULT '',
    accuracy_m REAL,
    source     TEXT NOT NULL DEFAULT 'gps',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO truck_location (id) VALUES (1);
`);
 
console.log("✅ SQLite initialisé:", DB_PATH);
 
/* ══ ÉTAT EN MÉMOIRE — POMPE ═══════════════════════════════════════
   On conserve l'état de la pompe en RAM pour le polling 1s.
   Aucune persistance nécessaire : si le serveur redémarre, la pompe
   est physiquement arrêtée (ESP8266 gère le relais).
══════════════════════════════════════════════════════════════════ */
let pumpState = {
  active      : false,
  op_id       : null,
  volume_cmd  : 0,
  volume_done : 0,
  started_at  : null,
  timer       : null,   // setInterval handle
};
 
/* ══ MIDDLEWARES ═══════════════════════════════════════════════════ */
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
 
/* ═══════════════════════════════════════════════════════════════════
   PILIER 7 — LOCALISATION CAMION
   Le camion (ou l'opérateur terrain) envoie sa position GPS via
   POST /api/truck/location depuis son téléphone / l'ESP8266.
   L'app web lit GET /api/truck/location pour afficher la position
   réelle du camion-citerne (et non celle du bureau).
═══════════════════════════════════════════════════════════════════ */
 
/**
 * POST /api/truck/location
 * Body: { latitude, longitude, city?, address?, accuracy_m?, source? }
 * Envoyé par : l'opérateur terrain via son téléphone OU l'ESP8266
 */
app.post("/api/truck/location", (req, res) => {
  const { latitude, longitude, city, address, accuracy_m, source } = req.body;
  if (!latitude || !longitude) {
    return res.status(400).json({ error: "latitude et longitude requis" });
  }
  db.prepare(`
    UPDATE truck_location
    SET latitude   = ?,
        longitude  = ?,
        city       = COALESCE(?, city),
        address    = COALESCE(?, address),
        accuracy_m = COALESCE(?, accuracy_m),
        source     = COALESCE(?, 'gps'),
        updated_at = datetime('now')
    WHERE id = 1
  `).run(
    String(latitude), String(longitude),
    city    || null,
    address || null,
    accuracy_m != null ? Number(accuracy_m) : null,
    source  || "gps"
  );
  const loc = db.prepare("SELECT * FROM truck_location WHERE id = 1").get();
  res.json({ success: true, location: loc });
});
 
/**
 * GET /api/truck/location
 * Retourne la dernière position connue du camion
 */
app.get("/api/truck/location", (req, res) => {
  const loc = db.prepare("SELECT * FROM truck_location WHERE id = 1").get();
  res.json({ success: true, location: loc });
});
 
/* ═══════════════════════════════════════════════════════════════════
   ROUTES CITERNE
═══════════════════════════════════════════════════════════════════ */
 
/** GET /api/citerne */
app.get("/api/citerne", (req, res) => {
  const citerne = db.prepare("SELECT * FROM citerne WHERE id = 1").get();
  res.json(citerne);
});
 
/** PUT /api/citerne */
app.put("/api/citerne", (req, res) => {
  const { initial_L, current_L, distributed_L } = req.body;
  db.prepare(`
    UPDATE citerne
    SET initial_L = ?, current_L = ?, distributed_L = ?,
        updated_at = datetime('now')
    WHERE id = 1
  `).run(initial_L, current_L, distributed_L);
  res.json({ success: true });
});
 
/** POST /api/reset-citerne */
app.post("/api/reset-citerne", (req, res) => {
  const vol = Number(req.body.initial_L) || 10000;
  db.prepare(`
    UPDATE citerne
    SET initial_L = ?, current_L = ?, distributed_L = 0,
        updated_at = datetime('now')
    WHERE id = 1
  `).run(vol, vol);
  res.json({ success: true, message: `Citerne réinitialisée à ${vol} L` });
});
 
/* ═══════════════════════════════════════════════════════════════════
   ROUTES DISTRIBUTIONS
═══════════════════════════════════════════════════════════════════ */
 
/** POST /api/distributions */
app.post("/api/distributions", (req, res) => {
  const {
    id, societe, responsable, volume_cmd_L, volume_reel_L,
    bon, latitude, longitude, location_city, location_addr, statut
  } = req.body;
 
  if (!societe || volume_reel_L == null) {
    return res.status(400).json({ error: "societe et volume_reel_L requis" });
  }
 
  // INSERT OR REPLACE pour idempotence (retry offline)
  db.prepare(`
    INSERT OR REPLACE INTO distributions
      (id, societe, responsable, volume_cmd_L, volume_reel_L,
       bon, latitude, longitude, location_city, location_addr, statut)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id || genId(), societe, responsable || null,
    volume_cmd_L || volume_reel_L, volume_reel_L,
    bon || null, latitude || null, longitude || null,
    location_city || null, location_addr || null,
    statut || "COMPLÉTÉ"
  );
 
  db.prepare(`
    UPDATE citerne
    SET current_L     = MAX(0, current_L - ?),
        distributed_L = distributed_L + ?,
        updated_at    = datetime('now')
    WHERE id = 1
  `).run(volume_reel_L, volume_reel_L);
 
  const citerne = db.prepare("SELECT * FROM citerne WHERE id = 1").get();
  res.json({ success: true, citerne });
});
 
/** GET /api/distributions */
app.get("/api/distributions", (req, res) => {
  const { date, limit = 100, offset = 0 } = req.query;
  let query  = "SELECT * FROM distributions";
  const params = [];
  if (date) { query += " WHERE DATE(created_at) = ?"; params.push(date); }
  query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(Number(limit), Number(offset));
  const rows  = db.prepare(query).all(...params);
  const total = db.prepare(
    date
      ? "SELECT COUNT(*) as n FROM distributions WHERE DATE(created_at) = ?"
      : "SELECT COUNT(*) as n FROM distributions"
  ).get(...(date ? [date] : [])).n;
  res.json({ data: rows, total });
});
 
/** GET /api/distributions/:id */
app.get("/api/distributions/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM distributions WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Distribution non trouvée" });
  res.json(row);
});
 
/** DELETE /api/distributions/:id */
app.delete("/api/distributions/:id", (req, res) => {
  db.prepare("DELETE FROM distributions WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});
 
/* ═══════════════════════════════════════════════════════════════════
   ██████╗  ██████╗ ███╗   ███╗██████╗ ███████╗
   ██╔══██╗██╔═══██╗████╗ ████║██╔══██╗██╔════╝
   ██████╔╝██║   ██║██╔████╔██║██████╔╝█████╗
   ██╔═══╝ ██║   ██║██║╚██╔╝██║██╔═══╝ ██╔══╝
   ██║     ╚██████╔╝██║ ╚═╝ ██║██║     ███████╗
   ╚═╝      ╚═════╝ ╚═╝     ╚═╝╚═╝     ╚══════╝
 
   PILIER 6 — ROUTES POMPE COMPLÈTES
   POST /api/pompe/start   → Démarre la pompe (contact ESP8266)
   GET  /api/pompe/status  → Polling 1s depuis le front
   POST /api/pompe/stop    → Arrêt manuel ou fin automatique
═══════════════════════════════════════════════════════════════════ */
 
/**
 * Envoie une commande HTTP à l'ESP8266 (contact LAN direct)
 * volume=0 → arrêt pompe  |  volume>0 → démarre pour X litres
 */
function contactESP8266(volumeL) {
  return new Promise((resolve, reject) => {
    const path = `/pump?vol=${volumeL}`;
    const options = {
      hostname : ESP8266_IP,
      port     : 80,
      path,
      method   : "GET",
      timeout  : 3000,
    };
    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", d => body += d);
      res.on("end",  () => resolve({ ok: true, status: res.statusCode, body }));
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("ESP8266 timeout")); });
    req.on("error",   (e) => reject(e));
    req.end();
  });
}
 
/* ─── POST /api/pompe/start ────────────────────────────────────────
   Body: {
     op_id, societe, responsable, volume_L, bon,
     latitude, longitude, location_city, location_addr
   }
   Réponse: { success, op_id, volume_L, duree_min, esp_contacte }
──────────────────────────────────────────────────────────────────── */
app.post("/api/pompe/start", async (req, res) => {
  if (pumpState.active) {
    return res.status(409).json({ success: false, error: "Pompe déjà en cours" });
  }
 
  const {
    op_id, societe, responsable, volume_L, bon,
    latitude, longitude, location_city, location_addr
  } = req.body;
 
  if (!volume_L || volume_L <= 0) {
    return res.status(400).json({ success: false, error: "volume_L invalide" });
  }
 
  // Vérifier disponibilité citerne
  const citerne = db.prepare("SELECT * FROM citerne WHERE id = 1").get();
  if (volume_L > citerne.current_L) {
    return res.status(422).json({
      success: false,
      error: `Volume insuffisant — disponible: ${citerne.current_L.toFixed(0)} L`
    });
  }
 
  // Initialiser l'état pompe en mémoire
  const finalOpId = op_id || genId();
  pumpState = {
    active      : true,
    op_id       : finalOpId,
    societe     : societe || "—",
    responsable : responsable || "—",
    volume_cmd  : volume_L,
    volume_done : 0,
    bon         : bon || genBon(),
    latitude    : latitude  || null,
    longitude   : longitude || null,
    location_city: location_city || null,
    location_addr: location_addr || null,
    started_at  : Date.now(),
    timer       : null,
  };
 
  // Simulateur de débit côté serveur (s'arrête quand volume atteint)
  // En production réelle, l'ESP8266 envoie des callbacks ; ici on simule
  pumpState.timer = setInterval(() => {
    if (!pumpState.active) { clearInterval(pumpState.timer); return; }
    pumpState.volume_done = Math.min(
      pumpState.volume_done + PUMP_RATE_LPS,
      pumpState.volume_cmd
    );
    if (pumpState.volume_done >= pumpState.volume_cmd) {
      clearInterval(pumpState.timer);
      pumpState.active = false;
      console.log(`[POMPE] Distribution auto-terminée: ${pumpState.volume_done.toFixed(2)} L`);
    }
  }, 1000);
 
  // Contacter ESP8266
  let espContacte = false;
  try {
    await contactESP8266(volume_L);
    espContacte = true;
    console.log(`[POMPE] ✅ ESP8266 contacté — ${volume_L} L`);
  } catch (e) {
    console.warn(`[POMPE] ⚡ ESP8266 injoignable (${e.message}) — mode simulé`);
  }
 
  const duree_min = (volume_L / 3.0).toFixed(1);
  res.json({
    success     : true,
    op_id       : finalOpId,
    volume_L,
    duree_min,
    esp_contacte: espContacte,
  });
});
 
/* ─── GET /api/pompe/status ────────────────────────────────────────
   Polling 1s depuis le frontend
   Réponse: { active, op_id, volume_done, volume_cmd, percent, elapsed_s }
──────────────────────────────────────────────────────────────────── */
app.get("/api/pompe/status", (req, res) => {
  const elapsed_s = pumpState.started_at
    ? ((Date.now() - pumpState.started_at) / 1000).toFixed(1)
    : 0;
  const percent = pumpState.volume_cmd > 0
    ? Math.min(100, Math.round((pumpState.volume_done / pumpState.volume_cmd) * 100))
    : 0;
 
  res.json({
    active      : pumpState.active,
    op_id       : pumpState.op_id,
    volume_done : parseFloat(pumpState.volume_done.toFixed(2)),
    volume_cmd  : pumpState.volume_cmd,
    percent,
    elapsed_s,
  });
});
 
/* ─── POST /api/pompe/stop ─────────────────────────────────────────
   Arrêt manuel ou automatique
   Réponse: { success, volume_reel, statut }
──────────────────────────────────────────────────────────────────── */
app.post("/api/pompe/stop", async (req, res) => {
  if (!pumpState.active && pumpState.volume_done === 0) {
    return res.json({ success: true, volume_reel: 0, statut: "IDLE" });
  }
 
  // Arrêt de l'interval
  if (pumpState.timer) { clearInterval(pumpState.timer); pumpState.timer = null; }
  pumpState.active = false;
 
  const volReel  = parseFloat(pumpState.volume_done.toFixed(2));
  const isPartial = volReel < pumpState.volume_cmd - 0.1;
  const statut   = isPartial ? "PARTIEL" : "COMPLÉTÉ";
 
  // Contacter ESP8266 pour l'arrêt
  try {
    await contactESP8266(0);
    console.log("[POMPE] ✅ ESP8266 arrêté");
  } catch (e) {
    console.warn("[POMPE] ⚡ ESP8266 stop injoignable:", e.message);
  }
 
  res.json({ success: true, volume_reel: volReel, statut });
});
 
/* ═══════════════════════════════════════════════════════════════════
   CAPTEUR ULTRASONIQUE
═══════════════════════════════════════════════════════════════════ */
 
/**
 * GET /api/capteur
 * Interroge l'ESP8266 pour le niveau de la citerne.
 * Si l'ESP8266 est injoignable, retourne la valeur SQLite.
 */
app.get("/api/capteur", async (req, res) => {
  try {
    // Requête HTTP vers ESP8266 GET /sensor
    const espData = await new Promise((resolve, reject) => {
      const options = {
        hostname: ESP8266_IP, port: 80, path: "/sensor",
        method: "GET", timeout: 3000,
      };
      const req2 = http.request(options, (r) => {
        let body = "";
        r.on("data", d => body += d);
        r.on("end",  () => {
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error("JSON invalide")); }
        });
      });
      req2.on("timeout", () => { req2.destroy(); reject(new Error("timeout")); });
      req2.on("error",   (e) => reject(e));
      req2.end();
    });
 
    // Mettre à jour la citerne si niveau valide
    if (espData.niveau_L > 0) {
      db.prepare(`
        UPDATE citerne
        SET current_L = ?, updated_at = datetime('now')
        WHERE id = 1
      `).run(espData.niveau_L);
    }
 
    res.json({
      success     : true,
      niveau_L    : espData.niveau_L,
      distance_cm : espData.distance_cm,
      source      : "esp8266",
    });
  } catch (e) {
    // Fallback: valeur SQLite
    const citerne = db.prepare("SELECT * FROM citerne WHERE id = 1").get();
    res.json({
      success     : true,
      niveau_L    : citerne.current_L,
      distance_cm : null,
      source      : "database",
    });
  }
});
 
/* ═══════════════════════════════════════════════════════════════════
   STATS GLOBALES
═══════════════════════════════════════════════════════════════════ */
 
app.get("/api/stats", (req, res) => {
  const citerne   = db.prepare("SELECT * FROM citerne WHERE id = 1").get();
  const today     = db.prepare(`SELECT COALESCE(SUM(volume_reel_L),0) as total FROM distributions WHERE DATE(created_at) = DATE('now')`).get();
  const total_ops = db.prepare("SELECT COUNT(*) as n FROM distributions").get();
  const last5     = db.prepare("SELECT * FROM distributions ORDER BY created_at DESC LIMIT 5").all();
  const loc       = db.prepare("SELECT * FROM truck_location WHERE id = 1").get();
  res.json({ citerne, today_L: today.total, total_ops: total_ops.n, last5, truck_location: loc });
});
 
/* ══ FALLBACK SPA ══════════════════════════════════════════════════ */
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
 
/* ══ DÉMARRAGE ═════════════════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log(`🚀 EEA-CARBURANT-CI sur http://localhost:${PORT}`);
  console.log(`📦 DB: ${DB_PATH}  |  📡 ESP8266: ${ESP8266_IP}`);
});
 
/* ══ UTILITAIRES ═══════════════════════════════════════════════════ */
function genId()  { return `OP-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`; }
function genBon() { return `BC-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`; }