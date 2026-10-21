# Carte Linky Solaire

Carte Lovelace pour Home Assistant qui montre, **jour par jour**, l'énergie **produite** par vos panneaux, **importée** du réseau et **exportée** vers le réseau, avec l'**autoconsommation** et l'**autonomie** calculées. Pas besoin d'ouvrir le tableau de bord Énergie.

Elle a le même style que la [Carte Enedis Linky New](https://github.com/Marlboro62/content-card-linky-new), mais elle est **indépendante** : elle s'installe à part, avec son propre type `custom:linky-solaire-card`, et ne remplace aucune autre carte.

🎮 **[Essayer la démo en ligne](https://marlboro62.github.io/linky-solaire-card/docs/demo.html)** : la vraie carte avec des données simulées, sans installer Home Assistant.

| Style MyElectricalData (sombre) | Clair |
| --- | --- |
| ![Aperçu sombre](images/apercu-sombre.png) | ![Aperçu clair](images/apercu-clair.png) |

*Aperçus réalisés avec des données fictives.*

## Ce que la carte affiche

- **Trois tuiles** : total produit, importé et exporté sur la période, avec la valeur d'aujourd'hui. Un clic ouvre le capteur.
- **Autoconsommé** : produit − exporté, et la part de la production consommée sur place.
- **Autonomie** : part de vos besoins couverte par le solaire, autoconsommé ÷ (autoconsommé + importé).
- **Graphique en barres** : les trois valeurs pour chaque jour, aujourd'hui compris (journée en cours).
- **Tableau jour par jour**, du plus récent au plus ancien (désactivable).

Chaque série est facultative : avec seulement un capteur de production, la carte affiche la production seule. L'autoconsommation demande la production et l'export, l'autonomie demande les trois.

## Installation

### Avec HACS (recommandé)

1. Dans HACS, menu **⋮** → **Dépôts personnalisés**.
2. Ajoutez `https://github.com/Marlboro62/linky-solaire-card` avec le type **Tableau de bord** (Dashboard).
3. Cherchez **Carte Linky Solaire**, installez-la, puis rechargez la page (Ctrl+F5).

> Tant qu'il n'existe qu'une version bêta, activez **Afficher les versions bêta** dans la fenêtre de téléchargement de HACS.

### Manuellement

1. Téléchargez `linky-solaire-card.js` depuis les [releases](https://github.com/Marlboro62/linky-solaire-card/releases) et copiez-le dans `/config/www/`.
2. **Paramètres → Tableaux de bord → ⋮ → Ressources → Ajouter une ressource** :
   - URL : `/local/linky-solaire-card.js`
   - Type : **Module JavaScript**
3. Rechargez la page (Ctrl+F5).

## Capteurs nécessaires

La carte lit les **statistiques longue durée** de Home Assistant, les mêmes que le tableau de bord Énergie. Elle fonctionne donc avec **n'importe quel compteur d'énergie** : onduleur, prise ou pince de mesure, module TIC (Lixee, etc.), capteurs Linky, capteurs template ou `utility_meter`.

Chaque capteur doit :

- être en **kWh** ou en **Wh** (`device_class: energy`) ;
- avoir un `state_class` **`total_increasing`** ou **`total`** : sans lui, Home Assistant n'enregistre pas de statistiques.

Un compteur qui se remet à zéro chaque jour convient aussi s'il est en `total_increasing`. Pour vérifier un capteur : **Outils de développement → Statistiques**. S'il y apparaît, la carte peut le lire.

Si un capteur n'a pas de statistiques, la carte le signale sous le tableau. Pour un capteur tout neuf, les premières valeurs arrivent après la première heure complète.

## Configuration

```yaml
type: custom:linky-solaire-card
production: sensor.onduleur_energie_produite
import: sensor.energie_importee
export: sensor.energie_exportee
days: 7
```

| Option | Rôle | Défaut |
| --- | --- | --- |
| `production` | Énergie produite par les panneaux (onduleur) | détectée si possible |
| `import` | Énergie importée du réseau (soutirée) | détectée si possible |
| `export` | Énergie exportée vers le réseau (injectée) | détectée si possible |
| `days` | Nombre de jours affichés, aujourd'hui compris (de 1 à 31) | `7` |
| `title` | Titre de la carte | `Solaire` |
| `show_table` | Afficher le tableau jour par jour | `true` |
| `theme` | `v2` (bleu nuit MyElectricalData), `auto` (clair ou sombre selon HA), `ha` (thème Home Assistant) | `v2` |

Toutes les options sont disponibles dans l'**éditeur visuel**, où l'historique se choisit entre 5, 7 et 14 jours. En YAML, toute valeur de 1 à 31 est acceptée.

Les statistiques sont relues toutes les 5 minutes, et au plus une fois par minute quand un capteur change.

> Le capteur `sensor.linky_<pdl>_production` de MyElectricalData compte ce que le Linky voit **partir sur le réseau** : c'est donc de l'énergie **exportée**, pas la production totale des panneaux.

## Support

Questions et problèmes : uniquement via les [issues GitHub](https://github.com/Marlboro62/linky-solaire-card/issues).

## Voir aussi

- [Carte Enedis Linky New](https://github.com/Marlboro62/content-card-linky-new) : consommation, production et bilan réseau Linky via MyElectricalData.
- [Carte Linky Appareils](https://github.com/Marlboro62/linky-appareils-card) : coûts par circuit et par appareil.

Si la carte vous est utile : [Buy Me a Coffee](https://buymeacoffee.com/marlboro62) · [Ko-fi](https://ko-fi.com/nothing_one)

## Licence

MIT
