import {
	computeThumbprint,
	createExternalAccountBinding,
	exportPrivateKeyPem,
	exportPublicJwk,
	exportPublicKeyPem,
	generateRsaKeyPair,
	importPrivateKeyPem,
	pemCertificateToDerBase64Url
} from "./crypto.js";
import { base64UrlEncodeBuffer, base64UrlEncodeText, sleep } from "./utils.js";

export class AcmeClient {
	constructor(options) {
		this.directoryUrl = String(options && options.directoryUrl ? options.directoryUrl : "").trim();
		this.account = options && options.account ? options.account : null;
		this.directory = null;
		this.nonce = null;
		this.accountSigningKey = null;
	}

	setAccount(account) {
		this.account = account;
		this.accountSigningKey = null;
	}

	async getDirectory(forceReload = false) {
		if (!forceReload && this.directory) {
			return this.directory;
		}

		if (!this.directoryUrl) {
			throw new Error("ACME directory URL is required.");
		}

		const response = await fetch(this.directoryUrl);
		if (!response.ok) {
			throw new Error(`Could not load ACME directory (${response.status}).`);
		}

		const parsed = await parseJsonResponse(response);
		if (!parsed.newNonce || !parsed.newAccount || !parsed.newOrder) {
			throw new Error("Directory response is missing required endpoints.");
		}

		this.directory = parsed;
		return this.directory;
	}

	async consumeNonce() {
		if (this.nonce) {
			const value = this.nonce;
			this.nonce = null;
			return value;
		}

		const directory = await this.getDirectory();
		const response = await fetch(directory.newNonce, { method: "HEAD" });
		const replayNonce = response.headers.get("Replay-Nonce");
		if (!replayNonce) {
			throw new Error("ACME server did not return a nonce.");
		}
		return replayNonce;
	}

	async signedRequest(url, payload, options = {}) {
		const useKid = options.useKid !== false;
		const nonce = await this.consumeNonce();
		const protectedHeader = {
			alg: "RS256",
			nonce,
			url
		};

		if (useKid) {
			const accountUrl = options.accountUrl || (this.account && this.account.accountUrl);
			if (!accountUrl) {
				throw new Error("Missing account URL for authenticated ACME request.");
			}
			protectedHeader.kid = accountUrl;
		} else {
			const requestJwk = options.jwk || (this.account && this.account.key && this.account.key.jwk);
			if (!requestJwk) {
				throw new Error("Missing JWK for unsigned account request.");
			}
			protectedHeader.jwk = requestJwk;
		}

		const signingKey = options.signingKey || (await this.getAccountSigningKey());
		const protectedB64 = base64UrlEncodeText(JSON.stringify(protectedHeader));
		const payloadB64 = payload === null ? "" : base64UrlEncodeText(JSON.stringify(payload));
		const input = `${protectedB64}.${payloadB64}`;

		const signature = await window.crypto.subtle.sign(
			{ name: "RSASSA-PKCS1-v1_5" },
			signingKey,
			new TextEncoder().encode(input)
		);

		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/jose+json"
			},
			body: JSON.stringify({
				protected: protectedB64,
				payload: payloadB64,
				signature: base64UrlEncodeBuffer(signature)
			})
		});

		const replayNonce = response.headers.get("Replay-Nonce");
		if (replayNonce) {
			this.nonce = replayNonce;
		}

		if (!response.ok) {
			const detail = await extractAcmeError(response);
			throw new Error(`ACME request failed (${response.status}): ${detail}`);
		}

		return response;
	}

	async postAsGet(url) {
		const response = await this.signedRequest(url, null);
		return parseJsonResponse(response);
	}

	async registerAccount(input) {
		const options = input || {};
		const directory = await this.getDirectory();
		const accountKeyPair = await generateRsaKeyPair();
		const accountJwk = await exportPublicJwk(accountKeyPair.publicKey);
		const accountThumbprint = await computeThumbprint(accountJwk);

		const payload = {
			termsOfServiceAgreed: options.termsOfServiceAgreed !== false
		};

		if (Array.isArray(options.contactEmails) && options.contactEmails.length > 0) {
			payload.contact = options.contactEmails.map((email) => `mailto:${email}`);
		}

		if (options.eab && options.eab.keyId && options.eab.hmacKey) {
			payload.externalAccountBinding = await createExternalAccountBinding({
				keyId: options.eab.keyId,
				hmacKey: options.eab.hmacKey,
				newAccountUrl: directory.newAccount,
				accountJwk
			});
		}

		const response = await this.signedRequest(directory.newAccount, payload, {
			useKid: false,
			jwk: accountJwk,
			signingKey: accountKeyPair.privateKey
		});

		const accountUrl = response.headers.get("Location") || "";
		if (!accountUrl) {
			throw new Error("Account URL was missing in ACME response.");
		}

		const accountObject = await parseJsonResponse(response);
		const privatePem = await exportPrivateKeyPem(accountKeyPair.privateKey);
		const publicPem = await exportPublicKeyPem(accountKeyPair.publicKey);

		return {
			accountUrl,
			accountObject,
			accountThumbprint,
			key: {
				privatePem,
				publicPem,
				jwk: accountJwk
			}
		};
	}

	async getAccount() {
		if (!this.account || !this.account.accountUrl) {
			throw new Error("No account selected.");
		}
		return this.postAsGet(this.account.accountUrl);
	}

	async updateAccount(payloadPatch) {
		if (!this.account || !this.account.accountUrl) {
			throw new Error("No account selected.");
		}

		const response = await this.signedRequest(this.account.accountUrl, payloadPatch || {});
		return parseJsonResponse(response);
	}

	async deactivateAccount() {
		return this.updateAccount({ status: "deactivated" });
	}

	async fetchAccountOrders() {
		const accountState = await this.getAccount();
		const ordersUrl = accountState && accountState.orders ? accountState.orders : "";
		if (!ordersUrl) {
			return {
				ordersUrl: "",
				orders: []
			};
		}

		const payload = await this.postAsGet(ordersUrl);
		return {
			ordersUrl,
			orders: Array.isArray(payload && payload.orders) ? payload.orders : []
		};
	}

	async rolloverAccountKey() {
		if (!this.account || !this.account.accountUrl || !this.account.key || !this.account.key.jwk) {
			throw new Error("Missing account context for key rollover.");
		}

		const directory = await this.getDirectory();
		if (!directory.keyChange) {
			throw new Error("Directory does not expose keyChange endpoint.");
		}

		const oldJwk = this.account.key.jwk;
		const newKeyPair = await generateRsaKeyPair();
		const newJwk = await exportPublicJwk(newKeyPair.publicKey);
		const newPrivatePem = await exportPrivateKeyPem(newKeyPair.privateKey);
		const newPublicPem = await exportPublicKeyPem(newKeyPair.publicKey);

		const innerProtected = base64UrlEncodeText(JSON.stringify({
			alg: "RS256",
			jwk: newJwk,
			url: directory.keyChange
		}));
		const innerPayload = base64UrlEncodeText(JSON.stringify({
			account: this.account.accountUrl,
			oldKey: oldJwk
		}));
		const innerInput = `${innerProtected}.${innerPayload}`;
		const innerSignature = await window.crypto.subtle.sign(
			{ name: "RSASSA-PKCS1-v1_5" },
			newKeyPair.privateKey,
			new TextEncoder().encode(innerInput)
		);

		const nestedJws = {
			protected: innerProtected,
			payload: innerPayload,
			signature: base64UrlEncodeBuffer(innerSignature)
		};

		await this.signedRequest(directory.keyChange, nestedJws);

		const thumbprint = await computeThumbprint(newJwk);
		return {
			key: {
				privatePem: newPrivatePem,
				publicPem: newPublicPem,
				jwk: newJwk
			},
			thumbprint
		};
	}

	async createOrder(input) {
		const directory = await this.getDirectory();
		const payload = {
			identifiers: input.identifiers
		};

		if (input.profile) {
			payload.profile = input.profile;
		}

		if (input.notBefore) {
			payload.notBefore = input.notBefore;
		}

		if (input.notAfter) {
			payload.notAfter = input.notAfter;
		}

		const response = await this.signedRequest(directory.newOrder, payload);
		const order = await parseJsonResponse(response);
		const orderUrl = response.headers.get("Location") || "";
		return { orderUrl, order };
	}

	async getAuthorization(authorizationUrl) {
		return this.postAsGet(authorizationUrl);
	}

	async triggerChallenge(challengeUrl) {
		const response = await this.signedRequest(challengeUrl, {});
		return parseJsonResponse(response);
	}

	async pollAuthorizations(authorizationUrls, options = {}) {
		const maxAttempts = Number(options.maxAttempts || 20);
		const delayMs = Number(options.delayMs || 3000);
		const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};

		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			const authorizations = [];
			let validCount = 0;

			for (const authorizationUrl of authorizationUrls) {
				const authorization = await this.getAuthorization(authorizationUrl);
				authorizations.push(authorization);

				if (authorization.status === "valid") {
					validCount += 1;
					continue;
				}

				if (authorization.status === "invalid") {
					const identifier = authorization.identifier && authorization.identifier.value ? authorization.identifier.value : "identifier";
					const detail = authorization.error && authorization.error.detail ? authorization.error.detail : "authorization marked invalid";
					throw new Error(`Validation failed for ${identifier}: ${detail}`);
				}
			}

			onProgress({
				attempt,
				maxAttempts,
				validCount,
				total: authorizationUrls.length
			});

			if (validCount === authorizationUrls.length) {
				return authorizations;
			}

			await sleep(delayMs);
		}

		throw new Error("Timed out waiting for authorization validation.");
	}

	async finalizeOrder(finalizeUrl, csr) {
		const response = await this.signedRequest(finalizeUrl, { csr });
		return parseJsonResponse(response);
	}

	async pollOrder(orderUrl, options = {}) {
		const maxAttempts = Number(options.maxAttempts || 20);
		const delayMs = Number(options.delayMs || 3000);
		const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};

		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			const order = await this.postAsGet(orderUrl);

			if (order.status === "valid") {
				return order;
			}

			if (order.status === "invalid") {
				const detail = order.error && order.error.detail ? order.error.detail : "order marked invalid";
				throw new Error(`Order failed: ${detail}`);
			}

			onProgress({
				attempt,
				maxAttempts,
				status: order.status || "pending"
			});
			await sleep(delayMs);
		}

		throw new Error("Timed out waiting for order finalization.");
	}

	async downloadCertificate(certificateUrl) {
		const response = await this.signedRequest(certificateUrl, null);
		const pem = (await response.text()).trim();
		if (!pem.includes("BEGIN CERTIFICATE")) {
			throw new Error("Certificate response did not contain PEM content.");
		}
		return pem;
	}

	async revokeCertificate(certificatePem, reason = 0) {
		const directory = await this.getDirectory();
		if (!directory.revokeCert) {
			throw new Error("Directory does not expose revokeCert endpoint.");
		}

		const certificate = pemCertificateToDerBase64Url(certificatePem);
		await this.signedRequest(directory.revokeCert, {
			certificate,
			reason
		});
	}

	async deactivateAuthorization(authorizationUrl) {
		return this.signedRequest(authorizationUrl, { status: "deactivated" });
	}

	async getAccountSigningKey() {
		if (this.accountSigningKey) {
			return this.accountSigningKey;
		}

		if (!this.account || !this.account.key || !this.account.key.privatePem) {
			throw new Error("Missing account key material.");
		}

		this.accountSigningKey = await importPrivateKeyPem(this.account.key.privatePem);
		return this.accountSigningKey;
	}
}

async function parseJsonResponse(response) {
	const text = await response.text();
	if (!text) {
		return {};
	}

	try {
		return JSON.parse(text);
	} catch (_error) {
		throw new Error("Failed to parse ACME JSON response.");
	}
}

async function extractAcmeError(response) {
	const raw = await response.text();
	if (!raw) {
		return "no details returned";
	}

	try {
		const parsed = JSON.parse(raw);
		if (parsed && parsed.detail) {
			return parsed.detail;
		}
		if (parsed && parsed.type) {
			return parsed.type;
		}
		return raw;
	} catch (_error) {
		return raw;
	}
}
