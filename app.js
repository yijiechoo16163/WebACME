const DIRECTORY_URLS = {
	production: "https://acme-v02.api.letsencrypt.org/directory",
	staging: "https://acme-staging-v02.api.letsencrypt.org/directory"
};

const state = {
	directoryUrl: DIRECTORY_URLS.production,
	challengeType: "http-01",
	directory: null,
	nonce: null,
	accountKeyPair: null,
	accountJwk: null,
	accountThumbprint: "",
	accountUrl: "",
	orderUrl: "",
	finalizeUrl: "",
	authorizationUrls: [],
	challenges: [],
	domains: [],
	domainKeyPair: null,
	domainPrivatePem: "",
	certificatePem: "",
	inFlight: false
};

const ui = {
	modeSwitch: document.getElementById("modeSwitch"),
	modeLabel: document.getElementById("modeLabel"),
	startForm: document.getElementById("startForm"),
	challengeTypeInput: document.getElementById("challengeTypeInput"),
	domainsInput: document.getElementById("domainsInput"),
	emailInput: document.getElementById("emailInput"),
	generateBtn: document.getElementById("generateBtn"),
	instructionsSection: document.getElementById("instructionsSection"),
	instructionsSubtitle: document.getElementById("instructionsSubtitle"),
	challengeList: document.getElementById("challengeList"),
	verifyBtn: document.getElementById("verifyBtn"),
	resultsSection: document.getElementById("resultsSection"),
	certificateOutput: document.getElementById("certificateOutput"),
	privateKeyOutput: document.getElementById("privateKeyOutput"),
	statusMessage: document.getElementById("statusMessage"),
	errorMessage: document.getElementById("errorMessage"),
	copyButtons: Array.from(document.querySelectorAll(".copy-btn"))
};

init();

function init() {
	applyModeFromSwitch();
	bindEvents();

	if (!window.crypto || !window.crypto.subtle) {
		showError("WebCrypto is required, but this browser does not support it.");
	}

	if (!window.forge) {
		showError("Forge failed to load. Check your internet connection and refresh.");
	}
}

function bindEvents() {
	ui.modeSwitch.addEventListener("change", handleModeChange);
	ui.challengeTypeInput.addEventListener("change", handleChallengeTypeChange);
	ui.startForm.addEventListener("submit", handleGenerate);
	ui.verifyBtn.addEventListener("click", handleVerify);
	ui.copyButtons.forEach((button) => {
		button.addEventListener("click", handleCopy);
	});
}

function handleChallengeTypeChange() {
	state.challengeType = ui.challengeTypeInput.value === "dns-01" ? "dns-01" : "http-01";

	if (!state.inFlight) {
		clearAcmeSession();
		clearFlowOutput();
	}

	clearError();
	setStatus(`${readableChallengeType(state.challengeType)} selected.`);
}

function applyModeFromSwitch() {
	const isStaging = ui.modeSwitch.checked;
	state.directoryUrl = isStaging ? DIRECTORY_URLS.staging : DIRECTORY_URLS.production;
	ui.modeLabel.textContent = isStaging ? "Staging" : "Production";
}

function handleModeChange() {
	const hadSession = Boolean(state.orderUrl || state.challenges.length || state.certificatePem);
	applyModeFromSwitch();
	clearAcmeSession();
	clearFlowOutput();
	clearError();

	if (hadSession) {
		setStatus(`Switched to ${ui.modeLabel.textContent.toLowerCase()} mode. Previous session reset.`);
	} else {
		setStatus(`Ready in ${ui.modeLabel.textContent.toLowerCase()} mode.`);
	}
}

async function handleGenerate(event) {
	event.preventDefault();
	if (state.inFlight) {
		return;
	}

	clearError();

	const rawDomains = ui.domainsInput.value.trim();
	const email = ui.emailInput.value.trim();
	const domains = parseDomains(rawDomains);
	const challengeType = ui.challengeTypeInput.value === "dns-01" ? "dns-01" : "http-01";
	state.challengeType = challengeType;

	if (!domains.length) {
		showError("Enter at least one domain name.");
		return;
	}

	const invalidDomains = domains.filter((domain) => !isLikelyDomain(domain, challengeType));
	if (invalidDomains.length > 0) {
		showError(`Invalid domain format for ${readableChallengeType(challengeType)}: ${invalidDomains.join(", ")}`);
		return;
	}

	if (email && !isLikelyEmail(email)) {
		showError("Email format looks invalid.");
		return;
	}

	if (!window.crypto || !window.crypto.subtle || !window.forge) {
		showError("Required browser crypto components are unavailable.");
		return;
	}

	clearAcmeSession();
	clearFlowOutput();
	state.domains = domains;

	setLoading(true, "Preparing ACME account and order...");

	try {
		await getDirectory();
		await createAccount(email);
		await createOrder(domains, challengeType);
		renderChallenges();
		ui.instructionsSection.classList.remove("d-none");
		ui.verifyBtn.disabled = false;
		setStatus(`${readableChallengeType(challengeType)} instructions are ready. Complete them, then click Verify My Domain.`);
	} catch (error) {
		showError(normalizeError(error));
		setStatus("Could not create a challenge order.");
	} finally {
		setLoading(false);
	}
}

async function handleVerify() {
	if (state.inFlight) {
		return;
	}

	clearError();

	if (!state.challenges.length || !state.orderUrl || !state.finalizeUrl) {
		showError("No active order was found. Generate a certificate order first.");
		return;
	}

	setLoading(true, "Submitting verification requests...");

	try {
		for (const challenge of state.challenges) {
			await acmeSignedRequest(challenge.challengeUrl, {});
		}

		await waitForAuthorizationsValid();

		setStatus("Generating domain private key...");
		state.domainKeyPair = await generateRsaKeyPair();
		state.domainPrivatePem = await exportPrivateKeyPem(state.domainKeyPair.privateKey);

		setStatus("Creating CSR...");
		const csr = await createCsrBase64Url(state.domainKeyPair, state.domains);

		setStatus("Finalizing order...");
		await acmeSignedRequest(state.finalizeUrl, { csr });

		const validOrder = await waitForOrderValid();
		if (!validOrder.certificate) {
			throw new Error("CA did not provide a certificate URL.");
		}

		setStatus("Downloading certificate...");
		const certResponse = await acmeSignedRequest(validOrder.certificate, null);
		const certificatePem = (await certResponse.text()).trim();

		if (!certificatePem.includes("BEGIN CERTIFICATE")) {
			throw new Error("Certificate response did not contain PEM output.");
		}

		state.certificatePem = certificatePem;
		ui.certificateOutput.value = state.certificatePem;
		ui.privateKeyOutput.value = state.domainPrivatePem;
		ui.resultsSection.classList.remove("d-none");
		setStatus("Certificate issued successfully.");
	} catch (error) {
		showError(normalizeError(error));
		setStatus("Verification failed. Confirm challenge files and try again.");
	} finally {
		setLoading(false);
	}
}

async function createAccount(email) {
	setStatus("Generating account key...");
	state.accountKeyPair = await generateRsaKeyPair();
	state.accountJwk = await window.crypto.subtle.exportKey("jwk", state.accountKeyPair.publicKey);
	state.accountThumbprint = await computeRsaThumbprint(state.accountJwk);

	const directory = await getDirectory();
	const payload = { termsOfServiceAgreed: true };

	if (email) {
		payload.contact = [`mailto:${email}`];
	}

	setStatus("Registering account...");
	const response = await acmeSignedRequest(directory.newAccount, payload, { useKid: false });
	state.accountUrl = response.headers.get("Location") || "";

	if (!state.accountUrl) {
		throw new Error("Account URL missing in ACME response.");
	}
}

async function createOrder(domains, challengeType) {
	const directory = await getDirectory();
	const payload = {
		identifiers: domains.map((domain) => ({ type: "dns", value: domain }))
	};

	setStatus("Creating certificate order...");
	const orderResponse = await acmeSignedRequest(directory.newOrder, payload);
	const orderBody = await parseJson(orderResponse);

	state.orderUrl = orderResponse.headers.get("Location") || "";
	state.finalizeUrl = orderBody.finalize || "";
	state.authorizationUrls = Array.isArray(orderBody.authorizations) ? orderBody.authorizations : [];

	if (!state.orderUrl || !state.finalizeUrl || !state.authorizationUrls.length) {
		throw new Error("Order response was incomplete.");
	}

	setStatus("Loading challenge details...");
	state.challenges = [];

	for (const authorizationUrl of state.authorizationUrls) {
		const authResponse = await acmeSignedRequest(authorizationUrl, null);
		const authorization = await parseJson(authResponse);

		const domain = authorization.identifier && authorization.identifier.value;
		const challenge = (authorization.challenges || []).find((item) => item.type === challengeType);

		if (!domain || !challenge) {
			throw new Error(`${readableChallengeType(challengeType)} challenge is unavailable for ${domain || "a requested domain"}.`);
		}

		if (authorization.status === "invalid") {
			const detail = authorization.error && authorization.error.detail ? authorization.error.detail : "authorization invalid";
			throw new Error(`Authorization failed for ${domain}: ${detail}`);
		}

		const keyAuthorization = `${challenge.token}.${state.accountThumbprint}`;
		const dnsHost = `_acme-challenge.${domain.replace(/^\*\./, "")}`;
		const dnsValue = challengeType === "dns-01"
			? await computeDnsTxtValue(keyAuthorization)
			: "";
		const httpPath = `.well-known/acme-challenge/${challenge.token}`;
		const httpCheckUrl = `http://${domain.replace(/^\*\./, "")}/${httpPath}`;

		state.challenges.push({
			domain,
			challengeType,
			authorizationUrl,
			challengeUrl: challenge.url,
			keyAuthorization,
			httpPath,
			httpCheckUrl,
			dnsHost,
			dnsValue
		});
	}
}

async function computeDnsTxtValue(keyAuthorization) {
	const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(keyAuthorization));
	return base64UrlEncodeBuffer(digest);
}

async function waitForAuthorizationsValid(maxAttempts = 18, delayMs = 3000) {
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		let validCount = 0;

		for (const authorizationUrl of state.authorizationUrls) {
			const authResponse = await acmeSignedRequest(authorizationUrl, null);
			const authorization = await parseJson(authResponse);
			const status = authorization.status;

			if (status === "valid") {
				validCount += 1;
				continue;
			}

			if (status === "invalid") {
				const domain = authorization.identifier && authorization.identifier.value ? authorization.identifier.value : "domain";
				const detail = authorization.error && authorization.error.detail ? authorization.error.detail : "challenge marked invalid";
				throw new Error(`Validation failed for ${domain}: ${detail}`);
			}
		}

		if (validCount === state.authorizationUrls.length) {
			return;
		}

		setStatus(`Waiting for ACME validation (${attempt}/${maxAttempts})...`);
		await delay(delayMs);
	}

	throw new Error("Timed out waiting for domain validation.");
}

async function waitForOrderValid(maxAttempts = 18, delayMs = 3000) {
	let latestOrder = null;

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const response = await acmeSignedRequest(state.orderUrl, null);
		latestOrder = await parseJson(response);

		if (latestOrder.status === "valid") {
			return latestOrder;
		}

		if (latestOrder.status === "invalid") {
			const detail = latestOrder.error && latestOrder.error.detail ? latestOrder.error.detail : "order marked invalid";
			throw new Error(`Order finalization failed: ${detail}`);
		}

		setStatus(`Waiting for certificate issuance (${attempt}/${maxAttempts})...`);
		await delay(delayMs);
	}

	throw new Error("Timed out waiting for certificate issuance.");
}

async function acmeSignedRequest(url, payload, options = {}) {
	const useKid = options.useKid !== false;
	const nonce = await consumeNonce();

	const protectedHeader = {
		alg: "RS256",
		nonce,
		url
	};

	if (useKid) {
		if (!state.accountUrl) {
			throw new Error("Missing account URL.");
		}
		protectedHeader.kid = state.accountUrl;
	} else {
		if (!state.accountJwk) {
			throw new Error("Missing account key.");
		}
		protectedHeader.jwk = state.accountJwk;
	}

	const protectedB64 = base64UrlEncodeText(JSON.stringify(protectedHeader));
	const payloadB64 = payload === null ? "" : base64UrlEncodeText(JSON.stringify(payload));
	const signingInput = `${protectedB64}.${payloadB64}`;

	const signature = await window.crypto.subtle.sign(
		{ name: "RSASSA-PKCS1-v1_5" },
		state.accountKeyPair.privateKey,
		new TextEncoder().encode(signingInput)
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
		state.nonce = replayNonce;
	}

	if (!response.ok) {
		const detail = await extractAcmeError(response);
		throw new Error(`ACME request failed (${response.status}): ${detail || response.statusText}`);
	}

	return response;
}

async function getDirectory() {
	if (state.directory) {
		return state.directory;
	}

	const response = await fetch(state.directoryUrl);
	if (!response.ok) {
		throw new Error(`Could not load ACME directory (${response.status}).`);
	}

	state.directory = await parseJson(response);

	if (!state.directory.newNonce || !state.directory.newAccount || !state.directory.newOrder) {
		throw new Error("ACME directory response is missing required endpoints.");
	}

	return state.directory;
}

async function consumeNonce() {
	if (state.nonce) {
		const nonce = state.nonce;
		state.nonce = null;
		return nonce;
	}

	const directory = await getDirectory();
	const response = await fetch(directory.newNonce, {
		method: "HEAD"
	});

	const nonce = response.headers.get("Replay-Nonce");
	if (!nonce) {
		throw new Error("ACME server did not return a nonce.");
	}

	return nonce;
}

async function generateRsaKeyPair() {
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

async function computeRsaThumbprint(jwk) {
	const canonical = JSON.stringify({
		e: jwk.e,
		kty: jwk.kty,
		n: jwk.n
	});

	const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
	return base64UrlEncodeBuffer(digest);
}

async function createCsrBase64Url(domainKeyPair, domains) {
	const privatePem = await exportPrivateKeyPem(domainKeyPair.privateKey);
	const publicPem = await exportPublicKeyPem(domainKeyPair.publicKey);

	const privateKey = forge.pki.privateKeyFromPem(privatePem);
	const publicKey = forge.pki.publicKeyFromPem(publicPem);

	const csr = forge.pki.createCertificationRequest();
	csr.publicKey = publicKey;
	csr.setSubject([
		{
			name: "commonName",
			value: domains[0]
		}
	]);

	csr.setAttributes([
		{
			name: "extensionRequest",
			extensions: [
				{
					name: "subjectAltName",
					altNames: domains.map((domain) => ({
						type: 2,
						value: domain
					}))
				}
			]
		}
	]);

	csr.sign(privateKey, forge.md.sha256.create());

	if (!csr.verify()) {
		throw new Error("Generated CSR failed verification.");
	}

	const asn1 = forge.pki.certificationRequestToAsn1(csr);
	const derBinary = forge.asn1.toDer(asn1).getBytes();
	return base64UrlEncodeBuffer(binaryStringToArrayBuffer(derBinary));
}

async function exportPrivateKeyPem(privateKey) {
	const pkcs8 = await window.crypto.subtle.exportKey("pkcs8", privateKey);
	return toPem("PRIVATE KEY", pkcs8);
}

async function exportPublicKeyPem(publicKey) {
	const spki = await window.crypto.subtle.exportKey("spki", publicKey);
	return toPem("PUBLIC KEY", spki);
}

function toPem(label, keyBuffer) {
	const base64 = arrayBufferToBase64(keyBuffer);
	const chunks = base64.match(/.{1,64}/g) || [];
	return `-----BEGIN ${label}-----\n${chunks.join("\n")}\n-----END ${label}-----`;
}

function parseDomains(value) {
	const parts = value
		.split(",")
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean);

	return Array.from(new Set(parts));
}

function isLikelyDomain(domain, challengeType) {
	const allowWildcard = challengeType === "dns-01";
	let testDomain = domain;

	if (domain.startsWith("*.")) {
		if (!allowWildcard) {
			return false;
		}
		testDomain = domain.slice(2);
	}

	if (testDomain.includes("*")) {
		return false;
	}

	const pattern = /^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i;

	if (challengeType === "http-01" && /^\d+\.\d+\.\d+\.\d+$/.test(testDomain)) {
		return false;
	}

	return pattern.test(testDomain);
}

function isLikelyEmail(value) {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function renderChallenges() {
	ui.challengeList.innerHTML = "";
	ui.instructionsSubtitle.textContent = state.challengeType === "dns-01"
		? "Create each DNS TXT record exactly as shown, confirm propagation, then trigger verification."
		: "Create each HTTP challenge file exactly as shown, verify file access, then trigger verification.";

	state.challenges.forEach((challenge, index) => {
		const item = document.createElement("li");
		const title = document.createElement("div");
		title.className = "challenge-item-title";
		title.textContent = `${challenge.domain} (${readableChallengeType(challenge.challengeType)})`;
		item.appendChild(title);

		const grid = document.createElement("div");
		grid.className = "challenge-grid";

		if (challenge.challengeType === "dns-01") {
			grid.appendChild(createCopyableCodeBlock("Hostname", challenge.dnsHost));
			grid.appendChild(createCopyableCodeBlock("TXT Value", challenge.dnsValue));
		} else {
			grid.appendChild(createCopyableCodeBlock("File Path", challenge.httpPath));
			grid.appendChild(createCopyableCodeBlock("File Content", challenge.keyAuthorization));
		}

		item.appendChild(grid);

		const actions = document.createElement("div");
		actions.className = "challenge-actions";

		if (challenge.challengeType === "dns-01") {
			const dnsStatus = document.createElement("span");
			dnsStatus.className = "dns-check-result";
			dnsStatus.textContent = "Not checked yet.";

			const dnsCheckButton = document.createElement("button");
			dnsCheckButton.type = "button";
			dnsCheckButton.className = "btn btn-sm btn-outline-secondary";
			dnsCheckButton.textContent = "Check DNS Record";
			dnsCheckButton.addEventListener("click", () => {
				checkDnsRecord(index, dnsCheckButton, dnsStatus);
			});

			actions.appendChild(dnsCheckButton);
			actions.appendChild(dnsStatus);
		} else {
			const checkLink = document.createElement("a");
			checkLink.href = challenge.httpCheckUrl;
			checkLink.target = "_blank";
			checkLink.rel = "noopener noreferrer";
			checkLink.className = "challenge-check-link";
			checkLink.textContent = "Check file in new tab";
			actions.appendChild(checkLink);
		}

		item.appendChild(actions);
		ui.challengeList.appendChild(item);
	});
}

function createCopyableCodeBlock(label, value) {
	const wrap = document.createElement("div");
	wrap.className = "code-block-wrap";

	const header = document.createElement("div");
	header.className = "code-block-header";

	const heading = document.createElement("span");
	heading.textContent = label;

	const copyButton = document.createElement("button");
	copyButton.type = "button";
	copyButton.className = "btn btn-link copy-btn code-copy-btn";
	copyButton.setAttribute("aria-label", `Copy ${label}`);
	copyButton.dataset.copyText = value;
	copyButton.innerHTML = '<i class="bi bi-clipboard"></i>';
	copyButton.addEventListener("click", handleCopy);

	header.appendChild(heading);
	header.appendChild(copyButton);

	const pre = document.createElement("pre");
	pre.className = "challenge-code";
	pre.textContent = value;

	wrap.appendChild(header);
	wrap.appendChild(pre);

	return wrap;
}

async function checkDnsRecord(challengeIndex, button, statusElement) {
	const challenge = state.challenges[challengeIndex];
	if (!challenge || challenge.challengeType !== "dns-01") {
		return;
	}

	button.disabled = true;
	statusElement.classList.remove("success", "error");
	statusElement.textContent = "Checking DNS...";

	try {
		const expected = normalizeDnsTxtValue(challenge.dnsValue);
		const lookupUrl = `https://dns.google/resolve?name=${encodeURIComponent(challenge.dnsHost)}&type=TXT`;
		const response = await fetch(lookupUrl, {
			headers: {
				Accept: "application/dns-json"
			}
		});

		if (!response.ok) {
			throw new Error(`DNS lookup failed (${response.status}).`);
		}

		const payload = await response.json();
		const answers = Array.isArray(payload.Answer) ? payload.Answer : [];
		const txtValues = answers
			.filter((answer) => answer.type === 16)
			.map((answer) => normalizeDnsTxtValue(answer.data));

		if (txtValues.includes(expected)) {
			statusElement.classList.add("success");
			statusElement.textContent = "TXT record found.";
		} else if (txtValues.length) {
			statusElement.classList.add("error");
			statusElement.textContent = "TXT exists but value does not match yet.";
		} else {
			statusElement.classList.add("error");
			statusElement.textContent = "No TXT record found yet.";
		}
	} catch (error) {
		statusElement.classList.add("error");
		statusElement.textContent = normalizeError(error);
	} finally {
		button.disabled = false;
	}
}

function normalizeDnsTxtValue(value) {
	return String(value || "")
		.replace(/"/g, "")
		.trim();
}

function readableChallengeType(challengeType) {
	return challengeType === "dns-01" ? "DNS-01" : "HTTP-01";
}

async function handleCopy(event) {
	const button = event.currentTarget;
	const copyText = button.getAttribute("data-copy-text");
	let valueToCopy = copyText;

	if (copyText === null) {
		const targetId = button.getAttribute("data-copy-target");
		const target = document.getElementById(targetId);
		valueToCopy = target && target.value ? target.value : "";
	}

	if (!valueToCopy) {
		return;
	}

	try {
		await navigator.clipboard.writeText(valueToCopy);
	} catch (_error) {
		if (copyText !== null) {
			const hiddenInput = document.createElement("textarea");
			hiddenInput.value = valueToCopy;
			hiddenInput.setAttribute("readonly", "");
			hiddenInput.style.position = "fixed";
			hiddenInput.style.opacity = "0";
			document.body.appendChild(hiddenInput);
			hiddenInput.select();
			document.execCommand("copy");
			document.body.removeChild(hiddenInput);
		} else {
			const targetId = button.getAttribute("data-copy-target");
			const target = document.getElementById(targetId);
			if (target) {
				target.focus();
				target.select();
				document.execCommand("copy");
				target.setSelectionRange(0, 0);
				target.blur();
			}
		}
	}

	const icon = button.querySelector("i");
	button.classList.add("copied");

	if (icon) {
		icon.classList.remove("bi-clipboard");
		icon.classList.add("bi-clipboard-check");
	}

	window.setTimeout(() => {
		button.classList.remove("copied");
		if (icon) {
			icon.classList.remove("bi-clipboard-check");
			icon.classList.add("bi-clipboard");
		}
	}, 1200);
}

function setLoading(isLoading, message) {
	state.inFlight = isLoading;
	ui.generateBtn.disabled = isLoading;
	ui.verifyBtn.disabled = isLoading || ui.instructionsSection.classList.contains("d-none");
	ui.modeSwitch.disabled = isLoading;
	ui.challengeTypeInput.disabled = isLoading;
	ui.domainsInput.disabled = isLoading;
	ui.emailInput.disabled = isLoading;

	if (isLoading && message) {
		setStatus(message);
	}
}

function clearAcmeSession() {
	state.directory = null;
	state.nonce = null;
	state.accountKeyPair = null;
	state.accountJwk = null;
	state.accountThumbprint = "";
	state.accountUrl = "";
	state.orderUrl = "";
	state.finalizeUrl = "";
	state.authorizationUrls = [];
	state.challenges = [];
	state.domains = [];
	state.domainKeyPair = null;
	state.domainPrivatePem = "";
	state.certificatePem = "";
}

function clearFlowOutput() {
	ui.instructionsSection.classList.add("d-none");
	ui.resultsSection.classList.add("d-none");
	ui.challengeList.innerHTML = "";
	ui.certificateOutput.value = "";
	ui.privateKeyOutput.value = "";
}

function setStatus(message) {
	ui.statusMessage.textContent = message;
}

function showError(message) {
	ui.errorMessage.textContent = message;
	ui.errorMessage.classList.remove("d-none");
}

function clearError() {
	ui.errorMessage.textContent = "";
	ui.errorMessage.classList.add("d-none");
}

function normalizeError(error) {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error || "Unknown error");
}

async function parseJson(response) {
	const text = await response.text();
	if (!text) {
		return {};
	}

	try {
		return JSON.parse(text);
	} catch (_error) {
		throw new Error("Failed to parse JSON response from ACME server.");
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
		return raw;
	} catch (_error) {
		return raw;
	}
}

function arrayBufferToBase64(value) {
	const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
	let binary = "";
	const chunk = 0x8000;

	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}

	return btoa(binary);
}

function base64UrlEncodeBuffer(value) {
	return arrayBufferToBase64(value)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function base64UrlEncodeText(value) {
	return base64UrlEncodeBuffer(new TextEncoder().encode(value));
}

function binaryStringToArrayBuffer(binary) {
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

function delay(ms) {
	return new Promise((resolve) => {
		window.setTimeout(resolve, ms);
	});
}
