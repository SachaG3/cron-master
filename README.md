# Cron Master

Application Docker Compose avec un backend Node.js, un frontend Next.js/shadcn/lucide et PostgreSQL pour créer des jobs planifiés simples ou avancés.

## Lancer

```bash
docker compose up --build
```

- Web: http://localhost:3001
- API: http://localhost:4000/health
- API publique: http://localhost:4000/api/v1

La clé d'API Docker Compose par défaut est `change-me-dev-key`. Le token de création du premier compte admin en local est `change-me-dev-setup-token`. Change-les en production avec `CRON_MASTER_API_KEY` et `CRON_MASTER_SETUP_TOKEN`.

Guide complet: [`docs/CRON_MASTER_GUIDE.md`](docs/CRON_MASTER_GUIDE.md)

Déploiement et CI/CD: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)

Convention de commits: [`docs/COMMIT_CONVENTION.md`](docs/COMMIT_CONVENTION.md)

## Qualité et CI/CD

Commandes locales principales:

```bash
npm run lint
npm test
npm run audit:ci
npm run build
docker compose build api web
docker compose up -d
npm run smoke
```

Le pipeline GitHub Actions `.github/workflows/ci.yml` reprend ces étapes et lance un smoke test Docker complet. Le workflow `.github/workflows/deploy.yml` publie les images sur GHCR puis déploie `docker-compose.prod.yml` sur un serveur SSH.

## Fonctionnalités livrées

1. Jobs de notification périodique
2. Rappels à date fixe
3. Checks HTTP
4. Checks TCP machine/port
5. Suivi réseau avec ping multi-cibles, timer de panne et notification au rétablissement
6. Planification simple sans syntaxe cron
7. Édition des jobs existants
8. Templates prêts à l'emploi
9. Blocs visuels pour workflows avancés
10. Conditions dans les blocs
11. Variables de message (`$JOB_NAME`, `$NOW`, `$STATUS`, `$RESPONSE_TIME`, `$URL`, `$HOST`, `$PORT`)
12. Notifications globales Discord/ntfy
13. Notifications locales par job
14. Bouton de test des notifications
15. Retry avant échec définitif
16. Déduplication via incidents ouverts
17. Résolution automatique au retour OK
18. Historique lisible
19. Tags par job
20. Sévérité `info`, `warning`, `critical`
21. Dashboard de santé
22. Dead-man switch avec URL de ping
23. Page de status JSON publique
24. Fenêtres de maintenance
25. Credentials centralisés
26. Webhooks entrants pour déclencher un job
27. Webhooks sortants dans les blocs
28. Import/export JSON
29. Anti-spam par incident unique
30. Seuil de temps de réponse HTTP
31. Fallback texte pour anciens scripts

Le mode blocs permet d'ajouter: notification, test de site, test machine, attente, webhook sortant et condition.

Le backend garde aussi un fallback texte pour les scripts déjà créés:

```txt
# commentaires acceptés
notify "Début du contrôle"
http "https://example.com" status 200
tcp "db.local" 5432
sleep 1000
notify "Contrôle terminé"
```

Les variables disponibles dans les messages sont `$JOB_NAME` et `$NOW`.

## API publique pour apps externes

L'API versionnée permet à une autre app d'utiliser ce conteneur comme moteur de planification.

Authentification:

```bash
Authorization: Bearer change-me-dev-key
# ou
x-api-key: change-me-dev-key
```

Endpoints principaux:

- `GET /api/v1/health`: vérifier que l'API répond
- `GET /api/v1/jobs`: lister les jobs
- `POST /api/v1/jobs`: créer un job avec une planification lisible
- `GET /api/v1/jobs/:id`: récupérer un job
- `PUT /api/v1/jobs/:id`: remplacer un job
- `DELETE /api/v1/jobs/:id`: supprimer un job
- `POST /api/v1/jobs/:id/run`: lancer un job maintenant
- `POST /api/v1/jobs/:id/webhook`: déclencher un job avec un payload externe
- `POST /api/v1/jobs/:id/duplicate`: dupliquer un job en pause
- `POST /api/v1/jobs/:id/pause`: mettre un job en pause
- `POST /api/v1/jobs/:id/resume`: reprendre un job
- `GET /api/v1/jobs/:id/runs`: lire l'historique d'exécution
- `GET /api/v1/dashboard`: récupérer le résumé opérationnel
- `GET /api/v1/status`: récupérer la page de statut JSON
- `POST /api/v1/deadman`: créer un dead-man switch
- `ALL /api/v1/deadman/:slug/ping`: ping depuis une tâche externe

Planifications supportées sans expression cron:

```json
{ "mode": "every_minutes", "value": 5 }
{ "mode": "hourly", "value": 2 }
{ "mode": "daily", "time": "09:00" }
{ "mode": "weekly", "weekday": 1, "time": "09:00" }
{ "mode": "monthly", "day": 1, "time": "09:00" }
{ "mode": "once", "runAt": "2026-06-20T09:00:00.000Z" }
```

Créer un check HTTP toutes les 5 minutes:

```bash
curl -X POST http://localhost:4000/api/v1/jobs \
  -H "authorization: Bearer change-me-dev-key" \
  -H "content-type: application/json" \
  -d '{
    "name": "Check API publique",
    "type": "website_check",
    "schedule": { "mode": "every_minutes", "value": 5 },
    "config": {
      "url": "https://example.com",
      "expectedStatus": 200,
      "severity": "critical",
      "message": "Example.com ne repond plus"
    }
  }'
```

Créer une notification quotidienne:

```bash
curl -X POST http://localhost:4000/api/v1/jobs \
  -H "authorization: Bearer change-me-dev-key" \
  -H "content-type: application/json" \
  -d '{
    "name": "Digest quotidien",
    "type": "notification",
    "schedule": { "mode": "daily", "time": "08:30" },
    "config": {
      "message": "Point quotidien a verifier"
    }
  }'
```

Créer un suivi réseau toutes les minutes:

```bash
curl -X POST http://localhost:4000/api/v1/jobs \
  -H "authorization: Bearer change-me-dev-key" \
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
      "notifyOnDown": false,
      "notifyOnRecovery": true,
      "severity": "critical"
    }
  }'
```

Lancer un job immédiatement:

```bash
curl -X POST http://localhost:4000/api/v1/jobs/JOB_ID/run \
  -H "authorization: Bearer change-me-dev-key" \
  -H "content-type: application/json" \
  -d '{ "source": "external-app", "reason": "manual-test" }'
```
