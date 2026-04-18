export const PROVIDER_PRESETS = {
	"letsencrypt-prod": {
		id: "letsencrypt-prod",
		label: "Let's Encrypt (Production)",
		directoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
		requiresEab: false,
		capabilityProfile: "letsencrypt"
	},
	"letsencrypt-staging": {
		id: "letsencrypt-staging",
		label: "Let's Encrypt (Staging)",
		directoryUrl: "https://acme-staging-v02.api.letsencrypt.org/directory",
		requiresEab: false,
		capabilityProfile: "letsencrypt"
	},
	zerossl: {
		id: "zerossl",
		label: "ZeroSSL",
		directoryUrl: "https://acme.zerossl.com/v2/DV90/directory",
		requiresEab: true,
		capabilityProfile: "zerossl"
	},
	gts: {
		id: "gts",
		label: "Google Trust Services",
		directoryUrl: "https://dv.acme-v02.api.pki.goog/directory",
		requiresEab: true,
		capabilityProfile: "gts"
	},
	custom: {
		id: "custom",
		label: "Custom ACME Directory",
		directoryUrl: "",
		requiresEab: true,
		capabilityProfile: "custom"
	}
};

export const CAPABILITY_STATUS = {
	supported: "supported",
	unsupported: "unsupported",
	partial: "partial",
	unknown: "unknown",
	required: "required",
	notNeeded: "not-needed",
	conditional: "conditional",
	planned: "planned"
};

export const CAPABILITY_FIELDS = [
	{ key: "externalAccountBinding", label: "External Account Binding" },
	{ key: "accountKeyRollover", label: "Account Key Rollover" },
	{ key: "accountDeactivation", label: "Account Deactivation" },
	{ key: "accountOrders", label: "Account Orders" },
	{ key: "ipIdentifiers", label: "IP Address Identifiers" },
	{ key: "preAuthorization", label: "Pre-Authorization" },
	{ key: "authorizationDeactivation", label: "Authorization Deactivation" },
	{ key: "certificateRevocation", label: "Certificate Revocation" },
	{ key: "challengeRetrying", label: "Challenge Retrying" },
	{ key: "variableCertLifetime", label: "Variable Certificate Lifetime" },
	{ key: "sxgSupport", label: "SXG Support" },
	{ key: "ari", label: "ACME Renewal Information (ARI)" },
	{ key: "acmeProfiles", label: "ACME Profiles" },
	{ key: "dnsAccount01", label: "dns-account-01" },
	{ key: "dnsPersist01", label: "dns-persist-01" }
];

const capabilityProfiles = {
	letsencrypt: {
		externalAccountBinding: CAPABILITY_STATUS.notNeeded,
		accountKeyRollover: CAPABILITY_STATUS.supported,
		accountDeactivation: CAPABILITY_STATUS.supported,
		accountOrders: CAPABILITY_STATUS.planned,
		ipIdentifiers: CAPABILITY_STATUS.conditional,
		preAuthorization: CAPABILITY_STATUS.unsupported,
		authorizationDeactivation: CAPABILITY_STATUS.supported,
		certificateRevocation: CAPABILITY_STATUS.supported,
		challengeRetrying: CAPABILITY_STATUS.unsupported,
		variableCertLifetime: CAPABILITY_STATUS.unsupported,
		sxgSupport: CAPABILITY_STATUS.unsupported,
		ari: CAPABILITY_STATUS.supported,
		acmeProfiles: CAPABILITY_STATUS.supported,
		dnsAccount01: CAPABILITY_STATUS.unsupported,
		dnsPersist01: CAPABILITY_STATUS.planned
	},
	gts: {
		externalAccountBinding: CAPABILITY_STATUS.required,
		accountKeyRollover: CAPABILITY_STATUS.supported,
		accountDeactivation: CAPABILITY_STATUS.supported,
		accountOrders: CAPABILITY_STATUS.unsupported,
		ipIdentifiers: CAPABILITY_STATUS.conditional,
		preAuthorization: CAPABILITY_STATUS.unsupported,
		authorizationDeactivation: CAPABILITY_STATUS.supported,
		certificateRevocation: CAPABILITY_STATUS.supported,
		challengeRetrying: CAPABILITY_STATUS.unsupported,
		variableCertLifetime: CAPABILITY_STATUS.supported,
		sxgSupport: CAPABILITY_STATUS.conditional,
		ari: CAPABILITY_STATUS.supported,
		acmeProfiles: CAPABILITY_STATUS.unsupported,
		dnsAccount01: CAPABILITY_STATUS.unsupported,
		dnsPersist01: CAPABILITY_STATUS.planned
	},
	zerossl: {
		externalAccountBinding: CAPABILITY_STATUS.required,
		accountKeyRollover: CAPABILITY_STATUS.unsupported,
		accountDeactivation: CAPABILITY_STATUS.supported,
		accountOrders: CAPABILITY_STATUS.unsupported,
		ipIdentifiers: CAPABILITY_STATUS.unsupported,
		preAuthorization: CAPABILITY_STATUS.unsupported,
		authorizationDeactivation: CAPABILITY_STATUS.supported,
		certificateRevocation: CAPABILITY_STATUS.supported,
		challengeRetrying: CAPABILITY_STATUS.supported,
		variableCertLifetime: CAPABILITY_STATUS.unsupported,
		sxgSupport: CAPABILITY_STATUS.unsupported,
		ari: CAPABILITY_STATUS.unsupported,
		acmeProfiles: CAPABILITY_STATUS.unsupported,
		dnsAccount01: CAPABILITY_STATUS.unsupported,
		dnsPersist01: CAPABILITY_STATUS.unsupported
	},
	custom: {
		externalAccountBinding: CAPABILITY_STATUS.required,
		accountKeyRollover: CAPABILITY_STATUS.unknown,
		accountDeactivation: CAPABILITY_STATUS.unknown,
		accountOrders: CAPABILITY_STATUS.unknown,
		ipIdentifiers: CAPABILITY_STATUS.unknown,
		preAuthorization: CAPABILITY_STATUS.unknown,
		authorizationDeactivation: CAPABILITY_STATUS.unknown,
		certificateRevocation: CAPABILITY_STATUS.unknown,
		challengeRetrying: CAPABILITY_STATUS.unknown,
		variableCertLifetime: CAPABILITY_STATUS.unknown,
		sxgSupport: CAPABILITY_STATUS.unknown,
		ari: CAPABILITY_STATUS.unknown,
		acmeProfiles: CAPABILITY_STATUS.unknown,
		dnsAccount01: CAPABILITY_STATUS.unknown,
		dnsPersist01: CAPABILITY_STATUS.unknown
	}
};

export const ADVANCED_DB = {
	name: "webacme-advanced",
	version: 1,
	stores: {
		accounts: "accounts",
		requests: "requests"
	}
};

export function getProviderPreset(providerId) {
	return PROVIDER_PRESETS[providerId] || PROVIDER_PRESETS.custom;
}

export function getProviderLabel(providerId) {
	return getProviderPreset(providerId).label;
}

export function getProviderCapabilities(providerId) {
	const preset = getProviderPreset(providerId);
	const baseProfile = capabilityProfiles[preset.capabilityProfile] || capabilityProfiles.custom;
	return { ...baseProfile };
}

export function isCapabilityEnabled(status) {
	return status === CAPABILITY_STATUS.supported || status === CAPABILITY_STATUS.required || status === CAPABILITY_STATUS.notNeeded || status === CAPABILITY_STATUS.conditional;
}

export function capabilityStatusLabel(status) {
	switch (status) {
		case CAPABILITY_STATUS.supported:
			return "Supported";
		case CAPABILITY_STATUS.unsupported:
			return "Unsupported";
		case CAPABILITY_STATUS.partial:
			return "Partially Supported";
		case CAPABILITY_STATUS.required:
			return "Required";
		case CAPABILITY_STATUS.notNeeded:
			return "Not Needed";
		case CAPABILITY_STATUS.conditional:
			return "Conditional";
		case CAPABILITY_STATUS.planned:
			return "Planned";
		default:
			return "Unknown";
	}
}

export function capabilityStatusClass(status) {
	switch (status) {
		case CAPABILITY_STATUS.supported:
			return "capability-supported";
		case CAPABILITY_STATUS.required:
			return "capability-required";
		case CAPABILITY_STATUS.notNeeded:
			return "capability-not-needed";
		case CAPABILITY_STATUS.conditional:
			return "capability-conditional";
		case CAPABILITY_STATUS.planned:
			return "capability-planned";
		case CAPABILITY_STATUS.partial:
			return "capability-partial";
		case CAPABILITY_STATUS.unsupported:
			return "capability-unsupported";
		default:
			return "capability-unknown";
	}
}
