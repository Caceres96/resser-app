import { familiaDe, FAMILIAS } from './reglas.js';

// ============ Utilitaires ============

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)} %` : '—');
const KEY = 'resser.labo.v1';
const URL_FEUILLE = 'https://script.google.com/macros/s/AKfycbwanRuGOF3gCYAw-alVU-no0VYf4XNkm6YDEMSeZD4ODirJtG-MUOlHV_fzwVYBHLf4pw/exec';
const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const TESS_LANGUES = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/fra/4.0.0_best_int';
const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';
const MODELE_CLIP = new URLSearchParams(location.search).get('modele') || 'Xenova/clip-vit-base-patch16';

function lireStock() { try { return JSON.parse(localStorage.getItem(KEY)) || { ia: [], ticket: [] }; } catch { return { ia: [], ticket: [] }; } }
let stock = lireStock();
const sauver = () => { try { localStorage.setItem(KEY, JSON.stringify(stock)); } catch { toast('Stockage local plein : exportez vos résultats.'); } };
let toastT;
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3000); }
const log = (id, m) => { const p = $(id); p.hidden = false; p.textContent += `${m}\n`; p.scrollTop = p.scrollHeight; };
const barre = (id, v) => { $(id).style.width = `${Math.round(100 * v)}%`; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const charger = (src) => new Promise((ok, ko) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => ko(new Error(`Chargement impossible : ${src}`)); document.head.append(s); });

document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
  if (b.dataset.tab === 'resultats') bilan();
}));

// ============ Rapprochement de libellés (ticket ↔ produit) ============

const normaliser = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const simMot = (a, b) => {
  if (a === b) return 1;
  // « mozza » est le début de « mozzarella » : abréviation de caisse typique.
  if (a.length >= 3 && b.startsWith(a)) return 0.9;
  if (b.length >= 3 && a.startsWith(b)) return 0.9;
  return Math.max(0, 1 - levenshtein(a, b) / Math.max(a.length, b.length));
};
function trigrammes(s) { const t = ` ${s} `; const r = new Set(); for (let i = 0; i < t.length - 2; i++) r.add(t.slice(i, i + 3)); return r; }
function dice(a, b) {
  const A = trigrammes(a), B = trigrammes(b); let c = 0;
  for (const x of A) if (B.has(x)) c++;
  return (2 * c) / (A.size + B.size || 1);
}
function simNorm(a, b) {
  const ta = a.split(' '), tb = b.split(' ');
  const meilleurs = (u, v) => u.reduce((s, m) => s + Math.max(...v.map((n) => simMot(m, n))), 0) / u.length;
  const mots = (meilleurs(ta, tb) + meilleurs(tb, ta)) / 2;
  return 0.5 * mots + 0.5 * dice(a, b);
}
// Symétrique. Si l'un des textes est plus long (bruit d'OCR avant ou après le nom), on le compare
// aussi par fenêtres de mots, avec une légère pénalité quand la fenêtre n'a pas la taille de l'autre.
function similarite(x, y) {
  const a = normaliser(x), b = normaliser(y);
  if (!a || !b) return 0;
  let meilleur = simNorm(a, b);
  const [long, court] = a.split(' ').length >= b.split(' ').length ? [a, b] : [b, a];
  const tl = long.split(' '), n = court.split(' ').length;
  if (tl.length > n) {
    for (let m = Math.max(1, n - 1); m <= n + 1 && m <= tl.length; m++) {
      for (let i = 0; i + m <= tl.length; i++) meilleur = Math.max(meilleur, simNorm(tl.slice(i, i + m).join(' '), court) - 0.02 * Math.abs(m - n));
    }
  }
  return meilleur;
}

const SEUIL_SUR = 0.82, SEUIL_PROBABLE = 0.6;
// catalogue : [{ id, libelle, nom, marque }] ; renvoie les 3 meilleurs candidats.
function apparier(libelle, catalogue) {
  const cands = catalogue.map((p) => {
    const sLib = p.libelle ? similarite(libelle, p.libelle) : 0;
    const sNom = similarite(libelle, `${p.nom || ''} ${p.marque || ''}`) * 0.85; // un nom complet ressemble moins à une abréviation
    return { p, score: Math.max(sLib, sNom), via: sLib >= sNom ? 'libellé' : 'nom' };
  }).sort((a, b) => b.score - a.score).slice(0, 3);
  const top = cands[0];
  const niveau = !top ? 'aucun' : top.score >= SEUIL_SUR && top.via === 'libellé' ? 'sûr' : top.score >= SEUIL_PROBABLE ? 'probable' : 'aucun';
  return { niveau, cands };
}

// ============ Lecture d'un ticket (OCR) ============

const IGNORER = /\b(total|tva|carte|cb|especes?|monnaie|rendu|siret|merci|ticket|articles?|remise|fidelite|cagnotte|avoir|caisse|magasin|tel|www|date|heure|net|payer|paiement|visa|mastercard|contact|sous)\b/i;
function analyserLigne(brut) {
  const t = String(brut || '').replace(/\s+/g, ' ').trim();
  if (t.length < 4 || !/[a-zA-Z]{3}/.test(t) || IGNORER.test(t)) return null;
  // Dernier prix de la ligne (l'OCR ajoute parfois du bruit après : « 8,82 Bit », « 6,41 E », « 8,94 - »).
  const prix = [...t.matchAll(/(\d{1,3}[.,]\d{2})(?!\d)/g)].at(-1);
  if (!prix) return null; // sur un ticket, une ligne article porte un prix
  let libelle = t.slice(0, prix.index);
  let qte = 1;
  const q = libelle.match(/^\s*(\d{1,2})\s*[xX*]\s+/);
  if (q) { qte = Number(q[1]); libelle = libelle.slice(q[0].length); }
  libelle = libelle.replace(/^[\d\s\-.*#“”"'‘’]+/, '').replace(/[|_~=]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (libelle.replace(/[^a-zA-Z]/g, '').length < 3) return null;
  return { brut: t, libelle, prix: Number(prix[1].replace(',', '.')), qte };
}

let tesseractPret = null;
async function ocr(canvas, onProgress) {
  if (!window.Tesseract) await charger(TESSERACT);
  tesseractPret ??= window.Tesseract.createWorker('fra', 1, {
    langPath: TESS_LANGUES,
    logger: (m) => { if (m.status === 'recognizing text' && onProgress) onProgress(m.progress); },
  });
  const w = await tesseractPret;
  const { data } = await w.recognize(canvas);
  return data.lines.map((l) => l.text.trim()).filter(Boolean);
}

// Seuillage adaptatif (moyenne locale) après un léger flou : robuste au bruit et à l'éclairage inégal.
function binariser(c) {
  const w = c.width, h = c.height, x = c.getContext('2d', { willReadFrequently: true });
  const d = x.getImageData(0, 0, w, h), p = d.data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = p[i * 4];
  const fl = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    let s = 0, n = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const a = i + di, b = j + dj; if (a >= 0 && a < w && b >= 0 && b < h) { s += g[b * w + a]; n++; } }
    fl[j * w + i] = s / n;
  }
  const W1 = w + 1, I = new Float64Array(W1 * (h + 1));
  for (let j = 0; j < h; j++) { let l = 0; for (let i = 0; i < w; i++) { l += fl[j * w + i]; I[(j + 1) * W1 + i + 1] = I[j * W1 + i + 1] + l; } }
  const r = Math.max(10, Math.round(Math.min(w, h) / 30));
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const x0 = Math.max(0, i - r), x1 = Math.min(w, i + r + 1), y0 = Math.max(0, j - r), y1 = Math.min(h, j + r + 1);
    const moy = (I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0]) / ((x1 - x0) * (y1 - y0));
    const v = fl[j * w + i] < moy * 0.9 ? 0 : 255, k = (j * w + i) * 4;
    p[k] = p[k + 1] = p[k + 2] = v;
  }
  x.putImageData(d, 0, 0);
  return c;
}

// Lecture en deux temps : image en gris d'abord ; si peu de lignes article sont trouvées, image binarisée.
async function lireTicket(source, onProgress) {
  let meilleur = { brut: [], lignes: [], mode: 'gris' };
  for (const mode of ['gris', 'binaire']) {
    const brut = await ocr(preparer(source, mode), (p) => onProgress && onProgress((mode === 'gris' ? 0 : 0.5) + p / 2));
    const lignes = brut.map(analyserLigne).filter(Boolean);
    if (lignes.length > meilleur.lignes.length) meilleur = { brut, lignes, mode };
    if (mode === 'gris' && lignes.length >= 8) break;
  }
  return meilleur;
}

// Prétraitement : niveaux de gris + étirement du contraste, agrandi si l'image est petite.
function preparer(source, mode = 'gris') {
  const f = Math.max(1, Math.min(2.5, 1400 / (source.width || source.naturalWidth)));
  const c = document.createElement('canvas');
  c.width = Math.round((source.width || source.naturalWidth) * f);
  c.height = Math.round((source.height || source.naturalHeight) * f);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(source, 0, 0, c.width, c.height);
  const d = x.getImageData(0, 0, c.width, c.height), p = d.data;
  let min = 255, max = 0;
  for (let i = 0; i < p.length; i += 4) { const g = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]; p[i] = g; if (g < min) min = g; if (g > max) max = g; }
  const k = 255 / Math.max(1, max - min);
  for (let i = 0; i < p.length; i += 4) { const g = Math.max(0, Math.min(255, (p[i] - min) * k)); p[i] = p[i + 1] = p[i + 2] = g; }
  x.putImageData(d, 0, 0);
  return mode === 'binaire' ? binariser(c) : c;
}

// ============ Test automatique : ticket simulé ============

// Libellés abrégés réels du premier ticket de l'équipe (onglet « Ticket test »).
const LIBELLES = ['emmental rape 200g', '20 oeufs sol ppx', 'from bil mozza crf', 'mozzarella vache', 'ferrari parmigiano',
  'Gouda 10 TR 2000g c', 'lait 1/2 ecr', 'yaourt nature', '4maxi burger nat C', 'thon entier X 3 crf', 'Gallettes riz comp',
  "fins flocons d'avo", 'mission foods wrap', 'Miel fleurs liquid', 'jus de citron', "Huile d'olive", 'duc cannelle moulu',
  'Riz basmati 1kg cr', 'souris + balle', 'Le classique x2 17', 'banane', 'concombre noa 5K', 'citron vert 500gr',
  'Avocat FLT 450gr CA', 'PDT conso CAT 2 5', 'Ananas extra weet', 'Fraise ronde 250gr', 'pech plate 1 B BQ', 'air wick dif cot'];

function alea(graine) { let s = graine; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }

const VARIANTES = [
  { nom: 'Propre', flou: 0, bruit: 0, angle: 0, contraste: 1 },
  { nom: 'Flou léger', flou: 1.1, bruit: 0, angle: 0, contraste: 1 },
  { nom: 'Bruit', flou: 0, bruit: 28, angle: 0, contraste: 1 },
  { nom: 'Incliné 3°', flou: 0, bruit: 0, angle: 3, contraste: 1 },
  { nom: 'Papier thermique fané', flou: 0, bruit: 0, angle: 0, contraste: 0.42 },
  { nom: 'Très dégradé (limite)', flou: 0.9, bruit: 18, angle: 1.5, contraste: 0.55 },
];

function dessinerTicket(v) {
  const hasard = alea(7);
  const prix = LIBELLES.map(() => (0.6 + hasard() * 9).toFixed(2).replace('.', ','));
  const H = 40 + 28 * (LIBELLES.length + 9), W = 560;
  const base = document.createElement('canvas'); base.width = W; base.height = H;
  const x = base.getContext('2d');
  x.fillStyle = `rgb(${255 - 40 * (1 - v.contraste)},${255 - 40 * (1 - v.contraste)},${250 - 40 * (1 - v.contraste)})`;
  x.fillRect(0, 0, W, H);
  const encre = Math.round(20 + 150 * (1 - v.contraste));
  x.fillStyle = `rgb(${encre},${encre},${encre})`;
  x.font = '20px "Courier New", monospace';
  const ligne = (t, y, droite) => { x.textAlign = 'left'; x.fillText(t, 24, y); if (droite) { x.textAlign = 'right'; x.fillText(droite, W - 24, y); } };
  let y = 40;
  ['CARREFOUR NANCY', 'Rue de la Republique', 'Ticket 0245 Caisse 12', '28/10/2026 11:42'].forEach((t) => { ligne(t, y); y += 28; });
  y += 14;
  LIBELLES.forEach((l, i) => { ligne(l.toUpperCase(), y, prix[i]); y += 28; });
  y += 14;
  ligne('TOTAL A PAYER', y, '112,36'); y += 28;
  ligne('CB SANS CONTACT', y, '112,36'); y += 28;
  ligne('MERCI DE VOTRE VISITE', y);
  const fin = document.createElement('canvas'); fin.width = W + 60; fin.height = H + 60;
  const f = fin.getContext('2d', { willReadFrequently: true });
  f.fillStyle = '#c9c4b8'; f.fillRect(0, 0, fin.width, fin.height);
  f.save(); f.translate(fin.width / 2, fin.height / 2); f.rotate((v.angle * Math.PI) / 180);
  if (v.flou) f.filter = `blur(${v.flou}px)`;
  f.drawImage(base, -W / 2, -H / 2); f.restore(); f.filter = 'none';
  if (v.bruit) {
    const d = f.getImageData(0, 0, fin.width, fin.height), p = d.data;
    for (let i = 0; i < p.length; i += 4) { const n = (hasard() + hasard() + hasard() - 1.5) * v.bruit * 2; p[i] += n; p[i + 1] += n; p[i + 2] += n; }
    f.putImageData(d, 0, 0);
  }
  return fin;
}

async function lancerTicket() {
  const bouton = $('#lancer-ticket'); bouton.disabled = true;
  $('#log-ticket').textContent = ''; $('#res-ticket').innerHTML = '';
  const lignes = [];
  try {
    // Catalogue simulé : les produits déjà « liés » (2 sur 3) ; le tiers restant est inconnu de la base.
    const catalogue = LIBELLES.map((l, i) => ({ id: i, libelle: l, nom: '', marque: '', connu: i % 3 !== 0 })).filter((p) => p.connu);
    for (let k = 0; k < VARIANTES.length; k++) {
      const v = VARIANTES[k];
      const t0 = performance.now();
      const { lignes: lus, mode } = await lireTicket(dessinerTicket(v), (p) => barre('#barre-ticket', (k + p) / VARIANTES.length));
      const duree = (performance.now() - t0) / 1000;
      let retrouvees = 0, cerSomme = 0, ok = 0, faux = 0, manques = 0, absentsRepereOk = 0, absentsFauxPositifs = 0;
      const utilisees = new Set();
      LIBELLES.forEach((l, i) => {
        let best = null, bs = 0;
        lus.forEach((ln, j) => { const s = similarite(l, ln.libelle); if (s > bs) { bs = s; best = j; } });
        const lu = best != null && bs >= 0.6 ? lus[best] : null;
        if (lu) { retrouvees++; utilisees.add(best); cerSomme += levenshtein(normaliser(l), normaliser(lu.libelle)) / Math.max(1, normaliser(l).length); }
        const connu = i % 3 !== 0;
        const r = lu ? apparier(lu.libelle, catalogue) : { niveau: 'aucun', cands: [] };
        const propose = r.niveau === 'sûr' ? r.cands[0].p : null;
        if (connu) { if (propose && propose.id === i) ok++; else if (propose) faux++; else manques++; }
        else { if (propose) absentsFauxPositifs++; else absentsRepereOk++; }
      });
      const parasites = lus.filter((_, j) => !utilisees.has(j)).length;
      const connus = LIBELLES.filter((_, i) => i % 3 !== 0).length, inconnus = LIBELLES.length - connus;
      lignes.push({ nom: v.nom, mode, duree, retrouvees, cer: retrouvees ? cerSomme / retrouvees : 1, parasites, ok, faux, manques, connus, inconnus, absentsFauxPositifs, absentsRepereOk });
      log('#log-ticket', `${v.nom} [${mode}] : ${retrouvees}/${LIBELLES.length} lignes retrouvées, ${ok}/${connus} ré-associées, ${faux} erreurs, ${absentsFauxPositifs} faux positifs (${duree.toFixed(1)} s)`);
    }
    barre('#barre-ticket', 1);
    const rows = lignes.map((r) => `<tr><td>${esc(r.nom)} <span class="note">(${r.mode})</span></td><td class="num">${pct(r.retrouvees, LIBELLES.length)}</td><td class="num">${r.parasites}</td>
      <td class="num">${pct(r.ok, r.connus)}</td><td class="num ${r.faux ? 'ko' : 'ok'}">${r.faux}</td><td class="num ${r.absentsFauxPositifs ? 'ko' : 'ok'}">${r.absentsFauxPositifs}/${r.inconnus}</td><td class="num">${r.duree.toFixed(1)} s</td></tr>`).join('');
    $('#res-ticket').innerHTML = `<div class="tabla"><table><thead><tr><th>Qualité de l'image</th><th class="num">Lignes lues</th><th class="num">Lignes parasites</th><th class="num">Bien ré-associées</th><th class="num">Mauvaises associations</th><th class="num">Faux positifs</th><th class="num">Durée</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="note">${LIBELLES.length} lignes par ticket, dont ${LIBELLES.filter((_, i) => i % 3 !== 0).length} déjà connues du catalogue. « Faux positifs » : produits inconnus à tort associés à un produit connu (seuil « sûr » ≥ ${Math.round(SEUIL_SUR * 100)} %).</p>`;
    stock.ticketAuto = { date: new Date().toISOString(), lignes };
    sauver();
  } catch (e) {
    log('#log-ticket', `Erreur : ${e.message || e}`);
  } finally { bouton.disabled = false; }
}
$('#lancer-ticket').addEventListener('click', lancerTicket);

// ============ Ticket réel ============

let catalogue = [];
async function chargerCatalogue() {
  const local = (() => { try { return Object.values(JSON.parse(localStorage.getItem('resser.pruebaA.v1')).refs || {}); } catch { return []; } })();
  const cle = (() => { try { return JSON.parse(localStorage.getItem('resser.pruebaA.v1')).prefs.sync_cle; } catch { return ''; } })();
  let distant = [];
  if (cle) {
    try {
      const j = await (await fetch(`${URL_FEUILLE}?cle=${encodeURIComponent(cle)}&accion=lista`)).json();
      if (j.ok && Array.isArray(j.produits)) distant = j.produits;
    } catch { /* hors ligne : catalogue local seulement */ }
  }
  const par = new Map();
  local.forEach((r) => par.set(String(r.gtin), { id: String(r.gtin), nom: r.nombre, marque: r.marca, libelle: r.libelle_ticket || '' }));
  distant.forEach((r) => par.set(String(r.gtin), { id: String(r.gtin), nom: r.nom, marque: r.marque, libelle: r.libelle || '' }));
  catalogue = [...par.values()];
  const avecLib = catalogue.filter((p) => p.libelle).length;
  $('#catalogue-etat').textContent = `Catalogue : ${catalogue.length} produits (${avecLib} avec libellé de ticket)${distant.length ? '' : cle ? ' — feuille non lue, catalogue local' : ' — clé non saisie dans l’appli, catalogue local'}`;
}
chargerCatalogue();

$('#ticket-fichier').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const zone = $('#ticket-reel'); zone.innerHTML = '<p class="note">Lecture en cours (la première fois, le moteur et la langue française se téléchargent)…</p><div class="barre"><i id="barre-reel"></i></div>';
  try {
    const img = await createImageBitmap(f);
    const { brut, mode } = await lireTicket(img, (p) => barre('#barre-reel', p));
    const lus = brut.map((b) => ({ brut: b, art: analyserLigne(b) }));
    toast(`Lecture terminée (image ${mode})`);
    const id = `t${Date.now()}`;
    stock.ticket.push({ id, date: new Date().toISOString(), lignes: lus.map((l) => ({ brut: l.brut, libelle: l.art?.libelle || '', verdictLecture: '', verdictAsso: '', propose: '', niveau: '' })) });
    stock.ticket.at(-1).lignes.forEach((l, i) => {
      if (!lus[i].art) return;
      const r = apparier(l.libelle, catalogue); l.niveau = r.niveau; l.propose = r.cands[0] ? `${r.cands[0].p.id}|${r.cands[0].p.nom}|${r.cands[0].score.toFixed(2)}` : '';
    });
    sauver();
    afficherTicket(id);
  } catch (err) { zone.innerHTML = `<p class="ko">Erreur : ${esc(err.message || err)}</p>`; }
});

function afficherTicket(id) {
  const t = stock.ticket.find((x) => x.id === id);
  const lignes = t.lignes.map((l, i) => {
    if (!l.libelle) return `<tr style="opacity:.55"><td colspan="3">${esc(l.brut)}</td><td></td></tr>`;
    const r = apparier(l.libelle, catalogue);
    const chips = r.cands.filter((c) => c.score >= 0.4).map((c, k) => `<span class="chip ${k === 0 ? 'top' : ''}">${esc(c.p.nom || c.p.libelle || c.p.id)} · ${Math.round(c.score * 100)} % (${c.via})</span>`).join('') || '<span class="note">aucune proposition</span>';
    const opt = (cur, liste) => liste.map(([v, tx]) => `<option value="${v}"${cur === v ? ' selected' : ''}>${tx}</option>`).join('');
    return `<tr><td>${esc(l.brut)}</td><td><strong>${esc(l.libelle)}</strong></td><td>${chips}<div class="note">niveau : ${r.niveau}</div></td>
      <td><select data-t="${id}" data-i="${i}" data-k="verdictLecture">${opt(l.verdictLecture, [['', 'Lecture ?'], ['ok', 'Lecture juste'], ['ko', 'Lecture fausse'], ['np', 'Pas un produit']])}</select>
      <select data-t="${id}" data-i="${i}" data-k="verdictAsso">${opt(l.verdictAsso, [['', 'Association ?'], ['ok', 'Bon produit'], ['ko', 'Mauvais produit'], ['abs', 'Produit absent du catalogue'], ['none', 'Rien proposé à tort']])}</select></td></tr>`;
  }).join('');
  $('#ticket-reel').innerHTML = `<div class="tabla"><table><thead><tr><th>Ligne lue</th><th>Libellé</th><th>Propositions</th><th>Verdict</th></tr></thead><tbody>${lignes}</tbody></table></div>`;
}
document.addEventListener('change', (e) => {
  const s = e.target.closest('select[data-t]');
  if (!s) return;
  stock.ticket.find((x) => x.id === s.dataset.t).lignes[Number(s.dataset.i)][s.dataset.k] = s.value;
  sauver();
});

// ============ Suggestion IA (CLIP, zero-shot) ============

// Chaque classe combine forme et matériau ; le texte anglais est celui que CLIP comprend le mieux.
const CLASSES = [
  { id: 'glass_bottle', texte: 'a glass bottle', forme: 'bottle', fam: 'vidrio', fr: 'Bouteille en verre' },
  { id: 'plastic_bottle', texte: 'a plastic bottle', forme: 'bottle', fam: 'plastico', fr: 'Bouteille en plastique' },
  { id: 'glass_jar', texte: 'a glass jar', forme: 'jar', fam: 'vidrio', fr: 'Bocal en verre' },
  { id: 'metal_can', texte: 'a metal can', forme: 'can', fam: 'metal', fr: 'Boîte / canette métal' },
  { id: 'cardboard_box', texte: 'a cardboard box', forme: 'box', fam: 'papel_carton', fr: 'Boîte en carton' },
  { id: 'plastic_tray', texte: 'a plastic tray sealed with film', forme: 'tray', fam: 'plastico', fr: 'Barquette plastique' },
  { id: 'plastic_bag', texte: 'a plastic bag or pouch', forme: 'bag', fam: 'plastico', fr: 'Sac / sachet plastique' },
  { id: 'carton_brick', texte: 'a carton brick of milk or juice', forme: 'brick', fam: 'compuesto', fr: 'Brique carton' },
  { id: 'plastic_tub', texte: 'a plastic tub or cup with a lid', forme: 'tub', fam: 'plastico', fr: 'Pot plastique' },
  { id: 'plastic_film', texte: 'food wrapped in plastic film', forme: 'film', fam: 'plastico', fr: 'Film plastique' },
  { id: 'paper_bag', texte: 'a paper bag', forme: 'bag', fam: 'papel_carton', fr: 'Sac papier' },
  { id: 'tube', texte: 'a squeeze tube', forme: 'tube', fam: 'plastico', fr: 'Tube' },
];
const FORME_OFF = { 'en:bottle': 'bottle', 'en:drink-can': 'can', 'en:food-can': 'can', 'en:can': 'can', 'en:aerosol-can': 'can', 'en:box': 'box', 'en:card': 'box', 'en:carton': 'box',
  'en:bag': 'bag', 'en:individual-bag': 'bag', 'en:sachet': 'bag', 'en:pouch': 'bag', 'en:tray': 'tray', 'en:pot': 'tub', 'en:tub': 'tub', 'en:cup': 'tub', 'en:film': 'film',
  'en:sheet': 'film', 'en:wrapper': 'film', 'en:brick': 'brick', 'en:jar': 'jar', 'en:tube': 'tube' };
const famMat = (m) => familiaDe(String(m).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase());

let clip = null;
async function chargerClip(onProgress) {
  if (clip) return clip;
  const T = await import(TRANSFORMERS);
  T.env.allowLocalModels = false;
  const dispositif = navigator.gpu ? 'webgpu' : 'wasm';
  const options = { dtype: 'q8', progress_callback: (p) => { if (p.status === 'progress' && onProgress) onProgress(p); } };
  try { clip = await T.pipeline('zero-shot-image-classification', MODELE_CLIP, { ...options, device: dispositif }); clip.dispositif = dispositif; }
  catch (e) { if (dispositif === 'wasm') throw e; clip = await T.pipeline('zero-shot-image-classification', MODELE_CLIP, { ...options, device: 'wasm' }); clip.dispositif = 'wasm'; }
  return clip;
}
async function classer(image) {
  const c = await chargerClip();
  const sortie = await c(image, CLASSES.map((x) => x.texte), { hypothesis_template: 'a product photo of {}.' });
  return sortie.map((s) => ({ ...CLASSES.find((x) => x.texte === s.label), score: s.score })).sort((a, b) => b.score - a.score);
}

async function lancerIA() {
  const bouton = $('#lancer-ia'); bouton.disabled = true;
  $('#log-ia').textContent = ''; $('#res-ia').innerHTML = '';
  try {
    const jeu = (await (await fetch('labo/benchmark_off.json')).json()).produits;
    log('#log-ia', `Chargement du modèle ${MODELE_CLIP}…`);
    const t0 = performance.now(); let dernier = 0;
    await chargerClip((p) => { if (performance.now() - dernier > 800) { dernier = performance.now(); log('#log-ia', `  ${p.file?.split('/').pop() || ''} ${Math.round(p.progress || 0)} %`); } });
    log('#log-ia', `Modèle prêt en ${((performance.now() - t0) / 1000).toFixed(1)} s (${clip.dispositif}).`);
    const res = []; let tInf = 0;
    for (let i = 0; i < jeu.length; i++) {
      const p = jeu[i];
      const formes = new Set(p.composants.map((c) => FORME_OFF[c.forme]).filter(Boolean));
      const fams = new Set(p.composants.map((c) => famMat(c.materiau)));
      if (!formes.size) continue;
      const t1 = performance.now();
      let pred;
      try { pred = await classer(p.image); } catch (e) { log('#log-ia', `  ${p.code} : image illisible (${e.message || e})`); continue; }
      tInf += performance.now() - t1;
      const juste = (c) => formes.has(c.forme) && fams.has(c.fam);
      res.push({ code: p.code, nom: p.nom, vrai: [...formes].join('/') + ' · ' + [...fams].map((f) => FAMILIAS[f]?.label || f).join('/'),
        top1: pred[0].fr, strict1: juste(pred[0]), strict3: pred.slice(0, 3).some(juste),
        forme1: formes.has(pred[0].forme), fam1: fams.has(pred[0].fam), conf: pred[0].score });
      barre('#barre-ia', (i + 1) / jeu.length);
    }
    const n = res.length, s = (f) => res.filter(f).length;
    const lignes = res.map((r) => `<tr><td>${esc(r.nom)}</td><td>${esc(r.vrai)}</td><td>${esc(r.top1)} <span class="note">${Math.round(r.conf * 100)} %</span></td><td class="${r.strict1 ? 'ok' : r.forme1 || r.fam1 ? 'mid' : 'ko'}">${r.strict1 ? 'juste' : r.forme1 ? 'forme ok' : r.fam1 ? 'matériau ok' : 'faux'}</td></tr>`).join('');
    $('#res-ia').innerHTML = `<div class="kpis"><div class="kpi"><div class="l">Forme + matériau (1ʳᵉ proposition)</div><div class="v">${pct(s((r) => r.strict1), n)}</div><div class="n">${s((r) => r.strict1)} / ${n}</div></div>
      <div class="kpi"><div class="l">Dans les 3 premières propositions</div><div class="v">${pct(s((r) => r.strict3), n)}</div><div class="n">${s((r) => r.strict3)} / ${n}</div></div>
      <div class="kpi"><div class="l">Forme seule</div><div class="v">${pct(s((r) => r.forme1), n)}</div></div>
      <div class="kpi"><div class="l">Famille de matériau seule</div><div class="v">${pct(s((r) => r.fam1), n)}</div></div></div>
      <p class="note">Modèle ${esc(MODELE_CLIP)} · ${(tInf / Math.max(1, n) / 1000).toFixed(2)} s par photo (${clip.dispositif}). Référence : emballages décrits par Open Food Facts, qui contient des erreurs ; mesure indicative, pas une vérité.</p>
      <div class="tabla"><table><thead><tr><th>Produit</th><th>Open Food Facts</th><th>Proposition IA</th><th>Résultat</th></tr></thead><tbody>${lignes}</tbody></table></div>`;
    stock.iaAuto = { modele: MODELE_CLIP, date: new Date().toISOString(), n, strict1: s((r) => r.strict1), strict3: s((r) => r.strict3), forme1: s((r) => r.forme1), fam1: s((r) => r.fam1), dispositif: clip.dispositif, secParPhoto: tInf / Math.max(1, n) / 1000 };
    sauver();
  } catch (e) { log('#log-ia', `Erreur : ${e.message || e}`); } finally { bouton.disabled = false; }
}
$('#lancer-ia').addEventListener('click', lancerIA);

$('#ia-fichier').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const zone = $('#ia-reel'); zone.innerHTML = '<p class="note">Analyse en cours (la première fois, le modèle se télécharge : ≈ 150 Mo)…</p>';
  try {
    const url = URL.createObjectURL(f);
    const pred = await classer(url);
    const id = `i${Date.now()}`;
    stock.ia.push({ id, date: new Date().toISOString(), propositions: pred.slice(0, 3).map((p) => `${p.fr}:${p.score.toFixed(2)}`), verdict: '', correct: '' });
    sauver();
    zone.innerHTML = `<img class="apercu" src="${url}" alt="">
      <p>${pred.slice(0, 3).map((p, k) => `<span class="chip ${k === 0 ? 'top' : ''}">${esc(p.fr)} · ${Math.round(p.score * 100)} %</span>`).join('')}</p>
      <div class="actions"><select id="ia-verdict" data-id="${id}"><option value="">Votre verdict</option><option value="top1">La 1ʳᵉ proposition est juste</option><option value="top3">Juste, mais pas en 1ʳᵉ</option><option value="faux">Aucune n'est juste</option></select>
      <input id="ia-reel-vrai" placeholder="Le vrai emballage (facultatif)" style="max-width:260px"></div>`;
    $('#ia-verdict').addEventListener('change', (ev) => { const r = stock.ia.find((x) => x.id === id); r.verdict = ev.target.value; r.correct = $('#ia-reel-vrai').value; sauver(); toast('Verdict enregistré'); });
  } catch (err) { zone.innerHTML = `<p class="ko">Erreur : ${esc(err.message || err)}</p>`; }
});

if (location.search.includes('debug')) window.__labo = { dessinerTicket, VARIANTES, preparer, ocr, analyserLigne, lireTicket, apparier, similarite, LIBELLES };

// ============ Résultats ============

function bilan() {
  const t = stock.ticket.flatMap((x) => x.lignes).filter((l) => l.libelle);
  const lect = t.filter((l) => l.verdictLecture === 'ok' || l.verdictLecture === 'ko');
  const asso = t.filter((l) => l.verdictAsso);
  const sur = asso.filter((l) => l.niveau === 'sûr');
  const ia = stock.ia.filter((r) => r.verdict);
  $('#bilan').innerHTML = `
    <p><strong>Tickets réels</strong> : ${stock.ticket.length} ticket(s), ${t.length} lignes produit détectées.</p>
    <ul><li>Lecture juste : ${pct(lect.filter((l) => l.verdictLecture === 'ok').length, lect.length)} (${lect.length} jugées)</li>
    <li>Association « sûre » correcte : ${pct(sur.filter((l) => l.verdictAsso === 'ok').length, sur.length)} (${sur.length} jugées)</li>
    <li>Produits absents du catalogue : ${asso.filter((l) => l.verdictAsso === 'abs').length}</li></ul>
    <p><strong>Photos réelles (IA)</strong> : ${ia.length} verdict(s).</p>
    <ul><li>1ʳᵉ proposition juste : ${pct(ia.filter((r) => r.verdict === 'top1').length, ia.length)}</li>
    <li>Juste dans les 3 premières : ${pct(ia.filter((r) => r.verdict === 'top1' || r.verdict === 'top3').length, ia.length)}</li></ul>
    ${stock.ticketAuto ? `<p class="note">Dernier test automatique de ticket : ${stock.ticketAuto.date.slice(0, 16).replace('T', ' ')}</p>` : ''}
    ${stock.iaAuto ? `<p class="note">Dernier test automatique IA : ${stock.iaAuto.strict1}/${stock.iaAuto.n} justes en 1ʳᵉ proposition.</p>` : ''}`;
}
$('#exporter').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(stock, null, 2)], { type: 'application/json' }));
  a.download = `resser_labo_${new Date().toISOString().slice(0, 10)}.json`; a.click();
});
$('#effacer').addEventListener('click', () => { if (confirm('Effacer tous les verdicts de ce téléphone ?')) { stock = { ia: [], ticket: [] }; sauver(); bilan(); } });
