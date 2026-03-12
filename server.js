/* ═══════════════════════════════════════════════════════════════════
   EEA-CARBURANT-CI — server.js COMPLET
   Système de commande par polling — l'ESP interroge Render toutes les 2s

   FLUX POMPE:
   app.js → POST /api/pompe/start    → sauvegarde commande EN_ATTENTE
   ESP    → GET  /api/commande/pending → reçoit la commande → POMPE ON
   ESP    → POST /api/pompe/ack        → confirme démarrage → EN_COURS
   ESP    → POST /api/pompe/progression → progression 1s    → app voit la barre
   ESP    → POST /api/pompe/termine     → fin distribution  → COMPLÉTÉ
   app.js → GET  /api/pompe/status    → polling app web 1s
═══════════════════════════════════════════════════════════════════ */
"use strict";

const express  = require("express");
const Database = require("better-sqlite3");
const cors     = require("cors");
const path     = require("path");
require("dotenv").config();

const app  = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "eea_carburant.db");

/* ══ BASE DE DONNÉES ═══════════════════════════════════════════════ */
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
    volume_reel_L REAL NOT NULL DEFAULT 0,
    bon           TEXT,
    latitude      TEXT,
    longitude     TEXT,
    location_city TEXT,
    location_addr TEXT,
    statut        TEXT NOT NULL DEFAULT 'EN_ATTENTE',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS truck_location (
    id         INTEGER PRIMARY KEY DEFAULT 1,
    latitude   TEXT NOT NULL DEFAULT '5.3600',
    longitude  TEXT NOT NULL DEFAULT '-4.0083',
    city       TEXT NOT NULL DEFAULT 'Abidjan, CI',
    address    TEXT NOT NULL DEFAULT '',
    source     TEXT NOT NULL DEFAULT 'gps',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO truck_location (id) VALUES (1);
`);

console.log("✅ SQLite initialisé:", DB_PATH);

/* ══ ÉTAT POMPE EN RAM ═════════════════════════════════════════════
   Cet objet est mis à jour par l'ESP via les routes /progression et /termine.
   L'app web le lit via GET /api/pompe/status toutes les 1s.
══════════════════════════════════════════════════════════════════ */
let pompeState = {
  active      : false,
  op_id       : null,
  volume_cmd  : 0,
  volume_done : 0,
  percent     : 0,
  statut      : "IDLE",   // IDLE | EN_ATTENTE | EN_COURS | COMPLÉTÉ | PARTIEL
  started_at  : null,
};

/* ══ MIDDLEWARES ═══════════════════════════════════════════════════ */
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/* ═══════════════════════════════════════════════════════════════════

   ██████╗  ██████╗ ███╗   ███╗██████╗ ███████╗
   ██╔══██╗██╔═══██╗████╗ ████║██╔══██╗██╔════╝
   ██████╔╝██║   ██║██╔████╔██║██████╔╝█████╗
   ██╔═══╝ ██║   ██║██║╚██╔╝██║██╔═══╝ ██╔══╝
   ██║     ╚██████╔╝██║ ╚═╝ ██║██║     ███████╗
   ╚═╝      ╚═════╝ ╚═╝     ╚═╝╚═╝     ╚══════╝

   ROUTES POMPE — SYSTÈME POLLING ESP8266
═══════════════════════════════════════════════════════════════════ */

/**
 * POST /api/pompe/start
 * Appelé par app.js quand l'opérateur clique "Lancer la distribution"
 * → Sauvegarde la commande en base avec statut EN_ATTENTE
 * → L'ESP la récupère dans les 2 prochaines secondes
 */
app.post("/api/pompe/start", (req, res) => {
  if (pompeState.active || pompeState.statut === "EN_ATTENTE") {
    return res.status(409).json({ success: false, error: "Pompe déjà en cours ou commande en attente" });
  }

  const {
    op_id, societe, responsable, volume_L, bon,
    latitude, longitude, location_city, location_addr
  } = req.body;

  if (!volume_L || volume_L <= 0)
    return res.status(400).json({ success: false, error: "volume_L invalide" });

  const citerne = db.prepare("SELECT * FROM citerne WHERE id=1").get();
  if (volume_L > citerne.current_L)
    return res.status(422).json({ success: false, error: `Volume insuffisant — disponible: ${citerne.current_L.toFixed(0)} L` });

  const finalId = op_id || genId();

  // Sauvegarder la commande en base avec statut EN_ATTENTE
  db.prepare(`
    INSERT OR REPLACE INTO distributions
      (id, societe, responsable, volume_cmd_L, volume_reel_L, bon,
       latitude, longitude, location_city, location_addr, statut)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'EN_ATTENTE')
  `).run(
    finalId, societe || "—", responsable || null,
    volume_L, bon || genBon(),
    latitude || null, longitude || null,
    location_city || null, location_addr || null
  );

  // Mettre à jour l'état RAM
  pompeState = {
    active    : false,
    op_id     : finalId,
    volume_cmd: volume_L,
    volume_done: 0,
    percent   : 0,
    statut    : "EN_ATTENTE",
    started_at: null,
  };

  console.log(`[POMPE] Commande EN_ATTENTE → ${finalId} | ${volume_L}L`);
  const duree_min = (volume_L / 3.0).toFixed(1);

  res.json({
    success   : true,
    op_id     : finalId,
    volume_L,
    duree_min,
    message   : `Commande enregistrée — l'ESP démarre dans ≤2s`,
  });
});

/**
 * GET /api/commande/pending
 * Appelé par l'ESP8266 toutes les 2 secondes
 * → Retourne la commande EN_ATTENTE s'il y en a une
 * → L'ESP active alors le relais physiquement
 */
app.get("/api/commande/pending", (req, res) => {
  // Y a-t-il une commande EN_ATTENTE ?
  if (pompeState.statut !== "EN_ATTENTE" || !pompeState.op_id) {
    return res.json({ commande: false });
  }

  const dist = db.prepare("SELECT * FROM distributions WHERE id=?").get(pompeState.op_id);
  if (!dist) return res.json({ commande: false });

  console.log(`[COMMANDE] ESP récupère commande: ${dist.id} | ${dist.volume_cmd_L}L`);

  res.json({
    commande : true,
    op_id    : dist.id,
    volume   : dist.volume_cmd_L,
    societe  : dist.societe,
  });
});

/**
 * POST /api/pompe/ack
 * Appelé par l'ESP juste après avoir activé le relais
 * → Confirme que la pompe tourne physiquement → statut EN_COURS
 */
app.post("/api/pompe/ack", (req, res) => {
  const { op_id } = req.body;

  db.prepare(`UPDATE distributions SET statut='EN_COURS' WHERE id=?`)
    .run(op_id || pompeState.op_id);

  pompeState.active     = true;
  pompeState.statut     = "EN_COURS";
  pompeState.started_at = Date.now();

  console.log(`[POMPE] ✅ ACK reçu — pompe EN_COURS: ${op_id}`);
  res.json({ success: true });
});

/**
 * POST /api/pompe/progression
 * Appelé par l'ESP toutes les 1 seconde pendant la distribution
 * → Met à jour l'état RAM (lu par l'app web via /api/pompe/status)
 */
app.post("/api/pompe/progression", (req, res) => {
  const { volume_done, volume_target, percent, active } = req.body;

  pompeState.volume_done = parseFloat((volume_done || 0).toFixed(2));
  pompeState.percent     = parseFloat((percent || 0).toFixed(1));
  pompeState.active      = active !== false;

  res.json({ success: true });
});

/**
 * GET /api/pompe/status
 * Appelé par app.js toutes les 1 seconde (polling barre de progression)
 * → Retourne l'état actuel de la pompe
 */
app.get("/api/pompe/status", (req, res) => {
  const elapsed_s = pompeState.started_at
    ? ((Date.now() - pompeState.started_at) / 1000).toFixed(1)
    : 0;

  res.json({
    active      : pompeState.active,
    op_id       : pompeState.op_id,
    volume_done : pompeState.volume_done,
    volume_cmd  : pompeState.volume_cmd,
    percent     : pompeState.percent,
    statut      : pompeState.statut,
    elapsed_s,
  });
});

/**
 * POST /api/pompe/termine
 * Appelé par l'ESP quand la distribution est terminée (volume atteint ou stop)
 * → Met à jour la base + libère l'état pour une prochaine commande
 */
app.post("/api/pompe/termine", (req, res) => {
  const { volume_reel, statut } = req.body;
  const volReel  = parseFloat((volume_reel || pompeState.volume_done || 0).toFixed(2));
  const finalStatut = statut || (volReel >= pompeState.volume_cmd - 0.1 ? "COMPLÉTÉ" : "PARTIEL");

  if (pompeState.op_id) {
    // Mettre à jour la distribution en base
    db.prepare(`
      UPDATE distributions
      SET volume_reel_L = ?, statut = ?
      WHERE id = ?
    `).run(volReel, finalStatut, pompeState.op_id);

    // Mettre à jour le niveau de la citerne
    db.prepare(`
      UPDATE citerne
      SET current_L     = MAX(0, current_L - ?),
          distributed_L = distributed_L + ?,
          updated_at    = datetime('now')
      WHERE id = 1
    `).run(volReel, volReel);
  }

  console.log(`[POMPE] ${finalStatut}: ${volReel}L distribués (op: ${pompeState.op_id})`);

  // Remettre l'état à IDLE
  pompeState = {
    active    : false,
    op_id     : pompeState.op_id, // garder l'ID pour référence
    volume_cmd: pompeState.volume_cmd,
    volume_done: volReel,
    percent   : 100,
    statut    : finalStatut,
    started_at: pompeState.started_at,
  };

  res.json({ success: true, volume_reel: volReel, statut: finalStatut });
});

/**
 * POST /api/pompe/stop
 * Appelé par app.js si l'opérateur clique "ARRÊTER"
 * → Met statut STOP_DEMANDE → l'ESP le voit au prochain polling et coupe le relais
 */
app.post("/api/pompe/stop", (req, res) => {
  pompeState.statut = "STOP_DEMANDE";
  // L'ESP vérifie aussi ce statut dans /api/commande/pending
  console.log("[POMPE] STOP demandé par l'app web");
  res.json({ success: true, message: "Arrêt demandé — l'ESP s'arrête dans ≤2s" });
});

/**
 * GET /api/commande/stop
 * L'ESP vérifie cette route toutes les 2s pendant une distribution
 * → Si STOP_DEMANDE → l'ESP coupe le relais
 */
app.get("/api/commande/stop", (req, res) => {
  const doitStopper = pompeState.statut === "STOP_DEMANDE";
  if (doitStopper) {
    pompeState.statut = "STOP_EN_COURS";
    console.log("[POMPE] ESP a reçu l'ordre de stop");
  }
  res.json({ stop: doitStopper });
});

/* ═══════════════════════════════════════════════════════════════════
   CAPTEUR — reçoit les données de l'ESP
═══════════════════════════════════════════════════════════════════ */

/**
 * POST /api/capteur/push
 * L'ESP envoie le niveau toutes les 8 secondes
 */
app.post("/api/capteur/push", (req, res) => {
  const { niveau_L, distance_cm, niveau_pct } = req.body;
  if (niveau_L > 0) {
    db.prepare(`UPDATE citerne SET current_L=?, updated_at=datetime('now') WHERE id=1`)
      .run(niveau_L);
  }
  res.json({ success: true });
});

/**
 * GET /api/capteur
 * App web lit le niveau actuel
 */
app.get("/api/capteur", (req, res) => {
  const citerne = db.prepare("SELECT * FROM citerne WHERE id=1").get();
  res.json({ success: true, niveau_L: citerne.current_L, source: "database" });
});

/* ═══════════════════════════════════════════════════════════════════
   CITERNE
═══════════════════════════════════════════════════════════════════ */
app.get("/api/citerne", (req, res) => {
  res.json(db.prepare("SELECT * FROM citerne WHERE id=1").get());
});

app.put("/api/citerne", (req, res) => {
  const { initial_L, current_L, distributed_L } = req.body;
  db.prepare(`UPDATE citerne SET initial_L=?,current_L=?,distributed_L=?,updated_at=datetime('now') WHERE id=1`)
    .run(initial_L, current_L, distributed_L);
  res.json({ success: true });
});

app.post("/api/reset-citerne", (req, res) => {
  const vol = Number(req.body.initial_L) || 10000;
  db.prepare(`UPDATE citerne SET initial_L=?,current_L=?,distributed_L=0,updated_at=datetime('now') WHERE id=1`)
    .run(vol, vol);
  res.json({ success: true });
});

/* ═══════════════════════════════════════════════════════════════════
   DISTRIBUTIONS
═══════════════════════════════════════════════════════════════════ */
app.get("/api/distributions", (req, res) => {
  const { date, limit=100, offset=0 } = req.query;
  let q = "SELECT * FROM distributions"; const p = [];
  if (date) { q += " WHERE DATE(created_at)=?"; p.push(date); }
  q += " ORDER BY created_at DESC LIMIT ? OFFSET ?"; p.push(Number(limit), Number(offset));
  const rows = db.prepare(q).all(...p);
  const total = db.prepare(date
    ? "SELECT COUNT(*) as n FROM distributions WHERE DATE(created_at)=?"
    : "SELECT COUNT(*) as n FROM distributions"
  ).get(...(date ? [date] : [])).n;
  res.json({ data: rows, total });
});

app.get("/api/distributions/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM distributions WHERE id=?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Distribution non trouvée" });
  res.json(row);
});

app.post("/api/distributions", (req, res) => {
  const { id, societe, responsable, volume_cmd_L, volume_reel_L, bon, latitude, longitude, location_city, location_addr, statut } = req.body;
  if (!societe || volume_reel_L == null) return res.status(400).json({ error: "Données manquantes" });
  db.prepare(`INSERT OR REPLACE INTO distributions(id,societe,responsable,volume_cmd_L,volume_reel_L,bon,latitude,longitude,location_city,location_addr,statut)VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id||genId(),societe,responsable||null,volume_cmd_L||volume_reel_L,volume_reel_L,bon||null,latitude||null,longitude||null,location_city||null,location_addr||null,statut||"COMPLÉTÉ");
  db.prepare(`UPDATE citerne SET current_L=MAX(0,current_L-?),distributed_L=distributed_L+?,updated_at=datetime('now') WHERE id=1`).run(volume_reel_L,volume_reel_L);
  res.json({ success: true });
});

app.delete("/api/distributions/:id", (req, res) => {
  db.prepare("DELETE FROM distributions WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

/* ═══════════════════════════════════════════════════════════════════
   LOCALISATION CAMION
═══════════════════════════════════════════════════════════════════ */
app.post("/api/truck/location", (req, res) => {
  const { latitude, longitude, city, address, source } = req.body;
  if (!latitude || !longitude) return res.status(400).json({ error: "latitude et longitude requis" });
  db.prepare(`UPDATE truck_location SET latitude=?,longitude=?,city=COALESCE(?,city),address=COALESCE(?,address),source=COALESCE(?,'gps'),updated_at=datetime('now') WHERE id=1`)
    .run(String(latitude), String(longitude), city||null, address||null, source||"gps");
  res.json({ success: true, location: db.prepare("SELECT * FROM truck_location WHERE id=1").get() });
});

app.get("/api/truck/location", (req, res) => {
  res.json({ success: true, location: db.prepare("SELECT * FROM truck_location WHERE id=1").get() });
});

/* ═══════════════════════════════════════════════════════════════════
   STATS
═══════════════════════════════════════════════════════════════════ */
app.get("/api/stats", (req, res) => {
  const citerne   = db.prepare("SELECT * FROM citerne WHERE id=1").get();
  const today     = db.prepare(`SELECT COALESCE(SUM(volume_reel_L),0) as t FROM distributions WHERE DATE(created_at)=DATE('now') AND statut IN ('COMPLÉTÉ','PARTIEL')`).get();
  const total_ops = db.prepare("SELECT COUNT(*) as n FROM distributions WHERE statut IN ('COMPLÉTÉ','PARTIEL')").get();
  const last5     = db.prepare("SELECT * FROM distributions ORDER BY created_at DESC LIMIT 5").all();
  res.json({ citerne, today_L: today.t, total_ops: total_ops.n, last5, pompe: pompeState });
});

/* ══ FALLBACK SPA ══════════════════════════════════════════════════ */
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

/* ══ DÉMARRAGE ═════════════════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log(`🚀 EEA-CARBURANT-CI sur http://localhost:${PORT}`);
  console.log(`📦 DB: ${DB_PATH}`);
});

function genId()  { return `OP-${new Date().getFullYear()}-${Math.floor(1000+Math.random()*9000)}`; }
function genBon() { return `BC-${new Date().getFullYear()}-${Math.floor(1000+Math.random()*9000)}`; }