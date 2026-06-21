# Cron Master Documentation

Cron Master est un orchestrateur léger pour planifier des notifications, surveiller des services, suivre un réseau, recevoir des webhooks et exposer une API utilisable par d'autres applications.

Cette documentation est organisée comme un manuel produit. Elle commence par les usages courants, puis détaille les concepts, les types de jobs, l'API et les opérations.

## Sommaire

1. [Démarrage](#demarrage)
2. [Vue d'ensemble](#vue-densemble)
3. [Créer un job](#creer-un-job)
4. [Types de jobs](#types-de-jobs)
5. [Planification](#planification)
6. [Notifications](#notifications)
7. [Incidents et retries](#incidents-et-retries)
8. [Suivi réseau](#suivi-reseau)
9. [Workflows par blocs](#workflows-par-blocs)
10. [Automations](#automations)
11. [API publique](#api-publique)
12. [Recettes](#recettes)
13. [Dépannage](#depannage)
14. [Bonnes pratiques](#bonnes-pratiques)

## Démarrage

### Lancer l'application

```bash
docker compose up --build
```

Services exposés:

| Service | URL | Usage |
| --- | --- | --- |
| Web | `http://localhost:3001` | Interface utilisateur |
| API interne | `http://localhost:4000/health` | Santé du backend |
| API publique | `http://localhost:4000/api/v1` | Intégration externe |

La clé d'API par défaut en Docker Compose est:

```txt
change-me-dev-key
```

En production, crée plutôt des tokens scopés depuis `Settings > API publique`. `CRON_MASTER_API_KEY` reste disponible comme clé legacy optionnelle.

## Vue d'ensemble

Cron Master repose sur quatre objets principaux.

| Objet | Rôle | Où le voir |
| --- | --- | --- |
| Job | Ce qui doit être exécuté: check, notification, rappel, workflow | Page Jobs |
| Run | Une exécution d'un job avec statut et détails | Page Incidents, historique |
| Incident | Un problème ouvert après un échec confirmé | Page Incidents |
| Automation | Intégrations autour des jobs: dead-man, maintenance, import/export | Page Automations |

Le backend contient un worker. Il vérifie les jobs dus, les exécute, enregistre le résultat, planifie le prochain passage, puis ouvre ou résout les incidents.

## Créer un job

1. Ouvre l'interface web.
2. Clique sur `Nouveau job`.
3. Choisis l'intention: Site, Machine, Réseau, Workflow, Notification ou Rappel.
4. Choisis une planification lisible.
5. Renseigne les paramètres propres au type choisi.
6. Sauvegarde.
7. Clique sur le bouton d'exécution manuelle pour valider immédiatement.

Un job peut ensuite être:

| Action | Effet |
| --- | --- |
| Exécuter | Lance le job maintenant |
| Pause | Désactive le job et supprime le prochain passage |
| Reprendre | Réactive le job et recalcule le prochain passage |
| Dupliquer | Crée une copie désactivée, utile pour préparer une variante |
| Webhook | Copie une URL de déclenchement externe |
| Supprimer | Supprime le job et son historique |

## Types de jobs

### Choisir le bon type

| Besoin | Type recommandé | Pourquoi |
| --- | --- | --- |
| Vérifier une API HTTP ou une page web | Site | Vérifie un statut HTTP attendu |
| Vérifier qu'un service écoute sur un port | Machine | Test TCP simple |
| Surveiller une connexion réseau ou une box | Réseau | Ping multi-cibles avec timer de panne |
| Envoyer un message planifié | Notification | Simple, direct, sans check |
| Ne pas oublier une date précise | Rappel | Exécution unique possible |
| Enchaîner plusieurs actions | Workflow | Blocs visuels avec conditions |
| Surveiller une tâche externe | Dead-man | La tâche doit appeler une URL de ping |

### Notification

Envoie un message Discord ou ntfy.

Champs principaux:

| Champ | Description |
| --- | --- |
| `message` | Message envoyé |
| `useGlobalNotifications` | Utilise les destinations globales |
| `discordWebhookUrl` | Webhook Discord local au job |
| `ntfyTopic` | Topic ntfy local au job |

### Rappel

Envoie une notification à une date ou selon une cadence lisible. Pour une planification `once`, le job est désactivé après exécution.

### Site

Teste une URL.

| Champ | Exemple | Description |
| --- | --- | --- |
| `url` | `https://example.com/health` | URL appelée |
| `expectedStatus` | `200` | Statut HTTP attendu |
| `retryCount` | `2` | Retries avant échec final |
| `retryDelaySeconds` | `10` | Délai entre retries |

### Machine

Teste un port TCP.

| Champ | Exemple | Description |
| --- | --- | --- |
| `host` | `db.local` | DNS ou IP |
| `port` | `5432` | Port TCP |

### Réseau

Ping plusieurs cibles et mesure les coupures. Voir [Suivi réseau](#suivi-reseau).

### Workflow

Exécute une suite de blocs visuels. Voir [Workflows par blocs](#workflows-par-blocs).

## Planification

L'interface masque la syntaxe cron. Tu choisis une intention métier.

| Mode | Exemple UI | Usage |
| --- | --- | --- |
| Régulier | Toutes les 5 minutes | Monitoring |
| Jour | Tous les jours à 09:00 | Digest quotidien |
| Semaine | Chaque lundi à 09:00 | Contrôle hebdomadaire |
| Mois | Le 1 du mois à 09:00 | Facturation, relances |
| Date | 20 juin 2026 à 09:00 | Rappel unique |

L'API publique accepte aussi:

```json
{ "mode": "every_minutes", "value": 5 }
{ "mode": "hourly", "value": 2 }
{ "mode": "daily", "time": "09:00" }
{ "mode": "weekly", "weekday": 1, "time": "09:00" }
{ "mode": "monthly", "day": 1, "time": "09:00" }
{ "mode": "once", "runAt": "2026-06-20T09:00:00.000Z" }
```

## Notifications

Les notifications globales se configurent dans `Settings`.

| Destination | Champ | Notes |
| --- | --- | --- |
| Discord | `discordWebhookUrl` | Webhook entrant Discord |
| ntfy | `ntfyServer`, `ntfyTopic`, `ntfyToken` | `ntfyToken` optionnel selon ton serveur |

Chaque job peut utiliser les notifications globales ou définir ses propres destinations.

## Incidents et retries

Un job en échec ouvre un incident. Si le même job échoue à nouveau, l'incident existant est mis à jour au lieu d'être dupliqué.

Cycle normal:

1. Le job échoue.
2. Les retries éventuels sont exécutés.
3. Si l'échec persiste, un run `failure` est enregistré.
4. Un incident est ouvert ou mis à jour.
5. Au prochain succès, l'incident est résolu automatiquement.

Réglages utiles:

| Champ | Description |
| --- | --- |
| `retryCount` | Nombre de tentatives supplémentaires |
| `retryDelaySeconds` | Attente entre deux tentatives |
| `severity` | `info`, `warning` ou `critical` |

## Suivi réseau

Le type `Réseau` sert à suivre l'état d'une connexion ou d'un segment réseau.

### Fonctionnement

1. Cron Master ping chaque cible.
2. Il compte combien de cibles répondent.
3. Si le nombre est inférieur à `minOnline`, le check brut est considéré down.
4. La panne n'est confirmée qu'après `failureThreshold` échecs consécutifs.
5. Quand le réseau répond à nouveau, le retour OK n'est confirmé qu'après `recoveryThreshold` succès consécutifs.
6. Au rétablissement, Cron Master calcule la durée de panne et peut envoyer une notification.

### Configuration recommandée

| Champ | Valeur recommandée | Description |
| --- | --- | --- |
| `targets` | Routeur + DNS externe | Cibles à ping |
| `minOnline` | `1` | Nombre minimum de cibles qui doivent répondre |
| `timeoutMs` | `2000` | Timeout par ping |
| `failureThreshold` | `2` ou `3` | Échecs avant panne confirmée |
| `recoveryThreshold` | `2` | Succès avant retour OK confirmé |
| `reminderMinutes` | `30` ou `60` | Rappel pendant panne, `0` pour désactiver |
| `notifyOnDown` | `false` par défaut | Notifie au début de panne |
| `notifyOnRecovery` | `true` | Notifie au rétablissement |

### Exemple

```json
{
  "targets": [
    { "label": "Routeur", "host": "192.168.1.1" },
    { "label": "DNS Cloudflare", "host": "1.1.1.1" }
  ],
  "minOnline": 1,
  "timeoutMs": 2000,
  "failureThreshold": 2,
  "recoveryThreshold": 2,
  "reminderMinutes": 30,
  "notifyOnDown": false,
  "notifyOnRecovery": true
}
```

### État enregistré

| Champ | Description |
| --- | --- |
| `networkStatus` | `up` ou `down` |
| `outageStartedAt` | Début de panne confirmée |
| `lastCheckedAt` | Dernier check |
| `lastRecoveryDurationMs` | Durée de la dernière panne résolue |
| `lastNetworkResults` | Résultat par cible |
| `networkConsecutiveFailures` | Compteur anti faux-positif |
| `networkConsecutiveSuccesses` | Compteur anti flapping |

## Workflows par blocs

Un workflow permet de construire une automatisation simple sans écrire de code.

| Bloc | Rôle |
| --- | --- |
| `notify` | Envoie une notification |
| `http` | Teste une URL |
| `tcp` | Teste un host et un port |
| `condition` | Vérifie une variable |
| `webhook` | Appelle une URL externe |
| `wait` | Attend quelques secondes |

Variables disponibles:

| Variable | Description |
| --- | --- |
| `$JOB_NAME` | Nom du job |
| `$NOW` | Date courante ISO |
| `$STATUS` | Statut HTTP |
| `$RESPONSE_TIME` | Temps de réponse en ms |
| `$URL` | URL testée |
| `$HOST` | Host testé |
| `$PORT` | Port testé |

## Automations

### Dead-man switch

Un dead-man surveille une tâche externe. La tâche doit appeler une URL régulièrement. Si Cron Master ne reçoit plus de ping avant `intervalle attendu + grâce`, il ouvre un incident.

À la création, Cron Master peut générer une URL secrète automatiquement. C'est le mode recommandé: le slug n'est pas exposé dans le status public, il peut être copié depuis l'interface, testé manuellement, mis en pause ou régénéré si l'URL a fuité.

Exemple d'appel:

```bash
curl http://localhost:4000/ping/dm-<slug-secret>
```

Réglages utiles:

| Champ | Description |
| --- | --- |
| Intervalle attendu | Délai normal entre deux pings |
| Grâce | Marge avant ouverture d'incident |
| Rappel panne | Répète une notification pendant l'incident, `0` pour désactiver |
| Notification missing | Envoie une alerte quand le ping manque |
| Notification recovery | Envoie une alerte quand le ping revient |
| Rotation URL | Génère un nouveau slug et invalide l'ancienne URL |

### Maintenance

Une fenêtre de maintenance coupe les alertes pendant une période prévue. Elle sert aux déploiements, redémarrages serveur, migrations et interventions réseau.

### Import et export

L'export génère un JSON contenant les jobs, settings et objets opérationnels. L'import permet de restaurer ou transporter une configuration.

## API publique

Base URL:

```txt
http://localhost:4000/api/v1
```

Authentification:

```txt
Authorization: Bearer cm_xxx
```

ou:

```txt
x-api-key: cm_xxx
```

Les tokens se gèrent dans `Settings > API publique`. Le token brut est affiché une seule fois, puis seul son préfixe et ses 4 derniers caractères restent visibles. L'interface propose des presets par usage, une expiration optionnelle, la rotation d'un token existant et un test détaillé: validation des scopes, appel réel `/api/v1/me` en Bearer ou `x-api-key`, puis probes par endpoint sans lancer d'action destructrice.

Scopes disponibles:

| Scope | Usage |
| --- | --- |
| `status:read` | Health, status, dashboard, stats |
| `jobs:read` | Liste, détails et runs des jobs |
| `jobs:write` | Création, édition, pause, reprise, suppression |
| `jobs:run` | Exécution immédiate, dry-run, webhook |
| `deadman:read` | Lecture des dead-man switches |
| `deadman:write` | Création et ping dead-man |

### Endpoints

| Méthode | Route | Description |
| --- | --- | --- |
| `GET` | `/health` | Santé de l'API |
| `GET` | `/me` | Token courant, scopes et mode legacy |
| `GET` | `/scopes` | Scopes disponibles et probes de test |
| `GET` | `/openapi.json` | Description OpenAPI |
| `GET` | `/dashboard` | Résumé opérationnel |
| `GET` | `/status` | Status JSON public |
| `GET` | `/templates` | Templates disponibles |
| `GET` | `/jobs` | Liste des jobs |
| `POST` | `/jobs` | Création d'un job |
| `GET` | `/jobs/:id` | Détail d'un job |
| `PUT` | `/jobs/:id` | Remplacement d'un job |
| `DELETE` | `/jobs/:id` | Suppression |
| `POST` | `/jobs/:id/run` | Exécution immédiate |
| `POST` | `/jobs/:id/webhook` | Déclenchement avec payload |
| `POST` | `/jobs/:id/duplicate` | Copie désactivée |
| `POST` | `/jobs/:id/pause` | Pause |
| `POST` | `/jobs/:id/resume` | Reprise |
| `GET` | `/jobs/:id/runs` | Historique |
| `GET` | `/deadman` | Liste des dead-man switches |
| `POST` | `/deadman` | Création dead-man |
| `ALL` | `/deadman/:slug/ping` | Ping dead-man |

### Créer un suivi réseau

```bash
curl -X POST http://localhost:4000/api/v1/jobs \
  -H "authorization: Bearer $CRON_MASTER_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "name": "Suivi réseau maison",
    "type": "network_monitor",
    "schedule": { "mode": "every_minutes", "value": 1 },
    "config": {
      "targets": [
        { "label": "Routeur", "host": "192.168.1.1" },
        { "label": "DNS Cloudflare", "host": "1.1.1.1" }
      ],
      "minOnline": 1,
      "timeoutMs": 2000,
      "failureThreshold": 2,
      "recoveryThreshold": 2,
      "reminderMinutes": 30,
      "notifyOnRecovery": true
    }
  }'
```

## Recettes

### Surveiller une box Internet

| Réglage | Valeur |
| --- | --- |
| Type | Réseau |
| Cibles | `192.168.1.1`, `1.1.1.1` |
| Fréquence | Toutes les 1 à 5 minutes |
| Échecs avant panne | 2 |
| Succès avant retour OK | 2 |
| Notification | Rétablissement activé |

### Surveiller une API critique

| Réglage | Valeur |
| --- | --- |
| Type | Site |
| URL | Endpoint `/health` |
| Statut attendu | 200 |
| Retry | 2 |
| Sévérité | critical |

### Surveiller un backup

1. Crée un dead-man dans Automations.
2. Copie l'URL de ping.
3. Appelle l'URL à la fin du backup.
4. Ajuste le délai attendu, la marge et les rappels.
5. Utilise le bouton de test pour valider le ping depuis l'interface.

## Dépannage

| Problème | Vérifications |
| --- | --- |
| Ping réseau toujours KO | La cible accepte ICMP, le conteneur accède au réseau, sinon utiliser Machine TCP |
| Trop d'alertes | Augmenter `failureThreshold`, `recoveryThreshold`, retries ou maintenance |
| Pas de notification | Tester Settings, vérifier Discord/ntfy, vérifier destinations locales |
| Job sans exécution | Vérifier qu'il est actif, regarder le prochain passage, lancer manuellement |
| Incident qui reste ouvert | Le job doit réussir à nouveau ou être résolu manuellement |
| API 401 | Vérifier le token dans `Settings > API publique`, puis tester `/api/v1/health` depuis l'interface |
| API 403 | Ajouter le scope requis au token ou créer un token dédié |

## Bonnes pratiques

- Préférer des checks simples, rapides et déterministes.
- Utiliser une URL `/health` plutôt qu'une page complète.
- Mettre `failureThreshold` à 2 ou 3 sur les réseaux instables.
- Garder une cible locale et une cible externe pour le suivi réseau.
- Utiliser les fenêtres de maintenance avant les interventions prévues.
- Dupliquer un job stable pour créer une variante.
- Mettre les brouillons en pause.
- Tester les notifications avant de compter dessus.
- Donner des noms explicites aux jobs.
- Utiliser les tags pour retrouver les jobs par environnement ou service.
