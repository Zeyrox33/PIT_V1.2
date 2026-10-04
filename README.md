# Stratégie endurance karting

Appli web de stratégie pour les courses d'endurance en karting de location. Elle s'utilise depuis n'importe quel navigateur, sans compte.

- **Poste du team manager** : classement réel et net, note de chaque kart, rotation des karts dans les files, fenêtre de pit, simulations, règlement.
- **Téléphone du pilote** : dernier tour, écart avec son meilleur, position, écarts, chrono du relais, messages du stand en plein écran.
- **Radio** : messages rapides du stand vers le pilote, réponses du pilote (« Reçu », « Problème kart », « Je rentre »).
- **Chrono de la piste** : le serveur se connecte au live timing Apex Timing du circuit. Un flux de démonstration permet de tout tester sans circuit.

Aucune dépendance à installer : il suffit de **Node.js 22 ou plus récent**.

---

## 1. Lancer l'appli sur son ordinateur

1. Installez Node.js 22 (ou plus récent) depuis https://nodejs.org (version LTS).
2. Décompressez le dossier `strategie-karting`.
3. Ouvrez un terminal dans ce dossier (sous Windows : clic droit dans le dossier, puis « Ouvrir dans le terminal »).
4. Lancez :

   ```
   node server.mjs
   ```

5. Ouvrez http://localhost:3000 dans le navigateur.

Le terminal affiche aussi l'adresse à utiliser depuis un téléphone connecté au **même Wi-Fi**, par exemple `http://192.168.1.20:3000`.

### Au circuit, sans hébergement

Le PC du stand fait serveur :

1. Partagez la connexion 4G d'un téléphone (point d'accès).
2. Connectez le PC et les téléphones des pilotes à ce point d'accès.
3. Lancez `node server.mjs` sur le PC.
4. Les pilotes ouvrent l'adresse `http://…:3000` affichée dans le terminal.

Il faut une connexion internet pour lire le live timing du circuit.

> Sous Windows, autorisez Node.js dans le pare-feu quand il le demande (réseau privé), sinon les téléphones ne verront pas le serveur.

## 2. Mettre l'appli en ligne (accessible partout, en https)

Hébergé en ligne, tout le monde y accède par une simple adresse web. Le https permet aussi de garder l'écran du pilote allumé.

### Render (gratuit pour commencer)

1. Mettez le dossier sur un dépôt GitHub (sur github.com : bouton « Add file », puis « Upload files »).
2. Sur https://render.com, choisissez **New**, puis **Web Service**, et sélectionnez le dépôt.
3. Réglages :
   - Runtime : **Node** ;
   - Build command : laisser vide ;
   - Start command : `node server.mjs`.
4. Dans **Environment**, ajoutez `NODE_VERSION` = `22`.
5. Render donne une adresse du type `https://strategie-karting.onrender.com`.

Deux limites de l'offre gratuite :

- le service s'endort après 15 min sans visite, et le premier chargement prend alors environ 30 s ;
- les salles sont effacées à chaque redémarrage.

Le jour de la course, ouvrez l'appli quelques minutes avant le départ, ou prenez l'offre payante.

### Autres hébergeurs

N'importe quel hébergeur Node.js fonctionne : Railway, Fly.io, un VPS… Un `Dockerfile` est fourni :

```
docker build -t strategie-karting .
docker run -p 3000:3000 -v $(pwd)/data:/app/data strategie-karting
```

### Variables d'environnement

| Variable | Rôle | Défaut |
|---|---|---|
| `PORT` | port HTTP | `3000` |
| `DATA_FILE` | fichier de sauvegarde des salles | `./data/rooms.json` |
| `TIMING_HOSTS` | domaines de chrono autorisés, séparés par des virgules (`*` = tous) | `apex-timing.com` |

## 3. Utilisation

### Le team manager

1. Ouvrir l'appli, choisir **Team manager**, puis **Créer une salle**. Une salle correspond à une course.
2. Onglet **Radio** : le code de salle et le lien pilote s'affichent. Envoyez le lien aux pilotes.
3. Gardez la **clé de team manager** pour vous. Elle permet d'envoyer des messages et de piloter le chrono. Le bouton « Copier le lien manager » sert à ouvrir un second écran au stand.
4. **Réglages** : durée, règlement (quick-change, ravito, relais min et max), noms de l'équipe et des pilotes, et la partie **Files et rotation des karts** :
   - **nombre de files** et **karts par file** au départ (le nombre total de karts en découle : un par équipe plus ceux des files) ;
   - **les adversaires prennent leur kart** : *toujours dans la même file* (laquelle) ou *dans une file au hasard*.

### Lier la course au chrono

1. Onglet **Chrono** : collez l'adresse de la page live du circuit (par exemple `https://live.apex-timing.com/nom-du-circuit/`), puis **Connecter Apex Timing**.
2. **Tester la connexion**. La liste des équipes vues par le chrono apparaît : cochez la vôtre, puis **Créer la course depuis le chrono**.
3. Renseignez les **karts en piste** (un par équipe) et la **composition des files** (numéros séparés par des virgules, tête de file en premier).
4. Le départ est détecté au premier tour. Sinon, utilisez le bouton « Le départ vient d'être donné ».

Si la page live ne suffit pas, ouvrez-la dans Chrome, appuyez sur F12, allez dans l'onglet **Réseau**, filtrez sur **WS** et copiez l'adresse `wss://…` affichée.

Le **flux de démonstration** (vitesse 1×, 10× ou 50×) simule une course complète pour tout tester avant le jour J. Le simulateur intégré, onglet Course puis **Démarrer**, fonctionne aussi sans chrono.

### Rotation des karts

À chaque quick-change, l'équipe prend le kart en tête de file et rend le sien en queue de la même file. L'appli simule ce mouvement en continu :

- elle estime les prochains arrêts adverses à partir de leurs relais et du règlement ;
- elle fait tourner les files selon le comportement choisi (même file ou file au hasard) ;
- elle en déduit quel kart sera en tête de chaque file au moment de votre arrêt.

L'onglet **Files** affiche, pour chaque kart :

- sa note et le nombre de fois où il a été pris ;
- où il est en ce moment ;
- quand il repassera en tête de file, y compris les karts actuellement en piste chez les adversaires.

La recommandation PIT et la fenêtre de pit s'en servent pour vous faire rentrer quand un bon kart sera en tête.

Si les adversaires prennent **toujours la même file**, leurs changements de kart sont déduits automatiquement. Si c'est **au hasard**, l'appli vous demande d'un tap quelle file ils ont prise. Vous pouvez aussi l'ignorer : le kart reste alors inconnu.

Quand vous appelez un arrêt (bouton **Quick-change** ou **Appliquer**), le pilote reçoit « Rentre ce tour » sur son téléphone. La file choisie sert à savoir quel kart vous allez prendre.

### Le pilote

1. Ouvrir le lien pilote (ou l'appli, choisir **Pilote**, puis entrer le code de salle), puis choisir son nom.
2. L'appli propose de **passer en plein écran**, ce qui masque la barre d'adresse et la barre du téléphone. Le bouton ⛶ en haut permet d'y revenir, et le menu ⋯ regroupe les autres options.
3. Tout tient sur un seul écran, sans défilement, en portrait comme en paysage :
   - dernier tour, écart avec son meilleur et tours précédents ;
   - position et position nette ;
   - écarts devant et derrière ;
   - chrono du relais, avec le minimum et le maximum ;
   - moyenne sur 5 tours et kart ;
   - dernier message et boutons de réponse.
4. Les messages du stand apparaissent en plein écran avec vibration (Android) et bip. Les autres alertes de l'appli sont coupées en mode pilote.
5. **Sur iPhone**, Safari ne permet pas le plein écran d'une page. Ouvrez le lien pilote, touchez **Partager** puis **Sur l'écran d'accueil**, et lancez l'appli depuis l'icône : elle s'ouvre sans barre et déjà reliée à la salle. Le même ajout à l'écran d'accueil fonctionne aussi sur Android.
6. Activez **Ne pas déranger** (ou le mode Concentration) sur le téléphone : une page web ne peut pas bloquer les notifications des autres applis.
7. **Garder l'écran allumé** (menu ⋯) fonctionne en https.

Vérifiez auprès du circuit qu'un téléphone fixé sur le kart est autorisé.

## 4. Tests

```
npm test
```

Ce sont les tests du serveur : salles, clés, temps réel, chrono, sauvegarde. Les tests des moteurs de stratégie (règlement, notes, rotation, simulation…) se lancent depuis l'appli, onglet **Réglages**, bouton **Lancer les tests**.

## 5. Sécurité et limites

- Pas de comptes : l'accès se fait par **code de salle**. Toute personne qui a le code voit la course et peut répondre en tant que pilote. Seul le détenteur de la **clé** envoie des messages et pilote le chrono.
- Les salles inactives sont supprimées après 48 h.
- La lecture du flux Apex Timing a été écrite d'après le format connu de ce service, mais **pas encore testée sur un vrai circuit**. Faites un essai sur une séance avant la course.
- Le chrono ne dit pas dans quelle file un adversaire a pris son kart : c'est le réglage « même file / au hasard » qui le décide, avec une correction manuelle possible.
- La course du team manager (calculs, historique) est enregistrée dans son navigateur. Les pilotes reçoivent un résumé publié par le stand toutes les 1 à 2 secondes.

## Structure

```
server.mjs            serveur HTTP : pages, salles, temps réel (SSE), API chrono, sauvegarde
timing.mjs            lecture du live timing Apex Timing et flux de démonstration
public/index.html     l'appli (moteurs de stratégie, interface manager et pilote)
public/icon.svg       icône (le manifeste d'installation est généré par le serveur)
test/test.mjs         tests du serveur
Dockerfile
```
