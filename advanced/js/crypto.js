import { base64UrlDecodeToBytes, base64UrlEncodeBuffer, base64UrlEncodeText } from "./utils.js";

export async function generateRsaKeyPair() {
	return window.crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256"
		},
		true,
		["sign", "verify"]
	);
}

export async function exportPublicJwk(publicKey) {
	return window.crypto.subtle.exportKey("jwk", publicKey);
}

export async function exportPrivateKeyPem(privateKey) {
	const pkcs8 = await window.crypto.subtle.exportKey("pkcs8", privateKey);
	return toPem("PRIVATE KEY", pkcs8);
}

export async function exportPublicKeyPem(publicKey) {
	const spki = await window.crypto.subtle.exportKey("spki", publicKey);
	return toPem("PUBLIC KEY", spki);
}

export async function importPrivateKeyPem(privatePem) {
	const buffer = pemToArrayBuffer(privatePem, "PRIVATE KEY");
	return window.crypto.subtle.importKey(
		"pkcs8",
		buffer,
		{
			name: "RSASSA-PKCS1-v1_5",
			hash: "SHA-256"
		},
		false,
		["sign"]
	);
}

export async function computeThumbprint(jwk) {
	const canonical = JSON.stringify({
		e: jwk.e,
		kty: jwk.kty,
		n: jwk.n
	});

	const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
	return base64UrlEncodeBuffer(digest);
}

export async function computeDnsTxtValue(keyAuthorization) {
	const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(keyAuthorization || "")));
	return base64UrlEncodeBuffer(digest);
}

export async function createCsrBase64Url(domainKeyPair, identifiers) {
	if (!window.forge) {
		throw new Error("Forge is required to generate CSR.");
	}

	const normalizedIdentifiers = Array.isArray(identifiers)
		? identifiers
			.map((item) => {
				if (typeof item === "string") {
					return {
						type: isIpLiteral(item) ? "ip" : "dns",
						value: item
					};
				}

				if (!item || typeof item.value !== "string") {
					return null;
				}

				return {
					type: item.type === "ip" ? "ip" : "dns",
					value: item.value
				};
			})
			.filter(Boolean)
		: [];

	if (!normalizedIdentifiers.length) {
		throw new Error("At least one identifier is required for CSR creation.");
	}

	const privatePem = await exportPrivateKeyPem(domainKeyPair.privateKey);
	const publicPem = await exportPublicKeyPem(domainKeyPair.publicKey);
	const privateKey = window.forge.pki.privateKeyFromPem(privatePem);
	const publicKey = window.forge.pki.publicKeyFromPem(publicPem);

	const csr = window.forge.pki.createCertificationRequest();
	csr.publicKey = publicKey;
	csr.setSubject([
		{
			name: "commonName",
			value: normalizedIdentifiers[0].value
		}
	]);

	csr.setAttributes([
		{
			name: "extensionRequest",
			extensions: [
				{
					name: "subjectAltName",
					altNames: normalizedIdentifiers.map((identifier) => {
						if (identifier.type === "ip") {
							return {
								type: 7,
								ip: identifier.value
							};
						}

						return {
							type: 2,
							value: identifier.value
						};
					})
				}
			]
		}
	]);

	csr.sign(privateKey, window.forge.md.sha256.create());

	if (!csr.verify()) {
		throw new Error("Generated CSR failed verification.");
	}

	const asn1 = window.forge.pki.certificationRequestToAsn1(csr);
	const derBinary = window.forge.asn1.toDer(asn1).getBytes();
	const csrBytes = binaryStringToArrayBuffer(derBinary);
	return base64UrlEncodeBuffer(csrBytes);
}

export async function createExternalAccountBinding(input) {
	const keyId = String(input && input.keyId ? input.keyId : "").trim();
	const hmacKey = String(input && input.hmacKey ? input.hmacKey : "").trim();
	const newAccountUrl = String(input && input.newAccountUrl ? input.newAccountUrl : "").trim();
	const accountJwk = input && input.accountJwk ? input.accountJwk : null;

	if (!keyId || !hmacKey || !newAccountUrl || !accountJwk) {
		throw new Error("EAB requires key ID, HMAC key, account key, and newAccount endpoint.");
	}

	const protectedHeader = {
		alg: "HS256",
		kid: keyId,
		url: newAccountUrl
	};
	const protectedB64 = base64UrlEncodeText(JSON.stringify(protectedHeader));
	const payloadB64 = base64UrlEncodeText(JSON.stringify(accountJwk));
	const signingInput = `${protectedB64}.${payloadB64}`;
	const keyMaterial = decodeMaybeBase64Url(hmacKey);

	const importedHmacKey = await window.crypto.subtle.importKey(
		"raw",
		keyMaterial,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);

	const signature = await window.crypto.subtle.sign("HMAC", importedHmacKey, new TextEncoder().encode(signingInput));

	return {
		protected: protectedB64,
		payload: payloadB64,
		signature: base64UrlEncodeBuffer(signature)
	};
}

export function pemCertificateToDerBase64Url(certificatePem) {
	const base64 = String(certificatePem || "")
		.replace(/-----BEGIN CERTIFICATE-----/g, "")
		.replace(/-----END CERTIFICATE-----/g, "")
		.replace(/\s+/g, "")
		.trim();

	if (!base64) {
		throw new Error("Certificate PEM is empty.");
	}

	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);

	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}

	return base64UrlEncodeBuffer(bytes);
}

function decodeMaybeBase64Url(rawValue) {
	try {
		const bytes = base64UrlDecodeToBytes(rawValue);
		if (bytes.length > 0) {
			return bytes;
		}
	} catch (_error) {
		// Fall back to raw text bytes.
	}

	return new TextEncoder().encode(rawValue);
}

function toPem(label, keyBuffer) {
	const bytes = new Uint8Array(keyBuffer);
	let binary = "";
	const chunk = 0x8000;

	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}

	const base64 = btoa(binary);
	const chunks = base64.match(/.{1,64}/g) || [];
	return `-----BEGIN ${label}-----\n${chunks.join("\n")}\n-----END ${label}-----`;
}

function pemToArrayBuffer(pem, label) {
	const begin = `-----BEGIN ${label}-----`;
	const end = `-----END ${label}-----`;
	const normalized = String(pem || "").replace(begin, "").replace(end, "").replace(/\s+/g, "");
	if (!normalized) {
		throw new Error(`Invalid PEM format for ${label}.`);
	}

	const binary = atob(normalized);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

function binaryStringToArrayBuffer(binary) {
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function isIpLiteral(value) {
	const text = String(value || "").trim();
	if (!text) {
		return false;
	}

	if (/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(text)) {
		return true;
	}

	return text.includes(":");
}
