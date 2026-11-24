# ZNK Bot

Bot Discord de tickets, ventes, vouchs, invitations et modération, avec un dashboard web.

## Nouveautés

- **Ajouter / retirer un membre d'un ticket** : `/ticket ajouter` et `/ticket retirer` (dans le ticket).
- **Vouch vérifié** : `/vouch` dans un ticket → note de 1 à 5 étoiles → message → publication dans un salon dédié avec la photo de profil et un logo configurable.
- **Traduction automatique** : dans les tickets, chaque message reçu est traduit en français et en anglais, quelle que soit la langue d'origine. Un message français reçoit sa traduction anglaise (🇬🇧), un message anglais sa traduction française (🇫🇷), et un message dans une autre langue reçoit les deux. Les mentions, liens et emojis sont conservés. Activable par configuration ou par panel.
- **Suivi des ventes** : à la fermeture d'un ticket, le bot demande si la vente a été réalisée. Le staff saisit le montant, l'acheteur et le produit. Un panel dédié affiche le nombre de ventes, l'argent généré, le panier moyen et les dernières ventes.
- **Couleur globale** : une seule couleur pour tous les panels (tickets, vouchs, ventes), réglable depuis le dashboard ou `/ticket couleur`.
- **Dashboard simplifié** : navigation par sections (Accueil, Tickets, Vouches, Ventes, Apparence, Invitations, Commandes, Sauvegarde).
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
- `/ticket raison-ajouter`, `raison-modifier`, `raison-retirer`
- `/ticket panel`, `/ticket message`, `/ticket bouton`
- `/ticket couleur` (couleur globale ou par configuration)
- `/ticket vouch-salon`, `vouch-activer`, `vouch-desactiver`
- `/ticket traduction-activer`, `traduction-desactiver` (traduction automatique toute langue → français + anglais)
- `/ticket ventes-salon`, `ventes-panel`, `ventes-devise`

### Vouch

- `/vouch` : dans un ticket, ouvre le mini-panel de notation sur 5 étoiles.

### Fermeture d'un ticket

Le bouton **Fermer** est réservé au staff. Il ouvre une confirmation :

- **Oui, vente réalisée** → formulaire montant / acheteur / produit → panel des ventes mis à jour → ticket fermé.
- **Non, pas de vente** → ticket fermé sans vente.

Le membre qui a ouvert le ticket ne peut pas le fermer.
