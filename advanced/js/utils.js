const DOMAIN_PATTERN = /^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i;
const IPV4_PATTERN = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function createId() {
	if (window.crypto && typeof window.crypto.randomUUID === "function") {
		return window.crypto.randomUUID();
	}

	const bytes = new Uint8Array(16);
	window.crypto.getRandomValues(bytes);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

export function nowIso() {
	return new Date().toISOString();
}

export function formatDateTime(value) {
	if (!value) {
		return "-";
	}

	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return "-";
	}

	return new Intl.DateTimeFormat(undefined, {
		year: "numeric",
		month: "short",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit"
	}).format(date);
}

export function parseEmails(rawValue) {
	const emails = String(rawValue || "")
		.split(/[\n,;]/)
		.map((item) => item.trim())
		.filter(Boolean);

	const invalid = emails.filter((email) => !isLikelyEmail(email));
	return {
		emails,
		invalid
	};
}

export function isLikelyEmail(value) {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

export function parseIdentifiers(rawValue, options = {}) {
	const allowWildcard = options.allowWildcard !== false;
	const values = String(rawValue || "")
		.split(/[\n,;]/)
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean);

	const unique = Array.from(new Set(values));
	const identifiers = [];
	const invalid = [];

	unique.forEach((item) => {
		if (isLikelyIPv4(item) || isLikelyIPv6(item)) {
			identifiers.push({ type: "ip", value: item });
			return;
		}

		let candidate = item;
		if (item.startsWith("*.")) {
			if (!allowWildcard) {
				invalid.push(item);
				return;
			}
			candidate = item.slice(2);
		}

		if (!DOMAIN_PATTERN.test(candidate) || candidate.includes("*")) {
			invalid.push(item);
			return;
		}

		identifiers.push({ type: "dns", value: item });
	});

	return {
		identifiers,
		invalid
	};
}

export function isLikelyIPv4(value) {
	return IPV4_PATTERN.test(String(value || ""));
}

export function isLikelyIPv6(value) {
	const trimmed = String(value || "").trim();
	if (!trimmed.includes(":")) {
		return false;
	}

	try {
		return trimmed.split(":").length >= 3;
	} catch (_error) {
		return false;
	}
}

export async function copyText(value) {
	const text = String(value || "");
	if (!text) {
		return false;
	}

	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch (_error) {
		const input = document.createElement("textarea");
		input.value = text;
		input.readOnly = true;
		input.style.position = "fixed";
		input.style.opacity = "0";
		document.body.appendChild(input);
		input.focus();
		input.select();
		const copied = document.execCommand("copy");
		document.body.removeChild(input);
		return copied;
	}
}

export function base64UrlEncodeBuffer(value) {
	const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
	let binary = "";
	const chunk = 0x8000;

	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}

	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

export function base64UrlEncodeText(value) {
	return base64UrlEncodeBuffer(new TextEncoder().encode(String(value || "")));
}

export function base64UrlDecodeToBytes(value) {
	const normalized = String(value || "")
		.replace(/-/g, "+")
		.replace(/_/g, "/");

	const padding = normalized.length % 4;
	const padded = padding ? normalized.padEnd(normalized.length + (4 - padding), "=") : normalized;
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);

	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}

	return bytes;
}

export function base64UrlDecodeToText(value) {
	const bytes = base64UrlDecodeToBytes(value);
	return new TextDecoder().decode(bytes);
}

export function normalizeDnsTxtValue(value) {
	return String(value || "")
		.replace(/"/g, "")
		.trim();
}

export function safeJsonParse(value, fallback = {}) {
	try {
		return JSON.parse(value);
	} catch (_error) {
		return fallback;
	}
}

export function sleep(ms) {
	return new Promise((resolve) => {
		window.setTimeout(resolve, ms);
	});
}

export function toArray(value) {
	if (!value) {
		return [];
	}

	if (Array.isArray(value)) {
		return value;
	}

	return [value];
}

export function downloadTextFile(fileName, content) {
	const blob = new Blob([String(content || "")], { type: "text/plain;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = fileName;
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
	URL.revokeObjectURL(url);
}
