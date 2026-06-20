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
| `SESSION_SECRET` | Secret long et aléatoire pour signer les sessions |
| `CREDENTIALS_SECRET` | Secret long et aléatoire pour chiffrer les credentials |
| `POSTGRES_PASSWORD` | Mot de passe PostgreSQL |

Secrets optionnels:

| Secret | Description |
| --- | --- |
| `CRON_MASTER_API_KEY` | Clé API publique legacy pleine permission. Préférer les tokens scopés créés dans l'interface web. |
| `CRON_MASTER_BLOCK_PRIVATE_TARGETS` | Mettre `true` pour refuser les checks HTTP/TCP vers des IP privées depuis les jobs. |
| `CORS_ORIGIN` | Origines navigateur autorisées pour l'API, séparées par des virgules. Vide par défaut en production. |

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

Le frontend ne doit pas appeler directement `localhost:4000` depuis le navigateur. Les appels d'administration passent par `/api/backend/...` sur le service web, puis Next relaie côté serveur vers `API_URL=http://api:4000` dans le réseau Docker.

Vérifier:

```bash
curl http://localhost:4000/api/v1/health \
  -H "authorization: Bearer $CRON_MASTER_TOKEN"
curl -I http://localhost:3001
```

## Premier compte admin

Au premier accès web, l'interface demande seulement l'email et le mot de passe du compte admin. Une fois le premier compte créé, `/auth/register` refuse toute nouvelle création.

## Tokens API publics

Après la première connexion admin:

1. ouvre `Settings`;
2. va dans `API publique`;
3. crée un token avec les scopes nécessaires;
4. copie le token affiché une seule fois;
5. colle-le dans le champ de test pour vérifier `/api/v1/health`.

Les tokens sont stockés hashés en base. Un token peut être révoqué depuis l'interface. `CRON_MASTER_API_KEY` reste accepté si la variable est définie, mais il agit comme une clé legacy avec toutes les permissions.

Si un compte admin existe déjà alors que tu ne l'as pas créé, reprends la main depuis le serveur:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml exec postgres \
  psql -U cronmaster cronmaster \
  -c "TRUNCATE \"session\", admin_users RESTART IDENTITY CASCADE;"
docker compose --env-file .env.production -f docker-compose.prod.yml restart api
```

Ouvre ensuite l'interface web et recrée ton compte.

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
