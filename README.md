# WebACME

WebACME is a minimalist, stateless, client-side ACME interface for Let's Encrypt.

## What It Does

- Uses a clean Bootstrap 5 interface with a Production/Staging mode switch.
- Supports selectable `HTTP-01` and `DNS-01` validation methods.
- Generates all keys in-browser via WebCrypto.
- Creates CSR in-browser via Forge.
- Talks directly to ACME endpoints with `fetch` and signed JWS requests.
- Never stores keys in localStorage/sessionStorage.

Refreshing the page intentionally resets the entire session.

## Files

- `index.html`: page structure, Bootstrap/Forge CDNs, app sections.
- `styles.css`: minimalist visual styling and responsive layout.
- `app.js`: ACME protocol flow and browser crypto logic.

## Local Run

Any static server works. For example:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## User Flow

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
- Use Staging mode first to avoid production rate limits while testing.
