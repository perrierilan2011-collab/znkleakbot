# ZNK Bot

Bot Discord de tickets, ventes, vouchs, invitations et modération, avec un dashboard web.

## Nouveautés

- **Ajouter / retirer un membre d'un ticket** : `/add` et `/remove` (ou `/ticket ajouter` et `/ticket retirer`) dans le ticket, avec la mention du membre.
- **Vouch vérifié** : `/vouch` dans un ticket → note de 1 à 5 étoiles → message → publication dans un salon dédié. Le message est épuré (photo de profil, titre, note, citation) et tu peux mettre **ce que tu veux en dessous** (Service, Support, Prix…) : une ligne par information, avec des variables. Titre, pied de page et logo configurables depuis le dashboard.
- **Panel multi-boutons** : un panel avec une bannière, un texte et **un bouton par catégorie** (7 à 9 selon la bannière, limite Discord). Chaque bouton ouvre sa catégorie et, si un sous-panel y est relié, le premier menu du parcours (puis les sous-panels suivants). Rendu avec les composants Discord récents (bouton à droite de chaque texte) et repli automatique en embed + boutons sur les anciennes versions de discord.js.
- **Champs personnalisés des tickets** : dans le message d'ouverture, ajoute autant de champs que tu veux (nom + valeur, 10 maximum) sous la description : prix, service, délai… Chaque champ s'affiche sur deux lignes (nom au-dessus, valeur en dessous). Les variables `{prix}`, `{paiement}`, `{order}`, `{category}`… sont disponibles. Les champs remplacent automatiquement les deux lignes de texte par défaut, et une case permet de retirer ces lignes même sans champ.
- **Traduction automatique** : dans les tickets, chaque message reçu est traduit en français et en anglais, quelle que soit la langue d'origine. Un message français reçoit sa traduction anglaise (🇬🇧), un message anglais sa traduction française (🇫🇷), et un message dans une autre langue reçoit les deux. Les mentions, liens et emojis sont conservés. Activable par configuration ou par panel.
- **Suivi des ventes** : à la fermeture d'un ticket, le bot demande si la vente a été réalisée. Le staff saisit le montant, l'acheteur et le produit. Un panel dédié affiche le nombre de ventes, l'argent généré, le panier moyen et les dernières ventes.
- **Couleur globale** : une seule couleur pour tous les panels (tickets, vouchs, ventes), réglable depuis le dashboard ou `/ticket couleur`.
- **Dashboard simplifié** : navigation par sections (Accueil, Tickets, Vouches, Ventes, Produits, Restock, Images, Admin, Apparence, Invitations, Commandes, Sauvegarde).
- **Tickets réorganisés** : onglets Réglages, Catégories, Sous-panels, Panels, Message d'ouverture.
- **Sauvegarde Supabase complète** : `supabase.sql` contient la table principale, l'historique et des vues pour lire les invitations, panels, vouchs et ventes.

## Variables d'environnement

| Variable | Obligatoire | Description |
|---|---|---|
| `TOKEN` | Oui | Token du bot Discord. |
| `PANEL_PASSWORD` | Oui | Mot de passe du dashboard web. |
| `PORT` | Non | Port du dashboard (Railway le fournit automatiquement). |
| `DB_FILE` | Recommandé | Chemin du fichier JSON, ex. `/data/data.json` sur Railway. |
| `RAILWAY_VOLUME_MOUNT_PATH` | Non | Renseigné automatiquement par Railway si un volume est monté. |
| `SUPABASE_URL` | Oui (recommandé) | URL du projet Supabase (`https://xxxx.supabase.co`). |
| `SUPABASE_KEY` | Oui (recommandé) | Clé **service_role** Supabase (jamais la clé anon). |
| `SUPABASE_SERVICE_KEY` | Non | Alias accepté à la place de `SUPABASE_KEY`. |
| `SUPABASE_ALLOW_SHRINK` | Non | `1` pour autoriser l'écrasement par des données plus petites (garde-fou désactivé). |

Exemple complet : voir `.env.example`.

## Installation Supabase

1. Crée un projet sur [supabase.com](https://supabase.com).
2. Ouvre **SQL Editor → New query**, colle tout le contenu de `supabase.sql`, puis **Run**.
3. Récupère l'URL du projet et la clé **service_role** dans **Project Settings → API**.
4. Ajoute `SUPABASE_URL` et `SUPABASE_KEY` dans Railway (ou dans `.env`).

Le bot recharge Supabase au démarrage : les panels, catégories, invitations, vouchs et ventes sont restaurés après un redéploiement.

## Intents Discord

Dans le portail développeur Discord → ton application → Bot :

- **Server Members Intent** : activé.
- **Message Content Intent** : activé (transcripts de tickets).

Permissions du bot : Gérer les salons, Gérer les rôles, Gérer les messages, Voir les salons, Envoyer des messages, Joindre des fichiers, Intégrer des liens. Le rôle du bot doit être au-dessus des rôles staff.

## Commandes utiles

### Tickets

- `/ticket config-creer`, `config-liste`, `config-supprimer`
- `/ticket staff-ajouter`, `staff-retirer`
- `/ticket ajouter`, `/ticket retirer` (dans un ticket)
- `/add`, `/remove` — versions rapides, utilisables par le créateur du ticket et le staff (dans le ticket)
- `/ticket raison-ajouter`, `raison-modifier`, `raison-retirer`
- `/ticket panel`, `/ticket message`, `/ticket bouton`
- `/ticket couleur` (couleur globale ou par configuration)
- `/ticket vouch-salon`, `vouch-activer`, `vouch-desactiver`
- `/ticket traduction-activer`, `traduction-desactiver` (traduction automatique toute langue → français + anglais)
- `/ticket ventes-salon`, `ventes-panel`, `ventes-devise`

### Produits & Restock

Deux annonces de boutique entièrement personnalisables, disponibles en commande et depuis le dashboard (pages **Produits** et **Restock**) :

- `/product creer` — **annonce produit** : titre, description libre en Markdown, image, logo, pied de page et **autant de boutons-liens que tu veux** (25 maximum, limite Discord). Chaque bouton s'écrit `Texte | lien ou salon | emoji` (emoji optionnel).
- `/restock creer` — **tableau de restock** : lignes `Variante | Prix | Stock`, image, logo, pied de page et boutons-liens.

Options communes : `salon`, `couleur`, `logo` (coché par défaut, décochable pour masquer le logo) et mentions (`mention`, `ping`). Depuis le dashboard, les lignes, les liens et les images se saisissent directement (boutons d'ajout/suppression) sans passer par une commande.

Un bouton peut pointer vers un site **ou vers un salon Discord** : dans le dashboard, choisis le salon dans « ou salon (achat direct) », ou écris `#nom-du-salon` / `<#ID>` / l'ID du salon dans la commande. Le bouton ouvre alors directement le salon d'achat, sans lien intermédiaire. Les emojis Unicode des boutons sont placés dans le libellé pour être parfaitement alignés avec le texte.

Pour mettre **n'importe quel texte en gras**, sélectionne-le dans un champ Markdown puis clique sur **G** dans la barre de mise en forme en haut de page (ou `Ctrl+B`). Le gras fonctionne dans les descriptions, les variantes, les prix, le stock, les textes de panels, etc.

Chaque envoi est **mémorisé** dans la page **Produits** / **Restock** :

- **✏️ Modifier** recharge tous les paramètres dans le formulaire (titre, texte, liens, image, logo, couleur, pied de page…). Change ce que tu veux puis clique sur **Mettre à jour le message** : le message Discord est modifié directement, sans en créer un nouveau.
- **📤 Renvoyer** publie une copie avec les mêmes paramètres (ou les paramètres actuellement affichés depuis le formulaire).
- **🗑️** supprime le message Discord et l'entrée de la liste.

Plus besoin de tout refaire : un message envoyé reste modifiable et réutilisable.

### Images : lien, import et bibliothèque

Partout où une image est demandée (panels de tickets, sous-panels, message d'ouverture, produits, restock, logos du serveur, vouch), tu peux :

- coller un **lien** (`https://…`) ;
- **importer un fichier** depuis le dashboard. L'image est automatiquement redimensionnée et compressée dans le navigateur (photos de téléphone acceptées), puis envoyée avec le message Discord en pièce jointe : elle ne dépend d'aucun hébergement externe ;
- choisir une image déjà enregistrée dans la **bibliothèque** (liste déroulante sous chaque champ image).

La page **Images** permet de gérer la bibliothèque : ajouter un fichier ou un lien, lui donner un **nom** simple, le renommer, le supprimer et copier son lien. Les images sont stockées dans Supabase avec le serveur (40 maximum) et réutilisables partout en un clic. Le bouton **＋ Bibliothèque** sous un champ image enregistre directement l'image déjà choisie.

Le **logo global** se règle dans **Apparence** et s'applique à tous les panels, messages et annonces. Chaque annonce **Produits** / **Restock**, chaque panel de tickets, chaque sous-panel, le message d'ouverture, les vouchs et le panel des ventes ont aussi leur **propre logo** : choisis-le dans le champ « Logo » (lien, fichier importé ou image de la bibliothèque), il s'affiche en haut à droite. Vide = logo global (si la case correspondante est cochée).

### Accès aux commandes (onglet Admin)

L'onglet **Admin** permet de choisir précisément qui peut utiliser chaque commande :

- **Par commande** ou **par catégorie de commandes** (Boutique, Tickets, Modération…).
- Pour un **rôle** ou une **personne** (recherche par pseudo), avec la liste des accès actuels et un bouton pour retirer chacun.
- **Tout autoriser** donne immédiatement **toutes les commandes** à un rôle ou à une personne (accès total).
- Les commandes publiques (`/help`, `/vouch`, `/invites`, `/message-mp`) restent ouvertes à tous ; les commandes réservées au propriétaire ne peuvent pas être déléguées.
- Le salon privé des commandes est mis à jour automatiquement avec les rôles et les personnes autorisés.

Les mêmes réglages existent côté Discord avec `/permissions` et `/permissions-categorie` (rôles) ; le dashboard ajoute les autorisations nominatives et le bouton « tout autoriser ».

### Rôles staff des tickets

Dans **Tickets → Réglages** :

- Ajoute **autant de rôles staff que tu veux** (Ctrl + clic), ou **aucun rôle** (seuls les administrateurs et le membre qui ouvre voient alors le ticket).
- **Accès staff** : « Au moins un rôle suffit » (comportement classique) ou « **Tous les rôles sont requis** » : un membre doit posséder chaque rôle staff de la catégorie pour voir le ticket. En mode « tous les rôles », l'accès est recalculé automatiquement quand les rôles d'un membre changent.
- Chaque **catégorie du menu** et chaque **choix de sous-panel** peut avoir ses **propres rôles staff** (plusieurs) et son propre mode d'accès. Un ticket de cette catégorie utilise ces rôles à la place de ceux de la configuration.

### Panels de tickets

Tout se règle depuis le dashboard, onglet **Tickets** :

- **Catégories** : chaque catégorie a un nom, un emoji, une description courte et un **texte de panel** (affiché à gauche du bouton dans un panel multi-boutons).
- **Sous-panels** : un sous-panel est une liste de choix ; chaque choix peut mener à un autre sous-panel (`Suivant`) ou ouvrir le ticket. Un sous-panel peut être relié à une catégorie (ou servi par défaut).
- **Panels** → **Type** :
  - **Bouton** : un seul bouton « Ouvrir un ticket ».
  - **Plusieurs boutons** : une bannière + un bouton par catégorie. Un clic sur un bouton ouvre la catégorie et enchaîne les sous-panels reliés (le ticket n'est créé qu'à la fin du parcours).
  - **Menu déroulant** : un menu listant les catégories.
- Les panels déjà envoyés se mettent à jour automatiquement quand tu modifies les catégories, la couleur ou le logo.
- Dans la liste **Panels envoyés**, **✏️ Modifier** recharge le panel dans le formulaire : change le titre, la description, l'image, le logo, la couleur, le pied de page ou le bouton, puis clique sur **Mettre à jour ce panel**. Le message Discord existant est modifié directement (pas de doublon).

### Nom du ticket et prix

- **Nom du salon du ticket** : dans **Tickets → Réglages**, le champ **Nom du salon du ticket** définit le nom donné à l'ouverture. Variables disponibles : `{user}`, `{username}`, `{displayname}`, `{category}`, `{sub}`, `{config}`, `{number}` et **`[prix]`**. Vide = « ❌-catégorie » (comportement historique). Exemple : `ticket-{username}` ou `[prix]-{category}`.
- **Prix par catégorie** : chaque catégorie a un champ **Prix**. La variable **`[prix]`** (ou `{prix}`) est remplacée par ce prix dans la description, le nom du ticket et le message d'ouverture.
- **Description = prix** : le bouton **Mettre le prix en description** remplit la description avec `[prix]`, qui affiche donc directement le prix de la catégorie. Il suffit ensuite d'enregistrer.
- Chaque catégorie peut aussi avoir son **propre nom de ticket**, qui remplace le nom global de la configuration.

### Vouch

- `/vouch` : dans un ticket, ouvre le mini-panel de notation sur 5 étoiles.

### Fermeture d'un ticket

Le bouton **Fermer** est réservé au staff. Il ouvre une confirmation :

- **Oui, vente réalisée** → formulaire montant / acheteur / produit → panel des ventes mis à jour → ticket fermé.
- **Non, pas de vente** → ticket fermé sans vente.

Le membre qui a ouvert le ticket ne peut pas le fermer.
