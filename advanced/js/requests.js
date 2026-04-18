import { AcmeClient } from "./acme-client.js";
import { CAPABILITY_STATUS, getProviderCapabilities, getProviderLabel } from "./constants.js";
import { computeDnsTxtValue, computeThumbprint, createCsrBase64Url, exportPrivateKeyPem, generateRsaKeyPair } from "./crypto.js";
import {
	clearRequests,
	deleteRequest,
	getPreferences,
	listAccounts,
	listRequests,
	setPreferences,
	upsertAccount,
	upsertRequest
} from "./storage.js";
import { createId, formatDateTime, normalizeDnsTxtValue, nowIso, parseIdentifiers } from "./utils.js";
import { askConfirmation, humanizeAcmeError, initCommonUi, statusBadgeClass } from "./ui.js";

const commonUi = initCommonUi("requests");

const ui = {
	requestForm: document.getElementById("requestForm"),
	accountSelect: document.getElementById("accountSelect"),
	identifiersInput: document.getElementById("identifiersInput"),
	challengeTypeSelect: document.getElementById("challengeTypeSelect"),
	profileInput: document.getElementById("profileInput"),
	allowIpInput: document.getElementById("allowIpInput"),
	createOrderBtn: document.getElementById("createOrderBtn"),
	resetRequestFormBtn: document.getElementById("resetRequestFormBtn"),

	challengeList: document.getElementById("challengeList"),
	submitChallengesBtn: document.getElementById("submitChallengesBtn"),
	finalizeOrderBtn: document.getElementById("finalizeOrderBtn"),
	deactivateAuthzBtn: document.getElementById("deactivateAuthzBtn"),

	requestList: document.getElementById("requestList"),
	purgeRequestsBtn: document.getElementById("purgeRequestsBtn"),

	selectedRequestHint: document.getElementById("selectedRequestHint"),
	requestMetaWrap: document.getElementById("requestMetaWrap"),
	duplicateRequestBtn: document.getElementById("duplicateRequestBtn"),
	revokeCertificateBtn: document.getElementById("revokeCertificateBtn"),
	deleteRequestBtn: document.getElementById("deleteRequestBtn"),

	certificateOutput: document.getElementById("certificateOutput"),
	privateKeyOutput: document.getElementById("privateKeyOutput"),
	timelineList: document.getElementById("timelineList")
};

const state = {
	accounts: [],
	requests: [],
	activeRequestId: ""
};

init().catch((error) => {
	commonUi.showError(humanizeAcmeError(error));
});

async function init() {
	if (!window.crypto || !window.crypto.subtle) {
		throw new Error("WebCrypto is required for advanced request management.");
	}

	if (!window.forge) {
		throw new Error("Forge failed to load. Refresh the page and try again.");
	}

	bindEvents();
	await refreshData();
	populateAccountSelect();
	restoreSelection();
	applyAccountCapabilities();
	renderAll();
	commonUi.setStatus("Request manager is ready.");
}

function bindEvents() {
	ui.requestForm.addEventListener("submit", handleCreateOrder);
	ui.accountSelect.addEventListener("change", handleAccountChanged);
	ui.resetRequestFormBtn.addEventListener("click", resetRequestForm);

	ui.submitChallengesBtn.addEventListener("click", handleSubmitChallenges);
	ui.finalizeOrderBtn.addEventListener("click", handleFinalizeOrder);
	ui.deactivateAuthzBtn.addEventListener("click", handleDeactivateAuthorizations);

	ui.requestList.addEventListener("click", handleRequestListActions);
	ui.challengeList.addEventListener("click", handleChallengeActions);

	ui.duplicateRequestBtn.addEventListener("click", handleDuplicateSelected);
	ui.revokeCertificateBtn.addEventListener("click", handleRevokeCertificate);
	ui.deleteRequestBtn.addEventListener("click", handleDeleteSelectedRequest);

	ui.purgeRequestsBtn.addEventListener("click", handlePurgeRequests);
}

async function refreshData() {
	const [accounts, requests] = await Promise.all([listAccounts(), listRequests()]);
	state.accounts = accounts;
	state.requests = requests;

	if (state.activeRequestId && !state.requests.some((request) => request.id === state.activeRequestId)) {
		state.activeRequestId = "";
	}
}

function restoreSelection() {
	const prefs = getPreferences();
	const requestId = prefs.selectedRequestId || "";
	if (requestId && state.requests.some((request) => request.id === requestId)) {
		state.activeRequestId = requestId;
		return;
	}

	state.activeRequestId = state.requests.length ? state.requests[0].id : "";
}

function populateAccountSelect() {
	const preferredAccountId = getPreferredAccountId();
	ui.accountSelect.innerHTML = "";

	if (!state.accounts.length) {
		const option = document.createElement("option");
		option.value = "";
		option.textContent = "No accounts available";
		ui.accountSelect.appendChild(option);
		ui.createOrderBtn.disabled = true;
		return;
	}

	state.accounts.forEach((account) => {
		const option = document.createElement("option");
		option.value = account.id;
		option.textContent = `${account.nickname} (${getProviderLabel(account.providerId)})`;
		ui.accountSelect.appendChild(option);
	});

	if (preferredAccountId && state.accounts.some((account) => account.id === preferredAccountId)) {
		ui.accountSelect.value = preferredAccountId;
	} else {
		ui.accountSelect.value = state.accounts[0].id;
	}

	ui.createOrderBtn.disabled = false;
}

function getPreferredAccountId() {
	const prefs = getPreferences();
	return prefs.defaultAccountId || "";
}

function handleAccountChanged() {
	applyAccountCapabilities();
}

function applyAccountCapabilities() {
	const account = getSelectedFormAccount();
	if (!account) {
		ui.allowIpInput.checked = false;
		ui.allowIpInput.disabled = true;
		ui.profileInput.value = "";
		ui.profileInput.disabled = true;
		ui.createOrderBtn.disabled = true;
		return;
	}

	const capabilities = getProviderCapabilities(account.providerId);
	const canUseIp = canAttemptCapability(capabilities.ipIdentifiers);
	const canUseProfiles = canAttemptCapability(capabilities.acmeProfiles);

	ui.allowIpInput.disabled = !canUseIp;
	if (!canUseIp) {
		ui.allowIpInput.checked = false;
	}

	ui.profileInput.disabled = !canUseProfiles;
	if (!canUseProfiles) {
		ui.profileInput.value = "";
	}

	ui.createOrderBtn.disabled = false;
}

async function handleCreateOrder(event) {
	event.preventDefault();
	commonUi.clearError();

	const account = getSelectedFormAccount();
	if (!account) {
		commonUi.showError("Create an ACME account before creating certificate requests.");
		return;
	}

	const challengeType = ui.challengeTypeSelect.value === "dns-01" ? "dns-01" : "http-01";
	const profile = ui.profileInput.value.trim();
	const allowWildcard = challengeType === "dns-01";
	const parsed = parseIdentifiers(ui.identifiersInput.value, { allowWildcard });

	if (!parsed.identifiers.length) {
		commonUi.showError("Enter at least one identifier.");
		return;
	}

	if (parsed.invalid.length) {
		commonUi.showError(`Invalid identifiers: ${parsed.invalid.join(", ")}`);
		return;
	}

	const containsIp = parsed.identifiers.some((item) => item.type === "ip");
	const capabilities = getProviderCapabilities(account.providerId);
	if (containsIp) {
		if (!ui.allowIpInput.checked) {
			commonUi.showError("Enable IP identifiers for this request before submitting IP addresses.");
			return;
		}

		if (!canAttemptCapability(capabilities.ipIdentifiers)) {
			commonUi.showError("The selected provider does not support ACME IP identifiers.");
			return;
		}
	}

	if (profile && !canAttemptCapability(capabilities.acmeProfiles)) {
		commonUi.showError("ACME profiles are unsupported for this provider.");
		return;
	}

	commonUi.setBusy(ui.createOrderBtn, true, "Creating...");
	try {
		const thumbprint = await ensureAccountThumbprint(account);
		const client = new AcmeClient({ directoryUrl: account.directoryUrl, account });
		const createdOrder = await client.createOrder({
			identifiers: parsed.identifiers,
			profile: profile || undefined
		});

		if (!createdOrder.order || !createdOrder.order.finalize) {
			throw new Error("ACME order response did not include a finalize endpoint.");
		}

		const authorizationUrls = Array.isArray(createdOrder.order.authorizations)
			? createdOrder.order.authorizations
			: [];
		if (!authorizationUrls.length) {
			throw new Error("ACME order did not include authorization URLs.");
		}

		const challenges = [];
		for (const authorizationUrl of authorizationUrls) {
			const authorization = await client.getAuthorization(authorizationUrl);
			if (authorization.status === "invalid") {
				const detail = authorization.error && authorization.error.detail ? authorization.error.detail : "authorization marked invalid";
				const identifier = authorization.identifier && authorization.identifier.value ? authorization.identifier.value : "identifier";
				throw new Error(`Authorization failed for ${identifier}: ${detail}`);
			}

			const identifierValue = authorization.identifier && authorization.identifier.value ? authorization.identifier.value : "identifier";
			const challenge = (authorization.challenges || []).find((item) => item.type === challengeType);
			if (!challenge) {
				throw new Error(`${challengeType} challenge was unavailable for ${identifierValue}.`);
			}

			const keyAuthorization = `${challenge.token}.${thumbprint}`;
			const dnsHost = `_acme-challenge.${identifierValue.replace(/^\*\./, "")}`;
			const dnsValue = challengeType === "dns-01" ? await computeDnsTxtValue(keyAuthorization) : "";
			const httpPath = `.well-known/acme-challenge/${challenge.token}`;
			const httpCheckUrl = `http://${identifierValue.replace(/^\*\./, "")}/${httpPath}`;

			challenges.push({
				identifier: identifierValue,
				authorizationUrl,
				challengeUrl: challenge.url,
				challengeType,
				token: challenge.token,
				keyAuthorization,
				dnsHost,
				dnsValue,
				httpPath,
				httpCheckUrl,
				status: authorization.status || "pending"
			});
		}

		const requestRecord = {
			id: createId(),
			accountId: account.id,
			providerId: account.providerId,
			directoryUrl: account.directoryUrl,
			identifiers: parsed.identifiers,
			challengeType,
			profile,
			status: "ready",
			orderUrl: createdOrder.orderUrl,
			finalizeUrl: createdOrder.order.finalize,
			authorizationUrls,
			challenges,
			orderSnapshot: createdOrder.order,
			certificatePem: "",
			domainPrivateKeyPem: "",
			lastError: "",
			timeline: [
				createTimeline("Order created."),
				createTimeline(`Loaded ${challenges.length} challenge instruction(s).`)
			],
			createdAt: nowIso(),
			updatedAt: nowIso()
		};

		await upsertRequest(requestRecord);
		state.activeRequestId = requestRecord.id;
		setPreferences({ selectedRequestId: requestRecord.id });
		await refreshData();
		renderAll();
		commonUi.setStatus(`Created request ${requestRecord.id} for ${parsed.identifiers.length} identifier(s).`);
	} catch (error) {
		commonUi.showError(humanizeAcmeError(error));
	} finally {
		commonUi.setBusy(ui.createOrderBtn, false);
	}
}

async function handleSubmitChallenges() {
	const request = getActiveRequest();
	if (!request) {
		return;
	}

	const account = getAccountForRequest(request);
	if (!account) {
		commonUi.showError("Selected request has no linked account. Reassign by duplicating into form and creating a new order.");
		return;
	}

	commonUi.clearError();
	commonUi.setBusy(ui.submitChallengesBtn, true, "Submitting...");
	try {
		const client = new AcmeClient({ directoryUrl: account.directoryUrl, account });
		for (const challenge of request.challenges || []) {
			await client.triggerChallenge(challenge.challengeUrl);
		}

		const updated = {
			...request,
			status: "submitted",
			updatedAt: nowIso(),
			lastError: "",
			timeline: [...(request.timeline || []), createTimeline("Submitted challenge acknowledgements to ACME server.")]
		};
		await persistRequest(updated);
		commonUi.setStatus("Challenge acknowledgements submitted.");
	} catch (error) {
		await handleRequestError(request, error);
	} finally {
		commonUi.setBusy(ui.submitChallengesBtn, false);
	}
}

async function handleFinalizeOrder() {
	const request = getActiveRequest();
	if (!request) {
		return;
	}

	const account = getAccountForRequest(request);
	if (!account) {
		commonUi.showError("Selected request has no linked account. Reassign by duplicating into form and creating a new order.");
		return;
	}

	commonUi.clearError();
	commonUi.setBusy(ui.finalizeOrderBtn, true, "Finalizing...");
	try {
		const client = new AcmeClient({ directoryUrl: account.directoryUrl, account });
		await client.pollAuthorizations(request.authorizationUrls || [], {
			maxAttempts: 24,
			delayMs: 3000,
			onProgress(progress) {
				commonUi.setStatus(`Waiting for validations (${progress.validCount}/${progress.total}) attempt ${progress.attempt}/${progress.maxAttempts}...`);
			}
		});

		commonUi.setStatus("Generating domain key and CSR...");
		const domainKeyPair = await generateRsaKeyPair();
		const csr = await createCsrBase64Url(domainKeyPair, request.identifiers || []);
		const domainPrivateKeyPem = await exportPrivateKeyPem(domainKeyPair.privateKey);

		await client.finalizeOrder(request.finalizeUrl, csr);
		const validOrder = await client.pollOrder(request.orderUrl, {
			maxAttempts: 24,
			delayMs: 3000,
			onProgress(progress) {
				commonUi.setStatus(`Waiting for issuance (${progress.status}) attempt ${progress.attempt}/${progress.maxAttempts}...`);
			}
		});

		if (!validOrder.certificate) {
			throw new Error("ACME order did not return a certificate URL.");
		}

		const certificatePem = await client.downloadCertificate(validOrder.certificate);
		const updated = {
			...request,
			status: "valid",
			certificatePem,
			domainPrivateKeyPem,
			orderSnapshot: validOrder,
			updatedAt: nowIso(),
			lastError: "",
			timeline: [
				...(request.timeline || []),
				createTimeline("Authorizations validated."),
				createTimeline("Order finalized and certificate downloaded.")
			]
		};
		await persistRequest(updated);
		commonUi.setStatus("Certificate issued and stored successfully.");
	} catch (error) {
		await handleRequestError(request, error);
	} finally {
		commonUi.setBusy(ui.finalizeOrderBtn, false);
	}
}

async function handleDeactivateAuthorizations() {
	const request = getActiveRequest();
	if (!request) {
		return;
	}

	const account = getAccountForRequest(request);
	if (!account) {
		commonUi.showError("Selected request has no linked account.");
		return;
	}

	const capabilities = getProviderCapabilities(account.providerId);
	if (!canAttemptCapability(capabilities.authorizationDeactivation)) {
		commonUi.showError("Authorization deactivation is unsupported for this provider.");
		return;
	}

	const confirmed = askConfirmation("Deactivate all authorizations linked to this request?");
	if (!confirmed) {
		commonUi.setStatus("Authorization deactivation canceled.");
		return;
	}

	commonUi.clearError();
	commonUi.setBusy(ui.deactivateAuthzBtn, true, "Deactivating...");
	try {
		const client = new AcmeClient({ directoryUrl: account.directoryUrl, account });
		for (const authorizationUrl of request.authorizationUrls || []) {
			await client.deactivateAuthorization(authorizationUrl);
		}

		const updated = {
			...request,
			status: request.status === "valid" ? "valid" : "deactivated",
			updatedAt: nowIso(),
			lastError: "",
			timeline: [...(request.timeline || []), createTimeline("Authorization resources deactivated.")]
		};
		await persistRequest(updated);
		commonUi.setStatus("Authorizations deactivated.");
	} catch (error) {
		await handleRequestError(request, error);
	} finally {
		commonUi.setBusy(ui.deactivateAuthzBtn, false);
	}
}

async function handleChallengeActions(event) {
	const button = event.target.closest("button[data-action='check-dns']");
	if (!button) {
		return;
	}

	const request = getActiveRequest();
	if (!request) {
		return;
	}

	const index = Number(button.dataset.challengeIndex);
	const challenge = Array.isArray(request.challenges) ? request.challenges[index] : null;
	if (!challenge || challenge.challengeType !== "dns-01") {
		return;
	}

	const statusNode = document.getElementById(`dnsCheckStatus-${index}`);
	if (!statusNode) {
		return;
	}

	button.disabled = true;
	statusNode.textContent = "Checking DNS...";
	statusNode.classList.remove("status-error", "status-valid");

	try {
		const expected = normalizeDnsTxtValue(challenge.dnsValue);
		const url = `https://dns.google/resolve?name=${encodeURIComponent(challenge.dnsHost)}&type=TXT`;
		const response = await fetch(url, {
			headers: {
				Accept: "application/dns-json"
			}
		});
		if (!response.ok) {
			throw new Error(`DNS lookup failed (${response.status}).`);
		}

		const payload = await response.json();
		const answers = Array.isArray(payload.Answer) ? payload.Answer : [];
		const values = answers
			.filter((item) => item.type === 16)
			.map((item) => normalizeDnsTxtValue(item.data));

		if (values.includes(expected)) {
			statusNode.textContent = "TXT record found.";
			statusNode.classList.add("status-valid");
			return;
		}

		if (values.length > 0) {
			statusNode.textContent = "TXT exists but value does not match yet.";
			statusNode.classList.add("status-error");
			return;
		}

		statusNode.textContent = "No TXT record found yet.";
		statusNode.classList.add("status-error");
	} catch (error) {
		statusNode.textContent = humanizeAcmeError(error);
		statusNode.classList.add("status-error");
	} finally {
		button.disabled = false;
	}
}

function handleRequestListActions(event) {
	const button = event.target.closest("button[data-action]");
	if (!button) {
		return;
	}

	const requestId = button.dataset.requestId;
	const request = state.requests.find((item) => item.id === requestId);
	if (!request) {
		return;
	}

	const action = button.dataset.action;
	if (action === "select") {
		state.activeRequestId = request.id;
		setPreferences({ selectedRequestId: request.id });
		renderAll();
		commonUi.setStatus(`Selected request ${request.id}.`);
		return;
	}

	if (action === "duplicate") {
		duplicateIntoForm(request);
		commonUi.setStatus(`Loaded request ${request.id} into form.`);
		return;
	}

	if (action === "delete") {
		deleteRequestFlow(request);
	}
}

function handleDuplicateSelected() {
	const request = getActiveRequest();
	if (!request) {
		return;
	}
	duplicateIntoForm(request);
	commonUi.setStatus(`Loaded request ${request.id} into form.`);
}

async function handleRevokeCertificate() {
	const request = getActiveRequest();
	if (!request || !request.certificatePem) {
		return;
	}

	const account = getAccountForRequest(request);
	if (!account) {
		commonUi.showError("Selected request has no linked account.");
		return;
	}

	const capabilities = getProviderCapabilities(account.providerId);
	if (!canAttemptCapability(capabilities.certificateRevocation)) {
		commonUi.showError("Certificate revocation is unsupported for this provider.");
		return;
	}

	const confirmed = askConfirmation("Revoke the certificate associated with this request?");
	if (!confirmed) {
		commonUi.setStatus("Certificate revocation canceled.");
		return;
	}

	commonUi.clearError();
	commonUi.setBusy(ui.revokeCertificateBtn, true, "Revoking...");
	try {
		const client = new AcmeClient({ directoryUrl: account.directoryUrl, account });
		await client.revokeCertificate(request.certificatePem, 0);
		const updated = {
			...request,
			status: "revoked",
			updatedAt: nowIso(),
			lastError: "",
			timeline: [...(request.timeline || []), createTimeline("Certificate revoked.")]
		};
		await persistRequest(updated);
		commonUi.setStatus("Certificate revoked.");
	} catch (error) {
		await handleRequestError(request, error);
	} finally {
		commonUi.setBusy(ui.revokeCertificateBtn, false);
	}
}

function handleDeleteSelectedRequest() {
	const request = getActiveRequest();
	if (!request) {
		return;
	}
	deleteRequestFlow(request);
}

async function deleteRequestFlow(request) {
	const confirmed = askConfirmation(`Delete request ${request.id}?`);
	if (!confirmed) {
		commonUi.setStatus("Delete request canceled.");
		return;
	}

	commonUi.clearError();
	await deleteRequest(request.id);
	if (state.activeRequestId === request.id) {
		state.activeRequestId = "";
		setPreferences({ selectedRequestId: "" });
	}
	await refreshData();
	renderAll();
	commonUi.setStatus(`Deleted request ${request.id}.`);
}

async function handlePurgeRequests() {
	commonUi.clearError();
	const confirmed = askConfirmation("Purge all stored request records?");
	if (!confirmed) {
		commonUi.setStatus("Purge requests canceled.");
		return;
	}

	commonUi.setBusy(ui.purgeRequestsBtn, true, "Purging...");
	try {
		await clearRequests();
		state.activeRequestId = "";
		setPreferences({ selectedRequestId: "" });
		await refreshData();
		renderAll();
		commonUi.setStatus("All request records were purged.");
	} catch (error) {
		commonUi.showError(humanizeAcmeError(error));
	} finally {
		commonUi.setBusy(ui.purgeRequestsBtn, false);
	}
}

function renderAll() {
	renderRequestList();
	renderSelectedRequest();
	renderChallengeList();
	renderActionButtons();
}

function renderRequestList() {
	ui.requestList.innerHTML = "";
	if (!state.requests.length) {
		ui.requestList.innerHTML = '<p class="inline-help m-0">No request records stored yet.</p>';
		return;
	}

	state.requests.forEach((request) => {
		const article = document.createElement("article");
		article.className = `request-item${request.id === state.activeRequestId ? " active" : ""}`;
		const identifiers = formatIdentifiers(request.identifiers);
		const provider = request.providerId ? getProviderLabel(request.providerId) : "Unassigned";

		article.innerHTML = [
			`<h3 class="item-title">${escapeHtml(identifiers || request.id)}</h3>`,
			`<p class="item-subtitle">${escapeHtml(provider)} - ${escapeHtml(request.challengeType || "")}</p>`,
			`<div class="d-flex align-items-center gap-2 mt-2"><span class="status-pill ${statusBadgeClass(request.status)}">${escapeHtml(request.status || "unknown")}</span><span class="item-subtitle m-0">${escapeHtml(formatDateTime(request.updatedAt))}</span></div>`,
			"<div class=\"item-actions\">",
			`<button type="button" class="btn btn-sm btn-outline-primary" data-action="select" data-request-id="${escapeHtml(request.id)}">Select</button>`,
			`<button type="button" class="btn btn-sm btn-outline-secondary" data-action="duplicate" data-request-id="${escapeHtml(request.id)}">Duplicate</button>`,
			`<button type="button" class="btn btn-sm btn-outline-danger" data-action="delete" data-request-id="${escapeHtml(request.id)}">Delete</button>`,
			"</div>"
		].join("");

		ui.requestList.appendChild(article);
	});
}

function renderSelectedRequest() {
	const request = getActiveRequest();
	if (!request) {
		ui.selectedRequestHint.textContent = "Select a stored request to inspect full details.";
		ui.requestMetaWrap.textContent = "No request selected.";
		ui.certificateOutput.value = "";
		ui.privateKeyOutput.value = "";
		ui.timelineList.innerHTML = "";
		return;
	}

	const account = getAccountForRequest(request);
	const accountLabel = account ? `${account.nickname} (${getProviderLabel(account.providerId)})` : "Unassigned account";
	ui.selectedRequestHint.textContent = `Selected request: ${request.id}`;
	ui.requestMetaWrap.innerHTML = [
		`<p class="mb-1"><strong>Account:</strong> ${escapeHtml(accountLabel)}</p>`,
		`<p class="mb-1"><strong>Identifiers:</strong> ${escapeHtml(formatIdentifiers(request.identifiers))}</p>`,
		`<p class="mb-1"><strong>Challenge:</strong> ${escapeHtml(request.challengeType || "")}</p>`,
		`<p class="mb-1"><strong>Profile:</strong> ${escapeHtml(request.profile || "none")}</p>`,
		`<p class="mb-1"><strong>Order URL:</strong> ${escapeHtml(request.orderUrl || "-")}</p>`,
		`<p class="mb-0"><strong>Updated:</strong> ${escapeHtml(formatDateTime(request.updatedAt))}</p>`
	].join("");

	ui.certificateOutput.value = request.certificatePem || "";
	ui.privateKeyOutput.value = request.domainPrivateKeyPem || "";

	ui.timelineList.innerHTML = "";
	(request.timeline || []).forEach((entry) => {
		const item = document.createElement("li");
		item.textContent = `${formatDateTime(entry.at)} - ${entry.message}`;
		ui.timelineList.appendChild(item);
	});
}

function renderChallengeList() {
	const request = getActiveRequest();
	ui.challengeList.innerHTML = "";
	if (!request || !Array.isArray(request.challenges) || !request.challenges.length) {
		ui.challengeList.innerHTML = '<li class="inline-help">No active challenge instructions.</li>';
		return;
	}

	request.challenges.forEach((challenge, index) => {
		const item = document.createElement("li");
		item.className = "challenge-entry";

		if (challenge.challengeType === "dns-01") {
			item.innerHTML = [
				`<p class="item-title">${escapeHtml(challenge.identifier)} (DNS-01)</p>`,
				'<div class="code-row">',
				`<div><strong>Hostname</strong> <button type="button" class="btn btn-link copy-btn" data-copy-value="${escapeHtmlAttr(challenge.dnsHost)}"><i class="bi bi-clipboard"></i></button><pre>${escapeHtml(challenge.dnsHost)}</pre></div>`,
				`<div><strong>TXT Value</strong> <button type="button" class="btn btn-link copy-btn" data-copy-value="${escapeHtmlAttr(challenge.dnsValue)}"><i class="bi bi-clipboard"></i></button><pre>${escapeHtml(challenge.dnsValue)}</pre></div>`,
				"</div>",
				`<div class="item-actions"><button type="button" class="btn btn-sm btn-outline-secondary" data-action="check-dns" data-challenge-index="${index}">Check DNS</button><span id="dnsCheckStatus-${index}" class="item-subtitle m-0">Not checked yet.</span></div>`
			].join("");
		} else {
			item.innerHTML = [
				`<p class="item-title">${escapeHtml(challenge.identifier)} (HTTP-01)</p>`,
				'<div class="code-row">',
				`<div><strong>File Path</strong> <button type="button" class="btn btn-link copy-btn" data-copy-value="${escapeHtmlAttr(challenge.httpPath)}"><i class="bi bi-clipboard"></i></button><pre>${escapeHtml(challenge.httpPath)}</pre></div>`,
				`<div><strong>File Content</strong> <button type="button" class="btn btn-link copy-btn" data-copy-value="${escapeHtmlAttr(challenge.keyAuthorization)}"><i class="bi bi-clipboard"></i></button><pre>${escapeHtml(challenge.keyAuthorization)}</pre></div>`,
				"</div>",
				`<div class="item-actions"><a class="btn btn-sm btn-outline-secondary" href="${escapeHtmlAttr(challenge.httpCheckUrl)}" target="_blank" rel="noopener noreferrer">Check file in new tab</a></div>`
			].join("");
		}

		ui.challengeList.appendChild(item);
	});
}

function renderActionButtons() {
	const request = getActiveRequest();
	if (!request) {
		setRequestActionState(false);
		return;
	}

	setRequestActionState(true);

	const account = getAccountForRequest(request);
	const capabilities = account ? getProviderCapabilities(account.providerId) : null;
	const canDeactivateAuthz = capabilities ? canAttemptCapability(capabilities.authorizationDeactivation) : false;
	const canRevoke = capabilities ? canAttemptCapability(capabilities.certificateRevocation) : false;

	const challengeActionAllowed = request.status === "ready" || request.status === "submitted" || request.status === "pending";
	ui.submitChallengesBtn.disabled = !challengeActionAllowed;
	ui.finalizeOrderBtn.disabled = !challengeActionAllowed;
	ui.deactivateAuthzBtn.disabled = !canDeactivateAuthz;
	ui.revokeCertificateBtn.disabled = !request.certificatePem || !canRevoke || request.status === "revoked";
}

function setRequestActionState(enabled) {
	ui.submitChallengesBtn.disabled = !enabled;
	ui.finalizeOrderBtn.disabled = !enabled;
	ui.deactivateAuthzBtn.disabled = !enabled;
	ui.duplicateRequestBtn.disabled = !enabled;
	ui.revokeCertificateBtn.disabled = !enabled;
	ui.deleteRequestBtn.disabled = !enabled;
}

function resetRequestForm() {
	ui.identifiersInput.value = "";
	ui.challengeTypeSelect.value = "http-01";
	ui.profileInput.value = "";
	ui.allowIpInput.checked = false;
	applyAccountCapabilities();
}

function duplicateIntoForm(request) {
	if (request.accountId && state.accounts.some((account) => account.id === request.accountId)) {
		ui.accountSelect.value = request.accountId;
	}

	ui.identifiersInput.value = (request.identifiers || []).map((item) => item.value).join(", ");
	ui.challengeTypeSelect.value = request.challengeType || "http-01";
	ui.profileInput.value = request.profile || "";
	ui.allowIpInput.checked = (request.identifiers || []).some((item) => item.type === "ip");
	applyAccountCapabilities();
}

function getSelectedFormAccount() {
	const accountId = ui.accountSelect.value;
	return state.accounts.find((account) => account.id === accountId) || null;
}

function getActiveRequest() {
	return state.requests.find((request) => request.id === state.activeRequestId) || null;
}

function getAccountForRequest(request) {
	if (!request || !request.accountId) {
		return null;
	}
	return state.accounts.find((account) => account.id === request.accountId) || null;
}

async function persistRequest(record) {
	await upsertRequest(record);
	await refreshData();
	state.activeRequestId = record.id;
	setPreferences({ selectedRequestId: record.id });
	renderAll();
}

async function handleRequestError(request, error) {
	const message = humanizeAcmeError(error);
	commonUi.showError(message);

	if (!request) {
		return;
	}

	const updated = {
		...request,
		status: "invalid",
		lastError: message,
		updatedAt: nowIso(),
		timeline: [...(request.timeline || []), createTimeline(`Error: ${message}`)]
	};
	await persistRequest(updated);
}

async function ensureAccountThumbprint(account) {
	if (account.thumbprint) {
		return account.thumbprint;
	}

	if (!account.key || !account.key.jwk) {
		throw new Error("Selected account is missing key material required for ACME challenge key authorization.");
	}

	const thumbprint = await computeThumbprint(account.key.jwk);
	const updated = {
		...account,
		thumbprint,
		updatedAt: nowIso()
	};
	await upsertAccount(updated);
	await refreshData();
	return thumbprint;
}

function canAttemptCapability(status) {
	return status !== CAPABILITY_STATUS.unsupported && status !== CAPABILITY_STATUS.planned;
}

function formatIdentifiers(identifiers) {
	return (identifiers || []).map((item) => item.value).join(", ");
}

function createTimeline(message) {
	return {
		at: nowIso(),
		message
	};
}

function escapeHtml(value) {
	return String(value || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function escapeHtmlAttr(value) {
	return escapeHtml(value).replace(/`/g, "&#96;");
}
