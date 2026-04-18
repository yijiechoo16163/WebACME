import {
	CAPABILITY_FIELDS,
	capabilityStatusClass,
	capabilityStatusLabel
} from "./constants.js";
import { copyText } from "./utils.js";

export function initCommonUi(activePage) {
	const statusMessage = document.getElementById("statusMessage");
	const errorMessage = document.getElementById("errorMessage");
	const yearNode = document.getElementById("footerYear");

	if (yearNode) {
		yearNode.textContent = String(new Date().getFullYear());
	}

	document.querySelectorAll("[data-advanced-nav]").forEach((node) => {
		if (node.dataset.advancedNav === activePage) {
			node.classList.add("active");
		}
	});

	document.addEventListener("click", async (event) => {
		const button = event.target.closest("[data-copy-value], [data-copy-target]");
		if (!button) {
			return;
		}

		event.preventDefault();

		let value = button.getAttribute("data-copy-value");
		if (value === null) {
			const targetId = button.getAttribute("data-copy-target");
			const target = targetId ? document.getElementById(targetId) : null;
			value = target && "value" in target ? target.value : "";
		}

		if (!value) {
			return;
		}

		const copied = await copyText(value);
		if (!copied) {
			return;
		}

		button.classList.add("copied");
		const icon = button.querySelector("i");
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
	});

	return {
		setStatus(message) {
			if (statusMessage) {
				statusMessage.textContent = message;
			}
		},
		showError(message) {
			if (!errorMessage) {
				return;
			}
			errorMessage.textContent = String(message || "Unknown error");
			errorMessage.classList.remove("d-none");
		},
		clearError() {
			if (!errorMessage) {
				return;
			}
			errorMessage.textContent = "";
			errorMessage.classList.add("d-none");
		},
		setBusy(button, isBusy, busyLabel) {
			if (!button) {
				return;
			}

			if (isBusy) {
				if (!button.dataset.originalLabel) {
					button.dataset.originalLabel = button.textContent;
				}
				button.disabled = true;
				button.textContent = busyLabel || "Working...";
				return;
			}

			button.disabled = false;
			if (button.dataset.originalLabel) {
				button.textContent = button.dataset.originalLabel;
			}
		}
	};
}

export function renderCapabilityTable(container, capabilities) {
	if (!container) {
		return;
	}

	container.innerHTML = "";
	const table = document.createElement("table");
	table.className = "table table-sm align-middle capability-table";

	const thead = document.createElement("thead");
	thead.innerHTML = "<tr><th>Feature</th><th>Status</th></tr>";
	table.appendChild(thead);

	const tbody = document.createElement("tbody");
	CAPABILITY_FIELDS.forEach((field) => {
		const row = document.createElement("tr");
		const status = capabilities[field.key] || "unknown";
		row.innerHTML = `<td>${field.label}</td><td><span class="capability-pill ${capabilityStatusClass(status)}">${capabilityStatusLabel(status)}</span></td>`;
		tbody.appendChild(row);
	});
	table.appendChild(tbody);
	container.appendChild(table);
}

export function statusBadgeClass(status) {
	switch (String(status || "").toLowerCase()) {
		case "valid":
			return "status-valid";
		case "ready":
			return "status-ready";
		case "pending":
		case "processing":
			return "status-pending";
		case "submitted":
			return "status-submitted";
		case "invalid":
		case "deactivated":
			return "status-error";
		default:
			return "status-neutral";
	}
}

export function humanizeAcmeError(error) {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error || "Unknown error");
}

export function askConfirmation(message) {
	return window.confirm(message);
}
