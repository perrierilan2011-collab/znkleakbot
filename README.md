# ZNK Discord Bot

## Prérequis
- Node.js 18 ou plus récent
- Un bot créé dans le [Discord Developer Portal](https://discord.com/developers/applications)

## Installation
1. Installe les dépendances avec `npm install`.
2. Copie `.env.example` vers `.env`.
3. Dans `.env`, remplace `COLLE_ICI_LE_TOKEN_DU_BOT` par le token du bot.
4. Dans Discord Developer Portal > Bot > Privileged Gateway Intents, active :
   - Server Members Intent
   - Message Content Intent
5. Invite le bot sur ton serveur avec les scopes `bot` et `applications.commands`.
6. Démarre le bot avec `npm start`.

Les commandes slash sont enregistrées automatiquement sur les serveurs où le bot est présent.

## Données
Le bot utilise `data.json` pour conserver ses paramètres. Ce fichier est ignoré par Git afin de ne pas écraser les données lors des mises à jour. Fais régulièrement une sauvegarde de ce fichier.

## Sécurité
- Ne partage jamais le token.
- Ne téléverse jamais `.env` sur GitHub.
- Si le token a été publié, régénère-le dans le Discord Developer Portal.
