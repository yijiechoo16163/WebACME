# WebACME

WebACME is a static, browser-only ACME client prototype for issuing certificates from Let's Encrypt without backend code.

## What It Does

- Runs entirely in the browser (HTML/CSS/JS).
- Uses WebCrypto for account/domain key generation and request signing.
- Calls Let's Encrypt ACME v2 endpoints directly with `fetch` (CORS-enabled).
- Builds CSR data in-browser using `forge`.
- Provides a 4-step Bootstrap UI flow.
- Step 1: Identity and account/order setup.
- Step 2: Challenge details (http-01 or dns-01).
- Step 3: CSR generation and order finalization.
- Step 4: Certificate/key download.

## Files

- `index.html`: SPA shell and dependencies (Bootstrap + forge via CDN with SRI).
- `styles.css`: custom visual theme, responsive layout, and stepper styles.
- `app.js`: ACME flow implementation, WebCrypto helpers, CSR generation, and file downloads.

## Run Locally

Because this app uses browser APIs and cross-origin requests, use an HTTP server instead of opening the file directly:

```bash
cd /workspaces/WebACME
python3 -m http.server 8080
```

Then open <http://localhost:8080>.

## Deploy on GitHub Pages

1. Push this repository to GitHub.
2. In repository settings, open Pages.
3. Set source to `Deploy from a branch` and choose `main` + `/ (root)`.
4. Save and wait for the Pages URL.

## Important Safety Notes

- This is a client-side prototype. If the page is refreshed mid-flow, in-memory keys/progress can be lost.
- A `window.onbeforeunload` warning is included to reduce accidental data loss.
- Use Let's Encrypt **staging** first to avoid production rate limits.
- No backend means no server-side recovery of lost keys.

## Current Scope

- Single-domain flow is implemented.
- Account and domain private key export buttons are included.
- Session reset clears runtime state and localStorage.

## Disclaimer

Use for testing and educational purposes first. For production-grade certificate automation, add stronger persistence, robust retries, richer validation, and full multi-authorization handling.
