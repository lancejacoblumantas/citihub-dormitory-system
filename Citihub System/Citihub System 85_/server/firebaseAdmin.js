const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const { HttpError } = require("./utils/errors");

function resolveCredentialPath(filePath) {
    if (!filePath) {
        return null;
    }

    return path.isAbsolute(filePath) ? filePath : path.join(__dirname, filePath);
}

function getCredential() {
    if (admin.apps.length) {
        return null;
    }

    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (serviceAccountJson) {
        return admin.credential.cert(JSON.parse(serviceAccountJson));
    }

    const credentialPaths = [
        resolveCredentialPath(process.env.GOOGLE_APPLICATION_CREDENTIALS),
        resolveCredentialPath("citihub-service-account.json")
    ].filter(Boolean);

    for (const credentialPath of credentialPaths) {
        if (fs.existsSync(credentialPath)) {
            return admin.credential.cert(require(credentialPath));
        }
    }

    return admin.credential.applicationDefault();
}

function getProjectId() {
    return process.env.FIREBASE_PROJECT_ID || "citihub-example";
}

if (!admin.apps.length) {
    const projectId = getProjectId();
    admin.initializeApp({
        credential: getCredential(),
        projectId,
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${projectId}.firebasestorage.app`
    });
}

const db = admin.firestore();

function decodeJwtPayload(token) {
    const [, payload] = String(token || "").split(".");
    if (!payload) {
        return null;
    }

    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

function canUseLocalAuthFallback() {
    return String(process.env.DEV_AUTH_FALLBACK || "").toLowerCase() === "true";
}

async function verifyFirebaseIdToken(token) {
    try {
        return await admin.auth().verifyIdToken(token);
    } catch (error) {
        if (canUseLocalAuthFallback()) {
            try {
                const decoded = decodeJwtPayload(token);
                const uid = decoded?.user_id || decoded?.sub || decoded?.uid;
                if (uid) {
                    console.warn("Using DEV_AUTH_FALLBACK. Firebase token signature was not verified.");
                    return {
                        ...decoded,
                        uid,
                        email: decoded.email || ""
                    };
                }
            } catch (fallbackError) {
                console.warn("DEV_AUTH_FALLBACK could not decode token:", fallbackError.message);
            }
        }

        const projectId = getProjectId();
        throw new HttpError(
            401,
            `Invalid auth token. Make sure the backend is using Firebase project "${projectId}" credentials.`,
            "unauthenticated"
        );
    }
}

module.exports = { admin, db, verifyFirebaseIdToken };
