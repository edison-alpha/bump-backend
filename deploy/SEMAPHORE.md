# Semaphore templates for bump

Two ways to deploy, both end at `bump-backend.service` on the VPS (port 7000, `https://api.paymom3nts.xyz`).
Only the bump service is restarted; sama, trackboard and mom3 are never touched.

## A. Semaphore UI (the one with the Ansible templates, same project as "Deploy Sama BE")

Reuse the existing Key Store entry (the VPS ssh key) and the inventory that has `[vps]`. Add two repositories and two templates:

| Repository | URL | Branch |
|---|---|---|
| bump-backend | `https://github.com/edison-alpha/bump-backend.git` | `main` |
| bump-packages | `https://github.com/edison-alpha/bump-packages.git` | `main` |

| Template | Repository | Playbook | Inventory | When to run |
|---|---|---|---|---|
| **Deploy Bump BE** | bump-backend | `deploy/bump.yml` | the `vps` inventory | backend changed (it pulls packages too) |
| **Deploy Bump Packages** | bump-packages | `deploy/bump-packages.yml` | the `vps` inventory | only packages changed |

App type **Ansible**, no environment or extra vars needed. Both playbooks run `scripts/deploy-remote.sh` on the VPS:
`git pull --ff-only`, `bun install`, `systemctl restart bump-backend`, then wait for `/api/health`.

The repositories are public, so no git credentials are needed. Do not add the production `.env` anywhere in Semaphore:
it lives only on the VPS at `~/bump/bump-backend/.env`.

## B. Semaphore CI (`.semaphore/*.yml`, in both repos)

Every push runs `bunx tsc --noEmit` and `bun test`. "Deploy to VPS" is a manual promotion that needs a Semaphore secret
named `bump-vps` with `VPS_HOST`, `VPS_USER` and the deploy key mounted at `~/.ssh/id_ed25519`.

Order for a change that touches both repos: push packages first, then backend, then run **Deploy Bump BE** once
(it pulls both). For a packages-only change run **Deploy Bump Packages**.