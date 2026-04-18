# WebACME

WebACME is a browser-only ACME client prototype for managing ACME accounts and requesting certificates without backend code.

## App Structure

The UI now uses page-style top navigation:

1. Account Manager page
2. Request Cert page
3. Revoke Cert page (placeholder for future implementation)

The top-right action button is now Purge Saved Accounts, which removes all saved ACME accounts from browser storage.

## Features

- Runs entirely in the browser (HTML/CSS/JS).
- Uses WebCrypto for account and domain key generation and request signing.
- Calls ACME directory/order/challenge endpoints directly with fetch.
- Builds CSR data in-browser with forge.
- Supports provider-aware certificate profiles and identifier types (DNS/IP for supported profiles).
- Stores multiple ACME accounts locally with nickname, provider, environment, and creation timestamp.
- Supports account selection, rename, delete, export, and import from Account Manager.
- Request Cert page drives the issuance workflow from configuration through certificate download.

## Storage Model

- Saved ACME account records are stored in browser local storage.
- Export/import uses JSON files so accounts can be moved across devices/browsers.
- Purge Saved Accounts removes the saved account store from this browser.

## Files

- index.html: App shell, top navigation, shared layout, and CDN dependencies.
- styles.css: Theme styling, responsive layout, and account table styling.
- app.js: Navigation state, account manager logic, ACME request flow, and storage helpers.

## Run Locally

Use an HTTP server instead of opening files directly:

```bash
cd /workspaces/WebACME
python3 -m http.server 8080
```

Then open http://localhost:8080.

## Deploy on GitHub Pages

1. Push this repository to GitHub.
2. In repository settings, open Pages.
3. Set source to Deploy from a branch and choose main + / (root).
4. Save and wait for the Pages URL.

## Notes

- This project is a prototype and should be tested with staging before production.
- Since account keys can be stored locally and exported, treat browser profile and export files as sensitive.
- Revoke Cert page is intentionally scaffolded for future work.
