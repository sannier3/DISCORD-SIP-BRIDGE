# Pont Discord vers Yeastar via Asterisk

Bot Discord qui relie un salon vocal à la ligne téléphonique Yeastar via Asterisk ARI et un pont audio WebSocket.

## Fonctionnement

Le bot refuse `/appeler` si l'utilisateur n'est pas dans un salon vocal. Seule la voix de l'initiateur est envoyée au téléphone. Tous les membres du salon entendent le correspondant.

Commandes :

- `/appeler numero:0768573209`
- `/raccrocher`
- `/muet`
- `/dtmf touches:1#`
- `/statut-appel`

L'appel est automatiquement terminé si l'initiateur quitte le salon, si le salon devient vide, si le bot est déplacé ou si la durée maximale est atteinte.

## Prérequis

- Node.js 22.12 ou supérieur
- Asterisk avec ARI, `chan_websocket` et `res_http_websocket`
- Trunk PJSIP vers un Yeastar (ou autre PBX SIP)
- Serveur Linux pour le déploiement en production (Debian/Ubuntu recommandé)

## Préparation Discord

1. Créer une application dans le [portail développeur Discord](https://discord.com/developers/applications).
2. Ajouter un bot et récupérer son token.
3. Activer les scopes `bot` et `applications.commands` dans l'URL d'invitation.
4. Donner au bot les permissions Voir les salons, Se connecter, Parler et Utiliser les commandes d'application.
5. Relever l'identifiant du serveur Discord et, si nécessaire, les identifiants des rôles autorisés.

Aucun intent privilégié n'est nécessaire. Le bot utilise `Guilds` et `GuildVoiceStates`.

## Installation depuis GitHub

Dépôt : [github.com/sannier3/DISCORD-SIP-BRIDGE](https://github.com/sannier3/DISCORD-SIP-BRIDGE)

### Installation en une commande (Debian/Ubuntu)

```bash
curl -fsSL https://raw.githubusercontent.com/sannier3/DISCORD-SIP-BRIDGE/main/deploy/install-bot.sh | sudo bash
```

Mode verbeux (affiche la compilation npm en direct) :

```bash
curl -fsSL https://raw.githubusercontent.com/sannier3/DISCORD-SIP-BRIDGE/main/deploy/install-bot.sh | sudo bash -s -- --verbose
```

Le script télécharge automatiquement les sources depuis GitHub, installe les dépendances, déploie le bot dans `/opt/discord-sip-bridge` et active le service systemd.

**La même commande sert aussi à mettre à jour** une installation existante : le code et les dépendances npm sont remplacés, le fichier `.env` est conservé, et le service est redémarré s’il tournait déjà.

> Si le script semble bloqué sans message, c’est en général l’une de ces étapes lentes : paquets Debian (`man-db`), compilation npm des modules audio (2 à 5 min), ou arrêt du service en cours d’appel. La version actuelle du script affiche une ligne `[HH:MM:SS]` à chaque étape.

> Le tiret `-` qui tourne seul est le spinner npm (pas un blocage). Utilisez `--verbose` pour plus de détails.

Puis configurer le bot (première installation uniquement) :

```bash
sudo nano /opt/discord-sip-bridge/.env
sudo systemctl start discord-sip-bridge
```

### Installation manuelle (clone Git)

```bash
git clone https://github.com/sannier3/DISCORD-SIP-BRIDGE.git
cd DISCORD-SIP-BRIDGE
chmod +x deploy/install-bot.sh
sudo ./deploy/install-bot.sh
sudo nano /opt/discord-sip-bridge/.env
```

Renseigner au minimum :

```dotenv
DISCORD_TOKEN=le_token_du_bot
DISCORD_GUILD_ID=identifiant_du_serveur
```

Le script reprend automatiquement les identifiants ARI depuis `/root/discord-asterisk-credentials.txt` lorsque ce fichier existe. Le chemin peut être surchargé avec `ASTERISK_CREDENTIALS_FILE` dans `.env`.

Pour autoriser uniquement certains rôles :

```dotenv
RESTRICT_COMMANDS_TO_AUTHORIZED_ONLY=true
AUTHORIZED_ROLE_IDS=123456789012345678
```

Pour plusieurs rôles ou utilisateurs, séparer les identifiants par des virgules. Avec `RESTRICT_COMMANDS_TO_AUTHORIZED_ONLY=true`, seuls les rôles ou utilisateurs listés peuvent utiliser les commandes (le propriétaire du serveur reste toujours autorisé ; si les listes sont vides, seuls les administrateurs le sont). Sans cette option, toutes les commandes sont accessibles à tous les membres du serveur.

Pour limiter les commandes au salon textuel des salons vocaux :

```dotenv
RESTRICT_COMMANDS_TO_VOICE_TEXT=true
```

Cette option impose le salon textuel d’un salon vocal **à l’exécution** (le bot refuse la commande ailleurs). Pour masquer les commandes dans l’interface Discord, configurez les salons dans **Paramètres du serveur → Intégrations → votre bot** (Discord exige une autorisation OAuth pour le faire par code).

### Développement local

```bash
git clone https://github.com/sannier3/DISCORD-SIP-BRIDGE.git
cd DISCORD-SIP-BRIDGE
cp .env.example .env
# Éditer .env avec vos identifiants
npm ci
npm run check
npm start
```

Sur Linux, les paquets système suivants sont requis pour compiler les modules natifs audio :

```bash
sudo apt-get install -y build-essential pkg-config libopus-dev libsodium-dev
```

## Configuration

Copier `.env.example` vers `.env` et renseigner les variables. Les principales :

| Variable | Description |
| --- | --- |
| `DISCORD_TOKEN` | Token du bot Discord (obligatoire) |
| `DISCORD_GUILD_ID` | ID du serveur pour enregistrer les commandes slash localement |
| `ARI_USERNAME` / `ARI_PASSWORD` | Identifiants ARI Asterisk (obligatoires) |
| `PJSIP_ENDPOINT` | Endpoint PJSIP vers le trunk Yeastar |
| `RESTRICT_COMMANDS_TO_AUTHORIZED_ONLY` | Limite toutes les commandes aux rôles/utilisateurs autorisés |
| `AUTHORIZED_ROLE_IDS` | Rôles autorisés (si restriction activée) |
| `RESTRICT_COMMANDS_TO_VOICE_TEXT` | Commandes uniquement dans le chat textuel des salons vocaux |
| `HIDE_CALLED_NUMBER` | Masque le numéro appelé dans le message d’état Discord |
| `CALLED_NUMBER_PATTERN` | Modèles Yeastar autorisés, séparés par des virgules (`X`, `Z`, `.`) |
| `CALLED_NUMBER_MASK_START` | Chiffres masqués au début sur Discord |
| `CALLED_NUMBER_MASK_END` | Chiffres masqués à la fin sur Discord |
| `OUTBOUND_DIAL_RULES` | Préfixe Yeastar caché : `pattern:prefix`, séparés par des virgules (ordre important) |
| `STATUS_REFRESH_INTERVAL_SECONDS` | Actualisation du message d’appel en cours (défaut : 5 s) |
| `VOICE_CONNECTION_TIMEOUT_SECONDS` | Délai d’attente de la connexion vocale Discord (défaut : 30 s) |
| `VOICE_DEBUG` | Journaux détaillés de `@discordjs/voice` (défaut : `false`) |

Voir `.env.example` pour la liste complète.

### Masquage des numéros et préfixe Yeastar

Syntaxe du modèle Yeastar (`CALLED_NUMBER_PATTERN`) :

| Symbole | Signification |
| --- | --- |
| `X` | Chiffre 0 à 9 |
| `Z` | Chiffre 1 à 9 |
| `.` | Zéro ou plusieurs chiffres |
| `0`–`9` | Chiffre fixe |

Exemple pour les numéros français :

```dotenv
CALLED_NUMBER_PATTERN=0ZXXXXXXXX,09XXXXXXXX
HIDE_CALLED_NUMBER=true
CALLED_NUMBER_MASK_START=3
CALLED_NUMBER_MASK_END=3
```

`0768573209` s’affiche sur Discord comme `•••8573•••`.

Préfixe de sortie Yeastar (ajouté avant numérotation, jamais affiché sur Discord). Les règles sont évaluées **dans l’ordre** : placez les modèles spécifiques avant les règles générales (`0X.`, `X.`, etc.) :

```dotenv
OUTBOUND_DIAL_RULES=0ZXXXXXXXX:8,09XXXXXXXX:9,0X.:7,X.:0
```

- `0768573209` → composé `80768573209` (règle `0ZXXXXXXXX`)
- `0912345678` → composé `90912345678` (règle `09XXXXXXXX`)
- autre numéro commençant par `0` → préfixe `7` via `0X.`
- tout autre numéro autorisé → préfixe `0` via `X.`

## Démarrage

```bash
systemctl start discord-sip-bridge
systemctl status discord-sip-bridge --no-pager -l
journalctl -u discord-sip-bridge -f
```

## Mise à jour des dépendances vocales

Après une mise à jour du code ou des dépendances Discord :

```bash
cd /opt/discord-sip-bridge
rm -rf node_modules package-lock.json
npm install
npm run check
npm run voice-report
sudo systemctl restart discord-sip-bridge
sudo journalctl -u discord-sip-bridge -f
```

### Journaux attendus au démarrage

```text
Rapport des dépendances vocales Discord
WebSocket ARI connecté
Bot Discord connecté
Commandes Discord enregistrées dans le serveur
```

### Journaux attendus lors de `/appeler`

```text
État vocal Discord modifié ... newStatus: signalling
État vocal Discord modifié ... newStatus: connecting
État vocal Discord modifié ... newStatus: ready
Connexion vocale Discord prête
Appel lancé
```

Pour diagnostiquer un problème de connexion vocale, activez temporairement :

```dotenv
VOICE_DEBUG=true
VOICE_CONNECTION_TIMEOUT_SECONDS=30
```

Puis redémarrez le service. Remettez `VOICE_DEBUG=false` une fois le problème résolu.

## Dépannage vocal Discord

- **État bloqué sur `signalling`** : vérifier que le bot reçoit bien les événements `VOICE_STATE_UPDATE` et `VOICE_SERVER_UPDATE` (intents `Guilds` et `GuildVoiceStates`).
- **État bloqué sur `connecting`** : vérifier la sortie UDP du serveur vers les serveurs vocaux Discord (pare-feu, NAT, Proxmox).
- **État `ready` mais aucun canal Asterisk** : vérifier les appels ARI exécutés après cette étape dans les journaux.
- **Appel Asterisk lancé sans audio** : diagnostiquer séparément le RTP Yeastar et le WebSocket média Asterisk.

## Structure du dépôt

```
.
├── server.js                  # Application principale
├── package.json
├── .env.example               # Modèle de configuration
├── deploy/
│   ├── install-bot.sh         # Script d'installation systemd
│   └── discord-sip-bridge.service
└── .github/workflows/ci.yml   # Vérification syntaxique
```

## Asterisk

Les éléments suivants doivent être actifs :

```bash
asterisk -rx "module show like chan_websocket"
asterisk -rx "module show like res_ari"
asterisk -rx "module show like res_http_websocket"
asterisk -rx "http show status"
asterisk -rx "pjsip show registrations"
```

`/etc/asterisk/chan_websocket.conf` :

```ini
[global]
control_message_format = json
```

Puis :

```bash
systemctl restart asterisk
```

## Audio RTP Yeastar

Le SDP retourné par le Yeastar doit annoncer une adresse joignable depuis Asterisk. Si le Yeastar annonce encore `192.168.100.58` alors que les deux sites utilisent des réseaux privés qui se chevauchent, le bot appellera mais l'audio téléphonique ne fonctionnera pas. Corriger `System > Network > Public IP and Ports` sur le Yeastar et la redirection de sa plage RTP.

## Licence

[MIT](LICENSE)
