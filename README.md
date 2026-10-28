# Resser · Test A (emballages)

PWA de test pour l'étude de faisabilité sur la Métropole du Grand Nancy : scanner le code-barres d'un produit, récupérer ses emballages depuis Open Food Facts (API v3), les vérifier sur le produit physique, les classer en A/B/C/D et exporter le tableau de référence.

## Lancer sur le PC

```bash
python -m http.server 8642 --bind 127.0.0.1
```

Depuis ce dossier, puis ouvrir http://localhost:8642. Sur le PC, le code peut être saisi à la main ; la caméra fonctionne sur `localhost` ou en HTTPS.

## Utiliser sur le téléphone

La caméra du navigateur exige HTTPS. Options : publier le dossier sur GitHub Pages / Netlify (site statique, sans backend) ou un tunnel HTTPS temporaire vers le PC.

## Fichiers

| Fichier | Contenu |
|---|---|
| `index.html`, `styles.css` | Interface (trois onglets : Scanner, Inventaire, Synthèse) |
| `app.js` | Requêtes OFF, éditeur, règles de classe, indicateurs, export |
| `reglas.js` | Vocabulaires (matériaux, formes, sources de poids) et consignes de tri |
| `sw.js`, `manifest.webmanifest`, `icon.svg` | Installation comme application et usage hors connexion |

## Règles de qualité (plan, section 06)

- **D** : aucun composant, ou un composant sans matériau.
- **C** : matériau identifié, mais poids manquant pour un composant plastique (ou pour tous, s'il n'y a pas de plastique).
- **B** : poids complets, mais l'un est estimé ou la référence n'est pas vérifiée physiquement.
- **A** : poids mesurés/déclarés et référence vérifiée.

La masse plastique (Σ unités × poids des composants plastiques) n'est renseignée qu'en A et B. La classe suggérée peut être corrigée à la main.

## Feuille partagée (Google Sheets)

`google-apps-script/Code.gs` reçoit les références de tous les téléphones dans une même feuille (onglets Références, Composants, Synthèse, Dictionnaire) et renvoie la fiche d'un produit déjà caractérisé, que l'app affiche pré-remplie. Installation : voir l'en-tête du fichier. L'URL du script est intégrée à l'app ; chaque personne saisit seulement son nom et la clé de l'équipe dans « Contexte d'achat ». La clé n'est pas dans ce dépôt.

Chaque fiche enregistrée après un scan ajoute un achat au « Journal des achats » (une ligne par composant) ; une correction depuis l'inventaire n'en ajoute pas. L'onglet « Tableau de bord » en tire les chiffres clés et les graphiques sur 7 / 30 / 365 jours, par semaine, mois et année (`?cle=…&accion=configurer` le reconstruit).

Recherche d'un code scanné : téléphone → feuille de l'équipe → bases Open Facts → création (avec photo réduite, gardée dans l'onglet masqué « Photos »).

## Données

Elles sont enregistrées dans le navigateur (`localStorage`) de l'appareil. Exporter régulièrement des sauvegardes JSON ; « Importer JSON » fusionne par GTIN (la version la plus récente l'emporte), ce qui permet de réunir le travail de plusieurs personnes.

Exports CSV avec `;` et BOM UTF-8 pour Excel en français :
- `references` : une ligne par produit (classe, couverture, masse, cause).
- `composants` : une ligne par composant (forme, matériau, poids et source, consigne).

## À faire

- Comparer `consignaTri()` avec le Guide du tri du Grand Nancy (aujourd'hui : règle nationale générale).
- Données OFF sous licence ODbL : vérifier les conditions avant toute rediffusion.
- OCR des tickets (Test B) hors de cette version, en attente du protocole RGPD.
