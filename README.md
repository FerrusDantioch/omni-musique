# Omni-Musique

Le lecteur audio de l'Omni-système : musique, podcasts et livres audio, sur
téléphone et ordinateur. Les fichiers restent sur l'appareil et s'écoutent
même sans Internet.

**Ouvrir l'application :** https://ferrusdantioch.github.io/omni-musique/

---

## Ce que fait l'application

- **Ajouter ses fichiers** : bouton « Ajouter », fichiers ou dossier entier
  (dossier entier : sur ordinateur et sur certains téléphones Android, pas
  sur iPhone ni iPad). Sur ordinateur, on peut aussi
  glisser-déposer les fichiers sur la page. Formats : MP3, M4A, M4B, AAC,
  OGG, Opus, FLAC, WAV et WebM, selon ce que le navigateur sait lire.
- **Trois rubriques** : Musique (par morceaux, albums ou artistes),
  Podcasts (par émission) et Livres audio (par livre). Le titre, l'artiste,
  l'album et la pochette sont lus dans les fichiers.
- **Rangement automatique** : un fichier M4B ou marqué « livre audio » va
  dans Livres audio, un fichier marqué « podcast » va dans Podcasts.
  Ajouté depuis l'onglet Podcasts ou Livres audio, il y est rangé d'office.
  Le menu ⋮ d'une piste permet de la changer de rubrique.
- **Le lecteur** : lecture et pause, piste précédente et suivante, barre
  d'avancement, volume, file d'attente, lecture aléatoire et répétition.
- **Podcasts et livres audio** : reprise là où on s'était arrêté, vitesse de
  0,5× à 3×, recul de 15 secondes et avance de 30 secondes, signets avec
  note, épisodes et chapitres marqués « écouté ».
- **Minuterie de sommeil** : arrêt au bout de 5 à 90 minutes, ou à la fin de
  la piste, avec un son qui baisse doucement.
- **Écran verrouillé et casque** : titre, pochette et boutons de lecture
  s'affichent sur l'écran verrouillé et répondent aux boutons du casque.
- **Listes de lecture** : créer, renommer, supprimer, ajouter et ordonner
  des pistes.
- **Trois thèmes** : Nuit (par défaut), Sombre et Clair.

Pas d'abonnement aux podcasts en ligne : l'application fonctionne
entièrement hors ligne.

## Les fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Toute l'application : textes, mise en page et code |
| `service-worker.js` | Garde l'application en mémoire pour qu'elle marche sans Internet |
| `manifest.webmanifest` | Nom et icônes pour installer l'application sur l'écran d'accueil |
| `icons/` | Les icônes de l'application |
| `LICENSE` | La licence du code |

Les fichiers audio ne sont jamais envoyés sur Internet : ils sont rangés dans
la base de données du navigateur (IndexedDB), sur l'appareil. Effacer les
données du site dans le navigateur efface aussi la bibliothèque : gardez vos
fichiers d'origine.

## Publication et mises à jour

L'application est publiée par GitHub Pages depuis la branche `main`, dossier
racine.

À chaque nouvelle version, changez **les deux** numéros de version, avec la
même valeur :

- `CACHE_NAME` dans `service-worker.js` (exemple : `omni-musique-v1.0.1`) ;
- `APP_VERSION` dans `index.html` (exemple : `1.0.1`).

L'application affiche alors « Nouvelle version disponible » ; la mise à jour
se fait d'un appui sur « Mettre à jour », sans couper l'écoute avant cet
appui.

## Droits et licence

**Code : © 2026 Ferrus Dantioch — Creative Commons BY-NC-ND 4.0**
([résumé de la licence en français](https://creativecommons.org/licenses/by-nc-nd/4.0/deed.fr)).
En clair : le partage est autorisé, à l'identique et en citant l'auteur ;
l'usage commercial est interdit ; la modification et les œuvres dérivées sont
interdites. Le logiciel est fourni « en l'état », sans aucune garantie.
Texte complet dans le fichier [LICENSE](LICENSE).
