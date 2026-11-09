# ShopGuard Private Starter

Private-first Shopify theme workflow CLI. Source, tests, package metadata and generated CLI live at this repository root; there is no nested `shopguard-cli` folder. The package is private and must not be published.

## Requirements

- Node.js 22 or newer
- Git
- Shopify CLI 4.x or newer, logged into the intended store
- A separate private GitHub repository for each client project (HTTPS)

## Start a client project

For each client, use GitHub's **Use this template** action to create a separate private client repository, then clone that repository over HTTPS. Do not directly clone this starter as the client repo: ShopGuard intentionally blocks the starter's origin. The template creates independent client Git history.

```bash
git clone https://github.com/OWNER/CLIENT-REPO.git
cd CLIENT-REPO
npm install
npm run check
npm link
sgd configure --store client.myshopify.com
```

Review `.shopguard/project.json` (it is ignored by Git), then run the guided baseline import:

```bash
sgd init
```

For an existing shop, `init` checks the exact configured store, asks you to confirm a Live theme by ID, pulls it into a temporary isolated folder, and previews additions/conflicts. It imports only new files after a second typed confirmation, creates a local `master` baseline, creates `dev` at the same commit, and finishes on `dev`. It never uploads to Shopify or pushes to GitHub. Existing files and branches are preserved.

For a new theme, configure it with `sgd configure --store client.myshopify.com --mode new`. `init` downloads Shopify's default skeleton to a temporary folder and imports only new files after preview. It does not connect to or change the configured store.

`sgd setup` adds local configuration files without replacing existing ones. It does not rewrite `package.json` or install dependencies. To enable optional project-local formatting and linting, install the tools your project uses, for example:

```bash
npm install --save-dev eslint prettier @shopify/prettier-plugin-liquid stylelint
```

## Day-to-day commands

```bash
sgd status
sgd doctor
sgd check
sgd dev
sgd sync --check
sgd pull --preview
sgd preflight --fetch
```

- `dev` verifies the configured store and requires typing `DEV <store>` before Shopify CLI starts a development theme upload.
- `sync --check` requires confirmation before `git fetch --prune origin`, then reports local/remote divergence for current, production, and development branches. Plain `sync` only fast-forwards the current clean branch; it refuses divergent history.
- `pull --preview` downloads the configured or specified theme to `.shopguard/snapshots/`, an ignored directory. `sgd pull --theme <id> --files sections/example.liquid` allows a reviewed import of selected **new** files; conflicts and merchant-managed settings JSON cannot be overwritten.
- `preflight` reports local changes and changed protected merchant JSON. Add `--fetch` to confirm a remote Git fetch, compare production/development divergence and flag remote customizer JSON changes. It does not merge or deploy.
- `lint` runs Shopify Theme Check and ESLint/Stylelint where the project has the relevant configuration and dependencies. `format` operates only on changed files and supports `--check` and `--files`.
- `push` currently fails closed. A safe manual theme upload needs fresh remote-baseline comparison, recovery and post-upload verification; it is not implemented.

## GitHub HTTPS

Keep the client repository private. Sign in with GitHub CLI using HTTPS and create/select the client repository yourself. Never put tokens in `.shopguard/project.json`, remote URLs, shell history or logs. Follow [GitHub HTTPS setup](docs/github-https.md). Keeper SSH Agent is not required.

## Verification and boundaries

Run `npm run check` for typecheck, ESLint and offline automated tests. CI uses fixtures only and has read-only GitHub permissions. Shopify authentication, remote Git fetch, development-theme upload, client repository selection/push, theme GitHub integration and production publishing require the operator to run the corresponding step and confirm its target. ShopGuard does not create repositories, publish packages, or publish a theme.
