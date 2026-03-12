/* ═══════════════════════════════════════════════════════════════════
   EEA-CARBURANT-CI — app.js  FINAL COMPLET v2
   PILIER 1 → Mode Avion Intelligent       (LocalStorage + file attente)
   PILIER 2 → Verrou de Sécurité           (beforeunload + arrêt auto)
   PILIER 3 → Réconciliation Double-Check  (IndexedDB vs SQLite Render)
   PILIER 4 → Fetch no-cors ESP8266        (double canal navigateur)
   PILIER 5 → Jauge 60 FPS                 (requestAnimationFrame)
   PILIER 6 → Bouton Distribution Complet  (POST /api/pompe/start →
                                            GET  /api/pompe/status 1s →
                                            POST /api/pompe/stop)
   PILIER 7 → Localisation GPS Camion      (position réelle du camion-
                                            citerne via POST /api/truck/
                                            location, pas du bureau)
═══════════════════════════════════════════════════════════════════ */
"use strict";

/* ══ 0 — CONFIG ══════════════════════════════════════════════════ */
const CFG = Object.freeze({
  API_BASE: (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
    ? "http://localhost:3000/api" : "/api",
  CORRECT_CODE    : "180605",
  ESP8266_IP      : "192.168.4.1",
  PUMP_RATE_LPM   : 3.0,
  PUMP_RATE_LPS   : 3.0 / 60,
  TANK_DEFAULT    : 10000,
  IDB_NAME        : "EEA_DB",
  IDB_VERSION     : 1,
  IDB_STORE       : "citerne_state",
  LS_STATE_KEY    : "eea_last_state",
  LS_HIST_KEY     : "eea_offline_queue",
  RECONCILE_TOL   : 50,
  GAUGE_SMOOTHING : 0.06,
  POLL_POMPE_MS   : 1000,
  POLL_CAPTEUR_MS : 8000,
  /* PILIER 7 — GPS camion : on envoie la position toutes les N ms
     si l'opérateur terrain est sur le téléphone embarqué dans le camion */
  TRUCK_GPS_INTERVAL_MS : 15000,
  /* Seuil de distance (mètres) avant ré-envoi de la position */
  TRUCK_GPS_MOVE_THRESHOLD_M : 20,
});

/* ══ 1 — STATE ═══════════════════════════════════════════════════ */
const state = {
  tankInitial    : CFG.TANK_DEFAULT,
  tankCurrent    : CFG.TANK_DEFAULT,
  tankDistributed: 0,
  pumpRunning    : false,
  distribTarget  : 0,
  distribDone    : 0,
  currentOp      : null,
  pollPompeTimer : null,
  pollCapteurTimer: null,
  history        : [],
  selectedRecu   : null,
  /* PILIER 7 — deux objets de localisation séparés */
  userLocation   : { lat: null, lng: null, city: "Abidjan, CI", address: "" },   // opérateur bureau
  truckLocation  : { lat: null, lng: null, city: "Abidjan, CI", address: "", source: "unknown" }, // camion-citerne
  truckGpsTimer  : null,
  truckLastLat   : null,
  truckLastLng   : null,
  serverOnline   : false,
  esp8266Online  : false,
  gaugeTarget    : 0,
  gaugeCurrent   : 0,
  gaugeAnimId    : null,
};
let idb = null;

/* ══ 2 — DÉMARRAGE ═══════════════════════════════════════════════ */
window.addEventListener("DOMContentLoaded", async () => {
  setupPinInputs();
  startClock();
  getUserLocation();     // position de l'opérateur (fallback)
  await openIDB();
  installBeforeUnload();
  loadOfflineState();
});

/* ═══════════════════════════════════════════════════════════════════
   PILIER 7 — LOCALISATION GPS DU CAMION-CITERNE
   ───────────────────────────────────────────────────────────────────
   Principe : l'application tourne SUR le téléphone embarqué dans le
   camion-citerne.  Elle demande la géolocalisation du navigateur ET
   envoie continuellement les coordonnées au serveur via
   POST /api/truck/location.
   Si l'app tourne au bureau, les coords sont quand même transmises
   mais le serveur garde la DERNIÈRE position connue du camion
   (mise à jour depuis l'ESP8266 ou depuis l'app mobile embarquée).
═══════════════════════════════════════════════════════════════════ */

/**
 * Démarre le tracking GPS du camion.
 * Appelé dès initApp() — tente watchPosition haute précision.
 */
function startTruckGPSTracking() {
  if (!navigator.geolocation) {
    fetchTruckLocationFromServer(); // lecture seule si pas de GPS
    return;
  }

  /* watchPosition haute précision pour le téléphone embarqué dans le camion */
  navigator.geolocation.watchPosition(
    (pos) => {
      const lat = parseFloat(pos.coords.latitude.toFixed(6));
      const lng = parseFloat(pos.coords.longitude.toFixed(6));
      const acc = pos.coords.accuracy;

      /* Ne ré-envoyer que si le camion a bougé de plus du seuil */
      const moved = !state.truckLastLat ||
        haversineM(state.truckLastLat, state.truckLastLng, lat, lng) > CFG.TRUCK_GPS_MOVE_THRESHOLD_M;

      state.truckLocation.lat = String(lat);
      state.truckLocation.lng = String(lng);

      if (moved) {
        state.truckLastLat = lat;
        state.truckLastLng = lng;
        reverseGeocodeTruck(lat, lng).then(({ city, address }) => {
          state.truckLocation.city    = city;
          state.truckLocation.address = address;
          pushTruckLocationToServer(lat, lng, city, address, acc, "gps_watch");
        });
      }

      updateTruckLocationUI();
    },
    (err) => {
      console.warn("[GPS CAMION] watchPosition error:", err.message);
      /* Fallback : lire la dernière position connue depuis le serveur */
      fetchTruckLocationFromServer();
      /* Retry périodique */
      if (!state.truckGpsTimer) {
        state.truckGpsTimer = setInterval(retryTruckGPS, CFG.TRUCK_GPS_INTERVAL_MS);
      }
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 10000 }
  );
}

function retryTruckGPS() {
  navigator.geolocation?.getCurrentPosition(
    (pos) => {
      const lat = parseFloat(pos.coords.latitude.toFixed(6));
      const lng = parseFloat(pos.coords.longitude.toFixed(6));
      state.truckLocation.lat = String(lat);
      state.truckLocation.lng = String(lng);
      clearInterval(state.truckGpsTimer); state.truckGpsTimer = null;
      reverseGeocodeTruck(lat, lng).then(({ city, address }) => {
        pushTruckLocationToServer(lat, lng, city, address, pos.coords.accuracy, "gps_retry");
      });
    },
    () => {},
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

/** Pousse la position camion vers le serveur */
async function pushTruckLocationToServer(lat, lng, city, address, accuracy_m, source) {
  try {
    await apiPost("/truck/location", {
      latitude   : String(lat),
      longitude  : String(lng),
      city       : city || "Abidjan, CI",
      address    : address || "",
      accuracy_m : accuracy_m || null,
      source     : source || "gps",
    });
    state.truckLocation.source = source || "gps";
  } catch (e) {
    console.warn("[GPS CAMION] push failed:", e.message);
  }
}

/** Lit la dernière position camion depuis le serveur (si autre appareil) */
async function fetchTruckLocationFromServer() {
  try {
    const resp = await apiGet("/truck/location");
    if (resp.success && resp.location) {
      const loc = resp.location;
      state.truckLocation.lat     = loc.latitude;
      state.truckLocation.lng     = loc.longitude;
      state.truckLocation.city    = loc.city;
      state.truckLocation.address = loc.address;
      state.truckLocation.source  = loc.source;
      updateTruckLocationUI();
    }
  } catch (e) {
    console.warn("[GPS CAMION] fetch from server failed:", e.message);
    /* Dernier recours : IP géoloc */
    fetchIPLocation();
  }
}

/** Met à jour l'affichage UI de la position du camion */
function updateTruckLocationUI() {
  const el = document.getElementById("truckLocationLabel");
  if (el) {
    const src = state.truckLocation.source === "gps_watch" ? "📡 GPS" :
                state.truckLocation.source === "esp8266"   ? "📟 ESP" : "🌐";
    el.textContent = `${src} ${state.truckLocation.city}`;
    el.title = state.truckLocation.address || "";
  }
}

/** Reverse geocoding pour le camion (Nominatim) */
async function reverseGeocodeTruck(lat, lng) {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
      { signal: AbortSignal.timeout(6000) }
    );
    const d = await r.json();
    const city    = d.address.city || d.address.town || d.address.village || "Abidjan";
    const address = d.display_name || city;
    return { city: `${city}, CI`, address };
  } catch {
    return { city: "Abidjan, CI", address: "" };
  }
}

/** Distance en mètres entre deux coords GPS (Haversine) */
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Retourne les coordonnées à utiliser pour une distribution.
 * Priorité : position GPS du camion > position IP de l'utilisateur > défaut CI.
 */
function getDistribLocation() {
  if (state.truckLocation.lat && state.truckLocation.lng) {
    return {
      latitude     : state.truckLocation.lat,
      longitude    : state.truckLocation.lng,
      location_city: state.truckLocation.city,
      location_addr: state.truckLocation.address,
    };
  }
  return {
    latitude     : state.userLocation.lat  || "5.3600",
    longitude    : state.userLocation.lng  || "-4.0083",
    location_city: state.userLocation.city || "Abidjan, CI",
    location_addr: state.userLocation.address || "",
  };
}

/* ══ PILIER 1 — MODE AVION ═══════════════════════════════════════ */
function persistStateLocally() {
  try {
    localStorage.setItem(CFG.LS_STATE_KEY, JSON.stringify({
      tankInitial    : state.tankInitial,
      tankCurrent    : state.tankCurrent,
      tankDistributed: state.tankDistributed,
      savedAt        : new Date().toISOString(),
    }));
  } catch (_) {}
}
function loadOfflineState() {
  try {
    const s = JSON.parse(localStorage.getItem(CFG.LS_STATE_KEY) || "null");
    if (s && typeof s.tankCurrent === "number") {
      state.tankInitial     = s.tankInitial;
      state.tankCurrent     = s.tankCurrent;
      state.tankDistributed = s.tankDistributed;
    }
  } catch (_) {}
}
function enqueueOfflineDistrib(op) {
  try {
    const q = JSON.parse(localStorage.getItem(CFG.LS_HIST_KEY) || "[]");
    q.push({ ...op, queued: new Date().toISOString() });
    localStorage.setItem(CFG.LS_HIST_KEY, JSON.stringify(q));
  } catch (_) {}
}
async function flushOfflineQueue() {
  try {
    const queue = JSON.parse(localStorage.getItem(CFG.LS_HIST_KEY) || "[]");
    if (!queue.length) return;
    const remaining = [];
    for (const op of queue) {
      try { await apiPost("/distributions", op); }
      catch (_) { remaining.push(op); }
    }
    remaining.length
      ? localStorage.setItem(CFG.LS_HIST_KEY, JSON.stringify(remaining))
      : localStorage.removeItem(CFG.LS_HIST_KEY);
  } catch (_) {}
}

/* ══ PILIER 2 — VERROU SÉCURITÉ ══════════════════════════════════ */
function installBeforeUnload() {
  window.addEventListener("beforeunload", (e) => {
    if (!state.pumpRunning) return;
    apiPost("/pompe/stop", {}).catch(() => {});
    sendDirectToESP8266(0);
    const msg = `⚠ POMPE EN COURS — ${state.distribDone.toFixed(1)} L / ${state.distribTarget} L.\nQuitter va stopper la pompe.`;
    e.preventDefault(); e.returnValue = msg; return msg;
  });
}

/* ══ PILIER 3 — RÉCONCILIATION IndexedDB ═════════════════════════ */
function openIDB() {
  return new Promise((resolve) => {
    if (!window.indexedDB) { resolve(); return; }
    const req = indexedDB.open(CFG.IDB_NAME, CFG.IDB_VERSION);
    req.onupgradeneeded = (e) => {
      if (!e.target.result.objectStoreNames.contains(CFG.IDB_STORE))
        e.target.result.createObjectStore(CFG.IDB_STORE, { keyPath: "key" });
    };
    req.onsuccess = (e) => { idb = e.target.result; resolve(); };
    req.onerror   = () => resolve();
  });
}
function idbSave(data) {
  if (!idb) return;
  idb.transaction(CFG.IDB_STORE, "readwrite")
     .objectStore(CFG.IDB_STORE)
     .put({ key: "citerne", ...data, ts: Date.now() });
}
function idbLoad() {
  return new Promise((resolve) => {
    if (!idb) { resolve(null); return; }
    const req = idb.transaction(CFG.IDB_STORE, "readonly")
                   .objectStore(CFG.IDB_STORE)
                   .get("citerne");
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => resolve(null);
  });
}
async function reconcile(serverState) {
  const local = await idbLoad();
  if (!local) {
    idbSave({ tankInitial: serverState.initial_L, tankCurrent: serverState.current_L, tankDistributed: serverState.distributed_L });
    return serverState;
  }
  if ((serverState.current_L - local.tankCurrent) > CFG.RECONCILE_TOL) {
    console.warn(`[P3] Reset détecté → serveur:${serverState.current_L}L local:${local.tankCurrent}L`);
    try { await apiPut("/citerne", { initial_L: local.tankInitial, current_L: local.tankCurrent, distributed_L: local.tankDistributed }); }
    catch (_) {}
    return { initial_L: local.tankInitial, current_L: local.tankCurrent, distributed_L: local.tankDistributed };
  }
  idbSave({ tankInitial: serverState.initial_L, tankCurrent: serverState.current_L, tankDistributed: serverState.distributed_L });
  return serverState;
}

/* ══ PILIER 4 — DOUBLE CANAL ESP8266 (navigateur direct) ═════════ */
function sendDirectToESP8266(volumeL) {
  fetch(`http://${CFG.ESP8266_IP}/pump?vol=${volumeL}`, {
    method: "GET", mode: "no-cors", cache: "no-store",
    signal: AbortSignal.timeout(4000),
  })
  .then(() => { state.esp8266Online = true;  updateStatusBadge(true); })
  .catch((e) => {
    if (e.name !== "AbortError") { state.esp8266Online = true;  updateStatusBadge(true); }
    else                         { state.esp8266Online = false; updateStatusBadge(false); }
  });
}

/* ══ PILIER 5 — JAUGE 60 FPS requestAnimationFrame ══════════════ */
function animateGaugeTo(targetPct) {
  state.gaugeTarget = Math.max(0, Math.min(100, targetPct));
  if (state.gaugeAnimId) cancelAnimationFrame(state.gaugeAnimId);
  function frame() {
    const delta = state.gaugeTarget - state.gaugeCurrent;
    if (Math.abs(delta) < 0.05) {
      state.gaugeCurrent = state.gaugeTarget;
      drawGaugeFrame(state.gaugeCurrent);
      state.gaugeAnimId = null; return;
    }
    state.gaugeCurrent += delta * CFG.GAUGE_SMOOTHING;
    drawGaugeFrame(state.gaugeCurrent);
    state.gaugeAnimId = requestAnimationFrame(frame);
  }
  state.gaugeAnimId = requestAnimationFrame(frame);
}
function drawGaugeFrame(percent) {
  const canvas = document.getElementById("fuelGauge"); if (!canvas) return;
  const ctx = canvas.getContext("2d"), W = canvas.width, H = canvas.height, cx = W / 2, cy = H / 2 + 20, R = 110;
  const START = Math.PI * 0.75, END = Math.PI * 2.25, SPAN = END - START, fill = START + SPAN * (percent / 100);
  ctx.clearRect(0, 0, W, H);
  ctx.beginPath(); ctx.arc(cx, cy, R, START, END); ctx.strokeStyle = "rgba(0,212,255,.08)"; ctx.lineWidth = 18; ctx.lineCap = "round"; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, R, START, START + SPAN * 0.20); ctx.strokeStyle = "rgba(255,61,61,.18)"; ctx.lineWidth = 18; ctx.stroke();
  const g = ctx.createLinearGradient(cx - R, cy, cx + R, cy);
  if (percent > 50) { g.addColorStop(0, "#00a8cc"); g.addColorStop(.6, "#00d4ff"); g.addColorStop(1, "#f5a623"); }
  else if (percent > 20) { g.addColorStop(0, "#c47d0e"); g.addColorStop(1, "#ff6b35"); }
  else { g.addColorStop(0, "#6b0000"); g.addColorStop(1, "#ff3d3d"); }
  ctx.save(); ctx.shadowBlur = 22; ctx.shadowColor = percent > 50 ? "rgba(0,212,255,.55)" : percent > 20 ? "rgba(245,166,35,.55)" : "rgba(255,61,61,.55)";
  ctx.beginPath(); ctx.arc(cx, cy, R, START, fill); ctx.strokeStyle = g; ctx.lineWidth = 18; ctx.lineCap = "round"; ctx.stroke(); ctx.restore();
  for (let i = 0; i <= 10; i++) {
    const a = START + SPAN * (i / 10), r1 = R - 14, r2 = R - (i % 5 === 0 ? 30 : 22);
    ctx.beginPath(); ctx.moveTo(cx + r1 * Math.cos(a), cy + r1 * Math.sin(a));
    ctx.lineTo(cx + r2 * Math.cos(a), cy + r2 * Math.sin(a));
    ctx.strokeStyle = i % 5 === 0 ? "rgba(245,166,35,.75)" : "rgba(0,212,255,.30)"; ctx.lineWidth = i % 5 === 0 ? 2 : 1; ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(cx, cy, R - 30, 0, Math.PI * 2); ctx.fillStyle = "rgba(9,20,32,.94)"; ctx.fill();
  ctx.strokeStyle = "rgba(0,212,255,.12)"; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.font = "bold 12px 'Share Tech Mono'"; ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255,61,61,.75)";  ctx.fillText("E", cx + (R - 48) * Math.cos(START), cy + (R - 48) * Math.sin(START) + 4);
  ctx.fillStyle = "rgba(0,230,118,.75)";  ctx.fillText("F", cx + (R - 48) * Math.cos(END),   cy + (R - 48) * Math.sin(END)   + 4);
  const el = document.getElementById("gaugePercent"); if (el) el.textContent = `${Math.round(percent)}%`;
}

/* ══ PILIER 6 — BOUTON DISTRIBUTION COMPLET ══════════════════════
   FLUX EXACT À CHAQUE CLIC "LANCER LA DISTRIBUTION":
   [1] Validation formulaire (société, volume, disponibilité)
   [2] Récupère la position GPS du camion (PILIER 7)
   [3] POST /api/pompe/start → Node.js contacte ESP8266 + démarre timer
   [4] sendDirectToESP8266() → double canal no-cors navigateur
   [5] setInterval GET /api/pompe/status toutes les 1s
       └─ updateProgressBar() + animateGaugeTo() en temps réel
   [6] Quand status.active=false → onDistributionTerminee()
       └─ persistStateLocally() + idbSave() + POST /distributions
   BOUTON STOP:
   [1] POST /api/pompe/stop (Node.js envoie vol=0 à ESP)
   [2] sendDirectToESP8266(0) canal direct
   [3] onDistributionTerminee() statut PARTIEL
══════════════════════════════════════════════════════════════ */

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("distribVolume")?.addEventListener("input", updateDistribPreview);
});

function updateDistribPreview() {
  const vol   = parseFloat(document.getElementById("distribVolume")?.value) || 0;
  const after = state.tankCurrent - vol;
  const duree = vol ? (vol / CFG.PUMP_RATE_LPM).toFixed(1) : null;
  setTextSafe("prevVol",   vol  ? `${vol} L` : "— L");
  setTextSafe("prevAfter", vol  ? `${Math.max(0, after)} L` : "— L");
  setTextSafe("prevDuree", duree ? `~${duree} min` : "—");
  const al = document.getElementById("alertLow");
  if (al) al.style.display = (after < state.tankInitial * 0.15 && vol > 0) ? "flex" : "none";

  /* PILIER 7 — afficher la position camion dans le preview */
  const locEl = document.getElementById("prevLocation");
  if (locEl) {
    const loc = getDistribLocation();
    locEl.textContent = `📍 ${loc.location_city}`;
    locEl.title = loc.location_addr || loc.location_city;
  }
}

async function startDistribution() {
  /* [1] Validation */
  const societe     = document.getElementById("distribSociete")?.value.trim();
  const responsable = document.getElementById("distribResponsable")?.value.trim() || "";
  const vol         = parseFloat(document.getElementById("distribVolume")?.value);
  const bon         = document.getElementById("distribBon")?.value.trim() || genBon();

  if (!societe)       return showToast("⚠ Veuillez entrer le nom de la société.", "error");
  if (!vol || vol <= 0) return showToast("⚠ Veuillez entrer un volume valide.", "error");
  if (vol > state.tankCurrent)
    return showToast(`⚠ Volume insuffisant. Disponible: ${state.tankCurrent.toFixed(0)} L`, "error");

  /* [2] PILIER 7 — position réelle du camion */
  const loc = getDistribLocation();

  const op = {
    op_id       : genId(),
    societe,
    responsable,
    volume_L    : vol,
    bon,
    latitude    : loc.latitude,
    longitude   : loc.longitude,
    location_city: loc.location_city,
    location_addr: loc.location_addr,
  };

  state.currentOp     = op;
  state.pumpRunning   = true;
  state.distribTarget = vol;
  state.distribDone   = 0;

  setPumpUI("running");
  resetProgressBar();

  /* [4] PILIER 4 — canal direct navigateur → ESP8266 */
  sendDirectToESP8266(vol);

  /* [3] POST /api/pompe/start */
  try {
    const result = await apiPost("/pompe/start", op);
    if (!result.success) {
      state.pumpRunning = false;
      setPumpUI("idle");
      return showToast(`❌ ${result.error}`, "error");
    }
    showToast(
      `🔌 Pompe démarrée — ${vol} L — ~${result.duree_min} min` +
      (result.esp_contacte ? " — ESP8266 ✅" : " — Mode simulé ⚡"),
      result.esp_contacte ? "success" : "warn"
    );

    /* [5] Polling progression */
    startPompePolling(result.op_id, vol);

  } catch (e) {
    console.warn("[POMPE] Serveur hors ligne:", e.message);
    showToast("⚡ Mode hors-ligne — distribution simulée localement", "warn");
    startLocalSimulation(op, vol);
  }
}

/* [5] Polling GET /api/pompe/status (1s) */
function startPompePolling(op_id, volume_target) {
  if (state.pollPompeTimer) clearInterval(state.pollPompeTimer);
  state.pollPompeTimer = setInterval(async () => {
    try {
      const status        = await apiGet("/pompe/status");
      state.distribDone   = status.volume_done;
      updateProgressBar(status.percent, status.volume_done, volume_target);
      /* PILIER 5 — jauge en temps réel */
      animateGaugeTo(Math.round(((state.tankCurrent - status.volume_done) / state.tankInitial) * 100));
      /* [6] Fin automatique */
      if (!status.active && state.pumpRunning) {
        clearInterval(state.pollPompeTimer); state.pollPompeTimer = null;
        await onDistributionTerminee(op_id, status.volume_done, "COMPLÉTÉ");
      }
    } catch (e) { console.warn("[POLLING]", e.message); }
  }, CFG.POLL_POMPE_MS);
}

async function stopDistribution() {
  if (!state.pumpRunning) return;
  if (state.pollPompeTimer) { clearInterval(state.pollPompeTimer); state.pollPompeTimer = null; }
  sendDirectToESP8266(0); /* PILIER 4 canal direct */
  try {
    const result = await apiPost("/pompe/stop", {});
    const volReel = result.volume_reel ?? state.distribDone;
    showToast(`⛔ Pompe arrêtée — ${volReel.toFixed(1)} L distribués`, "warn");
    await onDistributionTerminee(state.currentOp?.op_id, volReel, "PARTIEL");
  } catch (e) {
    showToast("⛔ Pompe arrêtée (mode local)", "warn");
    await onDistributionTerminee(state.currentOp?.op_id, state.distribDone, "PARTIEL");
  }
}

async function onDistributionTerminee(op_id, vol_reel, statut) {
  state.pumpRunning = false;
  const actualVol = parseFloat((vol_reel || 0).toFixed(2));

  /* Mise à jour locale immédiate */
  state.tankCurrent     = Math.max(0, state.tankCurrent - actualVol);
  state.tankDistributed += actualVol;

  /* PILIER 1 */
  persistStateLocally();
  /* PILIER 3 */
  idbSave({ tankInitial: state.tankInitial, tankCurrent: state.tankCurrent, tankDistributed: state.tankDistributed });

  /* PILIER 7 — position camion au moment de la distribution */
  const loc = getDistribLocation();

  const histEntry = {
    id           : op_id || genId(),
    societe      : state.currentOp?.societe   || "—",
    responsable  : state.currentOp?.responsable || "—",
    volume_cmd_L : state.currentOp?.volume_L  || actualVol,
    volume_reel_L: actualVol,
    volumeReel   : actualVol,
    bon          : state.currentOp?.bon        || "—",
    latitude     : loc.latitude,
    longitude    : loc.longitude,
    location_city: loc.location_city,
    location_addr: loc.location_addr,
    statut,
    status       : statut,
    created_at   : new Date().toISOString(),
    dateTime     : new Date().toISOString(),
  };

  /* Archiver via POST /api/distributions (INSERT OR REPLACE) */
  try {
    await apiPost("/distributions", { ...histEntry, id: op_id });
    state.serverOnline = true;
  } catch (e) {
    enqueueOfflineDistrib({ ...histEntry, id: op_id });
    showBanner("⚡ Hors-ligne — distribution sauvegardée localement", "warn");
  }

  state.history.unshift(histEntry);
  setPumpUI("idle", statut === "PARTIEL");
  updateProgressBar(100, actualVol, actualVol);
  updateDashboard();
  addTodayItem(histEntry);
  setTimeout(() => setPumpUI("waiting"), 4000);
  showToast(
    `✅ Distribution ${statut === "PARTIEL" ? "interrompue" : "terminée"} — ${actualVol} L distribués à ${state.currentOp?.societe || ""} 📍 ${loc.location_city}`,
    statut === "COMPLÉTÉ" ? "success" : "warn"
  );
}

/* Simulation locale si serveur totalement inaccessible */
function startLocalSimulation(op, vol) {
  let done = 0;
  const timer = setInterval(async () => {
    done = Math.min(done + CFG.PUMP_RATE_LPS, vol);
    state.distribDone = done;
    const pct = (done / vol) * 100;
    updateProgressBar(pct, done, vol);
    animateGaugeTo(Math.round(((state.tankCurrent - done) / state.tankInitial) * 100));
    if (done >= vol) { clearInterval(timer); await onDistributionTerminee(op.op_id, done, "COMPLÉTÉ"); }
  }, 1000);
}

/* Polling capteur ultrasonique (8s) */
function startCapteurPolling() {
  if (state.pollCapteurTimer) clearInterval(state.pollCapteurTimer);
  state.pollCapteurTimer = setInterval(async () => {
    if (state.pumpRunning) return;
    try {
      const data = await apiGet("/capteur");
      if (data.success && data.niveau_L > 0 && data.source === "esp8266") {
        state.tankCurrent = data.niveau_L;
        persistStateLocally();
        idbSave({ tankInitial: state.tankInitial, tankCurrent: state.tankCurrent, tankDistributed: state.tankDistributed });
        updateDashboard();
      }
      setTextSafe("sensorDist", `${data.distance_cm?.toFixed(1) || "—"} cm`);
      updateStatusBadge(data.source === "esp8266");
    } catch (_) {}
  }, CFG.POLL_CAPTEUR_MS);
}

/* ══ 3 — REQUÊTES API ════════════════════════════════════════════ */
async function apiGet(path) {
  const res = await fetch(`${CFG.API_BASE}${path}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}
async function apiPost(path, body) {
  const res = await fetch(`${CFG.API_BASE}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
  return res.json();
}
async function apiPut(path, body) {
  const res = await fetch(`${CFG.API_BASE}${path}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`PUT ${path} → ${res.status}`);
  return res.json();
}

/* ══ 4 — INIT APP ════════════════════════════════════════════════ */
async function initApp() {
  showLoadingOverlay(true);
  loadOfflineState();
  animateGaugeTo(levelPercent());
  updateDashboard();

  /* PILIER 7 — Démarre le tracking GPS du camion */
  startTruckGPSTracking();

  try {
    const trusted = await reconcile(await apiGet("/citerne"));
    state.tankInitial     = trusted.initial_L;
    state.tankCurrent     = trusted.current_L;
    state.tankDistributed = trusted.distributed_L;
    state.serverOnline    = true;
    persistStateLocally();
    flushOfflineQueue();
    state.history = (await apiGet("/distributions?limit=5")).data || [];
    /* PILIER 7 — charger aussi la position camion depuis le serveur */
    fetchTruckLocationFromServer();
  } catch (e) {
    state.serverOnline = false;
    if (!state.history.length) state.history = getDemoHistory();
    showBanner("⚡ Mode hors-ligne — données locales affichées", "warn");
  }

  animateGaugeTo(levelPercent());
  updateDashboard();
  drawConsumChart();
  populateTodayList();
  simulateLiveSensor();
  startCapteurPolling();
  showLoadingOverlay(false);
}

/* ══ 5 — LOGIN / LOGOUT ══════════════════════════════════════════ */
function setupPinInputs() {
  const inputs = document.querySelectorAll(".pin-box");
  inputs.forEach((inp, i) => {
    inp.addEventListener("input", e => {
      const val = e.target.value.replace(/[^0-9]/g, "");
      e.target.value = val ? val.slice(-1) : "";
      if (val && i < inputs.length - 1) inputs[i + 1].focus();
      val ? e.target.classList.add("filled") : e.target.classList.remove("filled");
      if (Array.from(inputs).map(x => x.value).join("").length === 6) setTimeout(handleLogin, 200);
    });
    inp.addEventListener("keydown", e => {
      if (e.key === "Backspace" && !inp.value && i > 0) { inputs[i - 1].focus(); inputs[i - 1].value = ""; inputs[i - 1].classList.remove("filled"); }
      if (e.key === "Enter") handleLogin();
    });
  });
}
function handleLogin() {
  const inputs = document.querySelectorAll(".pin-box");
  const code   = Array.from(inputs).map(i => i.value).join("");
  const errEl  = document.getElementById("loginError");
  if (code === CFG.CORRECT_CODE) {
    errEl.textContent = "";
    const btn = document.getElementById("btnLogin");
    btn.innerHTML = '<i class="fas fa-check-circle"></i> <span>ACCÈS ACCORDÉ</span>';
    btn.style.background = "linear-gradient(135deg,#003a10,#006620,#00e676)";
    setTimeout(() => {
      document.getElementById("loginPage").classList.remove("active");
      document.getElementById("mainApp").classList.add("active");
      initApp();
    }, 600);
  } else {
    errEl.textContent = "⚠ CODE INCORRECT — ACCÈS REFUSÉ";
    inputs.forEach(i => { i.classList.add("error"); i.value = ""; i.classList.remove("filled"); });
    setTimeout(() => inputs.forEach(i => i.classList.remove("error")), 600);
    inputs[0].focus();
  }
}
function logout() {
  if (state.pumpRunning) {
    if (!confirm("⚠ La pompe tourne encore. Arrêter et se déconnecter ?")) return;
    apiPost("/pompe/stop", {}).catch(() => {});
    sendDirectToESP8266(0);
    if (state.pollPompeTimer) { clearInterval(state.pollPompeTimer); state.pollPompeTimer = null; }
    state.pumpRunning = false;
  }
  if (state.pollCapteurTimer) { clearInterval(state.pollCapteurTimer); state.pollCapteurTimer = null; }
  if (state.truckGpsTimer)    { clearInterval(state.truckGpsTimer);    state.truckGpsTimer = null; }

  document.getElementById("mainApp").classList.remove("active");
  document.getElementById("loginPage").classList.add("active");
  document.querySelectorAll(".pin-box").forEach(i => { i.value = ""; i.classList.remove("filled", "error"); });
  document.getElementById("loginError").textContent = "";
  const btn = document.getElementById("btnLogin");
  btn.innerHTML = '<span class="btn-text">ACCÉDER AU SYSTÈME</span><i class="fas fa-arrow-right btn-icon"></i>';
  btn.style.background = "";
}

/* ══ 6 — NAVIGATION ══════════════════════════════════════════════ */
function showPage(name) {
  document.querySelectorAll(".content-page").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(i => i.classList.remove("active"));
  document.getElementById(`page-${name}`)?.classList.add("active");
  const map = {
    dashboard   : { title: "TABLEAU DE BORD", bread: "Accueil / Dashboard" },
    distribution: { title: "DISTRIBUTION",    bread: "Accueil / Distribution" },
    historique  : { title: "HISTORIQUE",       bread: "Accueil / Historique" },
    recu        : { title: "GESTION DES REÇUS",bread: "Accueil / Reçus" },
  };
  const info = map[name] || { title: name.toUpperCase(), bread: `Accueil/${name}` };
  setTextSafe("pageTitle",  info.title);
  setTextSafe("breadcrumb", info.bread);
  const navMap = ["dashboard","distribution","historique","recu"];
  const items  = document.querySelectorAll(".nav-item");
  const idx    = navMap.indexOf(name);
  if (idx >= 0 && items[idx]) items[idx].classList.add("active");
  if (name === "distribution") { updateDistribPreview(); fetchTruckLocationFromServer(); }
  if (name === "historique")   loadAndRenderHistory();
  if (name === "recu")         loadAndRenderRecus();
}
function toggleSidebar() {
  const sb = document.getElementById("sidebar");
  sb.style.width = sb.offsetWidth > 100 ? "60px" : "240px";
}

/* ══ 7 — DASHBOARD ═══════════════════════════════════════════════ */
function levelPercent() {
  if (!state.tankInitial) return 0;
  return Math.max(0, Math.min(100, Math.round((state.tankCurrent / state.tankInitial) * 100)));
}
function updateDashboard() {
  const pct     = levelPercent();
  const distPct = state.tankInitial ? Math.round((state.tankDistributed / state.tankInitial) * 100) : 0;
  setTextSafe("gaugePercent",   `${pct}%`);
  setTextSafe("litresRestants", formatL(state.tankCurrent));
  setTextSafe("litresInitial",  formatL(state.tankInitial));
  setTextSafe("statDistribue",  formatL(state.tankDistributed));
  setTextSafe("hintDisponible", formatL(state.tankCurrent));
  setBarWidth("lbFuel", pct);
  setBarWidth("lbDist", distPct);
  animateGaugeTo(pct);
}

/* ══ 8 — GRAPHIQUE CONSOMMATION ══════════════════════════════════ */
async function drawConsumChart() {
  const canvas = document.getElementById("consumChart"); if (!canvas) return;
  const ctx = canvas.getContext("2d"), W = canvas.offsetWidth || 600, H = 160;
  canvas.width = W; canvas.height = H;
  let data = [320,850,440,1200,680,920,340], labels = ["Lun","Mar","Mer","Jeu","Ven","Sam","Dim"];
  try {
    const hist = await apiGet("/distributions?limit=200");
    if (hist.data?.length >= 2) {
      const dayMap = {};
      hist.data.forEach(h => { const d = (h.created_at||"").substring(0,10); if(d) dayMap[d]=(dayMap[d]||0)+(h.volume_reel_L||0); });
      const keys = Object.keys(dayMap).sort().slice(-7);
      if (keys.length >= 2) {
        data   = keys.map(k => dayMap[k]);
        labels = keys.map(k => new Date(k).toLocaleDateString("fr-CI", { weekday: "short" }));
      }
    }
  } catch (_) {}
  const maxVal = Math.max(...data, 1), pL=50, pR=20, pT=20, pB=30, cW=W-pL-pR, cH=H-pT-pB;
  ctx.clearRect(0, 0, W, H);
  for (let i=0; i<=4; i++) {
    const y = pT + cH - cH * i / 4;
    ctx.beginPath(); ctx.moveTo(pL, y); ctx.lineTo(W-pR, y); ctx.strokeStyle="rgba(0,212,255,.07)"; ctx.lineWidth=1; ctx.stroke();
    ctx.fillStyle="rgba(90,122,154,.6)"; ctx.font="10px 'Share Tech Mono'"; ctx.textAlign="right"; ctx.fillText(`${Math.round(maxVal*i/4)}`, pL-6, y+4);
  }
  const pts = data.map((v,i) => ({ x: pL+(i/Math.max(data.length-1,1))*cW, y: pT+cH-(v/maxVal)*cH }));
  const ag = ctx.createLinearGradient(0,pT,0,pT+cH); ag.addColorStop(0,"rgba(0,212,255,.22)"); ag.addColorStop(1,"rgba(0,212,255,.01)");
  ctx.beginPath(); ctx.moveTo(pts[0].x, pT+cH); pts.forEach(p=>ctx.lineTo(p.x,p.y)); ctx.lineTo(pts.at(-1).x, pT+cH); ctx.closePath(); ctx.fillStyle=ag; ctx.fill();
  ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); pts.forEach(p=>ctx.lineTo(p.x,p.y)); ctx.strokeStyle="rgba(0,212,255,.9)"; ctx.lineWidth=2; ctx.lineJoin="round"; ctx.stroke();
  pts.forEach((p,i) => {
    ctx.beginPath(); ctx.arc(p.x,p.y,5,0,Math.PI*2); ctx.fillStyle="#00d4ff"; ctx.shadowBlur=10; ctx.shadowColor="#00d4ff"; ctx.fill(); ctx.shadowBlur=0;
    ctx.fillStyle="rgba(90,122,154,.9)"; ctx.font="10px 'Share Tech Mono'"; ctx.textAlign="center"; ctx.fillText(labels[i]||"", p.x, H-8);
  });
}

/* ══ 9 — CAPTEUR SIMULATION ══════════════════════════════════════ */
function simulateLiveSensor() {
  setInterval(() => {
    if (state.esp8266Online) return;
    const pct = levelPercent(), dist = Math.round((200*(1-pct/100))*10)/10;
    setTextSafe("sensorDist", `${dist} cm`);
    setTextSafe("statTemp",   `${(27.5+Math.random()*2).toFixed(1)}°C`);
  }, 3000);
}

/* ══ 10 — HISTORIQUE ═════════════════════════════════════════════ */
async function loadAndRenderHistory(filterDate=null) {
  const tbody = document.getElementById("histTableBody"); if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:30px;color:var(--text-dim);font-family:var(--font-mono)"><i class="fas fa-spinner fa-spin"></i> Chargement...</td></tr>`;
  try {
    const resp = await apiGet(filterDate ? `/distributions?date=${filterDate}` : "/distributions?limit=100");
    state.history = resp.data || [];
    renderHistoryTable(state.history, resp.total);
  } catch (_) { renderHistoryTable(state.history.length ? state.history : getDemoHistory(), null); }
}
function renderHistoryTable(data, total) {
  const tbody = document.getElementById("histTableBody"); if (!tbody) return;
  if (!data?.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:30px;color:var(--text-dim);font-family:var(--font-mono)">Aucune distribution trouvée</td></tr>`;
    setTextSafe("histCount", "0 enregistrement(s)"); return;
  }
  tbody.innerHTML = data.map((h,idx) => {
    const dt  = new Date(h.created_at||h.dateTime);
    const lat = h.latitude||h.lat||"5.3600", lng = h.longitude||h.lng||"-4.0083";
    const vol = h.volume_reel_L||h.volumeReel||h.volume||0;
    const stat = h.statut||h.status||"COMPLÉTÉ", id = h.id||`OP-${1000+idx}`;
    return `<tr>
      <td><span style="font-family:var(--font-mono);color:var(--accent3);font-size:11px">${id}</span></td>
      <td><div style="font-family:var(--font-mono);font-size:12px">${dt.toLocaleDateString("fr-CI",{day:"2-digit",month:"short",year:"numeric"})}</div>
          <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim)">${dt.toLocaleTimeString("fr-CI",{hour:"2-digit",minute:"2-digit"})}</div></td>
      <td style="font-weight:600">${h.societe||"—"}</td>
      <td style="color:var(--text-dim)">${h.responsable||"—"}</td>
      <td><span style="font-family:var(--font-display);font-size:15px;color:var(--accent)">${vol} L</span></td>
      <td style="font-family:var(--font-mono);font-size:11px;color:var(--text-dim)">${h.bon||"—"}</td>
      <td><a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" style="font-family:var(--font-mono);font-size:10px;color:var(--accent3);text-decoration:none">
            <i class="fas fa-map-marker-alt"></i> ${lat}, ${lng}</a>
          <div style="font-family:var(--font-mono);font-size:9px;color:var(--text-muted)">${h.location_city||h.location||"Abidjan, CI"}</div></td>
      <td><span class="tag-${stat==="COMPLÉTÉ"?"success":"partial"}">${stat}</span></td>
      <td><button class="btn-view-recu" onclick="viewRecuById('${id}')">REÇU</button></td>
    </tr>`;
  }).join("");
  setTextSafe("histCount", `${total??data.length} enregistrement(s)`);
}
function filterHistory() { loadAndRenderHistory(document.getElementById("histFilter")?.value||null); }
async function exportCSV() {
  try {
    const resp = await apiGet("/distributions?limit=9999");
    const data = resp.data?.length ? resp.data : getDemoHistory();
    const hdr  = ["ID","Date","Heure","Société","Responsable","Volume (L)","Bon","Latitude","Longitude","Lieu","Statut"];
    const rows = data.map(h => {
      const dt = new Date(h.created_at||h.dateTime);
      return [h.id,dt.toLocaleDateString("fr-CI"),dt.toLocaleTimeString("fr-CI"),h.societe,h.responsable||"",
              h.volume_reel_L||h.volumeReel||h.volume,h.bon||"",h.latitude||h.lat||"",
              h.longitude||h.lng||"",h.location_city||h.location||"",h.statut||h.status||"COMPLÉTÉ"]
             .map(v=>`"${v}"`).join(",");
    });
    const csv  = [hdr.join(","), ...rows].join("\n");
    const blob = new Blob(["\uFEFF"+csv], { type:"text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    Object.assign(document.createElement("a"), { href:url, download:`EEA-Historique-${new Date().toISOString().slice(0,10)}.csv` }).click();
    URL.revokeObjectURL(url);
  } catch (e) { showToast("Erreur export: "+e.message, "error"); }
}

/* ══ 11 — REÇUS ══════════════════════════════════════════════════ */
async function loadAndRenderRecus() {
  const list = document.getElementById("recuList"); if (!list) return;
  list.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-dim);font-family:var(--font-mono);font-size:12px"><i class="fas fa-spinner fa-spin"></i> Chargement...</div>`;
  try {
    const resp = await apiGet("/distributions?limit=50");
    state.history = resp.data || [];
    renderRecuList(state.history);
  } catch (_) { renderRecuList(state.history.length ? state.history : getDemoHistory()); }
}
function renderRecuList(data) {
  const list = document.getElementById("recuList"); if (!list) return;
  list.innerHTML = (data||[]).map(h => {
    const dt  = new Date(h.created_at||h.dateTime);
    const vol = h.volume_reel_L||h.volumeReel||h.volume||0;
    return `<div class="recu-item" data-id="${h.id}" onclick='selectRecu(${JSON.stringify(h).replace(/'/g,"&#39;")},this)'>
      <div class="recu-item-company">${h.societe}</div>
      <div class="recu-item-info">
        <span>${dt.toLocaleDateString("fr-CI")}</span>
        <span class="recu-item-vol">${vol} L</span>
        <span>${h.bon||h.id}</span>
      </div>
    </div>`;
  }).join("");
}
function selectRecu(op, el) {
  document.querySelectorAll(".recu-item").forEach(e => e.classList.remove("selected"));
  el.classList.add("selected");
  state.selectedRecu = normalizeOp(op);
  renderRecuPreview(state.selectedRecu);
}
async function viewRecuById(id) {
  showPage("recu");
  try { state.selectedRecu = normalizeOp(await apiGet(`/distributions/${id}`)); }
  catch (_) { state.selectedRecu = normalizeOp(state.history.find(h => h.id === id) || {}); }
  setTimeout(() => {
    renderRecuPreview(state.selectedRecu);
    document.querySelectorAll(".recu-item").forEach(el => el.classList.toggle("selected", el.dataset.id === id));
  }, 300);
}
function normalizeOp(h) {
  if (!h) return null;
  return {
    id         : h.id,
    societe    : h.societe,
    responsable: h.responsable || "—",
    volume     : h.volume_reel_L||h.volumeReel||h.volume,
    volumeReel : h.volume_reel_L||h.volumeReel||h.volume,
    bon        : h.bon,
    lat        : h.latitude||h.lat,
    lng        : h.longitude||h.lng,
    location   : h.location_city||h.location,
    address    : h.location_addr||h.address,
    dateTime   : h.created_at||h.dateTime,
    status     : h.statut||h.status||"COMPLÉTÉ",
  };
}
function renderRecuPreview(op) {
  const area = document.getElementById("recuPreview");
  if (area && op) area.innerHTML = buildReceiptHTML(op);
}
function buildReceiptHTML(op) {
  if (!op) return "";
  const dt      = new Date(op.dateTime||Date.now());
  const dateStr = dt.toLocaleDateString("fr-CI",{weekday:"long",day:"2-digit",month:"long",year:"numeric"});
  const timeStr = dt.toLocaleTimeString("fr-CI",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
  const vol = op.volumeReel||op.volume||0;
  const lat = op.lat||"5.3600", lng = op.lng||"-4.0083", loc = op.location||"Abidjan, Côte d'Ivoire";
  const bars = Array.from({length:40},()=>{
    const h=15+Math.floor(Math.random()*15),w=Math.random()>.5?2:1;
    return `<span style="width:${w}px;height:${h}px;margin:0 1px;background:#1a2a4e;display:inline-block;border-radius:1px;vertical-align:bottom"></span>`;
  }).join("");
  return `<div class="receipt-container" id="receiptToPrint">
    <div class="receipt-header">
      <div class="receipt-logo-row">
        <span class="receipt-logo-icon">⛽</span>
        <span class="receipt-co-name">EEA-CARBURANT-CI</span>
        <span class="receipt-flag">🇨🇮</span>
      </div>
      <div class="receipt-slogan">EXCELLENCE • ÉNERGIE • AFRIQUE</div>
      <div class="receipt-title">BORDEREAU DE DISTRIBUTION DE CARBURANT</div>
    </div>
    <div class="receipt-body">
      <div class="receipt-op-num">N° OPÉRATION: <strong>${op.id||"—"}</strong> &nbsp;|&nbsp; BON: <strong>${op.bon||"—"}</strong></div>
      <div class="receipt-section">
        <div class="receipt-section-title">📋 INFORMATIONS CLIENT</div>
        <div class="receipt-row"><span>Société bénéficiaire</span><strong>${op.societe||"—"}</strong></div>
        <div class="receipt-row"><span>Responsable</span><strong>${op.responsable||"—"}</strong></div>
        <div class="receipt-row"><span>Bon de commande</span><strong>${op.bon||"—"}</strong></div>
      </div>
      <div class="receipt-total-box">
        <div class="receipt-total-label">VOLUME DISTRIBUÉ</div>
        <div class="receipt-total-val">${vol}</div>
        <div class="receipt-total-unit">LITRES DE CARBURANT</div>
      </div>
      <div class="receipt-section">
        <div class="receipt-section-title">📅 DATE & HEURE</div>
        <div class="receipt-row"><span>Date</span><strong>${dateStr}</strong></div>
        <div class="receipt-row"><span>Heure</span><strong>${timeStr}</strong></div>
        <div class="receipt-row"><span>Statut</span><strong style="color:${op.status==="COMPLÉTÉ"?"#00e676":"#f5a623"}">${op.status||"COMPLÉTÉ"}</strong></div>
      </div>
      <div class="receipt-section">
        <div class="receipt-section-title">📍 LOCALISATION CAMION-CITERNE</div>
        <div class="receipt-row"><span>Adresse</span><strong>${loc}</strong></div>
        <div class="receipt-row"><span>Latitude</span><strong>${lat}</strong></div>
        <div class="receipt-row"><span>Longitude</span><strong>${lng}</strong></div>
        <div class="receipt-row"><span>Carte</span><strong><a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" style="color:#1a2a4e;text-decoration:underline;font-size:12px">Voir sur Google Maps ↗</a></strong></div>
      </div>
      <div class="receipt-section">
        <div class="receipt-section-title">⚙ MATÉRIEL UTILISÉ</div>
        <div class="receipt-row"><span>Contrôleur</span><strong>ESP8266 (WiFi)</strong></div>
        <div class="receipt-row"><span>Pompe</span><strong>Submersible 12V DC</strong></div>
        <div class="receipt-row"><span>Relais</span><strong>CIT-046 1 Canal</strong></div>
        <div class="receipt-row"><span>Capteur niveau</span><strong>Ultrasonique HC-SR04</strong></div>
        <div class="receipt-row"><span>Régulateur</span><strong>LM2596 DC-DC CIT-012</strong></div>
      </div>
      <div style="text-align:center;margin:16px 0 8px">${bars}</div>
      <div style="text-align:center;font-size:9px;font-family:monospace;color:#9ca3af;letter-spacing:.1em">
        ${(op.id||"OP0000").replace(/-/g,"")}-${Date.now().toString(36).toUpperCase()}
      </div>
    </div>
    <div class="receipt-footer">
      <p style="font-weight:700;color:#1a2a4e;font-size:13px">EEA-CARBURANT-CI 🇨🇮</p>
      <p>Siège social: Abidjan, Côte d'Ivoire</p>
      <p>Ce bordereau constitue une preuve officielle de distribution</p>
      <p style="margin-top:8px;font-style:italic">"Excellence • Énergie • Afrique"</p>
    </div>
  </div>`;
}
function printRecu() {
  const content = document.getElementById("receiptToPrint");
  if (!content) return showToast("Sélectionnez d'abord une distribution.", "error");
  const win = window.open("","_blank");
  win.document.write(`<!DOCTYPE html><html><head><title>Reçu EEA</title><style>body{margin:0;padding:20px;background:#f0f0f0}@media print{body{padding:0;background:white}}</style></head><body>`);
  win.document.write(content.outerHTML);
  win.document.write("</body></html>");
  win.document.close(); win.focus();
  setTimeout(() => win.print(), 600);
}
function downloadPDF() {
  if (!state.selectedRecu) return showToast("Sélectionnez d'abord une distribution.", "error");
  const el = document.getElementById("receiptToPrint"); if (!el) return;
  const { jsPDF } = window.jspdf;
  html2canvas(el, { scale:2, backgroundColor:"#ffffff", useCORS:true }).then(canvas => {
    const img  = canvas.toDataURL("image/jpeg", .95);
    const pdf  = new jsPDF({ orientation:"portrait", unit:"mm", format:"a4" });
    const pdfW = pdf.internal.pageSize.getWidth();
    pdf.addImage(img, "JPEG", 0, 0, pdfW, (canvas.height*pdfW)/canvas.width);
    pdf.save(`Recu-EEA-${state.selectedRecu.id}-${(state.selectedRecu.societe||"").replace(/\s+/g,"-")}.pdf`);
  });
}

/* ══ 12 — HELPERS UI ═════════════════════════════════════════════ */
function setPumpUI(mode, partial=false) {
  const btnPump  = document.getElementById("btnPump");
  const btnStop  = document.getElementById("btnStop");
  const progress = document.getElementById("distribProgress");
  const ps       = document.getElementById("pumpState");
  const card     = document.getElementById("pumpStatusCard");
  const iw       = document.querySelector(".pump-icon-wrap");
  if (mode === "running") {
    if (btnPump)  btnPump.style.display  = "none";
    if (btnStop)  btnStop.style.display  = "flex";
    if (progress) progress.style.display = "block";
    if (ps)       { ps.textContent = "POMPE ACTIVE"; ps.style.color = "var(--accent)"; }
    if (card)     card.classList.add("pump-spinning");
    if (iw)       { iw.style.background = "rgba(245,166,35,.15)"; iw.style.color = "var(--accent)"; }
  } else if (mode === "idle") {
    if (btnPump)  btnPump.style.display = "flex";
    if (btnStop)  btnStop.style.display = "none";
    if (ps)       { ps.textContent = partial ? "ARRÊTÉE" : "TERMINÉ ✓"; ps.style.color = partial ? "var(--red)" : "var(--green)"; }
    if (card)     card.classList.remove("pump-spinning");
    if (iw)       { iw.style.background = ""; iw.style.color = ""; }
  } else if (mode === "waiting") {
    if (ps) { ps.textContent = "EN ATTENTE"; ps.style.color = "var(--green)"; }
  }
}
function resetProgressBar() {
  const fill = document.getElementById("distribProgressFill");
  const text = document.getElementById("distribProgressText");
  if (fill) fill.style.width = "0%";
  if (text) text.textContent  = "0%";
}
function updateProgressBar(pct, done, target) {
  const fill = document.getElementById("distribProgressFill");
  const text = document.getElementById("distribProgressText");
  if (fill) fill.style.width = `${Math.min(pct,100)}%`;
  if (text) text.textContent  = `${Math.round(pct)}% — ${done.toFixed(1)} / ${target} L`;
}
function addTodayItem(op) {
  const list = document.getElementById("todayList"); if (!list) return;
  const dt = new Date(), t = `${String(dt.getHours()).padStart(2,"0")}:${String(dt.getMinutes()).padStart(2,"0")}`;
  const div = document.createElement("div"); div.className = "td-item";
  div.innerHTML = `<span class="td-time">${t}</span><span class="td-company">${op.societe}</span><span class="td-vol">${op.volumeReel||op.volume} L</span>`;
  list.prepend(div);
}
function populateTodayList() {
  const today = new Date().toDateString();
  state.history.filter(h => new Date(h.created_at||h.dateTime).toDateString()===today).forEach(addTodayItem);
}
function updateStatusBadge(online) {
  const el = document.querySelector(".status-indicator"); if (!el) return;
  el.className = `status-indicator ${online?"online":"offline"}`;
  const span = el.querySelector("span:last-child"); if (span) span.textContent = online ? "ESP8266 EN LIGNE" : "ESP8266 HORS LIGNE";
  const dot  = el.querySelector(".pulse-dot");       if (dot)  dot.style.background = online ? "var(--green)" : "var(--red)";
}
function showLoadingOverlay(show) {
  let el = document.getElementById("loadingOverlay");
  if (!el) {
    el = document.createElement("div"); el.id = "loadingOverlay";
    Object.assign(el.style, { position:"fixed",inset:"0",background:"rgba(5,12,20,.88)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:"9997",flexDirection:"column",gap:"16px",fontFamily:"'Share Tech Mono',monospace",color:"#00d4ff",fontSize:"13px",letterSpacing:".2em" });
    el.innerHTML = `<i class="fas fa-spinner" style="font-size:32px;animation:spin 1s linear infinite"></i><span>CONNEXION AU SERVEUR...</span>`;
    document.body.appendChild(el);
  }
  el.style.display = show ? "flex" : "none";
}
function showBanner(msg, type="info") {
  let el = document.getElementById("statusBanner");
  if (!el) {
    el = document.createElement("div"); el.id = "statusBanner";
    Object.assign(el.style, { position:"fixed",top:"0",left:"0",right:"0",padding:"10px 20px",zIndex:"9996",textAlign:"center",fontFamily:"'Share Tech Mono',monospace",fontSize:"12px",letterSpacing:".12em",transition:"transform .4s ease" });
    document.body.appendChild(el);
  }
  el.style.background = type==="warn" ? "rgba(245,166,35,.92)" : "rgba(0,212,255,.92)";
  el.style.color = "#050c14"; el.textContent = msg; el.style.transform = "translateY(0)";
  setTimeout(() => { el.style.transform = "translateY(-100%)"; }, 4000);
}
function showToast(msg, type="info") {
  const colors = { success:"rgba(0,230,118,.9)", warn:"rgba(245,166,35,.9)", error:"rgba(255,61,61,.9)", info:"rgba(0,212,255,.9)" };
  let el = document.getElementById("toastMsg");
  if (!el) {
    el = document.createElement("div"); el.id = "toastMsg";
    Object.assign(el.style, { position:"fixed",bottom:"24px",right:"24px",maxWidth:"380px",padding:"14px 20px",borderRadius:"10px",zIndex:"9995",fontFamily:"'Share Tech Mono',monospace",fontSize:"12px",letterSpacing:".1em",color:"#050c14",lineHeight:"1.5",boxShadow:"0 8px 30px rgba(0,0,0,.4)",transition:"opacity .3s ease" });
    document.body.appendChild(el);
  }
  el.style.background = colors[type]||colors.info; el.textContent = msg; el.style.opacity = "1";
  clearTimeout(el._tid); el._tid = setTimeout(() => { el.style.opacity = "0"; }, 4000);
}

/* ══ 13 — HORLOGE & GÉOLOC UTILISATEUR (bureau) ═════════════════
   Note : getUserLocation() récupère la position de l'opérateur
   bureau uniquement comme fallback. La position du camion est
   gérée par startTruckGPSTracking() (PILIER 7).
════════════════════════════════════════════════════════════════ */
function startClock() {
  const pad = n => String(n).padStart(2,"0");
  const tick = () => {
    const now = new Date(), el = document.getElementById("topbarTime");
    if (el) el.textContent = `${now.toLocaleDateString("fr-CI",{weekday:"short",day:"2-digit",month:"short",year:"numeric"})} — ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  };
  tick(); setInterval(tick, 1000);
}
function getUserLocation() {
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        state.userLocation.lat = pos.coords.latitude.toFixed(5);
        state.userLocation.lng = pos.coords.longitude.toFixed(5);
      },
      () => fetchIPLocation(),
      { timeout: 6000 }
    );
  } else { fetchIPLocation(); }
}
function fetchIPLocation() {
  fetch("https://ipapi.co/json/", { signal: AbortSignal.timeout(5000) })
  .then(r => r.json())
  .then(d => {
    state.userLocation.lat     = String(d.latitude  || "5.3600");
    state.userLocation.lng     = String(d.longitude || "-4.0083");
    state.userLocation.city    = `${d.city||"Abidjan"}, ${d.country_name||"Côte d'Ivoire"}`;
    state.userLocation.address = `${d.city}, ${d.region}, ${d.country_name}`;
    const el = document.getElementById("topbarLoc"); if (el) el.textContent = state.userLocation.city;
  })
  .catch(() => {
    state.userLocation.lat  = "5.3600";
    state.userLocation.lng  = "-4.0083";
    state.userLocation.city = "Abidjan, Côte d'Ivoire";
  });
}

/* ══ 14 — DONNÉES DÉMO & UTILITAIRES ════════════════════════════ */
function getDemoHistory() {
  const b = new Date();
  return [
    { id:"OP-2025-1001", created_at:new Date(b-86400000*0+8*3600000).toISOString(),  societe:"TOTAL ENERGIES CI",  responsable:"Koné Moussa",    volume_reel_L:500,  bon:"BC-2025-0481", latitude:"5.3544", longitude:"-4.0167", location_city:"Cocody, Abidjan",   statut:"COMPLÉTÉ" },
    { id:"OP-2025-1002", created_at:new Date(b-86400000*0+10*3600000).toISOString(), societe:"SHELL CI",           responsable:"Traoré Aïcha",    volume_reel_L:340,  bon:"BC-2025-0482", latitude:"5.3600", longitude:"-4.0083", location_city:"Plateau, Abidjan",  statut:"COMPLÉTÉ" },
    { id:"OP-2025-1003", created_at:new Date(b-86400000*1+14*3600000).toISOString(), societe:"ORYX CI",            responsable:"Diomandé Paul",   volume_reel_L:650,  bon:"BC-2025-0479", latitude:"5.3422", longitude:"-3.9875", location_city:"Marcory, Abidjan",  statut:"PARTIEL"  },
    { id:"OP-2025-1004", created_at:new Date(b-86400000*2+9*3600000).toISOString(),  societe:"PUMA ENERGY",        responsable:"Coulibaly Fatou", volume_reel_L:1200, bon:"BC-2025-0475", latitude:"5.3280", longitude:"-4.0144", location_city:"Koumassi, Abidjan", statut:"COMPLÉTÉ" },
    { id:"OP-2025-1005", created_at:new Date(b-86400000*3+16*3600000).toISOString(), societe:"VIVO ENERGY CI",     responsable:"Bamba Seydou",    volume_reel_L:600,  bon:"BC-2025-0470", latitude:"5.3900", longitude:"-4.0250", location_city:"Yopougon, Abidjan", statut:"COMPLÉTÉ" },
  ];
}
function setTextSafe(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
function setBarWidth(id, pct) { const el = document.getElementById(id); if (!el) return; el.style.width=`${pct}%`; const p=el.querySelector(".lb-pct"); if(p)p.textContent=`${pct}%`; }
function formatL(n) { if(n==null)return"— L"; return n>=1000?`${(n/1000).toFixed(1).replace(".",",")} 000 L`:`${Math.round(n)} L`; }
function genId()  { return `OP-${new Date().getFullYear()}-${Math.floor(1000+Math.random()*9000)}`; }
function genBon() { return `BC-${new Date().getFullYear()}-${Math.floor(1000+Math.random()*9000)}`; }

window.addEventListener("resize", () => { drawConsumChart(); drawGaugeFrame(state.gaugeCurrent); });