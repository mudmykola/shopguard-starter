# Private GitHub repositories over HTTPS

Keeper SSH Agent is not required for this workflow. Use the HTTPS URL for the separate private repository created for each client.

1. Sign in to GitHub CLI with `gh auth login` and choose **HTTPS** when asked for Git operations. The credential is stored by GitHub CLI in the operating system's secure credential store.
2. Check access to the exact client repository with `gh repo view OWNER/CLIENT-REPO` or `git ls-remote https://github.com/OWNER/CLIENT-REPO.git`.
3. Clone with `git clone https://github.com/OWNER/CLIENT-REPO.git`, or set that exact HTTPS URL as `origin` after confirming it is the client repository.
4. Never put a personal access token in the URL, shell command, project config, `.env`, Git remote, documentation, or logs. Use the interactive GitHub CLI sign-in and credential helper.
5. Keep the repository private, enable 2FA/passkeys, and grant collaborators only the access they need.

GitHub authentication and Shopify authorization are separate. A working HTTPS GitHub credential does not grant access to a Shopify store. ShopGuard does not need a Keeper integration for GitHub HTTPS and does not store credentials.

Example client remote (fictional): `https://github.com/example-owner/client-theme.git`.
