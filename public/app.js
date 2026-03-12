/* ═══════════════════════════════════════════════════
EEA-CARBURANT-CI — Frontend connecté au serveur
Les données sont sauvegardées dans SQLite (Render)
═══════════════════════════════════════════════════ */

"use strict";

// ── CONFIG ──
const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
? "http://localhost:3000/api"
: "/api";

const CORRECT_CODE  = "180605";
const ESP8266_IP    = "192.168.4.1";
const PUMP_RATE_LPM = 3.0;

// ── STATE LOCAL (cache) ──
let state = {
tankInitial:     10000,
tankCurrent:     10000,
tankDistributed: 0,
pumpRunning:     false,
distribTarget:   0,
distribDone:     0,
currentOp:       null,
history:         [],
selectedRecu:    null,
location:        { lat: null, lng: null, city: "Abidjan, CI", address: "" }
};

let pumpTimer = null;

/* ══════════════════════════════════════
INIT
══════════════════════════════════════ */
window.addEventListener("DOMContentLoaded", () => {
setupPinInputs();
startClock();
getLocation();
});

/* ══════════════════════════════════════
API HELPERS
══════════════════════════════════════ */
async function apiGet(path) {
const res = await fetch(`${API_BASE}${path}`);
if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
return res.json();
}

async function apiPost(path, body) {
const res = await fetch(`${API_BASE}${path}`, {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify(body)
});
if (!res.ok) throw new Error(`API POST ${path} → ${res.status}`);
return res.json();
}

async function apiPut(path, body) {
const res = await fetch(`${API_BASE}${path}`, {
method: "PUT",
headers: { "Content-Type": "application/json" },
body: JSON.stringify(body)
});
if (!res.ok) throw new Error(`API PUT ${path} → ${res.status}`);
return res.json();
}

/* ══════════════════════════════════════
HORLOGE
══════════════════════════════════════ */
function startClock() {
function tick() {
const now = new Date();
const pad = n => String(n).padStart(2, "0");
const s   = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
const d   = now.toLocaleDateString("fr-CI", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
const el  = document.getElementById("topbarTime");
if (el) el.textContent = `${d} — ${s}`;
}
tick();
setInterval(tick, 1000);
}

/* ══════════════════════════════════════
GÉOLOCALISATION
══════════════════════════════════════ */
function getLocation() {
if (navigator.geolocation) {
navigator.geolocation.getCurrentPosition(
pos => {
state.location.lat = pos.coords.latitude.toFixed(5);
state.location.lng = pos.coords.longitude.toFixed(5);
reverseGeocode(pos.coords.latitude, pos.coords.longitude);
},
() => fetchIPLocation(),
{ timeout: 6000 }
);
} else {
fetchIPLocation();
}
}

function fetchIPLocation() {
fetch("https://ipapi.co/json/")
.then(r => r.json())
.then(d => {
state.location.lat     = String(d.latitude  || "5.3600");
state.location.lng     = String(d.longitude || "-4.0083");
state.location.city    = `${d.city || "Abidjan"}, ${d.country_name || "Côte d'Ivoire"}`;
state.location.address = `${d.city}, ${d.region}, ${d.country_name}`;
const el = document.getElementById("topbarLoc");
if (el) el.textContent = state.location.city;
})
.catch(() => {
state.location.lat  = "5.3600";
state.location.lng  = "-4.0083";
state.location.city = "Abidjan, Côte d’Ivoire";
});
}

function reverseGeocode(lat, lng) {
fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`)
.then(r => r.json())
.then(d => {
const city = d.address.city || d.address.town || d.address.village || "Abidjan";
state.location.city    = `${city}, CI`;
state.location.address = d.display_name || city;
const el = document.getElementById("topbarLoc");
if (el) el.textContent = state.location.city;
})
.catch(() => {});
}

/* ══════════════════════════════════════
LOGIN
══════════════════════════════════════ */
function setupPinInputs() {
const inputs = document.querySelectorAll(".pin-box");
inputs.forEach((inp, i) => {
inp.addEventListener("input", e => {
const val = e.target.value.replace(/[^0-9]/g, "");
e.target.value = val ? val.slice(-1) : "";
if (val && i < inputs.length - 1) inputs[i + 1].focus();
if (val) e.target.classList.add("filled");
else e.target.classList.remove("filled");
const code = Array.from(inputs).map(x => x.value).join("");
if (code.length === 6) setTimeout(handleLogin, 200);
});
inp.addEventListener("keydown", e => {
if (e.key === "Backspace" && !inp.value && i > 0) {
inputs[i - 1].focus();
inputs[i - 1].value = "";
inputs[i - 1].classList.remove("filled");
}
if (e.key === "Enter") handleLogin();
});
});
}

function handleLogin() {
const inputs = document.querySelectorAll(".pin-box");
const code   = Array.from(inputs).map(i => i.value).join("");
const errEl  = document.getElementById("loginError");

if (code === CORRECT_CODE) {
errEl.textContent = "";
const btn = document.getElementById("btnLogin");
btn.innerHTML     = '<i class="fas fa-check-circle"></i> <span>ACCÈS ACCORDÉ</span>';
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
document.getElementById("mainApp").classList.remove("active");
document.getElementById("loginPage").classList.add("active");
document.querySelectorAll(".pin-box").forEach(i => { i.value = ""; i.classList.remove("filled", "error"); });
document.getElementById("loginError").textContent = "";
const btn = document.getElementById("btnLogin");
btn.innerHTML    = '<span class="btn-text">ACCÉDER AU SYSTÈME</span><i class="fas fa-arrow-right btn-icon"></i>';
btn.style.background = "";
}

/* ══════════════════════════════════════
INIT APP (après login) — charge le serveur
══════════════════════════════════════ */
async function initApp() {
showLoadingOverlay(true);
try {
const citerne = await apiGet("/citerne");
state.tankInitial     = citerne.initial_L;
state.tankCurrent     = citerne.current_L;
state.tankDistributed = citerne.distributed_L;

const hist = await apiGet("/distributions?limit=5");
state.history = hist.data;

} catch (e) {
console.warn("Serveur non accessible, mode démo:", e.message);
state.history = getDemoHistory();
}

drawGauge(levelPercent());
drawConsumChart();
updateDashboard();
simulateLiveSensor();
showLoadingOverlay(false);
}

function showLoadingOverlay(show) {
let el = document.getElementById("loadingOverlay");
if (!el) {
el = document.createElement("div");
el.id = "loadingOverlay";
el.style.cssText = `position:fixed;inset:0;background:rgba(5,12,20,0.85);display:flex;align-items:center; justify-content:center;z-index:9997;font-family:'Share Tech Mono',monospace;color:#00d4ff; font-size:13px;letter-spacing:0.2em;flex-direction:column;gap:16px;`;
el.innerHTML = `<i class="fas fa-spinner" style="font-size:32px;animation:spin 1s linear infinite"></i> <span>CONNEXION AU SERVEUR...</span>`;
document.body.appendChild(el);
}
el.style.display = show ? "flex" : "none";
}

/* ══════════════════════════════════════
NAVIGATION
══════════════════════════════════════ */
function showPage(name) {
document.querySelectorAll(".content-page").forEach(p => p.classList.remove("active"));
document.querySelectorAll(".nav-item").forEach(i => i.classList.remove("active"));
document.getElementById(`page-${name}`).classList.add("active");

const map = {
dashboard:    { title: "TABLEAU DE BORD",   bread: "Accueil / Dashboard" },
distribution: { title: "DISTRIBUTION",      bread: "Accueil / Distribution" },
historique:   { title: "HISTORIQUE",        bread: "Accueil / Historique" },
recu:         { title: "GESTION DES REÇUS", bread: "Accueil / Reçus" }
};
const info = map[name] || {};
document.getElementById("pageTitle").textContent  = info.title || name.toUpperCase();
document.getElementById("breadcrumb").textContent = info.bread || name;

const navMap = ["dashboard", "distribution", "historique", "recu"];
const idx    = navMap.indexOf(name);
const items  = document.querySelectorAll(".nav-item");
if (idx >= 0 && items[idx]) items[idx].classList.add("active");

if (name === "distribution") updateDistribPreview();
if (name === "historique")   loadAndRenderHistory();
if (name === "recu")         loadAndRenderRecus();
}

function toggleSidebar() {
const sb = document.getElementById("sidebar");
sb.style.width = sb.offsetWidth > 100 ? "60px" : "240px";
}

/* ══════════════════════════════════════
DASHBOARD
══════════════════════════════════════ */
function levelPercent() {
return Math.round((state.tankCurrent / state.tankInitial) * 100);
}

function updateDashboard() {
const pct = levelPercent();
document.getElementById("gaugePercent").textContent   = `${pct}%`;
document.getElementById("litresRestants").textContent = formatL(state.tankCurrent);
document.getElementById("litresInitial").textContent  = formatL(state.tankInitial);
document.getElementById("statDistribue").textContent  = formatL(state.tankDistributed);
document.getElementById("hintDisponible").textContent = formatL(state.tankCurrent);

const distPct = Math.round((state.tankDistributed / state.tankInitial) * 100);
const lbFuel  = document.getElementById("lbFuel");
const lbDist  = document.getElementById("lbDist");
if (lbFuel) { lbFuel.style.width = `${pct}%`; lbFuel.querySelector(".lb-pct").textContent = `${pct}%`; }
if (lbDist) { lbDist.style.width = `${distPct}%`; lbDist.querySelector(".lb-pct").textContent = `${distPct}%`; }

drawGauge(pct);
}

/* ══════════════════════════════════════
GAUGE CANVAS
══════════════════════════════════════ */
function drawGauge(percent) {
const canvas = document.getElementById("fuelGauge");
if (!canvas) return;
const ctx = canvas.getContext("2d");
const W = canvas.width, H = canvas.height;
const cx = W / 2, cy = H / 2 + 20;
const R  = 110;
const startAngle = Math.PI * 0.75;
const endAngle   = Math.PI * 2.25;
const fillAngle  = startAngle + (endAngle - startAngle) * (percent / 100);

ctx.clearRect(0, 0, W, H);

ctx.beginPath();
ctx.arc(cx, cy, R, startAngle, endAngle);
ctx.strokeStyle = "rgba(0,212,255,0.08)";
ctx.lineWidth   = 18; ctx.lineCap = "round"; ctx.stroke();

ctx.beginPath();
ctx.arc(cx, cy, R, startAngle, startAngle + (endAngle - startAngle) * 0.20);
ctx.strokeStyle = "rgba(255,61,61,0.2)";
ctx.lineWidth   = 18; ctx.stroke();

const grad = ctx.createLinearGradient(cx - R, cy, cx + R, cy);
if (percent > 50) {
grad.addColorStop(0, "#00a8cc");
grad.addColorStop(0.6, "#00d4ff");
grad.addColorStop(1, "#f5a623");
} else if (percent > 20) {
grad.addColorStop(0, "#f5a623");
grad.addColorStop(1, "#ff6b35");
} else {
grad.addColorStop(0, "#8b0000");
grad.addColorStop(1, "#ff3d3d");
}
ctx.save();
ctx.shadowBlur  = 20;
ctx.shadowColor = percent > 50 ? "rgba(0,212,255,0.6)" : "rgba(245,166,35,0.6)";
ctx.beginPath();
ctx.arc(cx, cy, R, startAngle, fillAngle);
ctx.strokeStyle = grad; ctx.lineWidth = 18; ctx.lineCap = "round"; ctx.stroke();
ctx.restore();

for (let i = 0; i <= 10; i++) {
const a = startAngle + (endAngle - startAngle) * (i / 10);
const r1 = R - 14, r2 = R - (i % 5 === 0 ? 28 : 22);
ctx.beginPath();
ctx.moveTo(cx + r1 * Math.cos(a), cy + r1 * Math.sin(a));
ctx.lineTo(cx + r2 * Math.cos(a), cy + r2 * Math.sin(a));
ctx.strokeStyle = i % 5 === 0 ? "rgba(245,166,35,0.7)" : "rgba(0,212,255,0.3)";
ctx.lineWidth   = i % 5 === 0 ? 2 : 1; ctx.stroke();
}

ctx.beginPath();
ctx.arc(cx, cy, R - 30, 0, Math.PI * 2);
ctx.fillStyle   = "rgba(9,20,32,0.9)"; ctx.fill();
ctx.strokeStyle = "rgba(0,212,255,0.15)"; ctx.lineWidth = 1.5; ctx.stroke();

ctx.font = "bold 12px 'Share Tech Mono'"; ctx.textAlign = "center";
ctx.fillStyle = "rgba(255,61,61,0.8)";
ctx.fillText("E", cx + (R-48)*Math.cos(startAngle), cy + (R-48)*Math.sin(startAngle)+4);
ctx.fillStyle = "rgba(0,230,118,0.8)";
ctx.fillText("F", cx + (R-48)*Math.cos(endAngle), cy + (R-48)*Math.sin(endAngle)+4);
}

/* ══════════════════════════════════════
GRAPHIQUE CONSOMMATION
══════════════════════════════════════ */
async function drawConsumChart() {
const canvas = document.getElementById("consumChart");
if (!canvas) return;
const ctx = canvas.getContext("2d");
const W = canvas.offsetWidth || 600, H = 160;
canvas.width = W; canvas.height = H;

let data   = [320, 850, 440, 1200, 680, 920, 340];
let labels = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
try {
const hist = await apiGet("/distributions?limit=200");
if (hist.data && hist.data.length > 0) {
const dayMap = {};
hist.data.forEach(h => {
const d = h.created_at ? h.created_at.substring(0, 10) : "";
if (!d) return;
dayMap[d] = (dayMap[d] || 0) + (h.volume_reel_L || 0);
});
const keys = Object.keys(dayMap).sort().slice(-7);
if (keys.length >= 2) {
data   = keys.map(k => dayMap[k]);
labels = keys.map(k => {
const d = new Date(k);
return d.toLocaleDateString("fr-CI", { weekday: "short" });
});
}
}
} catch (e) {}

const maxVal = Math.max(...data, 1);
const padL = 50, padR = 20, padT = 20, padB = 30;
const chartW = W - padL - padR, chartH = H - padT - padB;

ctx.clearRect(0, 0, W, H);

for (let i = 0; i <= 4; i++) {
const y = padT + chartH - chartH * i / 4;
ctx.beginPath();
ctx.moveTo(padL, y); ctx.lineTo(W - padR, y);
ctx.strokeStyle = "rgba(0,212,255,0.07)"; ctx.lineWidth = 1; ctx.stroke();
ctx.fillStyle = "rgba(90,122,154,0.6)";
ctx.font = "10px 'Share Tech Mono'"; ctx.textAlign = "right";
ctx.fillText(`${Math.round(maxVal * i / 4)}`, padL - 6, y + 4);
}

const pts = data.map((v, i) => ({
x: padL + (i / Math.max(data.length - 1, 1)) * chartW,
y: padT + chartH - (v / maxVal) * chartH
}));

const areaGrad = ctx.createLinearGradient(0, padT, 0, padT + chartH);
areaGrad.addColorStop(0, "rgba(0,212,255,0.25)");
areaGrad.addColorStop(1, "rgba(0,212,255,0.01)");
ctx.beginPath();
ctx.moveTo(pts[0].x, padT + chartH);
pts.forEach(p => ctx.lineTo(p.x, p.y));
ctx.lineTo(pts[pts.length-1].x, padT + chartH);
ctx.closePath();
ctx.fillStyle = areaGrad; ctx.fill();

ctx.beginPath();
ctx.moveTo(pts[0].x, pts[0].y);
pts.forEach(p => ctx.lineTo(p.x, p.y));
ctx.strokeStyle = "rgba(0,212,255,0.9)"; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();

pts.forEach((p, i) => {
ctx.beginPath();
ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
ctx.fillStyle   = "#00d4ff";
ctx.shadowBlur  = 10; ctx.shadowColor = "#00d4ff";
ctx.fill(); ctx.shadowBlur = 0;
ctx.fillStyle   = "rgba(90,122,154,0.9)";
ctx.font         = "10px 'Share Tech Mono'"; ctx.textAlign = "center";
ctx.fillText(labels[i] || "", p.x, H - 8);
});
}

/* ══════════════════════════════════════
CAPTEUR LIVE (simulation)
══════════════════════════════════════ */
function simulateLiveSensor() {
setInterval(() => {
const pct        = levelPercent();
const tankHeight = 200;
const dist       = Math.round(tankHeight * (1 - pct / 100) * 10) / 10;
const el = document.getElementById("sensorDist");
if (el) el.textContent = `${dist} cm`;
const temp = (27.5 + Math.random() * 2).toFixed(1);
const tEl  = document.getElementById("statTemp");
if (tEl) tEl.textContent = `${temp}°C`;
}, 3000);
}

/* ══════════════════════════════════════
DISTRIBUTION
══════════════════════════════════════ */
document.addEventListener("DOMContentLoaded", () => {
const v = document.getElementById("distribVolume");
if (v) v.addEventListener("input", updateDistribPreview);
});

function updateDistribPreview() {
const vol    = parseFloat(document.getElementById("distribVolume")?.value) || 0;
const after  = state.tankCurrent - vol;
const duree  = (vol / PUMP_RATE_LPM).toFixed(1);
const pvVol  = document.getElementById("prevVol");
const pvAft  = document.getElementById("prevAfter");
const pvDur  = document.getElementById("prevDuree");
const alLow  = document.getElementById("alertLow");
if (pvVol) pvVol.textContent = vol ? `${vol} L` : "— L";
if (pvAft) pvAft.textContent = vol ? `${Math.max(0, after)} L` : "— L";
if (pvDur) pvDur.textContent = vol ? `~${duree} min` : "—";
if (alLow) alLow.style.display = (after < state.tankInitial * 0.15 && vol > 0) ? "flex" : "none";
}

async function startDistribution() {
const societe     = document.getElementById("distribSociete").value.trim();
const responsable = document.getElementById("distribResponsable").value.trim();
const vol         = parseFloat(document.getElementById("distribVolume").value);
const bon         = document.getElementById("distribBon").value.trim();

if (!societe) return alert("⚠ Veuillez entrer le nom de la société.");
if (!vol || vol <= 0) return alert("⚠ Veuillez entrer un volume valide.");
if (vol > state.tankCurrent) return alert(`⚠ Volume insuffisant. Disponible: ${state.tankCurrent} L`);

state.pumpRunning   = true;
state.distribTarget = vol;
state.distribDone   = 0;
state.currentOp = {
id:           genId(),
societe,
responsable,
volume:       vol,
bon:          bon || genBon(),
dateTime:     new Date().toISOString(),
lat:          state.location.lat  || "5.3600",
lng:          state.location.lng  || "-4.0083",
location:     state.location.city,
address:      state.location.address,
status:       "EN COURS"
};

document.getElementById("btnPump").style.display = "none";
document.getElementById("btnStop").style.display = "flex";
document.getElementById("distribProgress").style.display = "block";
document.getElementById("pumpState").textContent = "POMPE ACTIVE";
document.getElementById("pumpState").style.color = "var(--accent)";
document.getElementById("pumpStatusCard").classList.add("pump-spinning");

sendCommandToESP8266(vol);

const rate = PUMP_RATE_LPM / 60;
pumpTimer  = setInterval(() => {
state.distribDone += rate;
const pct = Math.min((state.distribDone / vol) * 100, 100);
document.getElementById("distribProgressFill").style.width = `${pct}%`;
document.getElementById("distribProgressText").textContent =
`${pct.toFixed(0)}% — ${state.distribDone.toFixed(1)} / ${vol} L`;
if (state.distribDone >= vol) finishDistribution(vol, false);
}, 1000);
}

function stopDistribution() {
if (!state.pumpRunning) return;
clearInterval(pumpTimer);
sendCommandToESP8266(0);
finishDistribution(state.distribDone, true);
}

async function finishDistribution(vol, partial) {
clearInterval(pumpTimer);
state.pumpRunning = false;
const actualVol = parseFloat(Math.min(vol, state.distribTarget).toFixed(2));

const op = {
id:           state.currentOp.id,
societe:      state.currentOp.societe,
responsable:  state.currentOp.responsable,
volume_cmd_L: state.currentOp.volume,
volume_reel_L: actualVol,
bon:          state.currentOp.bon,
latitude:     state.currentOp.lat,
longitude:    state.currentOp.lng,
location_city: state.currentOp.location,
location_addr: state.currentOp.address,
statut:       partial ? "PARTIEL" : "COMPLÉTÉ"
};

try {
const result = await apiPost("/distributions", op);
state.tankCurrent     = result.citerne.current_L;
state.tankDistributed = result.citerne.distributed_L;
console.log("✅ Distribution enregistrée en base de données");
} catch (e) {
state.tankCurrent     = Math.max(0, state.tankCurrent - actualVol);
state.tankDistributed += actualVol;
console.warn("⚠ Serveur indisponible, mise à jour locale:", e.message);
}

const histEntry = {
...op,
id:         op.id,
societe:    op.societe,
responsable: op.responsable,
volume:     actualVol,
volumeReel: actualVol,
bon:        op.bon,
lat:        op.latitude,
lng:        op.longitude,
location:   op.location_city,
dateTime:   new Date().toISOString(),
status:     op.statut
};
state.history.unshift(histEntry);

document.getElementById("btnPump").style.display = "flex";
document.getElementById("btnStop").style.display = "none";
document.getElementById("distribProgress").style.display = "none";
document.getElementById("distribProgressFill").style.width = "0%";
document.getElementById("pumpState").textContent = partial ? "ARRÊTÉE" : "TERMINÉ ✓";
document.getElementById("pumpState").style.color = partial ? "var(--red)" : "var(--green)";
document.getElementById("pumpStatusCard").classList.remove("pump-spinning");
updateDashboard();
addTodayItem(histEntry);
setTimeout(() => {
document.getElementById("pumpState").textContent = "EN ATTENTE";
document.getElementById("pumpState").style.color = "var(--green)";
}, 4000);

alert(`✅ Distribution ${partial ? "interrompue" : "terminée"}!\n${actualVol} L distribués à ${state.currentOp?.societe}`);
}

function addTodayItem(op) {
const list = document.getElementById("todayList");
if (!list) return;
const dt = new Date();
const time = `${String(dt.getHours()).padStart(2,"0")}:${String(dt.getMinutes()).padStart(2,"0")}`;
const div  = document.createElement("div");
div.className = "td-item";
div.innerHTML = `<span class="td-time">${time}</span><span class="td-company">${op.societe}</span><span class="td-vol">${op.volumeReel || op.volume} L</span>`;
list.prepend(div);
}

/* ══════════════════════════════════════
ESP8266 WiFi
══════════════════════════════════════ */
function sendCommandToESP8266(volumeL) {
const volML = Math.round(volumeL * 1000);
fetch(`http://${ESP8266_IP}/pump?vol=${volML}`, { mode: "no-cors", signal: AbortSignal.timeout(3000) })
.then(() => console.log("[ESP8266] Commande envoyée:", volML, "mL"))
.catch(e => console.warn("[ESP8266] Non connecté (simulé):", e.message));
}

/* ══════════════════════════════════════
HISTORIQUE — chargé depuis le serveur
══════════════════════════════════════ */
async function loadAndRenderHistory(filterDate = null) {
const tbody = document.getElementById("histTableBody");
if (!tbody) return;
tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:30px;color:var(--text-dim);font-family:var(--font-mono)"><i class="fas fa-spinner fa-spin"></i> Chargement...</td></tr>`;

try {
const url  = filterDate ? `/distributions?date=${filterDate}` : "/distributions?limit=100";
const resp = await apiGet(url);
state.history = resp.data;
renderHistoryTable(resp.data, resp.total);
} catch (e) {
renderHistoryTable(getDemoHistory(), getDemoHistory().length);
}
}

function renderHistoryTable(data, total) {
const tbody = document.getElementById("histTableBody");
if (!tbody) return;

if (!data || data.length === 0) {
tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:30px;color:var(--text-dim);font-family:var(--font-mono)">Aucune distribution trouvée</td></tr>`;
document.getElementById("histCount").textContent = "0 enregistrement(s)";
return;
}

tbody.innerHTML = data.map((h, idx) => {
const isApi = !!h.created_at;
const dt    = new Date(isApi ? h.created_at : h.dateTime);
const dateStr = dt.toLocaleDateString("fr-CI", { day:"2-digit", month:"short", year:"numeric" });
const timeStr = dt.toLocaleTimeString("fr-CI", { hour:"2-digit", minute:"2-digit" });
const lat  = h.latitude  || h.lat  || "5.3600";
const lng  = h.longitude || h.lng  || "-4.0083";
const loc  = h.location_city || h.location || "Abidjan, CI";
const vol  = h.volume_reel_L || h.volumeReel || h.volume || 0;
const stat = h.statut || h.status || "COMPLÉTÉ";
const id   = h.id || `OP-${1000+idx}`;
const bon  = h.bon || "—";
const soc  = h.societe || h.company || "—";
const resp = h.responsable || "—";

return `<tr>
  <td><span style="font-family:var(--font-mono);color:var(--accent3);font-size:11px">${id}</span></td>
  <td>
    <div style="font-family:var(--font-mono);font-size:12px">${dateStr}</div>
    <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim)">${timeStr}</div>
  </td>
  <td style="font-weight:600">${soc}</td>
  <td style="color:var(--text-dim)">${resp}</td>
  <td><span style="font-family:var(--font-display);font-size:15px;color:var(--accent)">${vol} L</span></td>
  <td style="font-family:var(--font-mono);font-size:11px;color:var(--text-dim)">${bon}</td>
  <td>
    <a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank"
       style="font-family:var(--font-mono);font-size:10px;color:var(--accent3);text-decoration:none">
      <i class="fas fa-map-marker-alt"></i> ${lat}, ${lng}
    </a>
    <div style="font-family:var(--font-mono);font-size:9px;color:var(--text-muted)">${loc}</div>
  </td>
  <td><span class="tag-${stat==='COMPLÉTÉ'?'success':'partial'}">${stat}</span></td>
  <td><button class="btn-view-recu" onclick="viewRecuById('${id}')">REÇU</button></td>
</tr>`;
}).join("");

document.getElementById("histCount").textContent = `${total || data.length} enregistrement(s)`;
}

function filterHistory() {
const val = document.getElementById("histFilter").value;
loadAndRenderHistory(val || null);
}

async function exportCSV() {
try {
const resp = await apiGet("/distributions?limit=9999");
const data = resp.data.length ? resp.data : getDemoHistory();
const headers = ["ID","Date","Heure","Société","Responsable","Volume (L)","Bon","Latitude","Longitude","Lieu","Statut"];
const rows = data.map(h => {
const dt = new Date(h.created_at || h.dateTime);
return [
h.id, dt.toLocaleDateString("fr-CI"), dt.toLocaleTimeString("fr-CI"),
h.societe, h.responsable||"", h.volume_reel_L||h.volumeReel||h.volume, h.bon||"",
h.latitude||h.lat||"", h.longitude||h.lng||"",
h.location_city||h.location||"", h.statut||h.status||"COMPLÉTÉ"
].map(v => `"${v}"`).join(",");
});
const csv  = [headers.join(","), ...rows].join("\n");
const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
const url  = URL.createObjectURL(blob);
const a    = document.createElement("a");
a.href = url; a.download = `EEA-Historique-${new Date().toISOString().slice(0,10)}.csv`;
a.click(); URL.revokeObjectURL(url);
} catch(e) { alert("Erreur export: " + e.message); }
}

/* ══════════════════════════════════════
REÇUS
══════════════════════════════════════ */
async function loadAndRenderRecus() {
const list = document.getElementById("recuList");
if (!list) return;
list.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-dim);font-family:var(--font-mono);font-size:12px"><i class="fas fa-spinner fa-spin"></i> Chargement...</div>`;
try {
const resp = await apiGet("/distributions?limit=50");
state.history = resp.data;
renderRecuList(resp.data);
} catch (e) {
renderRecuList(getDemoHistory());
}
}

function renderRecuList(data) {
const list = document.getElementById("recuList");
if (!list) return;
const items = data || state.history;
list.innerHTML = items.map(h => {
const dt  = new Date(h.created_at || h.dateTime);
const vol = h.volume_reel_L || h.volumeReel || h.volume || 0;
return ` <div class="recu-item" data-id="${h.id}" onclick='selectRecu(${JSON.stringify(h).replace(/'/g,"'")}, this)'> <div class="recu-item-company">${h.societe}</div> <div class="recu-item-info"> <span>${dt.toLocaleDateString("fr-CI")}</span> <span class="recu-item-vol">${vol} L</span> <span>${h.bon || h.id}</span> </div> </div>`;
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
try {
const op = await apiGet(`/distributions/${id}`);
state.selectedRecu = normalizeOp(op);
} catch(e) {
state.selectedRecu = state.history.find(h => h.id === id);
}
setTimeout(() => {
renderRecuPreview(state.selectedRecu);
document.querySelectorAll(".recu-item").forEach(el => {
el.classList.toggle("selected", el.dataset.id === id);
});
}, 300);
}

function normalizeOp(h) {
return {
id:           h.id,
societe:      h.societe,
responsable:  h.responsable || "—",
volume:       h.volume_reel_L || h.volumeReel || h.volume,
volumeReel:   h.volume_reel_L || h.volumeReel || h.volume,
bon:          h.bon,
lat:          h.latitude  || h.lat,
lng:          h.longitude || h.lng,
location:     h.location_city || h.location,
address:      h.location_addr || h.address,
dateTime:     h.created_at || h.dateTime,
status:       h.statut || h.status || "COMPLÉTÉ"
};
}

function renderRecuPreview(op) {
const area = document.getElementById("recuPreview");
if (!area || !op) return;
area.innerHTML = buildReceiptHTML(op);
}

function buildReceiptHTML(op) {
if (!op) return "";
const dt = new Date(op.dateTime || op.created_at);
const dateStr = dt.toLocaleDateString("fr-CI", { weekday:"long", day:"2-digit", month:"long", year:"numeric" });
const timeStr = dt.toLocaleTimeString("fr-CI", { hour:"2-digit", minute:"2-digit", second:"2-digit" });
const vol = op.volumeReel || op.volume || 0;
const lat = op.lat || op.latitude  || "5.3600";
const lng = op.lng || op.longitude || "-4.0083";
const loc = op.location || op.location_city || "Abidjan, Côte d’Ivoire";

const bars = Array.from({length:40}, () => {
const h = 15 + Math.floor(Math.random() * 15);
const w = Math.random() > 0.5 ? 2 : 1;
return `<span style="width:${w}px;height:${h}px;margin:0 1px;background:#1a2a4e;display:inline-block;border-radius:1px;vertical-align:bottom"></span>`;
}).join("");

return `
  <div class="receipt-container" id="receiptToPrint">
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
      <div class="receipt-op-num">
        N° OPÉRATION: <strong>${op.id}</strong>  |  BON: <strong>${op.bon || "—"}</strong>
      </div>
      <div class="receipt-section">
        <div class="receipt-section-title">📋 INFORMATIONS CLIENT</div>
        <div class="receipt-row"><span>Société bénéficiaire</span><strong>${op.societe}</strong></div>
        <div class="receipt-row"><span>Responsable</span><strong>${op.responsable || "—"}</strong></div>
        <div class="receipt-row"><span>Bon de commande</span><strong>${op.bon || "—"}</strong></div>
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
        <div class="receipt-row"><span>Statut</span><strong style="color:${op.status==='COMPLÉTÉ'?'#00e676':'#f5a623'}">${op.status}</strong></div>
      </div>
      <div class="receipt-section">
        <div class="receipt-section-title">📍 LOCALISATION VÉHICULE</div>
        <div class="receipt-row"><span>Adresse</span><strong>${loc}</strong></div>
        <div class="receipt-row"><span>Latitude</span><strong>${lat}</strong></div>
        <div class="receipt-row"><span>Longitude</span><strong>${lng}</strong></div>
        <div class="receipt-row">
          <span>Carte</span>
          <strong><a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank"
            style="color:#1a2a4e;text-decoration:underline;font-size:12px">Voir sur Google Maps ↗</a></strong>
        </div>
      </div>
      <div class="receipt-section">
        <div class="receipt-section-title">⚙ MATÉRIEL</div>
        <div class="receipt-row"><span>Contrôleur</span><strong>ESP8266 (WiFi)</strong></div>
        <div class="receipt-row"><span>Pompe</span><strong>Submersible 12V DC</strong></div>
        <div class="receipt-row"><span>Relais</span><strong>CIT-046 1 Canal</strong></div>
        <div class="receipt-row"><span>Capteur</span><strong>Ultrasonique HC-SR04</strong></div>
        <div class="receipt-row"><span>Régulateur</span><strong>LM2596 DC-DC CIT-012</strong></div>
      </div>
      <div style="text-align:center;margin:16px 0 8px">${bars}</div>
      <div style="text-align:center;font-size:9px;font-family:monospace;color:#9ca3af;letter-spacing:0.1em">
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
if (!content) return alert("Sélectionnez d’abord une distribution.");
const win = window.open("", "_blank");
win.document.write(`<!DOCTYPE html><html><head><title>Reçu EEA-CARBURANT-CI</title><style>body{margin:0;padding:20px;background:#f0f0f0}@media print{body{padding:0;background:white}}</style></head><body>`);
win.document.write(content.outerHTML);
win.document.write("</body></html>");
win.document.close(); win.focus();
setTimeout(() => win.print(), 600);
}

function downloadPDF() {
if (!state.selectedRecu) return alert("Sélectionnez d’abord une distribution.");
const { jsPDF } = window.jspdf;
const el = document.getElementById("receiptToPrint");
if (!el) return;
html2canvas(el, { scale: 2, backgroundColor: "#ffffff", useCORS: true }).then(canvas => {
const img  = canvas.toDataURL("image/jpeg", 0.95);
const pdf  = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
const pdfW = pdf.internal.pageSize.getWidth();
const pdfH = (canvas.height * pdfW) / canvas.width;
pdf.addImage(img, "JPEG", 0, 0, pdfW, pdfH);
pdf.save(`Recu-EEA-${state.selectedRecu.id}-${state.selectedRecu.societe?.replace(/\s+/g,"-")}.pdf`);
});
}

function getDemoHistory() {
const base = new Date();
return [
{ id:"OP-2025-1001", created_at: new Date(base-86400000*0+8*3600000).toISOString(), societe:"TOTAL ENERGIES CI", responsable:"Koné Moussa", volume_reel_L:500, bon:"BC-2025-0481", latitude:"5.3544", longitude:"-4.0167", location_city:"Cocody, Abidjan", statut:"COMPLÉTÉ" },
{ id:"OP-2025-1002", created_at: new Date(base-86400000*0+10*3600000).toISOString(), societe:"SHELL CI", responsable:"Traoré Aïcha", volume_reel_L:340, bon:"BC-2025-0482", latitude:"5.3600", longitude:"-4.0083", location_city:"Plateau, Abidjan", statut:"COMPLÉTÉ" },
{ id:"OP-2025-1003", created_at: new Date(base-86400000*1+14*3600000).toISOString(), societe:"ORYX CI", responsable:"Diomandé Paul", volume_reel_L:650, bon:"BC-2025-0479", latitude:"5.3422", longitude:"-3.9875", location_city:"Marcory, Abidjan", statut:"PARTIEL" },
{ id:"OP-2025-1004", created_at: new Date(base-86400000*2+9*3600000).toISOString(), societe:"PUMA ENERGY", responsable:"Coulibaly Fatou", volume_reel_L:1200, bon:"BC-2025-0475", latitude:"5.3280", longitude:"-4.0144", location_city:"Koumassi, Abidjan", statut:"COMPLÉTÉ" },
{ id:"OP-2025-1005", created_at: new Date(base-86400000*3+16*3600000).toISOString(), societe:"VIVO ENERGY CI", responsable:"Bamba Seydou", volume_reel_L:600, bon:"BC-2025-0470", latitude:"5.3900", longitude:"-4.0250", location_city:"Yopougon, Abidjan", statut:"COMPLÉTÉ" },
];
}

function formatL(n) {
return n >= 1000 ? `${Number(n/1000).toFixed(1)} 000 L` : `${n} L`;
}
function genId() {
return `OP-${new Date().getFullYear()}-${Math.floor(1000+Math.random()*9000)}`;
}
function genBon() {
return `BC-${new Date().getFullYear()}-${Math.floor(1000+Math.random()*9000)}`;
}

window.addEventListener("resize", () => { drawConsumChart(); drawGauge(levelPercent()); });