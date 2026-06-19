# Convention de commits

Cron Master utilise une convention proche de Conventional Commits, adaptée aux messages courts en français.

## Format obligatoire

```txt
type(scope): résumé court
```

Exemples valides:

```txt
fix(mobile): adapter les formulaires tactiles
fix(mobile): stabiliser la navigation basse
feat(mobile): améliorer l'installation PWA
docs(notifications): ajouter le guide de configuration des canaux
docs(notifications): documenter les canaux et leur sécurité
chore(notifications): automatiser les envois avec docker compose
feat(notifications): envoyer les rappels sur plusieurs canaux
```

## Règles

| Élément | Règle |
| --- | --- |
| `type` | Obligatoire, en minuscules |
| `scope` | Obligatoire, entre parenthèses |
| `résumé` | Obligatoire, sans point final |
| longueur | 100 caractères maximum |
| langue | Français recommandé |

## Types acceptés

| Type | Quand l'utiliser |
| --- | --- |
| `feat` | Nouvelle fonctionnalité |
| `fix` | Correction de bug |
| `docs` | Documentation |
| `ci` | Pipeline CI/CD |
| `chore` | Maintenance sans impact produit |
| `refactor` | Refactor sans changement fonctionnel |
| `test` | Tests |
| `build` | Build, dépendances, packaging |
| `perf` | Performance |
| `style` | Formatage ou style sans logique |
| `revert` | Annulation d'un commit |

## Scopes acceptés

```txt
api, auth, ci, database, deploy, docker, docs, incidents, jobs, logs,
mobile, monitoring, network, notifications, ops, repo, settings, tests,
ui, web, workflow
```

Choisis le scope le plus précis. Exemples:

- `fix(incidents): masquer les incidents résolus`
- `feat(logs): afficher les détails techniques des runs`
- `ci(deploy): publier les images sur ghcr`
- `docs(api): documenter les endpoints publics`

## Installation locale du hook

Les hooks sont fournis avec Husky.

```bash
npm install
npm run prepare
```

Le hook `.husky/commit-msg` lance `commitlint` à chaque commit.

## Vérifier un message à la main

```bash
echo "feat(network): ajouter le timer de panne" | npx commitlint
```

Tester le dernier commit:

```bash
npm run commitlint:sample
```

## CI

Le workflow GitHub Actions vérifie aussi les messages:

- sur pull request: tous les commits de la PR;
- sur push: les commits poussés.

Un commit mal formé bloque la CI.
