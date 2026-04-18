import { AcmeClient } from "./acme-client.js";
import {
	CAPABILITY_STATUS,
	PROVIDER_PRESETS,
	getProviderCapabilities,
	getProviderLabel,
	getProviderPreset
} from "./constants.js";
import {
	clearAccounts,
	deleteAccount,
	getPreferences,
	listAccounts,
	listRequests,
	setPreferences,
	upsertAccount
} from "./storage.js";
import { createId, formatDateTime, nowIso, parseEmails } from "./utils.js";
import { askConfirmation, humanizeAcmeError, initCommonUi, renderCapabilityTable, statusBadgeClass } from "./ui.js";

const commonUi = initCommonUi("accounts");

const ui = {
	accountForm: document.getElementById("accountForm"),
	nicknameInput: document.getElementById("nicknameInput"),
	providerSelect: document.getElementById("providerSelect"),
	customDirectoryWrap: document.getElementById("customDirectoryWrap"),
	customDirectoryInput: document.getElementById("customDirectoryInput"),
	contactInput: document.getElementById("contactInput"),
	customEabToggleWrap: document.getElementById("customEabToggleWrap"),
	customEabToggle: document.getElementById("customEabToggle"),
	eabFieldsWrap: document.getElementById("eabFieldsWrap"),
	eabKeyIdInput: document.getElementById("eabKeyIdInput"),
	eabHmacInput: document.getElementById("eabHmacInput"),
	eabHelpText: document.getElementById("eabHelpText"),
	registerAccountBtn: document.getElementById("registerAccountBtn"),
	resetAccountFormBtn: document.getElementById("resetAccountFormBtn"),
	purgeAccountsBtn: document.getElementById("purgeAccountsBtn"),
	accountList: document.getElementById("accountList"),
	selectedAccountHint: document.getElementById("selectedAccountHint"),
	refreshAccountBtn: document.getElementById("refreshAccountBtn"),
	fetchOrdersBtn: document.getElementById("fetchOrdersBtn"),
	keyRolloverBtn: document.getElementById("keyRolloverBtn"),
	deactivateAccountBtn: document.getElementById("deactivateAccountBtn"),
	deleteAccountBtn: document.getElementById("deleteAccountBtn"),
	updateContactInput: document.getElementById("updateContactInput"),
	updateContactBtn: document.getElementById("updateContactBtn"),
	capabilityTableWrap: document.getElementById("capabilityTableWrap"),
	accountOrdersWrap: document.getElementById("accountOrdersWrap")
};

const state = {
	accounts: [],
	requestCounts: {},
	selectedAccountId: "",
	ordersByAccount: {}
};

init().catch((error) => {
	commonUi.showError(humanizeAcmeError(error));
});

async function init() {
	if (!window.crypto || !window.crypto.subtle) {
		throw new Error("WebCrypto is required for advanced account management.");
	}

	populateProviderOptions();
	bindEvents();
	resetForm();
	await refreshData();
	restoreSelection();
	renderAll();
	commonUi.setStatus("Account manager is ready.");
}

function bindEvents() {
	ui.accountForm.addEventListener("submit", handleRegisterAccount);
	ui.providerSelect.addEventListener("change", handleProviderChanged);
	ui.customEabToggle.addEventListener("change", handleProviderChanged);
	ui.resetAccountFormBtn.addEventListener("click", resetForm);
	ui.accountList.addEventListener("click", handleAccountListActions);

	ui.refreshAccountBtn.addEventListener("click", handleRefreshAccountStatus);
	ui.fetchOrdersBtn.addEventListener("click", handleFetchOrders);
	ui.keyRolloverBtn.addEventListener("click", handleKeyRollover);
	ui.deactivateAccountBtn.addEventListener("click", handleDeactivateAccount);
	ui.deleteAccountBtn.addEventListener("click", handleDeleteSelectedAccount);
	ui.updateContactBtn.addEventListener("click", handleUpdateContact);

	ui.purgeAccountsBtn.addEventListener("click", handlePurgeAccounts);
}

function populateProviderOptions() {
	ui.providerSelect.innerHTML = "";
	Object.values(PROVIDER_PRESETS).forEach((provider) => {
		const option = document.createElement("option");
		option.value = provider.id;
		option.textContent = provider.label;
		ui.providerSelect.appendChild(option);
	});
}

function restoreSelection() {
	const prefs = getPreferences();
	const preferred = prefs.selectedAccountId || prefs.defaultAccountId || "";
	if (preferred && state.accounts.some((account) => account.id === preferred)) {
		state.selectedAccountId = preferred;
		return;
	}

	state.selectedAccountId = state.accounts.length ? state.accounts[0].id : "";
}

async function refreshData() {
	const [accounts, requests] = await Promise.all([listAccounts(), listRequests()]);
	state.accounts = accounts;
	state.requestCounts = requests.reduce((acc, request) => {
		if (!request.accountId) {
			return acc;
		}
		acc[request.accountId] = Number(acc[request.accountId] || 0) + 1;
		return acc;
	}, {});

	if (state.selectedAccountId && !state.accounts.some((account) => account.id === state.selectedAccountId)) {
		state.selectedAccountId = "";
	}
}

function renderAll() {
	renderAccountList();
	renderSelectedAccountPanel();
	renderCapabilityPanel();
}

function renderAccountList() {
	ui.accountList.innerHTML = "";

	if (!state.accounts.length) {
		ui.accountList.innerHTML = '<p class="inline-help m-0">No ACME accounts are stored yet.</p>';
		return;
	}

	state.accounts.forEach((account) => {
		const article = document.createElement("article");
		article.className = `account-item${account.id === state.selectedAccountId ? " active" : ""}`;
		const status = account.accountStatus || "unknown";
		const linkedCount = Number(state.requestCounts[account.id] || 0);
		const providerLabel = getProviderLabel(account.providerId);

		article.innerHTML = [
			`<h3 class="item-title">${escapeHtml(account.nickname || "Unnamed account")}</h3>`,
			`<p class="item-subtitle">${escapeHtml(providerLabel)} - ${escapeHtml(account.directoryUrl || "")}</p>`,
			`<div class="d-flex align-items-center gap-2 flex-wrap mt-2"><span class="status-pill ${statusBadgeClass(status)}">${escapeHtml(status)}</span><span class="item-subtitle m-0">Account URL: ${escapeHtml(account.accountUrl || "-")}</span></div>`,
			`<p class="item-subtitle">Linked requests: ${linkedCount} - Updated: ${escapeHtml(formatDateTime(account.updatedAt))}</p>`,
			"<div class=\"item-actions\">",
			`<button type="button" class="btn btn-sm btn-outline-primary" data-action="select" data-account-id="${escapeHtml(account.id)}">Select</button>`,
			`<button type="button" class="btn btn-sm btn-outline-secondary" data-action="default" data-account-id="${escapeHtml(account.id)}">Set Default</button>`,
			`<button type="button" class="btn btn-sm btn-outline-danger" data-action="delete" data-account-id="${escapeHtml(account.id)}">Delete</button>`,
			"</div>"
		].join("");

		ui.accountList.appendChild(article);
	});
}

function renderSelectedAccountPanel() {
	const account = getSelectedAccount();
	if (!account) {
		ui.selectedAccountHint.textContent = "Select an account from the list to run lifecycle actions.";
		ui.accountOrdersWrap.textContent = "No account orders loaded yet.";
		setActionState(false);
		return;
	}

	const capabilities = getCapabilitiesForAccount(account);
	const canRollover = canAttemptCapability(capabilities.accountKeyRollover);
	const canDeactivate = canAttemptCapability(capabilities.accountDeactivation);
	const canOrders = canAttemptCapability(capabilities.accountOrders);

	setActionState(true);
	ui.keyRolloverBtn.disabled = !canRollover;
	ui.deactivateAccountBtn.disabled = !canDeactivate;
	ui.fetchOrdersBtn.disabled = !canOrders;

	ui.keyRolloverBtn.title = canRollover ? "" : "Key rollover is unsupported for this provider.";
	ui.deactivateAccountBtn.title = canDeactivate ? "" : "Account deactivation is unsupported for this provider.";
	ui.fetchOrdersBtn.title = canOrders ? "" : "Account orders endpoint is unavailable or unsupported for this provider.";

	ui.updateContactInput.value = Array.isArray(account.contactEmails) ? account.contactEmails.join(", ") : "";
	ui.selectedAccountHint.textContent = `Selected account: ${account.nickname} (${getProviderLabel(account.providerId)})`;
	renderOrdersForAccount(account.id);
}

function renderCapabilityPanel() {
	const account = getSelectedAccount();
	const providerId = account ? account.providerId : ui.providerSelect.value;
	const capabilities = getProviderCapabilities(providerId);
	renderCapabilityTable(ui.capabilityTableWrap, capabilities);
}

function renderOrdersForAccount(accountId) {
	const orders = state.ordersByAccount[accountId] || [];
	if (!orders.length) {
		ui.accountOrdersWrap.textContent = "No account orders loaded yet.";
		return;
	}

	const list = document.createElement("ul");
	list.className = "mb-0";
	orders.forEach((orderUrl) => {
		const item = document.createElement("li");
		item.textContent = orderUrl;
		list.appendChild(item);
	});

	ui.accountOrdersWrap.innerHTML = "";
	ui.accountOrdersWrap.appendChild(list);
}

function setActionState(enabled) {
	ui.refreshAccountBtn.disabled = !enabled;
	ui.fetchOrdersBtn.disabled = !enabled;
	ui.keyRolloverBtn.disabled = !enabled;
	ui.deactivateAccountBtn.disabled = !enabled;
	ui.deleteAccountBtn.disabled = !enabled;
	ui.updateContactInput.disabled = !enabled;
	ui.updateContactBtn.disabled = !enabled;
}

function handleProviderChanged() {
	applyProviderPolicy();
	renderCapabilityPanel();
}

function applyProviderPolicy() {
	const providerId = ui.providerSelect.value;
	const preset = getProviderPreset(providerId);
	const isCustom = providerId === "custom";

	ui.customDirectoryWrap.classList.toggle("d-none", !isCustom);
	ui.customEabToggleWrap.classList.toggle("d-none", !isCustom);

	if (!isCustom) {
		ui.customDirectoryInput.value = preset.directoryUrl;
	}

	const requireEab = getEabRequirement(providerId);
	ui.eabFieldsWrap.classList.toggle("d-none", !requireEab);
	ui.eabKeyIdInput.required = requireEab;
	ui.eabHmacInput.required = requireEab;
	ui.eabHelpText.textContent = requireEab
		? "This provider requires EAB for account registration. Enter key ID and HMAC key."
		: "EAB is optional for this provider.";
}

function getEabRequirement(providerId) {
	if (providerId === "custom") {
		return Boolean(ui.customEabToggle.checked);
	}
	return Boolean(getProviderPreset(providerId).requiresEab);
}

async function handleRegisterAccount(event) {
	event.preventDefault();
	commonUi.clearError();

	const nickname = ui.nicknameInput.value.trim();
	const providerId = ui.providerSelect.value;
	const providerPreset = getProviderPreset(providerId);
	const isCustom = providerId === "custom";
	const directoryUrl = isCustom ? ui.customDirectoryInput.value.trim() : providerPreset.directoryUrl;
	const { emails, invalid } = parseEmails(ui.contactInput.value.trim());
	const requireEab = getEabRequirement(providerId);
	const eabKeyId = ui.eabKeyIdInput.value.trim();
	const eabHmacKey = ui.eabHmacInput.value.trim();

	if (!nickname) {
		commonUi.showError("Account nickname is required.");
		return;
	}

	if (!directoryUrl) {
		commonUi.showError("Directory URL is required.");
		return;
	}

	if (!/^https:\/\//i.test(directoryUrl)) {
		commonUi.showError("Directory URL must begin with https://.");
		return;
	}

	if (invalid.length) {
		commonUi.showError(`Invalid email format: ${invalid.join(", ")}`);
		return;
	}

	if (requireEab && (!eabKeyId || !eabHmacKey)) {
		commonUi.showError("EAB key ID and HMAC key are required for this provider.");
		return;
	}

	commonUi.setBusy(ui.registerAccountBtn, true, "Registering...");
	try {
		const client = new AcmeClient({ directoryUrl });
		const registration = await client.registerAccount({
			contactEmails: emails,
			eab: requireEab
				? {
					keyId: eabKeyId,
					hmacKey: eabHmacKey
				}
				: null
		});
		const directory = await client.getDirectory();

		const now = nowIso();
		const accountRecord = {
			id: createId(),
			nickname,
			providerId,
			directoryUrl,
			requiresEab: requireEab,
			eab: {
				keyId: eabKeyId,
				hmacKey: eabHmacKey
			},
			contactEmails: emails,
			accountUrl: registration.accountUrl,
			accountStatus: registration.accountObject.status || "valid",
			ordersUrl: registration.accountObject.orders || "",
			accountPayload: registration.accountObject,
			thumbprint: registration.accountThumbprint,
			key: registration.key,
			directoryMeta: directory,
			capabilities: getProviderCapabilities(providerId),
			createdAt: now,
			updatedAt: now,
			lastSyncAt: now
		};

		await upsertAccount(accountRecord);
		const prefs = getPreferences();
		setPreferences({
			selectedAccountId: accountRecord.id,
			defaultAccountId: prefs.defaultAccountId || accountRecord.id
		});
		state.selectedAccountId = accountRecord.id;
		await refreshData();
		renderAll();
		resetForm();
		commonUi.setStatus(`Account registered: ${nickname}.`);
	} catch (error) {
		commonUi.showError(humanizeAcmeError(error));
	} finally {
		commonUi.setBusy(ui.registerAccountBtn, false);
	}
}

function resetForm() {
	ui.accountForm.reset();
	ui.providerSelect.value = "letsencrypt-prod";
	ui.customEabToggle.checked = true;
	ui.contactInput.value = "";
	ui.customDirectoryInput.value = "";
	ui.eabKeyIdInput.value = "";
	ui.eabHmacInput.value = "";
	applyProviderPolicy();
	renderCapabilityPanel();
}

async function handleAccountListActions(event) {
	const button = event.target.closest("button[data-action]");
	if (!button) {
		return;
	}

	const action = button.dataset.action;
	const accountId = button.dataset.accountId;
	const account = state.accounts.find((item) => item.id === accountId);
	if (!account) {
		return;
	}

	commonUi.clearError();

	if (action === "select") {
		state.selectedAccountId = account.id;
		setPreferences({ selectedAccountId: account.id });
		renderAll();
		commonUi.setStatus(`Selected account: ${account.nickname}.`);
		return;
	}

	if (action === "default") {
		setPreferences({ defaultAccountId: account.id });
		commonUi.setStatus(`Default account set: ${account.nickname}.`);
		return;
	}

	if (action === "delete") {
		const confirmed = askConfirmation(`Delete account "${account.nickname}" from local storage? Linked requests will be detached.`);
		if (!confirmed) {
			commonUi.setStatus("Delete account canceled.");
			return;
		}

		await deleteAccount(account.id, { cascadeRequests: false });
		if (state.selectedAccountId === account.id) {
			state.selectedAccountId = "";
			setPreferences({ selectedAccountId: "" });
		}
		await refreshData();
		renderAll();
		commonUi.setStatus(`Deleted account: ${account.nickname}.`);
	}
}

async function handleRefreshAccountStatus() {
	const account = getSelectedAccount();
	if (!account) {
		return;
	}

	commonUi.clearError();
	commonUi.setBusy(ui.refreshAccountBtn, true, "Refreshing...");
	try {
		const client = new AcmeClient({ directoryUrl: account.directoryUrl, account });
		const accountPayload = await client.getAccount();
		const updated = {
			...account,
			accountPayload,
			accountStatus: accountPayload.status || account.accountStatus,
			ordersUrl: accountPayload.orders || account.ordersUrl || "",
			lastSyncAt: nowIso(),
			updatedAt: nowIso()
		};
		await upsertAccount(updated);
		await refreshData();
		renderAll();
		commonUi.setStatus(`Account refreshed: ${account.nickname}.`);
	} catch (error) {
		commonUi.showError(humanizeAcmeError(error));
	} finally {
		commonUi.setBusy(ui.refreshAccountBtn, false);
	}
}

async function handleFetchOrders() {
	const account = getSelectedAccount();
	if (!account) {
		return;
	}

	commonUi.clearError();
	commonUi.setBusy(ui.fetchOrdersBtn, true, "Loading...");
	try {
		const client = new AcmeClient({ directoryUrl: account.directoryUrl, account });
		const ordersData = await client.fetchAccountOrders();
		state.ordersByAccount[account.id] = ordersData.orders || [];
		if (ordersData.ordersUrl && ordersData.ordersUrl !== account.ordersUrl) {
			await upsertAccount({
				...account,
				ordersUrl: ordersData.ordersUrl,
				updatedAt: nowIso()
			});
			await refreshData();
		}
		renderSelectedAccountPanel();
		commonUi.setStatus(`Fetched ${state.ordersByAccount[account.id].length} account order URL(s).`);
	} catch (error) {
		commonUi.showError(humanizeAcmeError(error));
	} finally {
		commonUi.setBusy(ui.fetchOrdersBtn, false);
	}
}

async function handleKeyRollover() {
	const account = getSelectedAccount();
	if (!account) {
		return;
	}

	const capabilities = getCapabilitiesForAccount(account);
	if (!canAttemptCapability(capabilities.accountKeyRollover)) {
		commonUi.showError("Key rollover is unsupported for this provider.");
		return;
	}

	const confirmed = askConfirmation(`Run account key rollover for "${account.nickname}" now?`);
	if (!confirmed) {
		commonUi.setStatus("Key rollover canceled.");
		return;
	}

	commonUi.clearError();
	commonUi.setBusy(ui.keyRolloverBtn, true, "Rolling over...");
	try {
		const client = new AcmeClient({ directoryUrl: account.directoryUrl, account });
		const rollover = await client.rolloverAccountKey();
		await upsertAccount({
			...account,
			key: rollover.key,
			thumbprint: rollover.thumbprint,
			updatedAt: nowIso(),
			lastSyncAt: nowIso()
		});
		await refreshData();
		renderAll();
		commonUi.setStatus(`Key rollover completed for ${account.nickname}.`);
	} catch (error) {
		commonUi.showError(humanizeAcmeError(error));
	} finally {
		commonUi.setBusy(ui.keyRolloverBtn, false);
	}
}

async function handleDeactivateAccount() {
	const account = getSelectedAccount();
	if (!account) {
		return;
	}

	const capabilities = getCapabilitiesForAccount(account);
	if (!canAttemptCapability(capabilities.accountDeactivation)) {
		commonUi.showError("Account deactivation is unsupported for this provider.");
		return;
	}

	const confirmed = askConfirmation(`Deactivate account "${account.nickname}" on the CA side?`);
	if (!confirmed) {
		commonUi.setStatus("Account deactivation canceled.");
		return;
	}

	commonUi.clearError();
	commonUi.setBusy(ui.deactivateAccountBtn, true, "Deactivating...");
	try {
		const client = new AcmeClient({ directoryUrl: account.directoryUrl, account });
		const response = await client.deactivateAccount();
		await upsertAccount({
			...account,
			accountStatus: response.status || "deactivated",
			accountPayload: response,
			updatedAt: nowIso(),
			lastSyncAt: nowIso()
		});
		await refreshData();
		renderAll();
		commonUi.setStatus(`Account deactivated: ${account.nickname}.`);
	} catch (error) {
		commonUi.showError(humanizeAcmeError(error));
	} finally {
		commonUi.setBusy(ui.deactivateAccountBtn, false);
	}
}

async function handleDeleteSelectedAccount() {
	const account = getSelectedAccount();
	if (!account) {
		return;
	}

	const confirmed = askConfirmation(`Delete account "${account.nickname}" from local storage? Linked requests will be detached.`);
	if (!confirmed) {
		commonUi.setStatus("Delete account canceled.");
		return;
	}

	commonUi.clearError();
	commonUi.setBusy(ui.deleteAccountBtn, true, "Deleting...");
	try {
		await deleteAccount(account.id, { cascadeRequests: false });
		state.selectedAccountId = "";
		setPreferences({ selectedAccountId: "" });
		await refreshData();
		renderAll();
		commonUi.setStatus(`Deleted account: ${account.nickname}.`);
	} catch (error) {
		commonUi.showError(humanizeAcmeError(error));
	} finally {
		commonUi.setBusy(ui.deleteAccountBtn, false);
	}
}

async function handleUpdateContact() {
	const account = getSelectedAccount();
	if (!account) {
		return;
	}

	commonUi.clearError();
	const { emails, invalid } = parseEmails(ui.updateContactInput.value.trim());
	if (invalid.length) {
		commonUi.showError(`Invalid email format: ${invalid.join(", ")}`);
		return;
	}

	commonUi.setBusy(ui.updateContactBtn, true, "Updating...");
	try {
		const client = new AcmeClient({ directoryUrl: account.directoryUrl, account });
		const payload = {
			contact: emails.map((email) => `mailto:${email}`)
		};
		const response = await client.updateAccount(payload);
		await upsertAccount({
			...account,
			contactEmails: emails,
			accountPayload: response,
			accountStatus: response.status || account.accountStatus,
			updatedAt: nowIso(),
			lastSyncAt: nowIso()
		});
		await refreshData();
		renderAll();
		commonUi.setStatus(`Updated contact for ${account.nickname}.`);
	} catch (error) {
		commonUi.showError(humanizeAcmeError(error));
	} finally {
		commonUi.setBusy(ui.updateContactBtn, false);
	}
}

async function handlePurgeAccounts() {
	commonUi.clearError();
	const confirmed = askConfirmation("Purge all account records? Request history will remain but will be unassigned.");
	if (!confirmed) {
		commonUi.setStatus("Purge accounts canceled.");
		return;
	}

	commonUi.setBusy(ui.purgeAccountsBtn, true, "Purging...");
	try {
		await clearAccounts();
		state.selectedAccountId = "";
		state.ordersByAccount = {};
		setPreferences({ selectedAccountId: "", defaultAccountId: "" });
		await refreshData();
		renderAll();
		commonUi.setStatus("All account records were purged.");
	} catch (error) {
		commonUi.showError(humanizeAcmeError(error));
	} finally {
		commonUi.setBusy(ui.purgeAccountsBtn, false);
	}
}

function getSelectedAccount() {
	return state.accounts.find((account) => account.id === state.selectedAccountId) || null;
}

function getCapabilitiesForAccount(account) {
	if (account && account.capabilities) {
		return account.capabilities;
	}
	return getProviderCapabilities(account.providerId);
}

function canAttemptCapability(status) {
	return status !== CAPABILITY_STATUS.unsupported && status !== CAPABILITY_STATUS.planned;
}

function escapeHtml(value) {
	return String(value || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
