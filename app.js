const PAGE_IDS = {
  ACCOUNT_MANAGER: "account-manager",
  REQUEST_CERT: "request-cert",
  REVOKE_CERT: "revoke-cert",
};

const REQUEST_STEPS = [
  { id: 2, label: "Certificate Config" },
  { id: 3, label: "Challenge" },
  { id: 4, label: "CSR & Finalize" },
  { id: 5, label: "Result" },
];

const ACME_PROVIDERS = {
  letsencrypt: {
    label: "Let's Encrypt",
    environments: {
      staging: "https://acme-staging-v02.api.letsencrypt.org/directory",
      production: "https://acme-v02.api.letsencrypt.org/directory",
    },
    defaultProfile: "classic",
    defaultIdentifierTypes: ["dns"],
    profileIdentifierTypes: {
      classic: ["dns"],
      tlsserver: ["dns"],
      tlsclient: ["dns"],
      shortlived: ["dns", "ip"],
    },
    certTypes: [
      { id: "dns", label: "Domain Certificate", placeholder: "example.com" },
      { id: "ip", label: "IP Certificate", placeholder: "203.0.113.10 or 2001:db8::1" },
    ],
  },
};

const ACME_ACCOUNT_STORAGE_KEY = "webacme.savedAcmeAccounts.v1";
const CERTIFICATE_REQUEST_STORAGE_KEY = "webacme.certificateRequests.v1";
const providerDirectoryMetaCache = new Map();
let certificateRequestsTableInstance = null;

function createInitialState() {
  return {
    page: PAGE_IDS.ACCOUNT_MANAGER,
    step: 1,
    alert: null,
    busy: false,
    logs: ["Session initialized."],
    email: "",
    accountNickname: "",
    provider: "letsencrypt",
    environment: "staging",
    providerTermsOfServiceUrl: "",
    providerWebsiteUrl: "",
    providerMetaLoading: false,
    providerMetaError: "",
    providerMetaRequestId: 0,
    savedAccounts: loadSavedAccounts(),
    certificateRequests: loadCertificateRequests(),
    certificateManagerMode: "list",
    activeRequestId: "",
    selectedAccountId: "",
    accountReady: false,
    profile: "",
    directoryProfiles: {},
    availableProfileIds: [],
    certType: "dns",
    identifierValue: "",
    sanInputValues: [""],
    sanIdentifiers: [],
    directory: null,
    nonce: null,
    accountKeyPair: null,
    accountPrivateKeyPem: "",
    accountJwk: null,
    accountThumbprint: "",
    accountKid: "",
    order: null,
    orderUrl: "",
    authorizationStates: [],
    selectedAuthorizationUrl: "",
    authorization: null,
    authorizationUrl: "",
    availableChallenges: {},
    selectedChallengeType: "",
    challenge: null,
    keyAuthorization: "",
    dnsTxtValue: "",
    domainKeyPair: null,
    domainPrivateKeyPem: "",
    certificatePem: "",
  };
}

const state = createInitialState();

const refs = {
  stepper: document.getElementById("stepper"),
  alertRegion: document.getElementById("alertRegion"),
  content: document.getElementById("app-step-content"),
  eventLog: document.getElementById("eventLog"),
  navAccountManagerBtn: document.getElementById("navAccountManagerBtn"),
  navRequestCertBtn: document.getElementById("navRequestCertBtn"),
  navRevokeCertBtn: document.getElementById("navRevokeCertBtn"),
  currentSelectionLabel: document.getElementById("currentSelectionLabel"),
};

init();

function init() {
  bindGlobalActions();
  state.savedAccounts = loadSavedAccounts();
  render();
  refreshProviderMetadataPreview();
}

function bindGlobalActions() {
  refs.navAccountManagerBtn.addEventListener("click", () => {
    if (state.busy) {
      return;
    }
    setActivePage(PAGE_IDS.ACCOUNT_MANAGER);
  });

  refs.navRequestCertBtn.addEventListener("click", () => {
    if (state.busy) {
      return;
    }
    state.certificateManagerMode = "list";
    setActivePage(PAGE_IDS.REQUEST_CERT);
  });

  refs.navRevokeCertBtn.addEventListener("click", () => {
    if (state.busy) {
      return;
    }
    setActivePage(PAGE_IDS.REVOKE_CERT);
  });
}

function render() {
  renderNav();
  renderAlert();
  renderCurrentPage();
  renderLog();
}

function renderStepper() {
  refs.stepper.innerHTML = REQUEST_STEPS.map((step, index) => {
    const classes = ["step-item"];
    if (state.step === step.id) {
      classes.push("active");
    }
    if (state.step > step.id) {
      classes.push("completed");
    }
    return `
      <li class="${classes.join(" ")}">
        <span class="step-number">${index + 1}.</span>${step.label}
      </li>
    `;
  }).join("");
}

function renderNav() {
  const navMap = [
    { id: PAGE_IDS.ACCOUNT_MANAGER, element: refs.navAccountManagerBtn },
    { id: PAGE_IDS.REQUEST_CERT, element: refs.navRequestCertBtn },
    { id: PAGE_IDS.REVOKE_CERT, element: refs.navRevokeCertBtn },
  ];

  navMap.forEach((item) => {
    if (!item.element) {
      return;
    }

    const isActive = state.page === item.id;
    item.element.classList.toggle("btn-light", isActive);
    item.element.classList.toggle("btn-outline-light", !isActive);
  });

  const selectedAccount = getSavedAccountById(state.selectedAccountId);
  const selectedAccountLabel = selectedAccount
    ? selectedAccount.nickname
    : (state.accountReady && state.accountNickname ? state.accountNickname : "(none)");

  if (refs.currentSelectionLabel) {
    refs.currentSelectionLabel.textContent = `Current selection: ${selectedAccountLabel}`;
  }
}

function renderAlert() {
  if (!state.alert) {
    refs.alertRegion.innerHTML = "";
    return;
  }

  refs.alertRegion.innerHTML = `
    <div class="alert alert-${state.alert.type} mb-0" role="alert">
      ${escapeHtml(state.alert.message)}
    </div>
  `;
}

function setActivePage(pageId) {
  state.page = pageId;
  render();
}

function renderCurrentPage() {
  if (state.page === PAGE_IDS.ACCOUNT_MANAGER) {
    destroyCertificateRequestsDataTable();
    refs.stepper.innerHTML = "";
    renderStepAccountInit();
    return;
  }

  if (state.page === PAGE_IDS.REVOKE_CERT) {
    destroyCertificateRequestsDataTable();
    refs.stepper.innerHTML = "";
    renderRevokeCertPage();
    return;
  }

  renderCertificateManagerPage();
}

function renderCertificateManagerPage() {
  if (state.certificateManagerMode === "list") {
    renderCertificateManagerList();
    return;
  }

  renderCertificateRequestWorkflow();
}

function renderCertificateRequestWorkflow() {
  destroyCertificateRequestsDataTable();

  if (!state.accountReady) {
    refs.stepper.innerHTML = "";
    refs.content.innerHTML = `
      <div class="alert alert-info mb-0">
        Select or create an ACME account in Account Manager first, then start a request from Certificate Manager.
      </div>
    `;
    return;
  }

  if (state.step < 2) {
    state.step = 2;
  }

  renderStepper();

  if (state.step === 2) {
    renderStepCertificateConfig();
    return;
  }

  if (state.step === 3) {
    renderStepChallenge();
    return;
  }

  if (state.step === 4) {
    renderStepFinalize();
    return;
  }

  renderStepResult();
}

function renderCertificateManagerList() {
  refs.stepper.innerHTML = "";

  const selectedAccount = getSavedAccountById(state.selectedAccountId);
  const selectedAccountRequests = getCertificateRequestsForSelectedAccount();
  const selectedAccountName = selectedAccount?.nickname || "(none)";

  const requestRows = selectedAccountRequests
    .map((request) => {
      const providerLabel = getProviderLabel(request.providerId);
      let typeLabel = "DNS";
      if (request.certType === "ip") {
        typeLabel = "IP";
      } else if (request.certType === "mixed") {
        typeLabel = "DNS + IP";
      }

      const identifiers = Array.isArray(request.sanValues) && request.sanValues.length
        ? request.sanValues
        : [request.identifierValue].filter(Boolean);
      const identifierSummary = identifiers.length > 1
        ? `${identifiers[0]} (+${identifiers.length - 1})`
        : (identifiers[0] || "");
      const profileLabel = request.profile || "(default)";
      const createdLabel = formatTimestamp(request.createdAt);
      const updatedLabel = formatTimestamp(request.updatedAt || request.createdAt);

      return `
        <tr>
          <td>${escapeHtml(truncateMiddle(request.id, 12))}</td>
          <td>${escapeHtml(request.status || "unknown")}</td>
          <td>${escapeHtml(typeLabel)}</td>
          <td>${escapeHtml(identifierSummary)}</td>
          <td>${escapeHtml(providerLabel)}</td>
          <td>${escapeHtml(request.environmentId || "")}</td>
          <td>${escapeHtml(profileLabel)}</td>
          <td>${escapeHtml(createdLabel)}</td>
          <td>${escapeHtml(updatedLabel)}</td>
        </tr>
      `;
    })
    .join("");

  refs.content.innerHTML = `
    <div class="d-flex justify-content-between align-items-start flex-wrap gap-2 mb-3">
      <div>
        <h2 class="h5 mb-1">Certificate Manager</h2>
        <p class="mini-note mb-0">Showing certificate requests for selected account: ${escapeHtml(selectedAccountName)}.</p>
      </div>
      <button id="openRequestCertificateFlowBtn" class="btn btn-primary" type="button" ${state.busy ? "disabled" : ""}>Request Certificate</button>
    </div>

    ${!selectedAccount
      ? `<div class="alert alert-warning">Select an account in Account Manager first. Certificate Manager only shows requests under the selected account.</div>`
      : ""}

    <div class="table-responsive">
      <table id="certificateRequestsTable" class="display table table-sm align-middle w-100">
        <thead>
          <tr>
            <th>Request ID</th>
            <th>Status</th>
            <th>Type</th>
            <th>Identifier</th>
            <th>Provider</th>
            <th>Environment</th>
            <th>Profile</th>
            <th>Created</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>${requestRows}</tbody>
      </table>
    </div>
  `;

  document.getElementById("openRequestCertificateFlowBtn")?.addEventListener("click", () => {
    if (!selectedAccount) {
      setAlert("warning", "Select an ACME account first from Account Manager.");
      render();
      return;
    }

    clearOrderContext({ preserveDirectoryMetadata: true });
    if (!state.availableProfileIds.length && state.directory) {
      syncProfilesFromDirectory();
    }
    state.certificateManagerMode = "request";
    state.step = 2;
    render();
  });

  initCertificateRequestsDataTable();
}

function renderRevokeCertPage() {
  refs.content.innerHTML = `
    <div class="mb-3">
      <h2 class="h5">Revoke Cert</h2>
      <p class="mini-note mb-0">This page is reserved for certificate revocation workflow and will be developed later.</p>
    </div>
    <div class="alert alert-secondary mb-0">Coming soon: revoke certificate by certificate + account credentials.</div>
  `;
}

function renderStepAccountInit() {
  const provider = getProviderConfig(state.provider);
  const providerLabel = provider.label;
  const providerOptions = Object.entries(ACME_PROVIDERS)
    .map(([providerId, providerConfig]) => {
      const selected = providerId === state.provider ? "selected" : "";
      return `<option value="${providerId}" ${selected}>${escapeHtml(providerConfig.label)}</option>`;
    })
    .join("");
  let termsAcknowledgementHtml = "";

  if (state.providerMetaLoading) {
    termsAcknowledgementHtml = `
      <div class="alert alert-secondary mb-0">
        Loading provider Terms of Service details...
      </div>
    `;
  } else if (state.providerTermsOfServiceUrl) {
    termsAcknowledgementHtml = `
      <div class="alert alert-secondary mb-0">
        By creating an ACME account with ${escapeHtml(providerLabel)}, you acknowledged that you agreed to the <a href="${escapeHtml(state.providerTermsOfServiceUrl)}" target="_blank" rel="noopener noreferrer">Terms of Service</a>.
      </div>
    `;
  } else {
    termsAcknowledgementHtml = `
      <div class="alert alert-secondary mb-0">
        By creating an ACME account with ${escapeHtml(providerLabel)}, you acknowledged that you agreed to the Terms of Service.
      </div>
    `;
  }
  const environmentOptions = Object.keys(provider.environments)
    .map((environmentId) => {
      const selected = environmentId === state.environment ? "selected" : "";
      const label = environmentId === "staging" ? "Staging (recommended for testing)" : "Production";
      return `<option value="${environmentId}" ${selected}>${label}</option>`;
    })
    .join("");
  const savedAccountRows = state.savedAccounts
    .map((account) => {
      const providerLabel = getProviderLabel(account.providerId);
      const rowClass = account.id === state.selectedAccountId ? "table-primary" : "";
      const createdAtLabel = formatTimestamp(account.createdAt);

      return `
        <tr class="${rowClass}">
          <td>
            <div class="fw-semibold">${escapeHtml(account.nickname)}</div>
          </td>
          <td>
            <div><span class="fw-semibold">Provider:</span> ${escapeHtml(providerLabel)}</div>
            <div><span class="fw-semibold">Environment:</span> ${escapeHtml(account.environmentId)}</div>
            <div><span class="fw-semibold">Email:</span> ${escapeHtml(account.email || "(not set)")}</div>
            <div><span class="fw-semibold">KID:</span> <span class="account-detail-kid">${escapeHtml(truncateMiddle(account.accountKid, 54))}</span></div>
          </td>
          <td class="text-nowrap">${escapeHtml(createdAtLabel)}</td>
          <td class="text-nowrap">
            <button class="btn btn-sm btn-outline-primary me-2" data-account-action="use" data-account-id="${escapeHtml(account.id)}" type="button" ${state.busy ? "disabled" : ""}>Use</button>
            <button class="btn btn-sm btn-outline-secondary me-2" data-account-action="rename" data-account-id="${escapeHtml(account.id)}" type="button" ${state.busy ? "disabled" : ""}>Rename</button>
            <button class="btn btn-sm btn-outline-danger" data-account-action="delete" data-account-id="${escapeHtml(account.id)}" type="button" ${state.busy ? "disabled" : ""}>Delete</button>
          </td>
        </tr>
      `;
    })
    .join("");

  refs.content.innerHTML = `
    <div class="mb-3">
      <h2 class="h5">Account Manager</h2>
      <p class="mini-note mb-0">Create and save ACME accounts in your browser, then open Request Cert when you are ready to issue a certificate.</p>
    </div>

    <form id="accountInitForm" class="row g-3">
      <div class="col-md-6">
        <label for="emailInput" class="form-label">Email (optional)</label>
        <input id="emailInput" class="form-control" type="email" placeholder="you@example.com" value="${escapeHtml(state.email)}" />
      </div>
      <div class="col-md-6">
        <label for="accountNicknameInput" class="form-label">Account Nickname</label>
        <input id="accountNicknameInput" class="form-control" type="text" maxlength="60" placeholder="e.g. Team Staging Account" value="${escapeHtml(state.accountNickname)}" />
      </div>
      <div class="col-md-6">
        <label for="providerInput" class="form-label">ACME Provider</label>
        <select id="providerInput" class="form-select">${providerOptions}</select>
      </div>
      <div class="col-md-6">
        <label for="environmentInput" class="form-label">Provider Environment</label>
        <select id="environmentInput" class="form-select">${environmentOptions}</select>
      </div>
      <div class="col-12">
        ${termsAcknowledgementHtml}
      </div>
      <div class="col-12 d-flex gap-2 flex-wrap">
        <button class="btn btn-primary" id="initAccountBtn" type="submit" ${state.busy ? "disabled" : ""}>
          ${state.busy ? "Working..." : "Create ACME Account And Save"}
        </button>
      </div>
    </form>

    <div class="card border-0 bg-light mt-4">
      <div class="card-body">
        <div class="d-flex justify-content-between align-items-start flex-wrap gap-2 mb-3">
          <div>
            <h3 class="h6 mb-1">Account Manager / Selector</h3>
            <p class="mini-note mb-0">You can keep multiple ACME accounts across providers and environments, each with a memorable nickname.</p>
          </div>
          <span class="badge text-bg-secondary">${state.savedAccounts.length} saved</span>
        </div>

        <div class="d-flex gap-2 flex-wrap mb-2">
          <button id="exportAccountsBtn" class="btn btn-outline-secondary" type="button" ${!state.savedAccounts.length || state.busy ? "disabled" : ""}>Export Saved Accounts</button>
          <button id="importAccountsBtn" class="btn btn-outline-secondary" type="button" ${state.busy ? "disabled" : ""}>Import Accounts JSON</button>
          <button id="purgeAccountsBtn" class="btn btn-outline-danger" type="button" ${!state.savedAccounts.length || state.busy ? "disabled" : ""}>Purge Saved Accounts</button>
          <input id="importAccountsInput" class="d-none" type="file" accept=".json,application/json" />
        </div>
        <p class="mini-note mb-3">Export/import includes ACME account private keys. Keep the JSON file in a secure place.</p>

        ${state.savedAccounts.length
          ? `
            <div class="table-responsive">
              <table class="table table-sm table-hover align-middle account-table mb-0">
                <thead>
                  <tr>
                    <th scope="col">ACME Account Nickname</th>
                    <th scope="col">ACME Account Details</th>
                    <th scope="col">Time Created</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>${savedAccountRows}</tbody>
              </table>
            </div>
          `
          : `<div class="alert alert-secondary mb-0">No saved ACME accounts yet. Create one above to get started.</div>`}
      </div>
    </div>
  `;

  document.getElementById("providerInput").addEventListener("change", (event) => {
    const nextProviderId = event.target.value;
    const nextProvider = getProviderConfig(nextProviderId);
    const availableEnvironments = Object.keys(nextProvider.environments);
    state.provider = nextProviderId;
    if (!availableEnvironments.includes(state.environment)) {
      state.environment = availableEnvironments[0];
    }
    refreshProviderMetadataPreview();
  });

  document.getElementById("environmentInput").addEventListener("change", (event) => {
    state.environment = event.target.value;
    refreshProviderMetadataPreview();
  });

  document.querySelectorAll("[data-account-action]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const target = event.currentTarget;
      const action = target.getAttribute("data-account-action");
      const accountId = target.getAttribute("data-account-id");

      if (!action || !accountId || state.busy) {
        return;
      }

      if (action === "delete") {
        const account = getSavedAccountById(accountId);
        if (!account) {
          return;
        }

        const confirmed = window.confirm(`Delete saved ACME account "${account.nickname}"?`);
        if (!confirmed) {
          return;
        }

        deleteSavedAccount(accountId);
        pushLog(`Deleted saved account: ${account.nickname}`);
        render();
        return;
      }

      if (action === "rename") {
        const account = getSavedAccountById(accountId);
        if (!account) {
          return;
        }

        const nextNicknameRaw = window.prompt("Enter new nickname:", account.nickname);
        if (nextNicknameRaw === null) {
          return;
        }

        const nextNickname = sanitizeAccountNickname(nextNicknameRaw);
        if (!nextNickname) {
          setAlert("warning", "Nickname cannot be empty.");
          render();
          return;
        }

        renameSavedAccount(accountId, nextNickname);
        pushLog(`Renamed account to "${nextNickname}".`);
        setAlert("success", "Account nickname updated.");
        render();
        return;
      }

      if (action === "use") {
        try {
          await runStep("Loading saved ACME account...", async () => {
            await loadSavedAcmeAccount(accountId);
          });
        } catch (error) {
          handleError(error);
        }
      }
    });
  });

  document.getElementById("exportAccountsBtn")?.addEventListener("click", () => {
    try {
      exportSavedAccountsToFile();
      pushLog(`Exported ${state.savedAccounts.length} saved ACME account(s).`);
      setAlert("success", "Saved ACME accounts exported.");
      render();
    } catch (error) {
      handleError(error);
    }
  });

  document.getElementById("purgeAccountsBtn")?.addEventListener("click", () => {
    if (state.busy) {
      return;
    }

    purgeAllSavedAccounts();
  });

  const importAccountsInput = document.getElementById("importAccountsInput");
  document.getElementById("importAccountsBtn")?.addEventListener("click", () => {
    if (state.busy) {
      return;
    }

    importAccountsInput?.click();
  });

  importAccountsInput?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      const importResult = await importAccountsFromFile(file);
      if (importResult.lastImportedAccountId) {
        state.selectedAccountId = importResult.lastImportedAccountId;
      }

      const importedMessage = `Imported ${importResult.importedCount} new account(s), updated ${importResult.updatedCount} existing account(s).`;
      pushLog(importedMessage);
      setAlert("success", importedMessage);
    } catch (error) {
      handleError(error);
    } finally {
      event.target.value = "";
      render();
    }
  });

  document.getElementById("accountInitForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    if (state.busy) {
      return;
    }

    const emailValue = document.getElementById("emailInput").value.trim();
    const accountNicknameValue = document.getElementById("accountNicknameInput").value.trim();
    const providerValue = document.getElementById("providerInput").value;
    const envValue = document.getElementById("environmentInput").value;

    try {
      await runStep("Initializing ACME account...", async () => {
        state.email = emailValue;
        state.accountNickname = sanitizeAccountNickname(accountNicknameValue);
        state.provider = providerValue;
        state.environment = envValue;
        await initializeAcmeAccount();
        const savedAccount = saveCurrentAccountToBrowser(state.accountNickname);
        state.selectedAccountId = savedAccount.id;
        state.accountNickname = savedAccount.nickname;
        pushLog(`Saved ACME account as "${savedAccount.nickname}".`);
      });
    } catch (error) {
      handleError(error);
    }
  });
}

function renderStepCertificateConfig() {
  if (!state.accountReady) {
    setActivePage(PAGE_IDS.ACCOUNT_MANAGER);
    return;
  }

  const provider = getProviderConfig(state.provider);
  state.sanInputValues = normalizeSanInputValues(state.sanInputValues);

  const profileOptions = state.availableProfileIds
    .map((profileId) => {
      const selected = profileId === state.profile ? "selected" : "";
      return `<option value="${profileId}" ${selected}>${escapeHtml(profileId)}</option>`;
    })
    .join("");
  const selectedProfileDocUrl = state.profile ? state.directoryProfiles[state.profile] : "";
  const supportedTypeLabel = getAllowedIdentifierTypesForProfile(provider, state.profile)
    .map((item) => item.toUpperCase())
    .join(", ");

  const sanRows = state.sanInputValues
    .map((value, index) => {
      const placeholder = index === 0 ? "example.com" : "203.0.113.10 or *.example.com";
      return `
        <div class="input-group mb-2">
          <span class="input-group-text">SAN ${index + 1}</span>
          <input
            class="form-control san-input"
            type="text"
            data-san-index="${index}"
            placeholder="${escapeHtml(placeholder)}"
            value="${escapeHtml(value)}"
            ${state.busy ? "disabled" : ""}
          />
        </div>
      `;
    })
    .join("");

  refs.content.innerHTML = `
    <div class="mb-3">
      <h2 class="h5">Step 2: Configure Certificate Request</h2>
      <p class="mini-note mb-0">Account is ready for ${escapeHtml(provider.label)}. Add one or more Subject Alternative Names (SANs), then create your order.</p>
    </div>

    <form id="certificateConfigForm" class="row g-3">
      <div class="col-md-6">
        <label for="profileInput" class="form-label">ACME Profile</label>
        <select id="profileInput" class="form-select" ${state.busy || !state.availableProfileIds.length ? "disabled" : ""}>
          ${profileOptions}
        </select>
        <div class="form-text">
          ${state.availableProfileIds.length
            ? `Profile list comes from provider directory metadata.${selectedProfileDocUrl ? ` <a href="${escapeHtml(selectedProfileDocUrl)}" target="_blank" rel="noopener noreferrer">Profile details</a>.` : ""}`
            : "Provider did not advertise profile selection metadata."}
        </div>
      </div>
      <div class="col-12">
        <label class="form-label">Subject Alternative Names (SAN)</label>
        ${sanRows}
        <div class="form-text">
          One SAN per row. Enter DNS names and/or IP addresses. Press Enter in a SAN field to add the next row.
          Profile supports: ${escapeHtml(supportedTypeLabel || "DNS")}
        </div>
      </div>
      <div class="col-12 d-flex gap-2 flex-wrap">
        <button class="btn btn-primary" id="createOrderBtn" type="submit" ${state.busy ? "disabled" : ""}>
          ${state.busy ? "Working..." : "Create ACME Order"}
        </button>
      </div>
    </form>
  `;

  document.getElementById("profileInput")?.addEventListener("change", (event) => {
    state.profile = event.target.value;
    render();
  });

  document.querySelectorAll(".san-input").forEach((input) => {
    input.addEventListener("input", () => {
      const currentInputs = Array.from(document.querySelectorAll(".san-input"));
      state.sanInputValues = normalizeSanInputValues(currentInputs.map((item) => item.value));
    });

    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || state.busy) {
        return;
      }

      event.preventDefault();

      const currentInputs = Array.from(document.querySelectorAll(".san-input"));
      state.sanInputValues = normalizeSanInputValues(currentInputs.map((item) => item.value));

      const currentIndex = Number(input.getAttribute("data-san-index"));
      if (!Number.isInteger(currentIndex) || currentIndex < 0) {
        return;
      }

      const nextIndex = currentIndex + 1;
      if (currentIndex >= state.sanInputValues.length - 1) {
        state.sanInputValues.push("");
      }

      render();
      window.requestAnimationFrame(() => {
        const nextInput = document.querySelector(`.san-input[data-san-index="${nextIndex}"]`);
        nextInput?.focus();
      });
    });
  });

  document.getElementById("certificateConfigForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    if (state.busy) {
      return;
    }

    const profileValue = document.getElementById("profileInput")?.value || state.profile;
    const sanValues = Array.from(document.querySelectorAll(".san-input")).map((input) => input.value);
    const sanParseResult = parseSanIdentifiers(sanValues);

    if (sanParseResult.errors.length) {
      setAlert("danger", sanParseResult.errors[0]);
      render();
      return;
    }

    if (!sanParseResult.identifiers.length) {
      setAlert("danger", "Please enter at least one SAN value.");
      render();
      return;
    }

    const includesIp = sanParseResult.identifiers.some((item) => item.type === "ip");
    if (includesIp && profileValue !== "shortlived") {
      setAlert("danger", "This request includes IP SAN entries. Select the shortlived profile before continuing.");
      render();
      return;
    }

    const allowedIdentifierTypes = getAllowedIdentifierTypesForProfile(provider, profileValue);
    const unsupportedIdentifier = sanParseResult.identifiers.find((item) => !allowedIdentifierTypes.includes(item.type));
    if (unsupportedIdentifier) {
      setAlert("danger", `Profile ${profileValue || "default"} does not permit ${unsupportedIdentifier.type.toUpperCase()} identifiers.`);
      render();
      return;
    }

    try {
      await runStep("Creating ACME order...", async () => {
        state.profile = profileValue;
        state.sanIdentifiers = sanParseResult.identifiers;
        state.sanInputValues = normalizeSanInputValues(sanParseResult.identifiers.map((item) => item.value));
        state.identifierValue = sanParseResult.identifiers[0].value;
        state.certType = deriveRequestCertType(sanParseResult.identifiers);
        await createAcmeOrder();
      });
    } catch (error) {
      handleError(error);
    }
  });
}

function renderStepChallenge() {
  const selectedAuthorization = getSelectedAuthorizationState();
  if (!selectedAuthorization) {
    refs.content.innerHTML = `
      <div class="alert alert-warning mb-0">No authorization data is available yet. Return to Step 2 and create a new order.</div>
    `;
    return;
  }

  const challenge = selectedAuthorization.challenge;
  const availableTypes = Object.keys(selectedAuthorization.availableChallenges || {});
  const hasMethodChoices = availableTypes.length > 1;
  const isHttp = challenge?.type === "http-01";
  const isDns = challenge?.type === "dns-01";
  const hasHttp = availableTypes.includes("http-01");
  const hasDns = availableTypes.includes("dns-01");
  const allValid = areAllAuthorizationsValid();

  const authorizationRows = state.authorizationStates
    .map((authorizationState) => {
      const isSelected = authorizationState.url === state.selectedAuthorizationUrl;
      const challengeTypeLabel = authorizationState.selectedChallengeType || "(none)";
      const identifierLabel = `${authorizationState.identifierType.toUpperCase()}: ${authorizationState.identifierValue}`;

      return `
        <tr class="${isSelected ? "table-primary" : ""}">
          <td>${escapeHtml(identifierLabel)}</td>
          <td>${escapeHtml(authorizationState.status || "pending")}</td>
          <td>${escapeHtml(challengeTypeLabel)}</td>
          <td class="text-nowrap">
            <button
              class="btn btn-sm btn-outline-primary me-2"
              type="button"
              data-auth-action="focus"
              data-auth-url="${escapeHtml(authorizationState.url)}"
              ${state.busy ? "disabled" : ""}
            >
              ${isSelected ? "Selected" : "Use"}
            </button>
            <button
              class="btn btn-sm btn-outline-secondary"
              type="button"
              data-auth-action="check"
              data-auth-url="${escapeHtml(authorizationState.url)}"
              ${state.busy ? "disabled" : ""}
            >Check</button>
          </td>
        </tr>
      `;
    })
    .join("");

  const dnsRecordName = selectedAuthorization.identifierType === "dns"
    ? `_acme-challenge.${selectedAuthorization.identifierValue}`
    : "_acme-challenge";

  refs.content.innerHTML = `
    <div class="mb-3">
      <h2 class="h5">Step 3: Complete SAN Authorizations</h2>
      <p class="mini-note mb-0">Each SAN must reach valid status before finalizing the order.</p>
    </div>

    <div class="table-responsive mb-3">
      <table class="table table-sm align-middle mb-0">
        <thead>
          <tr>
            <th>Identifier</th>
            <th>Status</th>
            <th>Method</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>${authorizationRows}</tbody>
      </table>
    </div>

    <div class="row g-3">
      <div class="col-12 col-md-7">
        <label class="form-label">Validation Method</label>
        <div class="btn-group w-100" role="group" aria-label="Validation method selection">
          <button
            id="challengeTypeHttpBtn"
            type="button"
            class="btn ${selectedAuthorization.selectedChallengeType === "http-01" ? "btn-primary" : "btn-outline-primary"}"
            ${!hasHttp || state.busy ? "disabled" : ""}
          >
            HTTP-01
          </button>
          <button
            id="challengeTypeDnsBtn"
            type="button"
            class="btn ${selectedAuthorization.selectedChallengeType === "dns-01" ? "btn-primary" : "btn-outline-primary"}"
            ${!hasDns || state.busy ? "disabled" : ""}
          >
            DNS-01
          </button>
        </div>
      </div>
      <div class="col-12">
        <div class="alert alert-secondary mb-0">${hasMethodChoices ? "You can switch between HTTP-01 and DNS-01 at any time before authorization becomes valid." : "Only one challenge method is currently available for this authorization."}</div>
      </div>
      <div class="col-12">
        <div class="card border-0 bg-light">
          <div class="card-body">
            <h3 class="h6">Challenge Instructions</h3>
            ${isHttp ? `
              <p class="mb-2"><strong>Filename:</strong></p>
              <div class="challenge-box challenge-copyable mb-3">
                <span class="challenge-copyable-value">.well-known/acme-challenge/${escapeHtml(challenge.token)}</span>
                <button id="copyHttpPathBtn" class="copy-icon-btn" type="button" title="Copy filename path" aria-label="Copy filename path" ${state.busy ? "disabled" : ""}>${copyIconSvg()}</button>
              </div>
              <p class="mb-2"><strong>Content:</strong></p>
              <div class="challenge-box challenge-copyable mb-3">
                <span class="challenge-copyable-value">${escapeHtml(selectedAuthorization.keyAuthorization)}</span>
                <button id="copyHttpContentBtn" class="copy-icon-btn" type="button" title="Copy content" aria-label="Copy content" ${state.busy ? "disabled" : ""}>${copyIconSvg()}</button>
              </div>
              <div>
                <button id="downloadHttpChallengeBtn" class="btn btn-outline-secondary btn-sm" type="button" ${state.busy ? "disabled" : ""}>
                  Download HTTP-01 Challenge File
                </button>
              </div>
            ` : ""}
            ${isDns ? `
              <p class="mb-2"><strong>TXT Record Name:</strong></p>
              <div class="challenge-box challenge-copyable mb-3">
                <span class="challenge-copyable-value">${escapeHtml(dnsRecordName)}</span>
                <button id="copyDnsNameBtn" class="copy-icon-btn" type="button" title="Copy TXT record name" aria-label="Copy TXT record name" ${state.busy ? "disabled" : ""}>${copyIconSvg()}</button>
              </div>
              <p class="mb-2"><strong>TXT Record Value:</strong></p>
              <div class="challenge-box challenge-copyable mb-3">
                <span class="challenge-copyable-value">${escapeHtml(selectedAuthorization.dnsTxtValue)}</span>
                <button id="copyDnsValueBtn" class="copy-icon-btn" type="button" title="Copy TXT record value" aria-label="Copy TXT record value" ${state.busy ? "disabled" : ""}>${copyIconSvg()}</button>
              </div>
              <p class="mini-note mb-0">For dns-01, this value is SHA-256(keyAuthorization) in base64url format.</p>
            ` : ""}
            ${!isHttp && !isDns ? `<div class="alert alert-secondary mb-0">No supported challenge method is currently selectable for this SAN identifier.</div>` : ""}
          </div>
        </div>
      </div>
      <div class="col-12 d-flex gap-2 flex-wrap">
        <button id="triggerChallengeBtn" class="btn btn-primary" type="button" ${state.busy || !selectedAuthorization.challenge?.url ? "disabled" : ""}>
          ${state.busy ? "Working..." : "Notify CA For Selected SAN"}
        </button>
        <button id="checkAuthStatusBtn" class="btn btn-outline-primary" type="button" ${state.busy ? "disabled" : ""}>Check Selected Status</button>
        <button id="checkAllAuthStatusBtn" class="btn btn-outline-primary" type="button" ${state.busy ? "disabled" : ""}>Check All SAN Statuses</button>
        <button id="continueToFinalizeBtn" class="btn btn-success" type="button" ${!allValid || state.busy ? "disabled" : ""}>Continue To Finalize</button>
      </div>
    </div>
  `;

  document.querySelectorAll("[data-auth-action]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      if (state.busy) {
        return;
      }

      const target = event.currentTarget;
      const action = target.getAttribute("data-auth-action");
      const authorizationUrl = target.getAttribute("data-auth-url");
      const authorizationState = state.authorizationStates.find((item) => item.url === authorizationUrl);

      if (!action || !authorizationUrl || !authorizationState) {
        return;
      }

      if (action === "focus") {
        state.selectedAuthorizationUrl = authorizationUrl;
        render();
        return;
      }

      if (action === "check") {
        try {
          await runStep(`Checking authorization status for ${authorizationState.identifierValue}...`, async () => {
            await refreshAuthorizationState(authorizationState);
            if (areAllAuthorizationsValid()) {
              state.step = 4;
              updateActiveCertificateRequest({
                status: "authorized",
                errorMessage: "",
              });
              pushLog("All SAN authorizations are valid. Proceed to CSR/finalize.");
            } else {
              pushLog(`Authorization for ${authorizationState.identifierValue} is ${authorizationState.status}.`);
            }
          });
        } catch (error) {
          handleError(error);
        }
      }
    });
  });

  const challengeTypeButtons = [
    { id: "challengeTypeHttpBtn", type: "http-01" },
    { id: "challengeTypeDnsBtn", type: "dns-01" },
  ];

  for (const item of challengeTypeButtons) {
    const button = document.getElementById(item.id);
    if (!button || button.disabled) {
      continue;
    }

    button.addEventListener("click", async () => {
      if (state.busy || item.type === selectedAuthorization.selectedChallengeType) {
        return;
      }

      try {
        await runStep(`Switching validation method to ${item.type}...`, async () => {
          await applyAuthorizationChallengeSelection(selectedAuthorization, item.type);
          pushLog(`Validation method for ${selectedAuthorization.identifierValue} switched to ${item.type}.`);
        });
      } catch (error) {
        handleError(error);
      }
    });
  }

  if (isHttp) {
    bindCopyButton("copyHttpPathBtn", `.well-known/acme-challenge/${selectedAuthorization.challenge.token}`, "HTTP challenge filename path");
    bindCopyButton("copyHttpContentBtn", selectedAuthorization.keyAuthorization, "HTTP challenge content");

    document.getElementById("downloadHttpChallengeBtn").addEventListener("click", () => {
      if (!selectedAuthorization.challenge?.token || !selectedAuthorization.keyAuthorization) {
        handleError(new Error("HTTP challenge data is incomplete."));
        return;
      }

      downloadTextFile(selectedAuthorization.challenge.token, selectedAuthorization.keyAuthorization, "application/octet-stream");
      pushLog(`Downloaded HTTP-01 challenge file: ${selectedAuthorization.challenge.token}`);
      renderLog();
    });
  }

  if (isDns) {
    bindCopyButton("copyDnsNameBtn", dnsRecordName, "DNS TXT record name");
    bindCopyButton("copyDnsValueBtn", selectedAuthorization.dnsTxtValue, "DNS TXT record value");
  }

  document.getElementById("triggerChallengeBtn").addEventListener("click", async () => {
    if (state.busy) {
      return;
    }
    try {
      await runStep("Triggering challenge and polling authorization...", async () => {
        await triggerChallenge();
      });
    } catch (error) {
      handleError(error);
    }
  });

  document.getElementById("checkAuthStatusBtn").addEventListener("click", async () => {
    if (state.busy) {
      return;
    }
    try {
      await runStep("Checking authorization status...", async () => {
        const auth = await fetchAuthorization();
        if (auth.status === "valid" && areAllAuthorizationsValid()) {
          state.step = 4;
          updateActiveCertificateRequest({
            status: "authorized",
            errorMessage: "",
          });
          pushLog("All SAN authorizations are valid. Proceed to CSR/finalize.");
        } else {
          pushLog(`Selected authorization is currently ${auth.status}.`);
        }
      });
    } catch (error) {
      handleError(error);
    }
  });

  document.getElementById("checkAllAuthStatusBtn").addEventListener("click", async () => {
    if (state.busy) {
      return;
    }

    try {
      await runStep("Checking all SAN authorization statuses...", async () => {
        await refreshAllAuthorizations();
        if (areAllAuthorizationsValid()) {
          state.step = 4;
          updateActiveCertificateRequest({
            status: "authorized",
            errorMessage: "",
          });
          pushLog("All SAN authorizations are valid. Proceed to CSR/finalize.");
        } else {
          pushLog("Some SAN authorizations are still pending. Continue validation.");
        }
      });
    } catch (error) {
      handleError(error);
    }
  });

  document.getElementById("continueToFinalizeBtn").addEventListener("click", () => {
    if (state.busy || !areAllAuthorizationsValid()) {
      return;
    }

    state.step = 4;
    render();
  });
}

function renderStepFinalize() {
  refs.content.innerHTML = `
    <div class="mb-3">
      <h2 class="h5">Step 4: Generate Domain Key, CSR, and Finalize</h2>
      <p class="mini-note mb-0">Your domain private key is generated locally and never sent to a backend.</p>
    </div>

    <div class="d-flex gap-2 flex-wrap mb-3">
      <button id="finalizeOrderBtn" class="btn btn-primary" type="button" ${state.busy ? "disabled" : ""}>
        ${state.busy ? "Working..." : "Generate Domain Key + Finalize Order"}
      </button>
      <button id="recheckOrderBtn" class="btn btn-outline-primary" type="button" ${state.busy ? "disabled" : ""}>Check Order Status</button>
    </div>

    <div class="alert alert-info mb-0">
      If your order takes time to validate, keep this page open and retry status checks.
    </div>
  `;

  document.getElementById("finalizeOrderBtn").addEventListener("click", async () => {
    if (state.busy) {
      return;
    }

    try {
      await runStep("Generating CSR and finalizing order...", async () => {
        await finalizeOrder();
      });
    } catch (error) {
      handleError(error);
    }
  });

  document.getElementById("recheckOrderBtn").addEventListener("click", async () => {
    if (state.busy) {
      return;
    }

    try {
      await runStep("Refreshing order status...", async () => {
        const order = await fetchOrder();
        if (order.status === "valid" && order.certificate) {
          await fetchCertificate(order.certificate);
          state.step = 5;
          pushLog("Order already valid. Certificate downloaded.");
        } else {
          pushLog(`Order is currently ${order.status}.`);
        }
      });
    } catch (error) {
      handleError(error);
    }
  });
}

function renderStepResult() {
  refs.content.innerHTML = `
    <div class="mb-3">
      <h2 class="h5">Step 5: Certificate Ready</h2>
      <p class="mini-note mb-0">Download your certificate and private key directly from browser memory.</p>
    </div>

    <div class="row g-3">
      <div class="col-12">
        <label class="form-label fw-semibold" for="certificateOutput">Certificate Chain (PEM)</label>
        <textarea id="certificateOutput" class="form-control output-block" readonly>${escapeHtml(state.certificatePem)}</textarea>
      </div>
      <div class="col-12">
        <label class="form-label fw-semibold" for="privateKeyOutput">Domain Private Key (PEM)</label>
        <textarea id="privateKeyOutput" class="form-control output-block" readonly>${escapeHtml(state.domainPrivateKeyPem)}</textarea>
      </div>
      <div class="col-12 d-flex gap-2 flex-wrap">
        <button id="downloadCertBtn" class="btn btn-primary" type="button">Download .crt</button>
        <button id="downloadKeyBtn" class="btn btn-outline-primary" type="button">Download .key</button>
      </div>
    </div>
  `;

  const primaryIdentifier = getPrimaryIdentifierValue(state.sanIdentifiers) || state.identifierValue || "certificate";
  const fileStem = getCertificateFileStem(primaryIdentifier);

  document.getElementById("downloadCertBtn").addEventListener("click", () => {
    downloadTextFile(`${fileStem}.crt`, state.certificatePem);
  });

  document.getElementById("downloadKeyBtn").addEventListener("click", () => {
    downloadTextFile(`${fileStem}.key`, state.domainPrivateKeyPem);
  });
}

function renderLog() {
  refs.eventLog.textContent = state.logs.join("\n");
  refs.eventLog.scrollTop = refs.eventLog.scrollHeight;
}

function setAlert(type, message) {
  state.alert = { type, message };
}

function clearAlert() {
  state.alert = null;
}

async function runStep(description, fn) {
  state.busy = true;
  clearAlert();
  pushLog(description);
  render();
  try {
    await fn();
    clearAlert();
  } finally {
    state.busy = false;
    render();
  }
}

function pushLog(message) {
  const stamp = new Date().toLocaleTimeString();
  state.logs.push(`[${stamp}] ${message}`);
  if (state.logs.length > 120) {
    state.logs = state.logs.slice(-120);
  }
}

function handleError(error) {
  const message = error instanceof Error ? error.message : String(error);
  pushLog(`Error: ${message}`);
  updateActiveCertificateRequest({
    status: "failed",
    errorMessage: message,
  });
  setAlert("danger", message);
  render();
}

function purgeAllSavedAccounts() {
  const confirmed = window.confirm("This will remove all saved ACME accounts from this browser. Continue?");
  if (!confirmed) {
    return;
  }

  localStorage.removeItem(ACME_ACCOUNT_STORAGE_KEY);
  const fresh = createInitialState();
  Object.assign(state, fresh);
  state.page = PAGE_IDS.ACCOUNT_MANAGER;
  pushLog("All saved ACME accounts were purged from browser storage.");
  setAlert("success", "Saved ACME accounts purged.");
  render();
  refreshProviderMetadataPreview();
}

function getProviderConfig(providerId = state.provider) {
  const providerConfig = ACME_PROVIDERS[providerId];
  if (!providerConfig) {
    throw new Error(`Unknown ACME provider: ${providerId}`);
  }
  return providerConfig;
}

function getDirectoryUrlForSelection() {
  const providerConfig = getProviderConfig();
  const directoryUrl = providerConfig.environments[state.environment];
  if (!directoryUrl) {
    throw new Error(`Environment ${state.environment} is not available for ${providerConfig.label}.`);
  }
  return directoryUrl;
}

function applyProviderDirectoryMeta(meta = {}) {
  state.providerTermsOfServiceUrl = typeof meta.termsOfService === "string" ? meta.termsOfService : "";
  state.providerWebsiteUrl = typeof meta.website === "string" ? meta.website : "";
}

async function refreshProviderMetadataPreview(options = {}) {
  const { suppressErrors = true } = options;
  const requestId = state.providerMetaRequestId + 1;
  state.providerMetaRequestId = requestId;
  state.providerMetaLoading = true;
  state.providerMetaError = "";
  render();

  try {
    const directoryUrl = getDirectoryUrlForSelection();
    const cacheKey = `${state.provider}|${state.environment}`;
    let directory;

    if (providerDirectoryMetaCache.has(cacheKey)) {
      directory = providerDirectoryMetaCache.get(cacheKey);
    } else {
      directory = await fetchJson(directoryUrl);
      providerDirectoryMetaCache.set(cacheKey, directory);
    }

    if (state.providerMetaRequestId !== requestId) {
      return;
    }

    applyProviderDirectoryMeta(directory?.meta || {});
  } catch (error) {
    if (state.providerMetaRequestId !== requestId) {
      return;
    }

    applyProviderDirectoryMeta({});
    state.providerMetaError = error instanceof Error ? error.message : String(error);
    if (!suppressErrors) {
      throw error;
    }
  } finally {
    if (state.providerMetaRequestId === requestId) {
      state.providerMetaLoading = false;
      render();
    }
  }
}

function getAllowedIdentifierTypesForProfile(providerConfig, profileId) {
  const profileMap = providerConfig.profileIdentifierTypes || {};
  if (profileId && Array.isArray(profileMap[profileId]) && profileMap[profileId].length) {
    return profileMap[profileId];
  }
  return providerConfig.defaultIdentifierTypes || ["dns"];
}

function syncProfilesFromDirectory() {
  const providerConfig = getProviderConfig();
  const directoryProfiles = state.directory?.meta?.profiles || {};
  state.directoryProfiles = directoryProfiles;

  const advertisedProfileIds = Object.keys(directoryProfiles);
  if (!advertisedProfileIds.length) {
    state.availableProfileIds = [];
    state.profile = "";
    return;
  }

  const knownProfileIds = advertisedProfileIds.filter((profileId) => {
    const profileMap = providerConfig.profileIdentifierTypes || {};
    return Array.isArray(profileMap[profileId]);
  });

  state.availableProfileIds = knownProfileIds.length ? knownProfileIds : advertisedProfileIds;

  const defaultProfile = providerConfig.defaultProfile;
  if (defaultProfile && state.availableProfileIds.includes(defaultProfile)) {
    state.profile = defaultProfile;
    return;
  }

  if (state.profile && state.availableProfileIds.includes(state.profile)) {
    return;
  }

  state.profile = state.availableProfileIds[0];
}

function clearOrderContext(options = {}) {
  const { preserveDirectoryMetadata = false } = options;

  state.activeRequestId = "";
  state.identifierValue = "";
  state.sanInputValues = [""];
  state.sanIdentifiers = [];
  if (!preserveDirectoryMetadata) {
    state.profile = "";
    state.directoryProfiles = {};
    state.availableProfileIds = [];
  }
  state.order = null;
  state.orderUrl = "";
  state.authorizationStates = [];
  state.selectedAuthorizationUrl = "";
  state.authorization = null;
  state.authorizationUrl = "";
  state.availableChallenges = {};
  state.selectedChallengeType = "";
  state.challenge = null;
  state.keyAuthorization = "";
  state.dnsTxtValue = "";
  state.domainKeyPair = null;
  state.domainPrivateKeyPem = "";
  state.certificatePem = "";
}

function loadCertificateRequests() {
  try {
    const serialized = localStorage.getItem(CERTIFICATE_REQUEST_STORAGE_KEY);
    if (!serialized) {
      return [];
    }

    const parsed = JSON.parse(serialized);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((item) => normalizeCertificateRequest(item))
      .filter(Boolean)
      .sort((first, second) => new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime());
  } catch {
    return [];
  }
}

function normalizeCertificateRequest(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const sanValuesFromRecord = Array.isArray(value.sanValues)
    ? value.sanValues
      .map((item) => normalizeIdentifierValue(String(item || "")))
      .filter(Boolean)
    : [];
  const legacyIdentifier = typeof value.identifierValue === "string"
    ? normalizeIdentifierValue(value.identifierValue)
    : "";
  const sanValues = Array.from(new Set([...sanValuesFromRecord, legacyIdentifier].filter(Boolean)));

  if (!sanValues.length) {
    return null;
  }

  const hasIp = sanValues.some((item) => isLikelyIpAddress(item));
  const hasDns = sanValues.some((item) => !isLikelyIpAddress(item));
  let derivedCertType = "dns";
  if (hasIp && hasDns) {
    derivedCertType = "mixed";
  } else if (hasIp) {
    derivedCertType = "ip";
  }

  const createdAt = typeof value.createdAt === "string" && value.createdAt.trim()
    ? value.createdAt
    : new Date().toISOString();

  const updatedAt = typeof value.updatedAt === "string" && value.updatedAt.trim()
    ? value.updatedAt
    : createdAt;

  return {
    id: typeof value.id === "string" && value.id.trim() ? value.id : `req_${Date.now()}`,
    status: typeof value.status === "string" ? value.status : "pending",
    certType: typeof value.certType === "string" ? value.certType : derivedCertType,
    identifierValue: sanValues[0],
    sanValues,
    accountId: typeof value.accountId === "string" ? value.accountId : "",
    accountKid: typeof value.accountKid === "string" ? value.accountKid : "",
    providerId: typeof value.providerId === "string" ? value.providerId : "",
    environmentId: typeof value.environmentId === "string" ? value.environmentId : "",
    profile: typeof value.profile === "string" ? value.profile : "",
    orderUrl: typeof value.orderUrl === "string" ? value.orderUrl : "",
    createdAt,
    updatedAt,
    errorMessage: typeof value.errorMessage === "string" ? value.errorMessage : "",
  };
}

function persistCertificateRequests(requests) {
  localStorage.setItem(CERTIFICATE_REQUEST_STORAGE_KEY, JSON.stringify(requests));
}

function createCertificateRequestRecord(data) {
  const nowIso = new Date().toISOString();
  const request = normalizeCertificateRequest({
    id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    status: data.status || "pending",
    certType: data.certType,
    identifierValue: data.identifierValue,
    sanValues: data.sanValues,
    accountId: data.accountId,
    accountKid: data.accountKid,
    providerId: data.providerId,
    environmentId: data.environmentId,
    profile: data.profile,
    orderUrl: data.orderUrl,
    createdAt: nowIso,
    updatedAt: nowIso,
    errorMessage: "",
  });

  if (!request) {
    throw new Error("Unable to create certificate request record.");
  }

  state.certificateRequests = [request, ...state.certificateRequests];
  persistCertificateRequests(state.certificateRequests);
  state.activeRequestId = request.id;
  return request;
}

function getCertificateRequestsForSelectedAccount() {
  const selectedAccount = getSavedAccountById(state.selectedAccountId);
  if (!selectedAccount) {
    return [];
  }

  return state.certificateRequests.filter((request) => {
    if (request.accountId) {
      return request.accountId === selectedAccount.id;
    }

    if (request.accountKid) {
      return request.accountKid === selectedAccount.accountKid;
    }

    return false;
  });
}

function updateCertificateRequestRecord(requestId, updates) {
  const requestIndex = state.certificateRequests.findIndex((item) => item.id === requestId);
  if (requestIndex < 0) {
    return;
  }

  const nextRequest = {
    ...state.certificateRequests[requestIndex],
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  const nextRequests = [...state.certificateRequests];
  nextRequests[requestIndex] = nextRequest;
  state.certificateRequests = nextRequests
    .map((item) => normalizeCertificateRequest(item))
    .filter(Boolean)
    .sort((first, second) => new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime());

  persistCertificateRequests(state.certificateRequests);
}

function updateActiveCertificateRequest(updates) {
  if (!state.activeRequestId) {
    return;
  }
  updateCertificateRequestRecord(state.activeRequestId, updates);
}

function destroyCertificateRequestsDataTable() {
  if (certificateRequestsTableInstance && typeof certificateRequestsTableInstance.destroy === "function") {
    certificateRequestsTableInstance.destroy();
  }
  certificateRequestsTableInstance = null;
}

function initCertificateRequestsDataTable() {
  destroyCertificateRequestsDataTable();

  const tableElement = document.getElementById("certificateRequestsTable");
  if (!tableElement || typeof window.DataTable !== "function") {
    return;
  }

  certificateRequestsTableInstance = new window.DataTable(tableElement, {
    pageLength: 10,
    order: [[7, "desc"]],
    searching: true,
    lengthChange: true,
    info: true,
  });
}

function loadSavedAccounts() {
  try {
    const serialized = localStorage.getItem(ACME_ACCOUNT_STORAGE_KEY);
    if (!serialized) {
      return [];
    }

    const parsed = JSON.parse(serialized);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((item) => normalizeSavedAccount(item, { allowMissingId: true, allowMissingCreatedAt: true }))
      .filter(Boolean)
      .sort((first, second) => new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime());
  } catch {
    return [];
  }
}

function normalizeSavedAccount(value, options = {}) {
  const { allowMissingId = false, allowMissingCreatedAt = false } = options;

  if (!value || typeof value !== "object") {
    return null;
  }

  const requiredFields = [
    "nickname",
    "providerId",
    "environmentId",
    "accountKid",
    "accountPrivateKeyPem",
    "accountThumbprint",
  ];

  for (const field of requiredFields) {
    if (typeof value[field] !== "string" || !value[field].trim()) {
      return null;
    }
  }

  if (!value.accountJwk || typeof value.accountJwk !== "object") {
    return null;
  }

  let accountId = typeof value.id === "string" ? value.id.trim() : "";
  if (!accountId && !allowMissingId) {
    return null;
  }
  if (!accountId) {
    accountId = createAccountId();
  }

  let createdAt = typeof value.createdAt === "string" ? value.createdAt.trim() : "";
  if (!createdAt && !allowMissingCreatedAt) {
    return null;
  }
  if (!createdAt) {
    createdAt = new Date().toISOString();
  }

  return {
    id: accountId,
    nickname: sanitizeAccountNickname(value.nickname),
    providerId: value.providerId.trim(),
    environmentId: value.environmentId.trim(),
    email: typeof value.email === "string" ? value.email : "",
    accountKid: value.accountKid.trim(),
    accountPrivateKeyPem: value.accountPrivateKeyPem,
    accountJwk: value.accountJwk,
    accountThumbprint: value.accountThumbprint.trim(),
    createdAt,
  };
}

function createAccountId() {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `acct_${Date.now()}`;
}

function sanitizeAccountNickname(value) {
  return String(value || "").trim().slice(0, 60);
}

function persistSavedAccounts(accounts) {
  try {
    localStorage.setItem(ACME_ACCOUNT_STORAGE_KEY, JSON.stringify(accounts));
  } catch {
    throw new Error("Unable to persist ACME account list in browser storage.");
  }
}

function getSavedAccountById(accountId) {
  return state.savedAccounts.find((account) => account.id === accountId) || null;
}

function getProviderLabel(providerId) {
  return ACME_PROVIDERS[providerId]?.label || providerId;
}

function formatTimestamp(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

function truncateMiddle(value, maxLength = 48) {
  if (!value || value.length <= maxLength) {
    return value;
  }

  const leftLength = Math.floor((maxLength - 1) / 2);
  const rightLength = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, leftLength)}...${value.slice(value.length - rightLength)}`;
}

function buildDefaultAccountNickname(email, providerId, environmentId) {
  if (email) {
    return `${getProviderLabel(providerId)} ${email}`;
  }
  return `${getProviderLabel(providerId)} ${environmentId} account`;
}

function sortAccountsByCreatedAtDesc(accounts) {
  accounts.sort((first, second) => new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime());
}

function renameSavedAccount(accountId, nicknameInput) {
  const nextNickname = sanitizeAccountNickname(nicknameInput);
  if (!nextNickname) {
    throw new Error("Nickname cannot be empty.");
  }

  const accountIndex = state.savedAccounts.findIndex((account) => account.id === accountId);
  if (accountIndex < 0) {
    throw new Error("Saved account not found.");
  }

  const nextAccounts = [...state.savedAccounts];
  nextAccounts[accountIndex] = {
    ...nextAccounts[accountIndex],
    nickname: nextNickname,
  };

  persistSavedAccounts(nextAccounts);
  state.savedAccounts = nextAccounts;

  if (state.selectedAccountId === accountId) {
    state.accountNickname = nextNickname;
  }
}

function exportSavedAccountsToFile() {
  if (!state.savedAccounts.length) {
    throw new Error("There are no saved accounts to export.");
  }

  const payload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    accounts: state.savedAccounts,
  };

  const filenameDate = new Date().toISOString().slice(0, 10);
  downloadTextFile(
    `webacme-accounts-${filenameDate}.json`,
    `${JSON.stringify(payload, null, 2)}\n`,
    "application/json;charset=utf-8"
  );
}

function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(new Error("Failed to read import file."));
    reader.readAsText(file);
  });
}

function extractAccountsForImport(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (payload && typeof payload === "object" && Array.isArray(payload.accounts)) {
    return payload.accounts;
  }

  throw new Error("Import file must be a JSON array or an object with an accounts array.");
}

function mergeImportedAccounts(existingAccounts, importedAccounts) {
  const mergedAccounts = [...existingAccounts];
  let importedCount = 0;
  let updatedCount = 0;
  let lastImportedAccountId = "";

  for (const importedAccount of importedAccounts) {
    const existingIndex = mergedAccounts.findIndex(
      (account) => account.providerId === importedAccount.providerId
        && account.environmentId === importedAccount.environmentId
        && account.accountKid === importedAccount.accountKid
    );

    if (existingIndex >= 0) {
      mergedAccounts[existingIndex] = {
        ...mergedAccounts[existingIndex],
        ...importedAccount,
        id: mergedAccounts[existingIndex].id,
        createdAt: mergedAccounts[existingIndex].createdAt || importedAccount.createdAt,
      };
      lastImportedAccountId = mergedAccounts[existingIndex].id;
      updatedCount += 1;
      continue;
    }

    mergedAccounts.push({
      ...importedAccount,
      id: importedAccount.id || createAccountId(),
      createdAt: importedAccount.createdAt || new Date().toISOString(),
    });
    lastImportedAccountId = mergedAccounts[mergedAccounts.length - 1].id;
    importedCount += 1;
  }

  sortAccountsByCreatedAtDesc(mergedAccounts);

  return {
    accounts: mergedAccounts,
    importedCount,
    updatedCount,
    lastImportedAccountId,
  };
}

async function importAccountsFromFile(file) {
  const text = await readTextFile(file);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Import file is not valid JSON.");
  }

  const rawAccounts = extractAccountsForImport(parsed);
  const importedAccounts = rawAccounts
    .map((item) => normalizeSavedAccount(item, { allowMissingId: true, allowMissingCreatedAt: true }))
    .filter(Boolean);

  if (!importedAccounts.length) {
    throw new Error("No valid ACME accounts found in import file.");
  }

  const mergeResult = mergeImportedAccounts(state.savedAccounts, importedAccounts);
  persistSavedAccounts(mergeResult.accounts);
  state.savedAccounts = mergeResult.accounts;

  return mergeResult;
}

function saveCurrentAccountToBrowser(nicknameInput) {
  if (!state.accountKid || !state.accountPrivateKeyPem || !state.accountJwk || !state.accountThumbprint) {
    throw new Error("Current account is incomplete and cannot be saved.");
  }

  const nowIso = new Date().toISOString();
  const nickname = sanitizeAccountNickname(nicknameInput) || buildDefaultAccountNickname(state.email, state.provider, state.environment);

  const newAccount = {
    id: createAccountId(),
    nickname,
    providerId: state.provider,
    environmentId: state.environment,
    email: state.email,
    accountKid: state.accountKid,
    accountPrivateKeyPem: state.accountPrivateKeyPem,
    accountJwk: state.accountJwk,
    accountThumbprint: state.accountThumbprint,
    createdAt: nowIso,
  };

  const existingIndex = state.savedAccounts.findIndex(
    (account) => account.providerId === newAccount.providerId
      && account.environmentId === newAccount.environmentId
      && account.accountKid === newAccount.accountKid
  );

  let nextAccounts;
  let savedAccount;

  if (existingIndex >= 0) {
    savedAccount = {
      ...state.savedAccounts[existingIndex],
      ...newAccount,
      id: state.savedAccounts[existingIndex].id,
      createdAt: state.savedAccounts[existingIndex].createdAt,
    };
    nextAccounts = [...state.savedAccounts];
    nextAccounts[existingIndex] = savedAccount;
  } else {
    savedAccount = newAccount;
    nextAccounts = [...state.savedAccounts, newAccount];
  }

  sortAccountsByCreatedAtDesc(nextAccounts);
  persistSavedAccounts(nextAccounts);
  state.savedAccounts = nextAccounts;

  return savedAccount;
}

function deleteSavedAccount(accountId) {
  const nextAccounts = state.savedAccounts.filter((account) => account.id !== accountId);
  persistSavedAccounts(nextAccounts);
  state.savedAccounts = nextAccounts;
  if (state.selectedAccountId === accountId) {
    state.selectedAccountId = "";
  }
}

async function loadSavedAcmeAccount(accountId) {
  const account = getSavedAccountById(accountId);
  if (!account) {
    throw new Error("Selected saved account no longer exists.");
  }

  if (!ACME_PROVIDERS[account.providerId]) {
    throw new Error(`Provider ${account.providerId} is no longer configured.`);
  }

  state.provider = account.providerId;
  state.environment = account.environmentId;
  state.email = account.email || "";
  state.accountNickname = account.nickname;
  state.selectedAccountId = account.id;

  clearOrderContext();
  state.accountReady = false;

  const directoryUrl = getDirectoryUrlForSelection();
  pushLog(`Loading ACME directory: ${directoryUrl}`);
  state.directory = await fetchJson(directoryUrl);
  applyProviderDirectoryMeta(state.directory?.meta || {});
  syncProfilesFromDirectory();

  state.accountPrivateKeyPem = account.accountPrivateKeyPem;
  state.accountKeyPair = {
    privateKey: await importPrivateKeyFromPem(account.accountPrivateKeyPem),
    publicKey: null,
  };
  state.accountJwk = account.accountJwk;
  state.accountThumbprint = account.accountThumbprint || await createJwkThumbprint(state.accountJwk);
  state.accountKid = account.accountKid;

  await refreshNonce();

  state.accountReady = true;
  state.step = 2;

  pushLog(`Loaded saved ACME account "${account.nickname}".`);
}

async function initializeAcmeAccount() {
  if (!window.crypto?.subtle) {
    throw new Error("WebCrypto API is unavailable in this browser.");
  }

  clearOrderContext();
  state.accountReady = false;

  const directoryUrl = getDirectoryUrlForSelection();
  pushLog(`Loading ACME directory: ${directoryUrl}`);
  state.directory = await fetchJson(directoryUrl);
  applyProviderDirectoryMeta(state.directory?.meta || {});
  syncProfilesFromDirectory();
  if (state.profile) {
    pushLog(`Selected ACME profile: ${state.profile}`);
  }

  pushLog("Generating account key pair (RSA 2048)...");
  state.accountKeyPair = await generateRsaKeyPair();
  state.accountPrivateKeyPem = await exportPrivateKeyToPem(state.accountKeyPair.privateKey);
  state.accountJwk = await crypto.subtle.exportKey("jwk", state.accountKeyPair.publicKey);
  state.accountThumbprint = await createJwkThumbprint(state.accountJwk);

  await refreshNonce();

  const accountPayload = {
    termsOfServiceAgreed: true,
    contact: state.email ? [`mailto:${state.email}`] : [],
  };

  pushLog("Creating ACME account...");
  const accountResponse = await acmePost(state.directory.newAccount, accountPayload, { useJwk: true });
  const accountKid = accountResponse.location || accountResponse.response.headers.get("Location");
  if (!accountKid) {
    throw new Error("ACME account creation did not return account location (kid).");
  }
  state.accountKid = accountKid;
  state.accountReady = true;
  state.step = 2;
  setAlert("success", "ACME account initialized and saved. You can stay in Account Manager or open Request Cert.");
}

async function createAcmeOrder() {
  if (!state.accountReady || !state.accountKid || !state.directory) {
    throw new Error("Please initialize your ACME account first.");
  }

  if (!Array.isArray(state.sanIdentifiers) || !state.sanIdentifiers.length) {
    throw new Error("Add at least one SAN identifier before creating an order.");
  }

  const providerConfig = getProviderConfig();
  const allowedIdentifierTypes = getAllowedIdentifierTypesForProfile(providerConfig, state.profile);
  const unsupportedIdentifier = state.sanIdentifiers.find((item) => !allowedIdentifierTypes.includes(item.type));
  if (unsupportedIdentifier) {
    throw new Error(`Profile ${state.profile || "default"} does not permit ${unsupportedIdentifier.type.toUpperCase()} identifiers.`);
  }

  state.order = null;
  state.orderUrl = "";
  state.authorizationStates = [];
  state.selectedAuthorizationUrl = "";
  state.authorization = null;
  state.authorizationUrl = "";
  state.availableChallenges = {};
  state.selectedChallengeType = "";
  state.challenge = null;
  state.keyAuthorization = "";
  state.dnsTxtValue = "";
  state.certificatePem = "";
  state.domainPrivateKeyPem = "";
  state.domainKeyPair = null;

  pushLog("Creating new order...");
  const orderPayload = {
    identifiers: state.sanIdentifiers.map((item) => ({
      type: item.type,
      value: item.value,
    })),
  };
  if (state.profile) {
    orderPayload.profile = state.profile;
  }
  const orderResponse = await acmePost(state.directory.newOrder, orderPayload);

  const orderUrl = orderResponse.location || orderResponse.response.headers.get("Location");
  if (!orderUrl) {
    throw new Error("Order response missing order URL location header.");
  }

  state.order = orderResponse.data;
  state.orderUrl = orderUrl;
  createCertificateRequestRecord({
    status: state.order.status || "pending",
    certType: deriveRequestCertType(state.sanIdentifiers),
    identifierValue: getPrimaryIdentifierValue(state.sanIdentifiers),
    sanValues: state.sanIdentifiers.map((item) => item.value),
    accountId: state.selectedAccountId,
    accountKid: state.accountKid,
    providerId: state.provider,
    environmentId: state.environment,
    profile: state.profile,
    orderUrl,
  });

  if (!Array.isArray(state.order.authorizations) || state.order.authorizations.length === 0) {
    throw new Error("Order does not include authorization URLs.");
  }

  for (const authorizationUrl of state.order.authorizations) {
    const authorization = await fetchAuthorizationByUrl(authorizationUrl);
    const authorizationState = await createAuthorizationState(authorizationUrl, authorization);
    state.authorizationStates.push(authorizationState);
    pushLog(`Authorization loaded for ${authorizationState.identifierType}:${authorizationState.identifierValue} (${authorizationState.status}).`);
  }

  state.sanIdentifiers = state.authorizationStates
    .map((item) => ({ type: item.identifierType, value: item.identifierValue }))
    .filter((item) => (item.type === "dns" || item.type === "ip") && item.value);
  state.identifierValue = getPrimaryIdentifierValue(state.sanIdentifiers);
  state.certType = deriveRequestCertType(state.sanIdentifiers);
  updateActiveCertificateRequest({
    certType: state.certType,
    identifierValue: state.identifierValue,
    sanValues: state.sanIdentifiers.map((item) => item.value),
  });

  const preferredAuthorization = state.authorizationStates.find((item) => item.status !== "valid") || state.authorizationStates[0];
  state.selectedAuthorizationUrl = preferredAuthorization?.url || "";

  if (!state.authorizationStates.some((item) => Object.keys(item.availableChallenges || {}).length)) {
    throw new Error("No supported challenge found. Expected http-01 or dns-01.");
  }

  if (areAllAuthorizationsValid()) {
    state.step = 4;
    updateActiveCertificateRequest({
      status: "authorized",
      errorMessage: "",
    });
    setAlert("success", "All SAN authorizations are already valid. Continue to CSR/finalize.");
    return;
  }

  state.step = 3;
  updateActiveCertificateRequest({
    status: "validating",
    errorMessage: "",
  });
  setAlert("success", "Order created. Complete validation for each SAN authorization.");
}

async function triggerChallenge() {
  const authorizationState = getSelectedAuthorizationState();
  if (!authorizationState) {
    throw new Error("No authorization selected.");
  }

  if (!authorizationState.challenge?.url) {
    throw new Error("Challenge URL is missing.");
  }

  updateActiveCertificateRequest({
    status: "validating",
    errorMessage: "",
  });
  await acmePost(authorizationState.challenge.url, {});
  pushLog(`Challenge notified to ACME server for ${authorizationState.identifierValue}.`);

  const authorization = await pollAuthorizationUntilTerminal(authorizationState);
  if (authorization.status !== "valid") {
    throw new Error(`Authorization ended with status ${authorization.status}.`);
  }

  if (areAllAuthorizationsValid()) {
    state.step = 4;
    updateActiveCertificateRequest({
      status: "authorized",
      errorMessage: "",
    });
    setAlert("success", "All SAN authorizations are valid. Continue to CSR and finalize.");
  } else {
    pushLog(`Authorization for ${authorizationState.identifierValue} is valid. Continue with remaining SAN entries.`);
  }
}

async function finalizeOrder() {
  await refreshAllAuthorizations();
  const nonValidAuthorizations = state.authorizationStates.filter((item) => item.status !== "valid");
  if (nonValidAuthorizations.length) {
    const pendingDetails = nonValidAuthorizations
      .map((item) => `${item.identifierValue} (${item.status})`)
      .join(", ");
    throw new Error(`Complete SAN validation first. Pending authorizations: ${pendingDetails}.`);
  }

  updateActiveCertificateRequest({
    status: "finalizing",
    errorMessage: "",
  });

  pushLog("Generating domain key pair (RSA 2048)...");
  state.domainKeyPair = await generateRsaKeyPair();
  state.domainPrivateKeyPem = await exportPrivateKeyToPem(state.domainKeyPair.privateKey);

  pushLog("Creating CSR with forge...");
  const csr = await createCsrBase64Url(state.domainKeyPair, state.sanIdentifiers);

  pushLog("Submitting finalize request...");
  await acmePost(state.order.finalize, { csr });

  const validOrder = await pollOrderUntilValid();

  if (!validOrder.certificate) {
    throw new Error("Order is valid but certificate URL is missing.");
  }

  await fetchCertificate(validOrder.certificate);
  state.step = 5;
  updateActiveCertificateRequest({
    status: "issued",
    errorMessage: "",
  });
  setAlert("success", "Certificate issued successfully.");
}

async function fetchAuthorization() {
  const authorizationState = getSelectedAuthorizationState();
  if (!authorizationState) {
    throw new Error("No authorization is selected.");
  }

  await refreshAuthorizationState(authorizationState);
  return authorizationState.authorization;
}

async function fetchAuthorizationByUrl(authorizationUrl) {
  const response = await acmePost(authorizationUrl, null);
  return response.data;
}

function buildChallengeMap(challenges) {
  const supported = {};
  for (const challenge of challenges) {
    if (challenge.type === "http-01" || challenge.type === "dns-01") {
      supported[challenge.type] = challenge;
    }
  }
  return supported;
}

async function createAuthorizationState(authorizationUrl, authorization) {
  const identifierType = authorization?.identifier?.type || "dns";
  const identifierValue = normalizeIdentifierValue(authorization?.identifier?.value || "");
  const authorizationState = {
    url: authorizationUrl,
    status: authorization?.status || "pending",
    identifierType,
    identifierValue,
    authorization,
    availableChallenges: buildChallengeMap(authorization?.challenges || []),
    selectedChallengeType: "",
    challenge: null,
    keyAuthorization: "",
    dnsTxtValue: "",
  };

  const preferredType = authorizationState.availableChallenges["http-01"]
    ? "http-01"
    : (authorizationState.availableChallenges["dns-01"] ? "dns-01" : "");
  if (preferredType) {
    await applyAuthorizationChallengeSelection(authorizationState, preferredType, { silent: true });
  }

  return authorizationState;
}

async function refreshAuthorizationState(authorizationState) {
  const authorization = await fetchAuthorizationByUrl(authorizationState.url);
  authorizationState.authorization = authorization;
  authorizationState.status = authorization?.status || "pending";

  if (authorization?.identifier?.type) {
    authorizationState.identifierType = authorization.identifier.type;
  }
  if (authorization?.identifier?.value) {
    authorizationState.identifierValue = normalizeIdentifierValue(authorization.identifier.value);
  }

  authorizationState.availableChallenges = buildChallengeMap(authorization?.challenges || []);

  let preferredType = authorizationState.selectedChallengeType;
  if (!preferredType || !authorizationState.availableChallenges[preferredType]) {
    preferredType = authorizationState.availableChallenges["http-01"]
      ? "http-01"
      : (authorizationState.availableChallenges["dns-01"] ? "dns-01" : "");
  }

  if (preferredType) {
    await applyAuthorizationChallengeSelection(authorizationState, preferredType, { silent: true });
  } else {
    authorizationState.selectedChallengeType = "";
    authorizationState.challenge = null;
    authorizationState.keyAuthorization = "";
    authorizationState.dnsTxtValue = "";
  }

  if (state.selectedAuthorizationUrl === authorizationState.url) {
    state.authorization = authorizationState.authorization;
    state.authorizationUrl = authorizationState.url;
    state.availableChallenges = authorizationState.availableChallenges;
    state.selectedChallengeType = authorizationState.selectedChallengeType;
    state.challenge = authorizationState.challenge;
    state.keyAuthorization = authorizationState.keyAuthorization;
    state.dnsTxtValue = authorizationState.dnsTxtValue;
  }

  return authorizationState.authorization;
}

async function refreshAllAuthorizations() {
  for (const authorizationState of state.authorizationStates) {
    await refreshAuthorizationState(authorizationState);
    pushLog(`Authorization ${authorizationState.identifierValue}: ${authorizationState.status}`);
  }
}

function getSelectedAuthorizationState() {
  if (!state.authorizationStates.length) {
    return null;
  }

  let selected = state.authorizationStates.find((item) => item.url === state.selectedAuthorizationUrl);
  if (!selected) {
    selected = state.authorizationStates.find((item) => item.status !== "valid") || state.authorizationStates[0];
    state.selectedAuthorizationUrl = selected.url;
  }

  state.authorization = selected.authorization;
  state.authorizationUrl = selected.url;
  state.availableChallenges = selected.availableChallenges;
  state.selectedChallengeType = selected.selectedChallengeType;
  state.challenge = selected.challenge;
  state.keyAuthorization = selected.keyAuthorization;
  state.dnsTxtValue = selected.dnsTxtValue;

  return selected;
}

function areAllAuthorizationsValid() {
  return state.authorizationStates.length > 0 && state.authorizationStates.every((item) => item.status === "valid");
}

async function applyAuthorizationChallengeSelection(authorizationState, type, options = {}) {
  const { silent = false } = options;

  const challenge = authorizationState.availableChallenges[type];
  if (!challenge) {
    throw new Error(`Challenge method ${type} is not available for this order.`);
  }

  authorizationState.selectedChallengeType = type;
  authorizationState.challenge = challenge;
  authorizationState.keyAuthorization = `${challenge.token}.${state.accountThumbprint}`;

  if (challenge.type === "dns-01") {
    const digest = await crypto.subtle.digest("SHA-256", utf8Bytes(authorizationState.keyAuthorization));
    authorizationState.dnsTxtValue = base64UrlFromArrayBuffer(digest);
  } else {
    authorizationState.dnsTxtValue = "";
  }

  if (state.selectedAuthorizationUrl === authorizationState.url) {
    state.selectedChallengeType = authorizationState.selectedChallengeType;
    state.challenge = authorizationState.challenge;
    state.keyAuthorization = authorizationState.keyAuthorization;
    state.dnsTxtValue = authorizationState.dnsTxtValue;
  }

  if (!silent) {
    pushLog(`Challenge selected for ${authorizationState.identifierValue}: ${challenge.type}`);
  }
}

async function fetchOrder() {
  const response = await acmePost(state.orderUrl, null);
  state.order = response.data;
  updateActiveCertificateRequest({
    status: state.order.status || "unknown",
  });
  return state.order;
}

async function fetchCertificate(certificateUrl) {
  const response = await acmePost(certificateUrl, null, { expectText: true });
  state.certificatePem = response.data;
  updateActiveCertificateRequest({
    status: "issued",
  });
}

async function pollAuthorizationUntilTerminal(authorizationState) {
  const maxAttempts = 25;
  for (let index = 0; index < maxAttempts; index += 1) {
    const authorization = await refreshAuthorizationState(authorizationState);
    pushLog(`Authorization status for ${authorizationState.identifierValue}: ${authorization.status}`);

    if (authorization.status === "valid" || authorization.status === "invalid") {
      if (authorization.status === "invalid") {
        const problem = authorization.challenges
          ?.map((item) => item.error?.detail)
          .filter(Boolean)
          .join(" | ");
        if (problem) {
          throw new Error(`Challenge failed: ${problem}`);
        }
      }
      return authorization;
    }

    await delay(3500);
  }

  throw new Error("Timed out waiting for authorization to become valid.");
}

async function pollOrderUntilValid() {
  const maxAttempts = 35;
  for (let index = 0; index < maxAttempts; index += 1) {
    const order = await fetchOrder();
    pushLog(`Order status: ${order.status}`);

    if (order.status === "valid") {
      return order;
    }

    if (order.status === "invalid") {
      throw new Error("Order became invalid. Check challenge details and retry.");
    }

    await delay(3500);
  }

  throw new Error("Timed out waiting for certificate issuance.");
}

async function acmePost(url, payload, options = {}) {
  const { useJwk = false, expectText = false } = options;

  if (!state.nonce) {
    await refreshNonce();
  }

  const protectedHeader = {
    alg: "RS256",
    nonce: state.nonce,
    url,
  };

  if (useJwk) {
    protectedHeader.jwk = state.accountJwk;
  } else {
    protectedHeader.kid = state.accountKid;
  }

  const protectedEncoded = base64UrlFromString(JSON.stringify(protectedHeader));
  const payloadEncoded = payload === null ? "" : base64UrlFromString(JSON.stringify(payload));
  const signingInput = `${protectedEncoded}.${payloadEncoded}`;

  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    state.accountKeyPair.privateKey,
    utf8Bytes(signingInput)
  );

  const body = {
    protected: protectedEncoded,
    payload: payloadEncoded,
    signature: base64UrlFromArrayBuffer(signature),
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/jose+json",
    },
    body: JSON.stringify(body),
  });

  const replayNonce = response.headers.get("Replay-Nonce");
  if (replayNonce) {
    state.nonce = replayNonce;
  }

  if (!response.ok) {
    const errorPayload = await tryReadError(response);
    throw new Error(`ACME ${response.status}: ${errorPayload}`);
  }

  let data;
  if (expectText) {
    data = await response.text();
  } else {
    const text = await response.text();
    if (text.trim().length === 0) {
      data = {};
    } else {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
  }

  return {
    response,
    data,
    location: response.headers.get("Location"),
  };
}

async function tryReadError(response) {
  const text = await response.text();
  if (!text) {
    return response.statusText;
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed.detail) {
      return parsed.detail;
    }
    return JSON.stringify(parsed);
  } catch {
    return text;
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { method: "GET" });
  if (!response.ok) {
    throw new Error(`Failed to load ACME directory (${response.status}).`);
  }
  return response.json();
}

async function refreshNonce() {
  const response = await fetch(state.directory.newNonce, { method: "HEAD" });
  const replayNonce = response.headers.get("Replay-Nonce");
  if (!replayNonce) {
    throw new Error("ACME server did not provide replay nonce.");
  }
  state.nonce = replayNonce;
}

async function generateRsaKeyPair() {
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );
}

async function exportPrivateKeyToPem(privateKey) {
  const buffer = await crypto.subtle.exportKey("pkcs8", privateKey);
  return toPem("PRIVATE KEY", new Uint8Array(buffer));
}

async function importPrivateKeyFromPem(privateKeyPem) {
  const base64 = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return crypto.subtle.importKey(
    "pkcs8",
    bytes.buffer,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    true,
    ["sign"]
  );
}

async function exportPublicKeyToPem(publicKey) {
  const buffer = await crypto.subtle.exportKey("spki", publicKey);
  return toPem("PUBLIC KEY", new Uint8Array(buffer));
}

function toPem(label, bytes) {
  const base64 = bytesToBase64(bytes);
  const lines = base64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

async function createJwkThumbprint(jwk) {
  const canonical = JSON.stringify({
    e: jwk.e,
    kty: jwk.kty,
    n: jwk.n,
  });

  const digest = await crypto.subtle.digest("SHA-256", utf8Bytes(canonical));
  return base64UrlFromArrayBuffer(digest);
}

async function createCsrBase64Url(domainKeyPair, identifiers) {
  const normalizedIdentifiers = Array.isArray(identifiers)
    ? identifiers
      .map((item) => ({
        type: item?.type,
        value: normalizeIdentifierValue(item?.value || ""),
      }))
      .filter((item) => (item.type === "dns" || item.type === "ip") && item.value)
    : [];

  if (!normalizedIdentifiers.length) {
    throw new Error("Unable to generate CSR: SAN identifier list is empty.");
  }

  const privatePem = await exportPrivateKeyToPem(domainKeyPair.privateKey);
  const publicPem = await exportPublicKeyToPem(domainKeyPair.publicKey);

  const privateKey = forge.pki.privateKeyFromPem(privatePem);
  const publicKey = forge.pki.publicKeyFromPem(publicPem);

  const subjectAltNames = normalizedIdentifiers.map((item) => {
    if (item.type === "ip") {
      return { type: 7, ip: item.value };
    }
    return { type: 2, value: item.value };
  });

  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = publicKey;
  // Keep CN on a DNS SAN when available. For IP-only certificates,
  // keep subject empty and rely on SAN extension only.
  const commonNameIdentifier = normalizedIdentifiers.find((item) => item.type === "dns");
  if (!commonNameIdentifier) {
    csr.setSubject([]);
  } else {
    csr.setSubject([{ name: "commonName", value: commonNameIdentifier.value }]);
  }
  csr.setAttributes([
    {
      name: "extensionRequest",
      extensions: [
        {
          name: "subjectAltName",
          altNames: subjectAltNames,
        },
      ],
    },
  ]);
  csr.sign(privateKey, forge.md.sha256.create());

  if (!csr.verify()) {
    throw new Error("CSR verification failed after generation.");
  }

  const csrAsn1 = forge.pki.certificationRequestToAsn1(csr);
  const csrDerBinary = forge.asn1.toDer(csrAsn1).getBytes();
  const csrBytes = binaryStringToUint8Array(csrDerBinary);
  return base64UrlFromBytes(csrBytes);
}

function binaryStringToUint8Array(value) {
  const result = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    result[index] = value.charCodeAt(index);
  }
  return result;
}

function normalizeIdentifierValue(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeSanInputValues(values) {
  const nextValues = Array.isArray(values)
    ? values.map((item) => String(item || ""))
    : [];

  while (
    nextValues.length > 1
    && !nextValues[nextValues.length - 1].trim()
    && !nextValues[nextValues.length - 2].trim()
  ) {
    nextValues.pop();
  }

  if (!nextValues.length) {
    nextValues.push("");
  }

  return nextValues;
}

function parseSanIdentifiers(rawValues) {
  const result = {
    identifiers: [],
    errors: [],
  };

  const seen = new Set();
  const values = Array.isArray(rawValues) ? rawValues : [];

  for (const rawValue of values) {
    const normalizedValue = normalizeIdentifierValue(rawValue);
    if (!normalizedValue) {
      continue;
    }

    if (/\s/.test(normalizedValue)) {
      result.errors.push(`SAN value "${normalizedValue}" is invalid: whitespace is not allowed.`);
      continue;
    }

    const type = isLikelyIpAddress(normalizedValue) ? "ip" : "dns";
    const dedupeKey = `${type}:${normalizedValue}`;
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    result.identifiers.push({
      type,
      value: normalizedValue,
    });
  }

  return result;
}

function deriveRequestCertType(identifiers) {
  const hasIp = identifiers.some((item) => item.type === "ip");
  const hasDns = identifiers.some((item) => item.type === "dns");

  if (hasIp && hasDns) {
    return "mixed";
  }
  if (hasIp) {
    return "ip";
  }
  return "dns";
}

function getPrimaryIdentifierValue(identifiers) {
  if (!Array.isArray(identifiers) || !identifiers.length) {
    return "";
  }

  const firstDns = identifiers.find((item) => item.type === "dns" && item.value);
  if (firstDns) {
    return firstDns.value;
  }

  return identifiers[0].value || "";
}

function isLikelyIpAddress(value) {
  const maybeIpv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value);
  if (maybeIpv4) {
    return value.split(".").every((segment) => {
      const numeric = Number(segment);
      return numeric >= 0 && numeric <= 255;
    });
  }

  return value.includes(":");
}

function getCertificateFileStem(value) {
  return value.replace(/[^a-z0-9._-]/gi, "_");
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function utf8Bytes(value) {
  return new TextEncoder().encode(value);
}

function base64UrlFromString(value) {
  return base64UrlFromBytes(utf8Bytes(value));
}

function base64UrlFromArrayBuffer(buffer) {
  return base64UrlFromBytes(new Uint8Array(buffer));
}

function base64UrlFromBytes(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;

  for (let index = 0; index < bytes.length; index += chunk) {
    const slice = bytes.subarray(index, index + chunk);
    binary += String.fromCharCode(...slice);
  }

  return btoa(binary);
}

function downloadTextFile(filename, content, mimeType = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

function copyIconSvg() {
  return '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M10 1.5a1.5 1.5 0 0 1 1.5 1.5v1H11V3a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1v.5H4A1.5 1.5 0 0 1 2.5 9V3A1.5 1.5 0 0 1 4 1.5h6z"/><path d="M6 6a1.5 1.5 0 0 1 1.5-1.5h4A1.5 1.5 0 0 1 13 6v6a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 6 12V6zm1.5-1a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-4z"/></svg>';
}

function checkIconSvg() {
  return '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3-3a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/></svg>';
}

function bindCopyButton(buttonId, value, label) {
  const button = document.getElementById(buttonId);
  if (!button) {
    return;
  }

  const defaultIcon = copyIconSvg();
  const copiedIcon = checkIconSvg();
  button.innerHTML = defaultIcon;

  button.addEventListener("click", async () => {
    try {
      await copyTextToClipboard(value);
      button.innerHTML = copiedIcon;
      button.classList.add("copied");
      if (button.copyResetTimer) {
        clearTimeout(button.copyResetTimer);
      }
      button.copyResetTimer = setTimeout(() => {
        button.innerHTML = defaultIcon;
        button.classList.remove("copied");
      }, 1600);
      pushLog(`Copied ${label}.`);
      renderLog();
    } catch {
      button.innerHTML = defaultIcon;
      button.classList.remove("copied");
      handleError(new Error(`Failed to copy ${label}.`));
    }
  });
}

async function copyTextToClipboard(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();

  const copied = document.execCommand("copy");
  textArea.remove();

  if (!copied) {
    throw new Error("Clipboard API unavailable.");
  }
}

function escapeHtml(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
