# WebACME

WebACME is a client-side ACME interface that now provides both a simple beginner flow and an advanced multi-page ACME client experience.

## Modes

- Simple mode (`/index.html`): beginner-oriented one-flow issuance with stateless behavior.
- Advanced mode (`/advanced/`): power-user multi-page client with account and request lifecycle controls, capability-aware operations, and browser persistence.

## What It Does (Simple Mode)

- Uses a clean Bootstrap 5 interface with a Production/Staging mode switch.
- Supports selectable `HTTP-01` and `DNS-01` validation methods.
- Generates all keys in-browser via WebCrypto.
- Creates CSR in-browser via Forge.
- Talks directly to ACME endpoints with `fetch` and signed JWS requests.
- Does not persist certificate flow state intentionally.

Refreshing the simple mode page resets the session.

## Advanced Mode

Advanced mode behaves like a browser ACME client for ACME v2 workflows and is split into dedicated pages:

- `advanced/index.html`: dashboard with metrics and purge controls.
- `advanced/accounts.html`: ACME Account Management.
- `advanced/requests.html`: Certificate Requests Management.

### Advanced Capabilities

- Provider presets: Let's Encrypt production, Let's Encrypt staging, ZeroSSL, Google Trust Services.
- Custom ACME directory URL support.
- Full EAB input support (`key id`, `HMAC key`) for account registration.
- Account lifecycle operations: register, refresh, contact update, deactivation, key rollover, account orders fetch (capability-gated).
- Request lifecycle operations: create order, render challenge instructions (`http-01` / `dns-01`), submit challenges, poll/finalize, retrieve certificate, duplicate request, delete request.
- Certificate operations: revoke certificate (capability-gated), deactivate authorizations (capability-gated).
- ACME profile field support in order payloads for providers with profile capability.
- Capability matrix driven gating/UX for unsupported or planned features.

### Provider and EAB Policy

- Let's Encrypt presets: EAB not required.
- ZeroSSL and Google Trust Services: EAB required.
- Custom provider: EAB required by default, with explicit override toggle.

### Browser Storage

Advanced mode persists data in browser storage:

- `IndexedDB`: accounts, account key material, requests, order/challenge state, issued certificate artifacts, timelines.
- `localStorage`: lightweight UI preferences (selected/default account/request).

Purge options are available for:

- Accounts only (requests are retained and detached)
- Requests only
- All advanced-mode data

### Advanced Files

- `advanced/advanced.css`: advanced layout/components while reusing root design tokens.
- `advanced/js/constants.js`: provider presets + capability matrix.
- `advanced/js/storage.js`: IndexedDB persistence and purge behaviors.
- `advanced/js/crypto.js`: key utilities, CSR generation, EAB JWS creation.
- `advanced/js/acme-client.js`: ACME client protocol/signing logic.
- `advanced/js/ui.js`: shared advanced UI helpers.
- `advanced/js/dashboard.js`: dashboard behavior.
- `advanced/js/accounts.js`: account management behavior.
- `advanced/js/requests.js`: request management behavior.

## Files

- `index.html`: simple-mode page structure.
- `styles.css`: shared visual styling and responsive layout.
- `app.js`: simple-mode ACME flow.
- `advanced/`: advanced multi-page client.

## Local Run

Any static server works. For example:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Simple Mode User Flow

1. Review the intro notice and click **Continue**.
2. Enter domains and optional email.
3. Choose `HTTP-01` or `DNS-01`.
4. Click **Generate Certificate**.
5. Complete challenge requirements shown in copyable code blocks.
6. For `HTTP-01`, open the check link in a new tab to verify file reachability.
7. For `DNS-01`, use the DNS check button to verify TXT propagation.
8. Click **Verify My Domain**.
9. Copy certificate and private key from the results section.

## Notes

- `http-01` requires each domain to be reachable over HTTP.
- Wildcard domains are allowed only when using `dns-01`.
- Use staging mode first to avoid production rate limits while testing.
