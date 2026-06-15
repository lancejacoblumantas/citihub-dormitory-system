const { HttpError } = require("../utils/errors");

const PAYMONGO_BASE_URL = "https://api.paymongo.com/v1";
const ALLOWED_PAYMENT_METHODS = [
    "card",
    "gcash",
    "maya",
    "grab_pay",
    "shopee_pay",
    "shopeepay",
    "qrph",
    "online_banking",
    "billease"
];

function mapMethodToPayMongo(method) {
    const methodMap = {
        maya: ["paymaya"],
        shopeepay: ["shopee_pay"],
        online_banking: ["dob", "brankas"]
    };

    return methodMap[method] || [method];
}

function requireValidMethod(method) {
    if (!ALLOWED_PAYMENT_METHODS.includes(method)) {
        throw new HttpError(400, "Unsupported payment method.", "invalid-argument");
    }
}

function normalizeBaseUrl(baseUrl) {
    return new URL(baseUrl).toString();
}

function getPayMongoAuthHeader() {
    const secretValue = process.env.PAYMONGO_SECRET_KEY;
    if (!secretValue) {
        throw new HttpError(500, "PAYMONGO_SECRET_KEY is not configured.", "internal");
    }

    return `Basic ${Buffer.from(`${secretValue}:`).toString("base64")}`;
}

async function paymongoRequest(path, options = {}) {
    const response = await fetch(`${PAYMONGO_BASE_URL}${path}`, {
        method: options.method || "GET",
        headers: {
            "Content-Type": "application/json",
            "Authorization": getPayMongoAuthHeader(),
            ...(options.headers || {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const message = data?.errors?.[0]?.detail || data?.errors?.[0]?.code || "PayMongo request failed.";
        throw new HttpError(502, message, "paymongo-error");
    }

    return data;
}

function hasPaidCheckout(sessionAttributes) {
    const payments = Array.isArray(sessionAttributes?.payments) ? sessionAttributes.payments : [];
    return payments.some((entry) => entry?.attributes?.status === "paid");
}

module.exports = {
    ALLOWED_PAYMENT_METHODS,
    hasPaidCheckout,
    mapMethodToPayMongo,
    normalizeBaseUrl,
    paymongoRequest,
    requireValidMethod
};
