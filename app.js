import {
  CATEGORIAS, FAMILIAS, MATERIALES, FORMAS, PESO_FUENTES, EXACTITUD, CAUSAS, ESTADOS_OFF,
  familiaDe, labelDe, labelMaterial, labelForma, consignaTri, FUENTE_TRI,
} from './reglas.js';

const APP_VERSION = '0.3.0';
const KEY = 'resser.pruebaA.v1'; // clé inchangée pour conserver les données déjà saisies
const OFF_FIELDS = 'code,product_name,product_name_fr,brands,quantity,packagings,packagings_complete,image_front_small_url';
// Lecteur de secours (zxing-cpp en WebAssembly) quand le navigateur n'a pas de BarcodeDetector natif (iPhone, Firefox…).
const LIB_LECTOR = 'https://cdn.jsdelivr.net/npm/barcode-detector@3.2.0/dist/iife/ponyfill.js';
const FORMATOS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
// Seuils exploratoires du plan de faisabilité (section 06).
const METAS = { producto: 0.85, material: 0.70, masa: 0.50 };

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const g1 = (n) => n.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const ahora = () => new Date().toISOString();

// ---------- Stockage (dans le navigateur ; exporter des sauvegardes régulièrement) ----------

function cargar() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
function guardar() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch { toast("Impossible d'enregistrer dans le navigateur. Exportez une sauvegarde JSON."); }
}
const db = cargar();
db.refs ??= {};
db.prefs ??= {};

// ---------- Utilitaires ----------

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}
function estado(msg) { $('#estado').textContent = msg || ''; }

function gtinValido(code) {
  if (!/^(\d{8}|\d{12,14})$/.test(code)) return false;
  const d = code.split('').map(Number);
  const control = d.pop();
  const suma = d.reverse().reduce((s, n, i) => s + n * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (suma % 10)) % 10 === control;
}

function opciones(lista, valor) {
  const conocido = lista.some((o) => o.id === (valor || ''));
  const extra = !conocido && valor ? `<option value="${esc(valor)}" selected>${esc(valor)} (OFF)</option>` : '';
  return extra + lista.map((o) => `<option value="${esc(o.id)}"${o.id === (valor || '') ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
}

function descargar(nombre, contenido, tipo) {
  const blob = new Blob([contenido], { type: tipo });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nombre;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

// ---------- Open Food Facts ----------

async function consultarOFF(gtin) {
  const url = `https://world.openfoodfacts.org/api/v3/product/${gtin}?fields=${OFF_FIELDS}`;
  let r;
  try { r = await fetch(url); } catch { throw new Error('Pas de connexion avec Open Food Facts.'); }
  if (r.status === 429) throw new Error('Limite Open Food Facts atteinte (15 requêtes/min). Patientez une minute.');
  if (r.status === 404) return { estado: 'no_encontrado' };
  if (!r.ok) throw new Error(`Open Food Facts a répondu ${r.status}.`);
  const j = await r.json();
  if (!j.product) return { estado: 'no_encontrado' };
  return { estado: 'encontrado', product: j.product };
}

function componentesDesdeOFF(packagings = []) {
  return packagings.map((k) => {
    let peso_g = null, peso_fuente = '';
    if (num(k.weight_measured) != null) { peso_g = num(k.weight_measured); peso_fuente = 'off_medido'; }
    else if (num(k.weight_specified) != null) { peso_g = num(k.weight_specified); peso_fuente = 'off_especificado'; }
    else if (num(k.weight_estimated) != null) { peso_g = num(k.weight_estimated); peso_fuente = 'off_estimado'; }
    return {
      forma: k.shape?.id || '',
      material: k.material?.id || '',
      unidades: num(k.number_of_units) ?? 1,
      peso_g,
      peso_fuente,
      reciclaje_off: k.recycling?.id || '',
      origen: 'off',
    };
  });
}

function nuevoRegistro(gtin, res) {
  const p = res.product || {};
  return {
    gtin,
    categoria: db.prefs.categoria || CATEGORIAS[0].id,
    nombre: p.product_name_fr || p.product_name || '',
    marca: p.brands || '',
    cantidad: p.quantity || '',
    imagen: p.image_front_small_url || '',
    off: {
      estado: res.estado,
      packagings_complete: p.packagings_complete ?? null,
      packagings: p.packagings || [],
      consultado: ahora(),
    },
    componentes: componentesDesdeOFF(p.packagings),
    verificado: false,
    exactitud_off: res.estado === 'encontrado' && !(p.packagings || []).length ? 'sin_datos' : '',
    clase_manual: '',
    causa: res.estado === 'no_encontrado' ? 'no_encontrado' : '',
    obs: '',
    creado: ahora(),
    actualizado: ahora(),
    version_app: APP_VERSION,
  };
}

// ---------- Règles de qualité (classes A/B/C/D du plan) ----------

function componentesRelevantes(r) {
  const plas = r.componentes.filter((c) => familiaDe(c.material) === 'plastico');
  return plas.length ? plas : r.componentes;
}

function claseSugerida(r) {
  const c = r.componentes || [];
  if (!c.length || c.some((x) => !x.material)) return 'D';
  const rel = componentesRelevantes(r);
  if (!rel.every((x) => num(x.peso_g) != null && x.peso_fuente)) return 'C';
  if (r.verificado && !rel.some((x) => /estimado/.test(x.peso_fuente))) return 'A';
  return 'B';
}
const claseFinal = (r) => r.clase_manual || claseSugerida(r);

// Masse plastique par unité de vente : Σ (unités × poids) des composants plastiques.
// Renseignée uniquement pour les classes A et B ; en C et D aucun gramme n'est attribué.
function masaPlastico(r) {
  if (!['A', 'B'].includes(claseFinal(r))) return null;
  return r.componentes
    .filter((c) => familiaDe(c.material) === 'plastico')
    .reduce((s, c) => s + (num(c.unidades) ?? 1) * (num(c.peso_g) ?? 0), 0);
}

// ---------- Onglets ----------

document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => mostrarTab(b.dataset.tab)));
function mostrarTab(id) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${id}`));
  if (id === 'inventario') pintarLista();
  if (id === 'resumen') pintarResumen();
  if (id !== 'escanear') cerrarCamara();
}

// ---------- Recherche et caméra ----------

const selCat = $('#categoria');
selCat.innerHTML = opciones(CATEGORIAS, db.prefs.categoria || CATEGORIAS[0].id);
selCat.addEventListener('change', () => { db.prefs.categoria = selCat.value; guardar(); });

$('#buscar').addEventListener('click', () => buscar($('#gtin').value));
$('#gtin').addEventListener('keydown', (e) => { if (e.key === 'Enter') buscar(e.target.value); });

let buscando = false;
async function buscar(valor, { reconsultar = false } = {}) {
  const gtin = normalizar(valor);
  if (!gtin) return estado('Saisissez ou scannez un code.');
  if (buscando) return;
  if (!gtinValido(gtin)) toast('La clé de contrôle ne correspond pas : vérifiez le code.');
  $('#gtin').value = gtin;

  if (db.refs[gtin] && !reconsultar) {
    estado("Cette référence est déjà dans l'inventaire.");
    return abrirEditor(structuredClone(db.refs[gtin]));
  }
  buscando = true;
  $('#buscar').disabled = true;
  estado('Interrogation d’Open Food Facts…');
  try {
    const res = await consultarOFF(gtin);
    if (reconsultar && db.refs[gtin]) {
      const r = structuredClone(db.refs[gtin]);
      const p = res.product || {};
      r.off = { estado: res.estado, packagings_complete: p.packagings_complete ?? null, packagings: p.packagings || [], consultado: ahora() };
      r.componentes = componentesDesdeOFF(p.packagings);
      r.verificado = false;
      estado('Données OFF mises à jour. Vérifiez à nouveau puis enregistrez.');
      abrirEditor(r);
    } else {
      estado(res.estado === 'encontrado' ? 'Produit trouvé. Vérifiez les emballages sur le produit physique.' : "Absent d'Open Food Facts. Décrivez les emballages à la main.");
      abrirEditor(nuevoRegistro(gtin, res));
    }
  } catch (e) {
    estado(e.message);
  } finally {
    buscando = false;
    $('#buscar').disabled = false;
  }
}

// ---------- Lecture du code-barres (caméra en direct ou photo) ----------

let detector = null;
let motor = '';

function cargarScript(src) {
  return new Promise((ok, ko) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = ok;
    s.onerror = () => ko(new Error('Impossible de charger le lecteur de codes (hors connexion ?).'));
    document.head.append(s);
  });
}

// Détecteur natif s'il lit l'EAN-13 (Chrome Android), sinon zxing-cpp en WebAssembly.
async function obtenerDetector() {
  if (detector) return detector;
  if ('BarcodeDetector' in window) {
    try {
      const soportados = await window.BarcodeDetector.getSupportedFormats();
      if (soportados.includes('ean_13')) {
        detector = new window.BarcodeDetector({ formats: FORMATOS.filter((f) => soportados.includes(f)) });
        motor = 'natif';
        return detector;
      }
    } catch { /* on passe au lecteur de secours */ }
  }
  if (!window.BarcodeDetectionAPI) await cargarScript(LIB_LECTOR);
  detector = new window.BarcodeDetectionAPI.BarcodeDetector({ formats: FORMATOS });
  motor = 'zxing';
  return detector;
}

// UPC-A (12 chiffres) → EAN-13 avec un 0 initial, la forme utilisée par Open Food Facts.
const normalizar = (texto) => {
  const d = String(texto || '').replace(/\D/g, '');
  return d.length === 12 ? `0${d}` : d;
};
const codigoLeido = (resultados) => resultados.map((r) => normalizar(r.rawValue)).find(gtinValido);

function mensajeCamara(e) {
  const n = e?.name || '';
  if (!navigator.mediaDevices?.getUserMedia) return 'La caméra exige une page en HTTPS. Utilisez « Photo du code » ou saisissez le code.';
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'Accès à la caméra refusé. Autorisez-le dans les réglages du navigateur, ou utilisez « Photo du code ».';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'Aucune caméra disponible. Utilisez « Photo du code » ou saisissez le code.';
  if (n === 'NotReadableError') return 'La caméra est utilisée par une autre application. Fermez-la puis réessayez.';
  return e?.message || String(e);
}

let flujo = null;
let ciclo = 0;
let linterna = false;

$('#camara').addEventListener('click', abrirCamara);
$('#cerrar-camara').addEventListener('click', cerrarCamara);

async function abrirCamara() {
  const id = ++ciclo;
  try {
    estado('Préparation du lecteur…');
    const det = await obtenerDetector();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    if (id !== ciclo) { stream.getTracks().forEach((t) => t.stop()); return; }
    flujo = stream;
    const video = $('#video');
    video.srcObject = flujo;
    await video.play();
    $('#lector').hidden = false;
    $('#botones-scan').hidden = true;

    const pista = flujo.getVideoTracks()[0];
    const cap = pista.getCapabilities?.() || {};
    if (cap.focusMode?.includes('continuous')) pista.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    linterna = false;
    $('#linterna').hidden = !cap.torch;
    estado(`Placez le code-barres dans le cadre, à 10–20 cm, bien éclairé. (lecteur ${motor})`);

    // Deux lectures identiques de suite avant d'accepter un code, pour écarter les lectures erronées.
    let ultimo = '', repeticiones = 0;
    const paso = async () => {
      if (id !== ciclo) return;
      if (video.readyState >= 2) {
        try {
          const code = codigoLeido(await det.detect(video));
          if (id !== ciclo) return;
          if (code) {
            repeticiones = code === ultimo ? repeticiones + 1 : 1;
            ultimo = code;
            if (repeticiones >= 2) {
              if (navigator.vibrate) navigator.vibrate(80);
              cerrarCamara();
              buscar(code);
              return;
            }
          }
        } catch { /* image non exploitable : on continue */ }
      }
      setTimeout(paso, 120);
    };
    paso();
  } catch (e) {
    cerrarCamara();
    estado(mensajeCamara(e));
  }
}

function cerrarCamara() {
  ciclo++;
  if (flujo) { flujo.getTracks().forEach((t) => t.stop()); flujo = null; }
  $('#video').srcObject = null;
  $('#lector').hidden = true;
  $('#botones-scan').hidden = false;
}

$('#linterna').addEventListener('click', async () => {
  const pista = flujo?.getVideoTracks()[0];
  if (!pista) return;
  linterna = !linterna;
  try { await pista.applyConstraints({ advanced: [{ torch: linterna }] }); } catch { linterna = false; }
});

// Photo prise avec l'appareil photo du téléphone : autofocus et pleine résolution, souvent plus fiable en magasin.
$('#foto').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  estado('Lecture de la photo…');
  try {
    const det = await obtenerDetector();
    const img = await createImageBitmap(f);
    const code = codigoLeido(await det.detect(img));
    img.close?.();
    if (code) buscar(code);
    else estado('Aucun code-barres détecté. Reprenez la photo plus près, nette, le code bien à plat et éclairé.');
  } catch (err) {
    estado(`Impossible de lire la photo : ${err?.message || err}`);
  }
});

// ---------- Éditeur d'une référence ----------

let actual = null;

function abrirEditor(r) {
  actual = r;
  pintarEditor();
  $('#editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function pintarEditor() {
  const r = actual;
  const ed = $('#editor');
  if (!r) { ed.innerHTML = ''; return; }
  const enOFF = r.off.estado === 'encontrado';
  const completo = r.off.packagings_complete;
  const yaGuardado = !!db.refs[r.gtin];

  ed.innerHTML = `
    <div class="card">
      <div class="prod">
        ${r.imagen ? `<img src="${esc(r.imagen)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
        <div class="meta">
          <div class="gtin">${esc(r.gtin)}</div>
          <div>
            <span class="badge ${enOFF ? 'good' : 'bad'}">${enOFF ? 'Dans Open Food Facts' : 'Introuvable dans OFF'}</span>
            ${enOFF ? `<span class="badge ${completo ? '' : 'warn'}">${completo ? 'OFF : emballages marqués complets' : 'OFF : emballages incomplets'}</span>` : ''}
            <span class="badge">${r.off.packagings.length} comp. dans OFF</span>
          </div>
          ${enOFF ? `<a class="note" href="https://world.openfoodfacts.org/product/${esc(r.gtin)}" target="_blank" rel="noopener">Voir la fiche Open Food Facts</a>` : ''}
        </div>
      </div>
    </div>

    <div class="card">
      <h3>Produit</h3>
      <div class="grid">
        <label class="field">Nom / variante<input data-k="nombre" value="${esc(r.nombre)}"></label>
        <label class="field">Marque<input data-k="marca" value="${esc(r.marca)}"></label>
        <label class="field">Quantité<input data-k="cantidad" value="${esc(r.cantidad)}" placeholder="ex. 1,5 L"></label>
        <label class="field">Catégorie<select data-k="categoria">${opciones(CATEGORIAS, r.categoria)}</select></label>
      </div>
    </div>

    <div class="card">
      <h3>Composants de l'emballage</h3>
      <p class="note">Chaque ligne est un composant d'une unité de vente (bouteille, bouchon, étiquette…). Le poids s'entend par unité de composant.</p>
      <div id="comps">${r.componentes.map(pintarComponente).join('') || '<p class="vacio">Aucun composant. Ajoutez ceux que vous observez sur le produit.</p>'}</div>
      <button type="button" id="add-comp" class="secondary wide">Ajouter un composant</button>
      <p class="note">Consignes de tri : ${esc(FUENTE_TRI)}</p>
    </div>

    <div class="card">
      <h3>Vérification et qualité</h3>
      <label class="check"><input type="checkbox" data-k="verificado" ${r.verificado ? 'checked' : ''}> Emballages vérifiés sur le produit physique</label>
      <div class="grid">
        <label class="field">Données OFF sur les emballages<select data-k="exactitud_off">${opciones(EXACTITUD, r.exactitud_off)}</select></label>
        <label class="field">Cause d'absence / problème<select data-k="causa">${opciones(CAUSAS, r.causa)}</select></label>
      </div>
      <div class="row" style="align-items:center;margin-bottom:10px">
        <span>Classe suggérée</span> <span id="clase-sug"></span>
        <label class="field" style="flex:1;margin:0">
          <select data-k="clase_manual">${opciones([
            { id: '', label: 'Utiliser la classe suggérée' },
            { id: 'A', label: 'A · masse mesurée ou déclarée et vérifiée' },
            { id: 'B', label: 'B · masse estimée' },
            { id: 'C', label: 'C · forme et matériau, sans poids' },
            { id: 'D', label: 'D · non caractérisable' },
          ], r.clase_manual)}</select>
        </label>
      </div>
      <p class="note" id="masa"></p>
      <label class="field">Observations<textarea data-k="obs" placeholder="Ce qui ne correspondait pas, méthode de pesée, photo prise…">${esc(r.obs)}</textarea></label>
      <div class="actions">
        <button type="button" id="guardar" class="primary">Enregistrer la référence</button>
        ${yaGuardado && enOFF ? '<button type="button" id="reconsultar" class="secondary">Réinterroger OFF</button>' : ''}
        <button type="button" id="descartar" class="ghost">${yaGuardado ? 'Fermer' : 'Abandonner'}</button>
      </div>
    </div>`;
  refrescarDerivados();
}

function pintarComponente(c, i) {
  return `
    <div class="comp" data-i="${i}">
      <div class="comp-head"><span>Composant ${i + 1}${c.origen === 'off' ? ' <span class="badge">OFF</span>' : ''}</span>
        <button type="button" class="ghost" data-del="${i}" aria-label="Supprimer le composant">Supprimer</button></div>
      <div class="grid">
        <label class="field">Forme<select data-c="forma">${opciones([{ id: '', label: '— sans forme —' }, ...FORMAS], c.forma)}</select></label>
        <label class="field">Matériau<select data-c="material">${opciones([{ id: '', label: '— sans matériau —' }, ...MATERIALES], c.material)}</select></label>
        <label class="field">Unités par produit<input data-c="unidades" type="number" min="0" step="1" value="${esc(c.unidades)}"></label>
        <label class="field">Poids par unité (g)<input data-c="peso_g" type="number" min="0" step="0.1" value="${esc(c.peso_g)}"></label>
        <label class="field">Source du poids<select data-c="peso_fuente">${opciones(PESO_FUENTES, c.peso_fuente)}</select></label>
      </div>
      <div class="comp-foot" data-foot></div>
    </div>`;
}

function refrescarDerivados() {
  const r = actual;
  if (!r) return;
  document.querySelectorAll('#comps .comp').forEach((el) => {
    const c = r.componentes[Number(el.dataset.i)];
    const fam = familiaDe(c.material);
    const tri = consignaTri(fam);
    el.querySelector('[data-foot]').innerHTML = `
      <span><span class="dot" style="background:${FAMILIAS[fam].color}"></span>${esc(FAMILIAS[fam].label)}</span>
      <span class="badge ${tri.id === 'nd' ? 'bad' : ''}">${esc(tri.label)}</span>
      ${c.reciclaje_off ? `<span class="note">OFF : ${esc(c.reciclaje_off.replace('en:', ''))}</span>` : ''}`;
  });
  const sug = claseSugerida(r);
  $('#clase-sug').innerHTML = `<span class="clase clase-${sug}">${sug}</span>`;
  const m = masaPlastico(r);
  $('#masa').textContent = m == null
    ? `Classe finale ${claseFinal(r)} : aucun gramme de plastique attribué.`
    : `Classe finale ${claseFinal(r)} : ${g1(m)} g de plastique par unité de vente.`;
}

// 'change' couvre les navigateurs qui n'émettent pas 'input' sur select/checkbox ; mettre à jour deux fois est sans effet.
['input', 'change'].forEach((ev) => $('#editor').addEventListener(ev, alEditar));
function alEditar(e) {
  const t = e.target;
  if (!actual) return;
  if (t.dataset.k) {
    actual[t.dataset.k] = t.type === 'checkbox' ? t.checked : t.value;
  } else if (t.dataset.c) {
    const i = Number(t.closest('.comp').dataset.i);
    const comp = actual.componentes[i];
    comp[t.dataset.c] = ['unidades', 'peso_g'].includes(t.dataset.c) ? num(t.value) : t.value;
    // Un poids saisi à la main sans source est considéré comme pesé par l'équipe.
    if (t.dataset.c === 'peso_g' && comp.peso_g != null && !comp.peso_fuente) {
      comp.peso_fuente = 'medido_resser';
      t.closest('.comp').querySelector('[data-c="peso_fuente"]').value = 'medido_resser';
    }
    if (comp.origen === 'off') comp.origen = 'off_corregido';
  }
  refrescarDerivados();
}

$('#editor').addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t || !actual) return;
  if (t.id === 'add-comp') {
    actual.componentes.push({ forma: '', material: '', unidades: 1, peso_g: null, peso_fuente: '', reciclaje_off: '', origen: 'manual' });
    pintarEditor();
  } else if (t.dataset.del != null) {
    actual.componentes.splice(Number(t.dataset.del), 1);
    pintarEditor();
  } else if (t.id === 'guardar') {
    actual.actualizado = ahora();
    actual.version_app = APP_VERSION;
    db.refs[actual.gtin] = actual;
    guardar();
    contar();
    toast(`Enregistré · classe ${claseFinal(actual)}`);
    actual = null;
    pintarEditor();
    $('#gtin').value = '';
    estado(`${Object.keys(db.refs).length} référence(s) dans l'inventaire.`);
  } else if (t.id === 'reconsultar') {
    buscar(actual.gtin, { reconsultar: true });
  } else if (t.id === 'descartar') {
    actual = null;
    pintarEditor();
    estado('');
  }
});

// ---------- Inventaire ----------

function contar() { $('#count').textContent = Object.keys(db.refs).length; }

$('#filtro').addEventListener('input', pintarLista);
function pintarLista() {
  const q = $('#filtro').value.trim().toLowerCase();
  const refs = Object.values(db.refs)
    .filter((r) => !q || `${r.nombre} ${r.marca} ${r.gtin}`.toLowerCase().includes(q))
    .sort((a, b) => b.actualizado.localeCompare(a.actualizado));
  $('#lista').innerHTML = refs.length
    ? refs.map((r) => {
      const k = claseFinal(r);
      return `<li data-gtin="${esc(r.gtin)}">
        <span class="clase clase-${k}">${k}</span>
        <div class="info"><strong>${esc(r.nombre || 'Sans nom')}</strong>
          <span>${esc(r.marca)} · ${esc(labelDe(CATEGORIAS, r.categoria))} · ${r.componentes.length} comp.${r.verificado ? ' · vérifié' : ''}</span></div>
      </li>`;
    }).join('')
    : '<li class="vacio" style="cursor:default;display:block">Aucune référence pour l’instant. Scannez le premier produit.</li>';
}

$('#lista').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-gtin]');
  if (!li) return;
  mostrarTab('escanear');
  $('#gtin').value = li.dataset.gtin;
  abrirEditor(structuredClone(db.refs[li.dataset.gtin]));
});

$('#borrar-todo').addEventListener('click', () => {
  const n = Object.keys(db.refs).length;
  if (!n) return;
  if (!confirm(`Effacer les ${n} références de ce navigateur ? Exportez d'abord une sauvegarde JSON si nécessaire.`)) return;
  db.refs = {};
  guardar();
  contar();
  pintarLista();
});

// ---------- Export (séparateur ';' et BOM pour Excel en français) ----------

function csv(filas) {
  const celda = (v) => {
    const s = v == null ? '' : String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + filas.map((f) => f.map(celda).join(';')).join('\r\n');
}
const fecha = () => new Date().toISOString().slice(0, 10);
const decimal = (n) => (n == null ? '' : String(Math.round(n * 10) / 10).replace('.', ','));

$('#exp-ref').addEventListener('click', () => {
  const filas = [[
    'gtin', 'categorie', 'nom', 'marque', 'quantite', 'statut_off', 'off_emballages_complets', 'nb_composants_off',
    'nb_composants', 'materiaux', 'formes', 'masse_plastique_g', 'classe_suggeree', 'classe_finale', 'verifie',
    'donnees_off', 'cause', 'observations', 'requete_off', 'mis_a_jour',
  ]];
  for (const r of Object.values(db.refs)) {
    filas.push([
      r.gtin, labelDe(CATEGORIAS, r.categoria), r.nombre, r.marca, r.cantidad, ESTADOS_OFF[r.off.estado] || r.off.estado,
      r.off.packagings_complete == null ? '' : (r.off.packagings_complete ? 'oui' : 'non'), r.off.packagings.length,
      r.componentes.length, r.componentes.map((c) => labelMaterial(c.material)).join(' + '),
      r.componentes.map((c) => labelForma(c.forma)).join(' + '), decimal(masaPlastico(r)), claseSugerida(r), claseFinal(r),
      r.verificado ? 'oui' : 'non', r.exactitud_off ? labelDe(EXACTITUD, r.exactitud_off) : '',
      r.causa ? labelDe(CAUSAS, r.causa) : '', r.obs, r.off.consultado, r.actualizado,
    ]);
  }
  descargar(`resser_testA_references_${fecha()}.csv`, csv(filas), 'text/csv;charset=utf-8');
});

$('#exp-comp').addEventListener('click', () => {
  const filas = [['gtin', 'nom', 'composant', 'forme', 'materiau', 'famille', 'unites', 'poids_g', 'source_poids', 'consigne_tri', 'recyclage_off', 'origine']];
  const origenes = { off: 'OFF', off_corregido: 'OFF corrigé', manual: 'Saisie manuelle' };
  for (const r of Object.values(db.refs)) {
    r.componentes.forEach((c, i) => {
      const fam = familiaDe(c.material);
      filas.push([r.gtin, r.nombre, i + 1, labelForma(c.forma), labelMaterial(c.material), FAMILIAS[fam].label,
        c.unidades, decimal(num(c.peso_g)), c.peso_fuente ? labelDe(PESO_FUENTES, c.peso_fuente) : '',
        consignaTri(fam).label, c.reciclaje_off, origenes[c.origen] || c.origen]);
    });
  }
  descargar(`resser_testA_composants_${fecha()}.csv`, csv(filas), 'text/csv;charset=utf-8');
});

$('#exp-json').addEventListener('click', () => {
  const datos = { app: 'resser-testA', version: APP_VERSION, exportado: ahora(), refs: db.refs };
  descargar(`resser_testA_sauvegarde_${fecha()}.json`, JSON.stringify(datos, null, 2), 'application/json');
});

// L'import fusionne par GTIN : la version mise à jour le plus récemment l'emporte.
$('#imp-json').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const datos = JSON.parse(await f.text());
    if (!datos.refs || typeof datos.refs !== 'object') throw new Error();
    let nuevas = 0, actualizadas = 0;
    for (const [gtin, r] of Object.entries(datos.refs)) {
      if (!r?.gtin || !Array.isArray(r.componentes) || !r.off) continue;
      const previa = db.refs[gtin];
      if (!previa) { db.refs[gtin] = r; nuevas++; }
      else if ((r.actualizado || '') > (previa.actualizado || '')) { db.refs[gtin] = r; actualizadas++; }
    }
    guardar();
    contar();
    pintarLista();
    toast(`Import : ${nuevas} nouvelle(s), ${actualizadas} mise(s) à jour.`);
  } catch {
    toast("Ce fichier n'est pas une sauvegarde valide du Test A.");
  }
});

// ---------- Synthèse des indicateurs ----------

function indicadores(refs) {
  const n = refs.length;
  const clases = { A: 0, B: 0, C: 0, D: 0 };
  refs.forEach((r) => clases[claseFinal(r)]++);
  const encontrados = refs.filter((r) => r.off.estado === 'encontrado').length;
  return {
    n, clases, encontrados,
    material: clases.A + clases.B + clases.C,
    masa: clases.A + clases.B,
    verificados: refs.filter((r) => r.verificado).length,
  };
}

function kpi(titulo, a, b, meta) {
  const p = pct(a, b);
  const ok = b && a / b >= meta;
  return `<div class="kpi"><div class="l">${esc(titulo)}</div><div class="v">${b ? p + ' %' : '—'}</div>
    <div class="n">${a} / ${b} références${meta != null ? ` · objectif ≥ ${Math.round(meta * 100)} % <span class="badge ${ok ? 'good' : 'warn'}">${ok ? 'atteint' : 'non atteint'}</span>` : ''}</div></div>`;
}

function pintarResumen() {
  const refs = Object.values(db.refs);
  const el = $('#tab-resumen');
  if (!refs.length) { el.innerHTML = '<div class="card vacio">Pas encore de données. Enregistrez des références dans « Scanner ».</div>'; return; }
  const I = indicadores(refs);

  const evaluadas = refs.filter((r) => ['correcto', 'parcial', 'incorrecto'].includes(r.exactitud_off));
  const correctas = evaluadas.filter((r) => r.exactitud_off === 'correcto').length;

  const unidadesFam = {};
  const consignas = {};
  refs.forEach((r) => r.componentes.forEach((c) => {
    const fam = familiaDe(c.material);
    const u = num(c.unidades) ?? 1;
    unidadesFam[fam] = (unidadesFam[fam] || 0) + u;
    const t = consignaTri(fam).label;
    consignas[t] = (consignas[t] || 0) + u;
  }));
  const totalU = Object.values(unidadesFam).reduce((s, v) => s + v, 0);

  const masas = refs.map(masaPlastico).filter((m) => m != null);
  const media = masas.length ? masas.reduce((s, v) => s + v, 0) / masas.length : null;

  const colores = { A: '#2c7a4b', B: '#5d9c3a', C: '#c98a1c', D: '#b3362b' };
  const barraClases = ['A', 'B', 'C', 'D'].filter((k) => I.clases[k])
    .map((k) => `<div style="flex:${I.clases[k]};background:${colores[k]}" title="${k} : ${I.clases[k]}">${k} ${I.clases[k]}</div>`).join('');

  const filasCat = CATEGORIAS.map((c) => {
    const sub = indicadores(refs.filter((r) => r.categoria === c.id));
    return `<tr><td>${esc(c.label)}</td><td class="num">${sub.n}</td><td class="num">${sub.n ? pct(sub.encontrados, sub.n) + ' %' : '—'}</td>
      <td class="num">${sub.n ? pct(sub.material, sub.n) + ' %' : '—'}</td><td class="num">${sub.n ? pct(sub.masa, sub.n) + ' %' : '—'}</td></tr>`;
  }).join('');

  const filasFam = Object.entries(unidadesFam).sort((a, b) => b[1] - a[1])
    .map(([f, u]) => `<tr><td><span class="dot" style="background:${FAMILIAS[f].color}"></span>${esc(FAMILIAS[f].label)}</td><td class="num">${u}</td><td class="num">${pct(u, totalU)} %</td></tr>`).join('');
  const filasTri = Object.entries(consignas).sort((a, b) => b[1] - a[1])
    .map(([t, u]) => `<tr><td>${esc(t)}</td><td class="num">${u}</td><td class="num">${pct(u, totalU)} %</td></tr>`).join('');

  el.innerHTML = `
    ${I.n < 10 ? `<div class="card note">Seulement ${I.n} référence(s) : les pourcentages sont encore très instables. Le premier jalon du plan est de 10 produits.</div>` : ''}
    <div class="kpis">
      ${kpi('Couverture produit', I.encontrados, I.n, METAS.producto)}
      ${kpi('Couverture matériau (classes A–C)', I.material, I.n, METAS.material)}
      ${kpi('Couverture masse (classes A–B)', I.masa, I.n, METAS.masa)}
      ${kpi('Données OFF correctes (réf. évaluées)', correctas, evaluadas.length, null)}
    </div>

    <div class="card" style="margin-top:14px">
      <h3>Classes de qualité</h3>
      <div class="bar">${barraClases}</div>
      <p class="note">${I.verificados} référence(s) sur ${I.n} vérifiée(s) physiquement.</p>
      <p class="note">${media == null ? 'Aucune référence avec une masse plastique quantifiée pour l’instant.' : `Masse plastique moyenne (classes A–B, n = ${masas.length}) : ${g1(media)} g par unité de vente.`}</p>
    </div>

    <div class="card">
      <h3>Par catégorie</h3>
      <div class="tabla"><table>
        <thead><tr><th>Catégorie</th><th class="num">n</th><th class="num">Produit</th><th class="num">Matériau</th><th class="num">Masse</th></tr></thead>
        <tbody>${filasCat}</tbody>
      </table></div>
    </div>

    <div class="card">
      <h3>Composants par matériau</h3>
      <p class="note">Unités de composant cumulées sur une unité de vente de chaque référence (n = ${totalU}).</p>
      <div class="tabla"><table><thead><tr><th>Famille</th><th class="num">Unités</th><th class="num">%</th></tr></thead><tbody>${filasFam}</tbody></table></div>
    </div>

    <div class="card">
      <h3>Destination selon la consigne de tri</h3>
      <div class="tabla"><table><thead><tr><th>Contenant</th><th class="num">Unités</th><th class="num">%</th></tr></thead><tbody>${filasTri}</tbody></table></div>
      <p class="note">${esc(FUENTE_TRI)}</p>
    </div>`;
}

// ---------- Démarrage ----------

contar();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
