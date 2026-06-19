# Déploiement Cron Master

Ce guide décrit le chemin CI/CD prévu pour Cron Master.

## Pipeline CI

Le workflow `.github/workflows/ci.yml` s'exécute sur chaque push et pull request.

Il vérifie:

1. installation déterministe avec `npm ci`;
2. typage avec `npm run lint`;
3. tests avec `npm test`;
4. build applicatif avec `npm run build`;
5. build Docker des images `api` et `web`;
6. démarrage complet avec Docker Compose;
7. smoke test API via `npm run smoke`;
8. vérification HTTP du front.

## Pipeline CD

Le workflow `.github/workflows/deploy.yml` est manuel (`workflow_dispatch`).

Il fait:

1. build de l'image API;
2. build de l'image Web;
3. push des images dans GHCR;
4. copie de `docker-compose.prod.yml` sur le serveur;
5. génération d'un `.env.production`;
6. `docker compose pull`;
7. `docker compose up -d`;
8. smoke test distant.

## Secrets GitHub requis

Dans GitHub, configure ces secrets:

| Secret | Description |
| --- | --- |
| `DEPLOY_HOST` | Host SSH du serveur |
| `DEPLOY_USER` | Utilisateur SSH |
| `DEPLOY_SSH_KEY` | Clé privée SSH |
| `DEPLOY_PATH` | Dossier cible sur le serveur |
| `CRON_MASTER_API_KEY` | Clé API publique |
| `CRON_MASTER_SETUP_TOKEN` | Token requis pour créer le premier compte admin |
| `POSTGRES_PASSWORD` | Mot de passe PostgreSQL |
| `PUBLIC_API_URL` | URL publique utilisée par le front |

## Préparer le serveur

Le serveur doit avoir:

- Docker;
- Docker Compose v2;
- accès au registre GHCR si les images sont privées;
- un dossier de déploiement, par exemple `/opt/cron-master`.

Le schéma PostgreSQL est créé par l'API au démarrage. Le compose de production ne monte donc aucun fichier `init.sql`, ce qui évite les erreurs de bind mount sur les plateformes où le dossier de stack est en lecture seule.

Création du dossier:

```bash
sudo mkdir -p /opt/cron-master
sudo chown $USER:$USER /opt/cron-master
```

Si les images GHCR sont privées, connecte Docker:

```bash
docker login ghcr.io
```

## Déploiement manuel sans GitHub Actions

Créer le fichier `.env.production` depuis l'exemple:

```bash
cp .env.production.example .env.production
```

Renseigner les images et secrets, puis lancer:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml pull
docker compose --env-file .env.production -f docker-compose.prod.yml up -d
```

Vérifier:

```bash
curl http://localhost:4000/api/v1/health \
  -H "authorization: Bearer $CRON_MASTER_API_KEY"
curl -I http://localhost:3001
```

## Premier compte admin

En production, `CRON_MASTER_SETUP_TOKEN` est obligatoire. Au premier accès web, l'interface demande ce token en plus de l'email et du mot de passe admin. Une fois le premier compte créé, `/auth/register` refuse toute nouvelle création.

Si un compte admin existe déjà alors que tu ne l'as pas créé, reprends la main depuis le serveur après avoir configuré un nouveau `CRON_MASTER_SETUP_TOKEN`:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml exec postgres \
  psql -U cronmaster cronmaster \
  -c "TRUNCATE admin_sessions, admin_users RESTART IDENTITY CASCADE;"
docker compose --env-file .env.production -f docker-compose.prod.yml restart api
```

Ouvre ensuite l'interface web et recrée ton compte avec le token de setup.

## Rollback

Le rollback consiste à relancer le compose avec un tag d'image précédent.

```bash
API_IMAGE=ghcr.io/OWNER/REPO/api:previous \
WEB_IMAGE=ghcr.io/OWNER/REPO/web:previous \
docker compose --env-file .env.production -f docker-compose.prod.yml up -d
```

## Données persistantes

PostgreSQL utilise le volume Docker `postgres-data`. Supprimer ce volume supprime les données.

Sauvegarde simple:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml exec postgres \
  pg_dump -U cronmaster cronmaster > cronmaster.sql
```

Restauration:

```bash
cat cronmaster.sql | docker compose --env-file .env.production -f docker-compose.prod.yml exec -T postgres \
  psql -U cronmaster cronmaster
```
