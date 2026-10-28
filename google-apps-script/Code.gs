/**
 * Resser · Test A — réception des données de l'application dans Google Sheets.
 *
 * Installation (une seule fois) :
 *  1. Créer un projet Apps Script, coller ce fichier, remplacer ID_FEUILLE par l'identifiant
 *     de la feuille (la partie de l'URL entre /d/ et /edit), enregistrer.
 *  2. Exécuter la fonction « configurer » et autoriser l'accès : crée les onglets
 *     Références, Composants, Synthèse et Dictionnaire, et écrit la clé de l'application
 *     dans le journal d'exécution.
 *  3. Déployer > Nouveau déploiement > Application Web :
 *     « Exécuter en tant que : moi », « Accès : tout le monde ». Copier l'URL /exec.
 *  4. Dans l'app (Inventaire > Synchronisation) : coller l'URL et la clé.
 *
 * Les onglets existants (« Hoja 1 ») ne sont jamais modifiés.
 */

const ID_FEUILLE = 'COLLER_ICI_L_ID_DE_LA_FEUILLE';
const classeur_ = () => SpreadsheetApp.openById(ID_FEUILLE);

const ONGLETS = { ref: 'Références', comp: 'Composants', syn: 'Synthèse', dic: 'Dictionnaire' };

// Ordre des colonnes ; l'application envoie des objets avec ces mêmes noms.
const COL_REF = [
  'mis_a_jour', 'saisi_par', 'gtin', 'libelle_ticket', 'nom', 'marque', 'quantite', 'rayon',
  'enseigne', 'commune', 'date_achat', 'sans_emballage', 'base_produits', 'statut_off',
  'off_emballages_complets', 'nb_composants', 'materiaux', 'formes', 'masse_plastique_g',
  'classe_suggeree', 'classe_finale', 'verifie', 'donnees_off', 'cause', 'observations', 'version_app',
];
const COL_COMP = [
  'mis_a_jour', 'saisi_par', 'gtin', 'nom', 'rayon', 'composant', 'forme', 'materiau', 'famille',
  'unites', 'poids_g', 'source_poids', 'consigne_tri', 'recyclage_off', 'origine',
];

function cle_() {
  const props = PropertiesService.getScriptProperties();
  let cle = props.getProperty('CLE');
  if (!cle) {
    cle = Utilities.getUuid().slice(0, 8);
    props.setProperty('CLE', cle);
  }
  return cle;
}

// À exécuter depuis l'éditeur pour retrouver la clé (journal d'exécution).
function afficherCle() {
  Logger.log(`Clé à saisir dans l'application : ${cle_()}`);
}

const lettre_ = (cols, nom) => {
  let n = cols.indexOf(nom) + 1, s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

function onglet_(ss, nom, entetes) {
  let sh = ss.getSheetByName(nom);
  if (!sh) sh = ss.insertSheet(nom);
  if (entetes) {
    sh.getRange(1, 1, 1, entetes.length).setValues([entetes]).setFontWeight('bold').setBackground('#e6f1ee');
    sh.setFrozenRows(1);
    sh.getRange(2, entetes.indexOf('gtin') + 1, sh.getMaxRows() - 1, 1).setNumberFormat('@');
  }
  return sh;
}

function configurer() {
  const ss = classeur_();
  onglet_(ss, ONGLETS.ref, COL_REF);
  onglet_(ss, ONGLETS.comp, COL_COMP);
  synthese_(onglet_(ss, ONGLETS.syn));
  dictionnaire_(onglet_(ss, ONGLETS.dic));
  Logger.log(`Clé de l'application : ${cle_()}`);
}

function synthese_(sh) {
  sh.clear();
  const R = `'${ONGLETS.ref}'!`, C = `'${ONGLETS.comp}'!`;
  const col = (n) => `${R}${lettre_(COL_REF, n)}2:${lettre_(COL_REF, n)}`;
  const classe = col('classe_finale');
  const lignes = [
    ['Synthèse du Test A', '', 'Objectif', 'Statut'],
    ['Références enregistrées', `=COUNTA(${col('gtin')})`, '', ''],
    ['Trouvées dans une base Open Facts', `=COUNTIF(${col('statut_off')},"Trouvé*")`, '', ''],
    ['Couverture produit', '=IFERROR(B3/B2,0)', 0.85, '=IF(B2=0,"",IF(B4>=C4,"atteint","non atteint"))'],
    ['Classes A–C (matériau identifié)', `=COUNTIF(${classe},"A")+COUNTIF(${classe},"B")+COUNTIF(${classe},"C")`, '', ''],
    ['Couverture matériau', '=IFERROR(B5/B2,0)', 0.70, '=IF(B2=0,"",IF(B6>=C6,"atteint","non atteint"))'],
    ['Classes A–B (masse disponible)', `=COUNTIF(${classe},"A")+COUNTIF(${classe},"B")`, '', ''],
    ['Couverture masse', '=IFERROR(B7/B2,0)', 0.50, '=IF(B2=0,"",IF(B8>=C8,"atteint","non atteint"))'],
    ['Vérifiées physiquement', `=COUNTIF(${col('verifie')},"oui")`, '', ''],
    ['Masse plastique moyenne, classes A–B (g)', `=IFERROR(AVERAGE(${col('masse_plastique_g')}),"")`, '', ''],
    ['Produits sans emballage (vrac)', `=COUNTIF(${col('sans_emballage')},"oui")`, '', ''],
  ];
  sh.getRange(1, 1, lignes.length, 4).setValues(lignes);
  sh.getRange('A1:D1').setFontWeight('bold').setBackground('#e6f1ee');
  ['B4', 'B6', 'B8', 'C4', 'C6', 'C8'].forEach((a) => sh.getRange(a).setNumberFormat('0%'));
  sh.getRange('B10').setNumberFormat('0.0');

  const L = (n) => lettre_(COL_REF, n);
  sh.getRange('F1').setValue('Par rayon').setFontWeight('bold');
  sh.getRange('F2').setFormula(
    `=IFERROR(QUERY(${R}A1:${lettre_(COL_REF, COL_REF[COL_REF.length - 1])},` +
    `"select ${L('rayon')}, count(${L('gtin')}) where ${L('gtin')} is not null group by ${L('rayon')} ` +
    `label ${L('rayon')} 'Rayon', count(${L('gtin')}) 'Références'",1),"")`);
  sh.getRange('F20').setValue('Par classe').setFontWeight('bold');
  sh.getRange('F21').setFormula(
    `=IFERROR(QUERY(${R}A1:${lettre_(COL_REF, COL_REF[COL_REF.length - 1])},` +
    `"select ${L('classe_finale')}, count(${L('gtin')}) where ${L('gtin')} is not null group by ${L('classe_finale')} ` +
    `label ${L('classe_finale')} 'Classe', count(${L('gtin')}) 'Références'",1),"")`);

  const K = (n) => lettre_(COL_COMP, n);
  sh.getRange('I1').setValue('Unités de composant par famille de matériau').setFontWeight('bold');
  sh.getRange('I2').setFormula(
    `=IFERROR(QUERY(${C}A1:${lettre_(COL_COMP, COL_COMP[COL_COMP.length - 1])},` +
    `"select ${K('famille')}, sum(${K('unites')}) where ${K('gtin')} is not null group by ${K('famille')} ` +
    `order by sum(${K('unites')}) desc label ${K('famille')} 'Famille', sum(${K('unites')}) 'Unités'",1),"")`);
  sh.getRange('I20').setValue('Unités par consigne de tri').setFontWeight('bold');
  sh.getRange('I21').setFormula(
    `=IFERROR(QUERY(${C}A1:${lettre_(COL_COMP, COL_COMP[COL_COMP.length - 1])},` +
    `"select ${K('consigne_tri')}, sum(${K('unites')}) where ${K('gtin')} is not null group by ${K('consigne_tri')} ` +
    `label ${K('consigne_tri')} 'Consigne', sum(${K('unites')}) 'Unités'",1),"")`);
  sh.setColumnWidth(1, 300);
}

function dictionnaire_(sh) {
  sh.clear();
  const d = [
    ['Onglet', 'Colonne', 'Description'],
    ['Références', 'mis_a_jour', "Date et heure du dernier enregistrement dans l'application"],
    ['Références', 'saisi_par', 'Personne qui a saisi la référence (réglage de l’app)'],
    ['Références', 'gtin', 'Code-barres (EAN-13/8). « SC-… » = produit sans code-barres (vrac, fruits et légumes)'],
    ['Références', 'libelle_ticket', 'Libellé tel qu’imprimé sur le ticket de caisse (utile pour le Test B : ticket → produit)'],
    ['Références', 'nom / marque / quantite', 'Identification du produit (Open Facts ou saisie manuelle)'],
    ['Références', 'rayon', 'Rayon du magasin (liste ci-dessous)'],
    ['Références', 'enseigne / commune / date_achat', "Contexte d'achat, mémorisé dans l'app entre deux scans"],
    ['Références', 'sans_emballage', 'oui = produit vendu sans emballage (vrac) : 0 composant, ce n’est pas une donnée manquante'],
    ['Références', 'base_produits', 'Base où le produit a été trouvé : Open Food / Beauty / Products Facts'],
    ['Références', 'statut_off', 'Trouvé, Introuvable ou Sans code-barres'],
    ['Références', 'off_emballages_complets', 'La base marque-t-elle la description des emballages comme complète ?'],
    ['Références', 'materiaux / formes', 'Liste des composants, séparés par « + »'],
    ['Références', 'masse_plastique_g', 'Σ unités × poids des composants plastiques, par unité de vente. Vide si classe C ou D'],
    ['Références', 'classe_suggeree / classe_finale', 'A : masse mesurée ou déclarée et vérifiée · B : masse estimée ou non vérifiée · C : forme et matériau sans poids · D : non caractérisable'],
    ['Références', 'verifie', 'Emballages contrôlés sur le produit physique'],
    ['Références', 'donnees_off', 'Les emballages décrits par la base étaient-ils corrects ?'],
    ['Références', 'cause', "Raison principale d'une donnée manquante ou erronée"],
    ['Composants', 'composant', "Numéro du composant dans l'emballage (bouteille, bouchon, étiquette…)"],
    ['Composants', 'forme / materiau / famille', 'Taxonomie Open Food Facts, regroupée en familles (plastique, verre, papier/carton, métal, composite…)'],
    ['Composants', 'unites / poids_g', 'Nombre de ce composant par unité de vente ; poids d’une unité en grammes'],
    ['Composants', 'source_poids', 'Pesé par nous, déclaré par le fabricant, Open Facts (mesuré/spécifié/estimé) ou estimé par nous'],
    ['Composants', 'consigne_tri', 'Règle nationale générale (extension des consignes de tri, 2023) — à vérifier avec le Guide du tri du Grand Nancy'],
    ['Composants', 'origine', 'OFF, OFF corrigé ou saisie manuelle'],
    ['', '', ''],
    ['Liste', 'Rayons', 'Crèmerie · Fromagerie · Charcuterie / traiteur · Boucherie / poissonnerie · Fruits et légumes · Boulangerie / viennoiserie · Épicerie salée · Épicerie sucrée · Boissons · Surgelés · Hygiène / beauté · Entretien / maison · Animaux · Autre'],
  ];
  sh.getRange(1, 1, d.length, 3).setValues(d);
  sh.getRange('A1:C1').setFontWeight('bold').setBackground('#e6f1ee');
  sh.setFrozenRows(1);
  sh.setColumnWidth(2, 260);
  sh.setColumnWidth(3, 700);
  sh.getRange(1, 3, d.length, 1).setWrap(true);
}

const json_ = (o) => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);

// Test de connexion depuis l'application : ?cle=XXXX
function doGet(e) {
  const ok = e && e.parameter && e.parameter.cle === cle_();
  return json_(ok ? { ok: true, feuille: classeur_().getName() } : { ok: false, erreur: 'Clé invalide' });
}

// Corps attendu : { cle, refs: [ { ref: {colonne: valeur…}, composants: [ {colonne: valeur…} ] } ] }
// Une référence déjà présente (même gtin) est remplacée, ainsi que tous ses composants.
function doPost(e) {
  const verrou = LockService.getScriptLock();
  verrou.waitLock(20000);
  try {
    const corps = JSON.parse(e.postData.contents);
    if (corps.cle !== cle_()) return json_({ ok: false, erreur: 'Clé invalide' });
    const lots = (corps.refs || []).filter((x) => x && x.ref && x.ref.gtin);
    if (!lots.length) return json_({ ok: true, n: 0 });
    const ss = classeur_();
    const shR = onglet_(ss, ONGLETS.ref, COL_REF);
    const shC = onglet_(ss, ONGLETS.comp, COL_COMP);
    const ligneR = (o) => COL_REF.map((c) => (o[c] == null ? '' : o[c]));
    const ligneC = (o) => COL_COMP.map((c) => (o[c] == null ? '' : o[c]));

    // Références : mise à jour sur place ou ajout.
    const iG = COL_REF.indexOf('gtin');
    const nR = shR.getLastRow() - 1;
    const gtins = nR > 0 ? shR.getRange(2, iG + 1, nR, 1).getValues().map((r) => String(r[0])) : [];
    const nouvelles = [];
    lots.forEach((x) => {
      const i = gtins.indexOf(String(x.ref.gtin));
      if (i >= 0) shR.getRange(i + 2, 1, 1, COL_REF.length).setValues([ligneR(x.ref)]);
      else nouvelles.push(ligneR(x.ref));
    });
    if (nouvelles.length) shR.getRange(shR.getLastRow() + 1, 1, nouvelles.length, COL_REF.length).setValues(nouvelles);

    // Composants : on retire ceux des références reçues, puis on ajoute les nouveaux.
    const recus = new Set(lots.map((x) => String(x.ref.gtin)));
    const jG = COL_COMP.indexOf('gtin');
    const nC = shC.getLastRow() - 1;
    const gardes = nC > 0
      ? shC.getRange(2, 1, nC, COL_COMP.length).getValues().filter((r) => !recus.has(String(r[jG])))
      : [];
    const ajout = [];
    lots.forEach((x) => (x.composants || []).forEach((c) => ajout.push(ligneC(c))));
    const toutes = gardes.concat(ajout);
    if (nC > 0) shC.getRange(2, 1, nC, COL_COMP.length).clearContent();
    if (toutes.length) shC.getRange(2, 1, toutes.length, COL_COMP.length).setValues(toutes);

    return json_({ ok: true, n: lots.length });
  } catch (err) {
    return json_({ ok: false, erreur: String(err) });
  } finally {
    verrou.releaseLock();
  }
}
