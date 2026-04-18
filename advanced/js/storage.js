import { ADVANCED_DB } from "./constants.js";
import { safeJsonParse } from "./utils.js";

const PREF_KEY = "webacme-advanced-prefs";

let databasePromise = null;

export function getPreferences() {
	const raw = localStorage.getItem(PREF_KEY);
	if (!raw) {
		return {};
	}
	return safeJsonParse(raw, {});
}

export function setPreferences(patch) {
	const current = getPreferences();
	const next = {
		...current,
		...patch
	};
	localStorage.setItem(PREF_KEY, JSON.stringify(next));
	return next;
}

export function clearPreferences() {
	localStorage.removeItem(PREF_KEY);
}

function requestAsPromise(request) {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
	});
}

function openDatabase() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(ADVANCED_DB.name, ADVANCED_DB.version);

		request.onupgradeneeded = () => {
			const db = request.result;

			if (!db.objectStoreNames.contains(ADVANCED_DB.stores.accounts)) {
				const accountStore = db.createObjectStore(ADVANCED_DB.stores.accounts, { keyPath: "id" });
				accountStore.createIndex("providerId", "providerId", { unique: false });
				accountStore.createIndex("updatedAt", "updatedAt", { unique: false });
			}

			if (!db.objectStoreNames.contains(ADVANCED_DB.stores.requests)) {
				const requestStore = db.createObjectStore(ADVANCED_DB.stores.requests, { keyPath: "id" });
				requestStore.createIndex("accountId", "accountId", { unique: false });
				requestStore.createIndex("status", "status", { unique: false });
				requestStore.createIndex("createdAt", "createdAt", { unique: false });
			}
		};

		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error || new Error("Failed to open IndexedDB."));
	});
}

async function getDatabase() {
	if (!databasePromise) {
		databasePromise = openDatabase();
	}
	return databasePromise;
}

async function withStore(storeName, mode, callback) {
	const db = await getDatabase();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(storeName, mode);
		const store = tx.objectStore(storeName);
		let callbackResult;

		try {
			callbackResult = callback(store, tx);
		} catch (error) {
			reject(error);
			return;
		}

		tx.oncomplete = () => resolve(callbackResult);
		tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed."));
		tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted."));
	});
}

export async function listAccounts() {
	const result = await withStore(ADVANCED_DB.stores.accounts, "readonly", (store) => requestAsPromise(store.getAll()));
	return (await result)
		.slice()
		.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

export async function getAccount(accountId) {
	const result = await withStore(ADVANCED_DB.stores.accounts, "readonly", (store) => requestAsPromise(store.get(accountId)));
	return result;
}

export async function upsertAccount(record) {
	await withStore(ADVANCED_DB.stores.accounts, "readwrite", (store) => {
		store.put(record);
	});
	return record;
}

export async function deleteAccount(accountId, options = {}) {
	const cascadeRequests = options.cascadeRequests === true;

	await withStore(ADVANCED_DB.stores.accounts, "readwrite", (store) => {
		store.delete(accountId);
	});

	if (cascadeRequests) {
		await withStore(ADVANCED_DB.stores.requests, "readwrite", (store) => {
			const index = store.index("accountId");
			const request = index.openCursor(IDBKeyRange.only(accountId));
			request.onsuccess = () => {
				const cursor = request.result;
				if (!cursor) {
					return;
				}
				cursor.delete();
				cursor.continue();
			};
		});
		return;
	}

	await withStore(ADVANCED_DB.stores.requests, "readwrite", (store) => {
		const index = store.index("accountId");
		const request = index.openCursor(IDBKeyRange.only(accountId));
		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor) {
				return;
			}

			const nextValue = {
				...cursor.value,
				accountId: "",
				updatedAt: new Date().toISOString(),
				lastError: cursor.value.lastError || "Linked account was removed. Reassign this request before running ACME operations."
			};
			cursor.update(nextValue);
			cursor.continue();
		};
	});
}

export async function clearAccounts(options = {}) {
	const cascadeRequests = options.cascadeRequests === true;

	await withStore(ADVANCED_DB.stores.accounts, "readwrite", (store) => {
		store.clear();
	});

	if (cascadeRequests) {
		await withStore(ADVANCED_DB.stores.requests, "readwrite", (store) => {
			store.clear();
		});
		return;
	}

	await withStore(ADVANCED_DB.stores.requests, "readwrite", (store) => {
		const cursorRequest = store.openCursor();
		cursorRequest.onsuccess = () => {
			const cursor = cursorRequest.result;
			if (!cursor) {
				return;
			}

			const nextValue = {
				...cursor.value,
				accountId: "",
				updatedAt: new Date().toISOString(),
				lastError: cursor.value.lastError || "Linked account was purged. Reassign this request before running ACME operations."
			};
			cursor.update(nextValue);
			cursor.continue();
		};
	});
}

export async function listRequests() {
	const result = await withStore(ADVANCED_DB.stores.requests, "readonly", (store) => requestAsPromise(store.getAll()));
	return (await result)
		.slice()
		.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

export async function getRequest(requestId) {
	const result = await withStore(ADVANCED_DB.stores.requests, "readonly", (store) => requestAsPromise(store.get(requestId)));
	return result;
}

export async function listRequestsByAccount(accountId) {
	const result = await withStore(ADVANCED_DB.stores.requests, "readonly", (store) => {
		const index = store.index("accountId");
		return requestAsPromise(index.getAll(IDBKeyRange.only(accountId)));
	});

	return (await result)
		.slice()
		.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

export async function upsertRequest(record) {
	await withStore(ADVANCED_DB.stores.requests, "readwrite", (store) => {
		store.put(record);
	});
	return record;
}

export async function deleteRequest(requestId) {
	await withStore(ADVANCED_DB.stores.requests, "readwrite", (store) => {
		store.delete(requestId);
	});
}

export async function clearRequests() {
	await withStore(ADVANCED_DB.stores.requests, "readwrite", (store) => {
		store.clear();
	});
}

export async function purgeAllData() {
	await clearAccounts({ cascadeRequests: true });
	clearPreferences();
}
