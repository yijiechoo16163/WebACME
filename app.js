const STEPS = [
  { id: 1, label: "Identity" },
  { id: 2, label: "Challenge" },
  { id: 3, label: "CSR & Finalize" },
  { id: 4, label: "Result" },
];

const DIRECTORY_URLS = {
  staging: "https://acme-staging-v02.api.letsencrypt.org/directory",
  production: "https://acme-v02.api.letsencrypt.org/directory",
};

function createInitialState() {
  return {
    step: 1,
    alert: null,
    busy: false,
    logs: ["Session initialized."],
    email: "",
    domain: "",
    environment: "staging",
    directory: null,
    nonce: null,
    accountKeyPair: null,
    accountPrivateKeyPem: "",
    accountJwk: null,
    accountThumbprint: "",
    accountKid: "",
    order: null,
    orderUrl: "",
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
    sessionDirty: false,
  };
}

const state = createInitialState();

const refs = {
  stepper: document.getElementById("stepper"),
  alertRegion: document.getElementById("alertRegion"),
  content: document.getElementById("app-step-content"),
  eventLog: document.getElementById("eventLog"),
  exportAccountBtn: document.getElementById("exportAccountKeyBtn"),
  exportDomainBtn: document.getElementById("exportDomainKeyBtn"),
  resetSessionBtn: document.getElementById("resetSessionBtn"),
};

window.onbeforeunload = function onBeforeUnload() {
  if (!state.sessionDirty) {
    return undefined;
  }
  return "You will lose your keys and progress if you leave!";
};

init();

function init() {
  bindGlobalActions();
  render();
}

function bindGlobalActions() {
  refs.exportAccountBtn.addEventListener("click", () => {
    if (!state.accountPrivateKeyPem) {
      return;
    }
    downloadTextFile("account-private-key.pem", state.accountPrivateKeyPem);
  });

  refs.exportDomainBtn.addEventListener("click", () => {
    if (!state.domainPrivateKeyPem) {
      return;
    }
    downloadTextFile("domain-private-key.pem", state.domainPrivateKeyPem);
  });

  refs.resetSessionBtn.addEventListener("click", () => {
    resetSession();
  });
}

function render() {
  renderStepper();
  renderAlert();
  renderCurrentStep();
  renderLog();
  refs.exportAccountBtn.disabled = !state.accountPrivateKeyPem;
  refs.exportDomainBtn.disabled = !state.domainPrivateKeyPem;
}

function renderStepper() {
  refs.stepper.innerHTML = STEPS.map((step) => {
    const classes = ["step-item"];
    if (state.step === step.id) {
      classes.push("active");
    }
    if (state.step > step.id) {
      classes.push("completed");
    }
    return `
      <li class="${classes.join(" ")}">
        <span class="step-number">${step.id}.</span>${step.label}
      </li>
    `;
  }).join("");
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

function renderCurrentStep() {
  if (state.step === 1) {
    renderStepIdentity();
    return;
  }
  if (state.step === 2) {
    renderStepChallenge();
    return;
  }
  if (state.step === 3) {
    renderStepFinalize();
    return;
  }
  renderStepResult();
}

function renderStepIdentity() {
  refs.content.innerHTML = `
    <div class="mb-3">
      <h2 class="h5">Step 1: Identity & Account Setup</h2>
      <p class="mini-note mb-0">Generate your ACME account key in browser memory and create an order.</p>
    </div>

    <form id="identityForm" class="row g-3">
      <div class="col-md-6">
        <label for="emailInput" class="form-label">Email (optional)</label>
        <input id="emailInput" class="form-control" type="email" placeholder="you@example.com" value="${escapeHtml(state.email)}" />
      </div>
      <div class="col-md-6">
        <label for="domainInput" class="form-label">Domain Name</label>
        <input id="domainInput" class="form-control" type="text" placeholder="example.com" required value="${escapeHtml(state.domain)}" />
      </div>
      <div class="col-md-6">
        <label for="environmentInput" class="form-label">Let&apos;s Encrypt Environment</label>
        <select id="environmentInput" class="form-select">
          <option value="staging" ${state.environment === "staging" ? "selected" : ""}>Staging (recommended for testing)</option>
          <option value="production" ${state.environment === "production" ? "selected" : ""}>Production</option>
        </select>
      </div>
      <div class="col-12">
        <div class="alert alert-warning mb-0">
          Leaving or refreshing during issuance can destroy in-memory keys and flow state.
        </div>
      </div>
      <div class="col-12 d-flex gap-2 flex-wrap">
        <button class="btn btn-primary" id="startOrderBtn" type="submit" ${state.busy ? "disabled" : ""}>
          ${state.busy ? "Working..." : "Generate Account Key + Start Order"}
        </button>
      </div>
    </form>
  `;

  document.getElementById("identityForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    if (state.busy) {
      return;
    }

    const emailValue = document.getElementById("emailInput").value.trim();
    const domainValue = normalizeDomain(document.getElementById("domainInput").value);
    const envValue = document.getElementById("environmentInput").value;

    if (!domainValue) {
      setAlert("danger", "Please enter a domain name.");
      render();
      return;
    }

    try {
      await runStep("Creating ACME account and order...", async () => {
        state.email = emailValue;
        state.domain = domainValue;
        state.environment = envValue;
        await startAcmeOrder();
      });
    } catch (error) {
      handleError(error);
    }
  });
}

function renderStepChallenge() {
  const challenge = state.challenge;
  const availableTypes = Object.keys(state.availableChallenges);
  const hasMethodChoices = availableTypes.length > 1;
  const isHttp = challenge?.type === "http-01";
  const isDns = challenge?.type === "dns-01";
  const hasHttp = availableTypes.includes("http-01");
  const hasDns = availableTypes.includes("dns-01");

  refs.content.innerHTML = `
    <div class="mb-3">
      <h2 class="h5">Step 2: Complete ${escapeHtml(challenge?.type || "")}</h2>
      <p class="mini-note mb-0">Publish the token response, then notify Let&apos;s Encrypt and wait for authorization.</p>
    </div>

    <div class="row g-3">
      <div class="col-12 col-md-7">
        <label class="form-label">Validation Method</label>
        <div class="btn-group w-100" role="group" aria-label="Validation method selection">
          <button
            id="challengeTypeHttpBtn"
            type="button"
            class="btn ${state.selectedChallengeType === "http-01" ? "btn-primary" : "btn-outline-primary"}"
            ${!hasHttp || state.busy ? "disabled" : ""}
          >
            HTTP-01
          </button>
          <button
            id="challengeTypeDnsBtn"
            type="button"
            class="btn ${state.selectedChallengeType === "dns-01" ? "btn-primary" : "btn-outline-primary"}"
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
                <span class="challenge-copyable-value">${escapeHtml(state.keyAuthorization)}</span>
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
                <span class="challenge-copyable-value">_acme-challenge.${escapeHtml(state.domain)}</span>
                <button id="copyDnsNameBtn" class="copy-icon-btn" type="button" title="Copy TXT record name" aria-label="Copy TXT record name" ${state.busy ? "disabled" : ""}>${copyIconSvg()}</button>
              </div>
              <p class="mb-2"><strong>TXT Record Value:</strong></p>
              <div class="challenge-box challenge-copyable mb-3">
                <span class="challenge-copyable-value">${escapeHtml(state.dnsTxtValue)}</span>
                <button id="copyDnsValueBtn" class="copy-icon-btn" type="button" title="Copy TXT record value" aria-label="Copy TXT record value" ${state.busy ? "disabled" : ""}>${copyIconSvg()}</button>
              </div>
              <p class="mini-note mb-0">For dns-01, this value is SHA-256(keyAuthorization) in base64url format.</p>
            ` : ""}
          </div>
        </div>
      </div>
      <div class="col-12 d-flex gap-2 flex-wrap">
        <button id="triggerChallengeBtn" class="btn btn-primary" type="button" ${state.busy ? "disabled" : ""}>
          ${state.busy ? "Working..." : "I Have Deployed It, Notify CA"}
        </button>
        <button id="checkAuthStatusBtn" class="btn btn-outline-primary" type="button" ${state.busy ? "disabled" : ""}>Check Authorization Status</button>
      </div>
    </div>
  `;

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
      if (state.busy || item.type === state.selectedChallengeType) {
        return;
      }

      try {
        await runStep(`Switching validation method to ${item.type}...`, async () => {
          await applyChallengeSelection(item.type);
          pushLog(`Validation method switched to ${item.type}.`);
        });
      } catch (error) {
        handleError(error);
      }
    });
  }

  if (isHttp) {
    bindCopyButton("copyHttpPathBtn", `.well-known/acme-challenge/${state.challenge.token}`, "HTTP challenge filename path");
    bindCopyButton("copyHttpContentBtn", state.keyAuthorization, "HTTP challenge content");

    document.getElementById("downloadHttpChallengeBtn").addEventListener("click", () => {
      if (!state.challenge?.token || !state.keyAuthorization) {
        handleError(new Error("HTTP challenge data is incomplete."));
        return;
      }

      downloadTextFile(state.challenge.token, state.keyAuthorization, "application/octet-stream");
      pushLog(`Downloaded HTTP-01 challenge file: ${state.challenge.token}`);
      renderLog();
    });
  }

  if (isDns) {
    bindCopyButton("copyDnsNameBtn", `_acme-challenge.${state.domain}`, "DNS TXT record name");
    bindCopyButton("copyDnsValueBtn", state.dnsTxtValue, "DNS TXT record value");
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
        if (auth.status === "valid") {
          state.step = 3;
          pushLog("Authorization is valid. Proceed to CSR/finalize.");
        } else {
          pushLog(`Authorization is currently ${auth.status}.`);
        }
      });
    } catch (error) {
      handleError(error);
    }
  });
}

function renderStepFinalize() {
  refs.content.innerHTML = `
    <div class="mb-3">
      <h2 class="h5">Step 3: Generate Domain Key, CSR, and Finalize</h2>
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
          state.step = 4;
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
      <h2 class="h5">Step 4: Certificate Ready</h2>
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

  document.getElementById("downloadCertBtn").addEventListener("click", () => {
    downloadTextFile(`${state.domain}.crt`, state.certificatePem);
  });

  document.getElementById("downloadKeyBtn").addEventListener("click", () => {
    downloadTextFile(`${state.domain}.key`, state.domainPrivateKeyPem);
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
  setAlert("danger", message);
  render();
}

function resetSession() {
  const fresh = createInitialState();
  Object.assign(state, fresh);
  localStorage.clear();
  pushLog("Session reset complete. Local storage cleared.");
  render();
}

async function startAcmeOrder() {
  if (!window.crypto?.subtle) {
    throw new Error("WebCrypto API is unavailable in this browser.");
  }

  state.certificatePem = "";
  state.domainPrivateKeyPem = "";
  state.domainKeyPair = null;

  const directoryUrl = DIRECTORY_URLS[state.environment];
  pushLog(`Loading ACME directory: ${directoryUrl}`);
  state.directory = await fetchJson(directoryUrl);

  pushLog("Generating account key pair (RSA 2048)...");
  state.accountKeyPair = await generateRsaKeyPair();
  state.accountPrivateKeyPem = await exportPrivateKeyToPem(state.accountKeyPair.privateKey);
  state.accountJwk = await crypto.subtle.exportKey("jwk", state.accountKeyPair.publicKey);
  state.accountThumbprint = await createJwkThumbprint(state.accountJwk);
  state.sessionDirty = true;

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

  pushLog("Creating new order...");
  const orderResponse = await acmePost(state.directory.newOrder, {
    identifiers: [{ type: "dns", value: state.domain }],
  });

  const orderUrl = orderResponse.location || orderResponse.response.headers.get("Location");
  if (!orderUrl) {
    throw new Error("Order response missing order URL location header.");
  }

  state.order = orderResponse.data;
  state.orderUrl = orderUrl;

  if (!Array.isArray(state.order.authorizations) || state.order.authorizations.length === 0) {
    throw new Error("Order does not include authorization URLs.");
  }

  state.authorizationUrl = state.order.authorizations[0];
  const authorization = await fetchAuthorization();

  if (!Object.keys(state.availableChallenges).length) {
    throw new Error("No supported challenge found. Expected http-01 or dns-01.");
  }

  state.step = 2;
  pushLog(`Challenge selected: ${state.selectedChallengeType}`);
  setAlert("success", "Order created. Publish your challenge response and continue.");
}

async function triggerChallenge() {
  if (!state.challenge?.url) {
    throw new Error("Challenge URL is missing.");
  }

  await acmePost(state.challenge.url, {});
  pushLog("Challenge notified to ACME server.");

  const authorization = await pollAuthorizationUntilTerminal();
  if (authorization.status !== "valid") {
    throw new Error(`Authorization ended with status ${authorization.status}.`);
  }

  state.step = 3;
  setAlert("success", "Authorization is valid. Continue to CSR and finalize.");
}

async function finalizeOrder() {
  const latestAuth = await fetchAuthorization();
  if (latestAuth.status !== "valid") {
    throw new Error(`Authorization is ${latestAuth.status}. Complete challenge validation first.`);
  }

  pushLog("Generating domain key pair (RSA 2048)...");
  state.domainKeyPair = await generateRsaKeyPair();
  state.domainPrivateKeyPem = await exportPrivateKeyToPem(state.domainKeyPair.privateKey);
  state.sessionDirty = true;

  pushLog("Creating CSR with forge...");
  const csr = await createCsrBase64Url(state.domainKeyPair, state.domain);

  pushLog("Submitting finalize request...");
  await acmePost(state.order.finalize, { csr });

  const validOrder = await pollOrderUntilValid();

  if (!validOrder.certificate) {
    throw new Error("Order is valid but certificate URL is missing.");
  }

  await fetchCertificate(validOrder.certificate);
  state.step = 4;
  setAlert("success", "Certificate issued successfully.");
}

async function fetchAuthorization() {
  const response = await acmePost(state.authorizationUrl, null);
  state.authorization = response.data;
  await syncChallengesFromAuthorization(state.authorization);
  return state.authorization;
}

async function syncChallengesFromAuthorization(authorization) {
  const nextChallenges = buildChallengeMap(authorization?.challenges || []);
  if (!Object.keys(nextChallenges).length) {
    return;
  }

  state.availableChallenges = nextChallenges;

  let preferredType = state.selectedChallengeType;
  if (!preferredType || !state.availableChallenges[preferredType]) {
    preferredType = state.availableChallenges["http-01"] ? "http-01" : "dns-01";
  }

  await applyChallengeSelection(preferredType, { silent: true });
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

async function applyChallengeSelection(type, options = {}) {
  const { silent = false } = options;

  const challenge = state.availableChallenges[type];
  if (!challenge) {
    throw new Error(`Challenge method ${type} is not available for this order.`);
  }

  state.selectedChallengeType = type;
  state.challenge = challenge;
  state.keyAuthorization = `${challenge.token}.${state.accountThumbprint}`;

  if (challenge.type === "dns-01") {
    const digest = await crypto.subtle.digest("SHA-256", utf8Bytes(state.keyAuthorization));
    state.dnsTxtValue = base64UrlFromArrayBuffer(digest);
  } else {
    state.dnsTxtValue = "";
  }

  if (!silent) {
    pushLog(`Challenge selected: ${challenge.type}`);
  }
}

async function fetchOrder() {
  const response = await acmePost(state.orderUrl, null);
  state.order = response.data;
  return state.order;
}

async function fetchCertificate(certificateUrl) {
  const response = await acmePost(certificateUrl, null, { expectText: true });
  state.certificatePem = response.data;
}

async function pollAuthorizationUntilTerminal() {
  const maxAttempts = 25;
  for (let index = 0; index < maxAttempts; index += 1) {
    const authorization = await fetchAuthorization();
    pushLog(`Authorization status: ${authorization.status}`);

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

async function createCsrBase64Url(domainKeyPair, domain) {
  const privatePem = await exportPrivateKeyToPem(domainKeyPair.privateKey);
  const publicPem = await exportPublicKeyToPem(domainKeyPair.publicKey);

  const privateKey = forge.pki.privateKeyFromPem(privatePem);
  const publicKey = forge.pki.publicKeyFromPem(publicPem);

  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = publicKey;
  csr.setSubject([{ name: "commonName", value: domain }]);
  csr.setAttributes([
    {
      name: "extensionRequest",
      extensions: [
        {
          name: "subjectAltName",
          altNames: [{ type: 2, value: domain }],
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

function normalizeDomain(value) {
  return value.trim().toLowerCase();
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
