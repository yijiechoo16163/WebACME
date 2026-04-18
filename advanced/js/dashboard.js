import { clearAccounts, clearRequests, listAccounts, listRequests, purgeAllData } from "./storage.js";
import { askConfirmation, humanizeAcmeError, initCommonUi } from "./ui.js";

const commonUi = initCommonUi("dashboard");

const ui = {
	accountsCount: document.getElementById("accountsCount"),
	requestsCount: document.getElementById("requestsCount"),
	issuedCount: document.getElementById("issuedCount"),
	purgeAccountsBtn: document.getElementById("purgeAccountsBtn"),
	purgeRequestsBtn: document.getElementById("purgeRequestsBtn"),
	purgeAllBtn: document.getElementById("purgeAllBtn")
};

init().catch((error) => {
	commonUi.showError(humanizeAcmeError(error));
});

async function init() {
	bindEvents();
	await renderCounts();
	commonUi.setStatus("Advanced dashboard is ready.");
}

function bindEvents() {
	ui.purgeAccountsBtn.addEventListener("click", handlePurgeAccounts);
	ui.purgeRequestsBtn.addEventListener("click", handlePurgeRequests);
	ui.purgeAllBtn.addEventListener("click", handlePurgeAll);
}

async function renderCounts() {
	const [accounts, requests] = await Promise.all([listAccounts(), listRequests()]);
	const issued = requests.filter((item) => item.status === "valid" && item.certificatePem).length;

	ui.accountsCount.textContent = String(accounts.length);
	ui.requestsCount.textContent = String(requests.length);
	ui.issuedCount.textContent = String(issued);
}

async function handlePurgeAccounts() {
	commonUi.clearError();
	const confirmed = askConfirmation("Purge all ACME account records? Existing requests will be kept but become unassigned.");
	if (!confirmed) {
		commonUi.setStatus("Purge accounts canceled.");
		return;
	}

	commonUi.setBusy(ui.purgeAccountsBtn, true, "Purging...");
	try {
		await clearAccounts();
		await renderCounts();
		commonUi.setStatus("All account records were purged.");
	} catch (error) {
		commonUi.showError(humanizeAcmeError(error));
	} finally {
		commonUi.setBusy(ui.purgeAccountsBtn, false);
	}
}

async function handlePurgeRequests() {
	commonUi.clearError();
	const confirmed = askConfirmation("Purge all certificate request records?");
	if (!confirmed) {
		commonUi.setStatus("Purge requests canceled.");
		return;
	}

	commonUi.setBusy(ui.purgeRequestsBtn, true, "Purging...");
	try {
		await clearRequests();
		await renderCounts();
		commonUi.setStatus("All request records were purged.");
	} catch (error) {
		commonUi.showError(humanizeAcmeError(error));
	} finally {
		commonUi.setBusy(ui.purgeRequestsBtn, false);
	}
}

async function handlePurgeAll() {
	commonUi.clearError();
	const confirmed = askConfirmation("Purge all advanced-mode data, including accounts, requests, and preferences?");
	if (!confirmed) {
		commonUi.setStatus("Purge all canceled.");
		return;
	}

	commonUi.setBusy(ui.purgeAllBtn, true, "Purging...");
	try {
		await purgeAllData();
		await renderCounts();
		commonUi.setStatus("All advanced-mode data was purged from this browser.");
	} catch (error) {
		commonUi.showError(humanizeAcmeError(error));
	} finally {
		commonUi.setBusy(ui.purgeAllBtn, false);
	}
}
