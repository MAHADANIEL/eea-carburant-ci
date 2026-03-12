/* ═══════════════════════════════════════════════════
EEA-CARBURANT-CI — Serveur Node.js + SQLite
Déploiement: Render.com (gratuit)
═══════════════════════════════════════════════════ */

const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const app  = express();
const PORT = process.env.PORT || 3000;

// ── BASE DE DONNÉES SQLite ──
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "eea_carburant.db");
const db = new Database(DB_PATH);

// Activer WAL pour de meilleures performances
db.pragma("journal_mode = WAL");

// ── CRÉATION DES TABLES ──
db.exec(`
CREATE TABLE IF NOT EXISTS citerne (
id             INTEGER PRIMARY KEY DEFAULT 1,
initial_L      REAL    NOT NULL DEFAULT 10000,
current_L      REAL    NOT NULL DEFAULT 10000,
distributed_L REAL    NOT NULL DEFAULT 0,
updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Insérer la citerne par défaut si elle n’existe pas
INSERT OR IGNORE INTO citerne (id, initial_L, current_L, distributed_L)
VALUES (1, 10000, 10000, 0);

CREATE TABLE IF NOT EXISTS distributions (
id             TEXT    PRIMARY KEY,
societe        TEXT    NOT NULL,
responsable    TEXT,
volume_cmd_L   REAL    NOT NULL,
volume_reel_L REAL    NOT NULL,
bon            TEXT,
latitude       TEXT,
longitude      TEXT,
location_city TEXT,
location_addr TEXT,
statut         TEXT    NOT NULL DEFAULT 'COMPLÉTÉ',
created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
`);

console.log("✅ Base de données SQLite initialisée:", DB_PATH);

// ── MIDDLEWARES ──
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ══════════════════════════════════════
// API ROUTES
// ══════════════════════════════════════

// ── GET /api/citerne — Lire l’état de la citerne ──
app.get("/api/citerne", (req, res) => {
const citerne = db.prepare("SELECT * FROM citerne WHERE id = 1").get();
res.json(citerne);
});

// ── PUT /api/citerne — Mettre à jour la citerne ──
app.put("/api/citerne", (req, res) => {
const { initial_L, current_L, distributed_L } = req.body;
db.prepare("UPDATE citerne SET initial_L = ?, current_L = ?, distributed_L = ?, updated_at = datetime('now') WHERE id = 1").run(initial_L, current_L, distributed_L);
res.json({ success: true });
});

// ── POST /api/distributions — Enregistrer une distribution ──
app.post("/api/distributions", (req, res) => {
const {
id, societe, responsable, volume_cmd_L, volume_reel_L,
bon, latitude, longitude, location_city, location_addr, statut
} = req.body;

// Valider les données
if (!societe || !volume_reel_L) {
return res.status(400).json({ error: "Données manquantes: societe et volume_reel_L requis" });
}

// Insérer la distribution
db.prepare("INSERT INTO distributions (id, societe, responsable, volume_cmd_L, volume_reel_L, bon, latitude, longitude, location_city, location_addr, statut) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
id || genId(),
societe,
responsable || null,
volume_cmd_L || volume_reel_L,
volume_reel_L,
bon || null,
latitude || null,
longitude || null,
location_city || null,
location_addr || null,
statut || "COMPLÉTÉ"
);

// Mettre à jour la citerne automatiquement
db.prepare("UPDATE citerne SET current_L = MAX(0, current_L - ?), distributed_L = distributed_L + ?, updated_at = datetime('now') WHERE id = 1").run(volume_reel_L, volume_reel_L);

const citerne = db.prepare("SELECT * FROM citerne WHERE id = 1").get();
res.json({ success: true, citerne });
});

// ── GET /api/distributions — Lire l’historique ──
app.get("/api/distributions", (req, res) => {
const { date, limit = 100, offset = 0 } = req.query;

let query = "SELECT * FROM distributions";
const params = [];

if (date) {
query += " WHERE DATE(created_at) = ?";
params.push(date);
}

query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
params.push(Number(limit), Number(offset));

const rows = db.prepare(query).all(...params);
const total = db.prepare(
date
? "SELECT COUNT(*) as n FROM distributions WHERE DATE(created_at) = ?"
: "SELECT COUNT(*) as n FROM distributions"
).get(...(date ? [date] : [])).n;

res.json({ data: rows, total });
});

// ── GET /api/distributions/:id — Lire une distribution ──
app.get("/api/distributions/:id", (req, res) => {
const row = db.prepare("SELECT * FROM distributions WHERE id = ?").get(req.params.id);
if (!row) return res.status(404).json({ error: "Distribution non trouvée" });
res.json(row);
});

// ── DELETE /api/distributions/:id ──
app.delete("/api/distributions/:id", (req, res) => {
db.prepare("DELETE FROM distributions WHERE id = ?").run(req.params.id);
res.json({ success: true });
});

// ── POST /api/reset-citerne — Réinitialiser la citerne (remplissage) ──
app.post("/api/reset-citerne", (req, res) => {
const { initial_L } = req.body;
const vol = initial_L || 10000;
db.prepare("UPDATE citerne SET initial_L = ?, current_L = ?, distributed_L = 0, updated_at = datetime('now') WHERE id = 1").run(vol, vol);
res.json({ success: true, message: `Citerne réinitialisée à ${vol} L` });
});

// ── GET /api/stats — Statistiques globales ──
app.get("/api/stats", (req, res) => {
const citerne = db.prepare("SELECT * FROM citerne WHERE id = 1").get();
const today   = db.prepare("SELECT COALESCE(SUM(volume_reel_L), 0) as total FROM distributions WHERE DATE(created_at) = DATE('now')").get();
const total_ops = db.prepare("SELECT COUNT(*) as n FROM distributions").get();
const last5     = db.prepare("SELECT * FROM distributions ORDER BY created_at DESC LIMIT 5").all();

res.json({
citerne,
today_L:   today.total,
total_ops: total_ops.n,
last5
});
});

// ── Fallback → index.html (SPA) ──
app.get("*", (req, res) => {
res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── DÉMARRAGE ──
app.listen(PORT, () => {
console.log(`🚀 EEA-CARBURANT-CI démarré sur http://localhost:${PORT}`);
console.log(`📦 Base de données: ${DB_PATH}`);
});

// ── UTILITAIRE ──
function genId() {
const y = new Date().getFullYear();
const r = Math.floor(1000 + Math.random() * 9000);
return `OP-${y}-${r}`;
}