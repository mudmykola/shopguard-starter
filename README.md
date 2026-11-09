# ShopGuard Private Starter

Private-first Shopify development starter and guarded CLI. The CLI lives directly in this repository root; there is no nested `shopguard-cli` project.

## Local install

Requirements: Node.js 22+, Git, and Shopify CLI 4.x or newer.

```bash
npm install
npm run typecheck
npm test
npm link
sgd --help
```

`npm link` installs the local binary only. This package stays private and is not published.

## Safe first project

Plan without writing files:

```bash
sgd init --path ./client-theme --store client.myshopify.com --mode existing
```

Create only local mock scaffolding (no Shopify or GitHub access):

```bash
sgd init --path ./client-theme --store client.myshopify.com --mode new --mock
sgd setup --path ./client-theme
sgd status --path ./client-theme
sgd doctor --path ./client-theme
sgd check --path ./client-theme
```

`sgd dev` prints the explicit Shopify command in dry-run mode. `sgd push` is fail-closed. `sgd pull` writes only an isolated ignored snapshot. `sgd sync` never rebases, resets, stashes, force-pushes, or discards local work.

## Security boundaries

Store domains and theme IDs may be recorded in `.shopguard/project.json`; tokens, private keys, auth caches and customer data may not. Shopify commands always receive an explicit store. `SHOPIFY_FLAG_*` values and theme tokens are stripped from child-process environments. Live themes and GitHub-connected themes are protected.

GitHub HTTPS is the recommended connection method; Keeper SSH Agent is not required. Sign in with GitHub CLI and choose HTTPS, then use a separate private repository for each client. Keep access tokens in the operating system credential store through GitHub CLI; never put them in remote URLs, config files, or logs. See [docs/github-https.md](docs/github-https.md).

## Remote actions requiring owner approval

Create/select a private client GitHub repository, sign in to GitHub over HTTPS, authenticate Shopify for the exact store, connect an unpublished theme to the client repository, push branches, publish a theme, or publish an npm package. This starter does none of those actions automatically.
