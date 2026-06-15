const { db, verifyFirebaseIdToken } = require("../firebaseAdmin");
const { HttpError } = require("../utils/errors");

async function requireAuth(req, _res, next) {
    try {
        const header = req.headers.authorization || "";
        const token = header.startsWith("Bearer ") ? header.slice(7) : "";

        if (!token) {
            throw new HttpError(401, "Missing auth token.", "unauthenticated");
        }

        const decoded = await verifyFirebaseIdToken(token);
        req.user = decoded;
        next();
    } catch (error) {
        next(error instanceof HttpError ? error : new HttpError(401, "Invalid auth token.", "unauthenticated"));
    }
}

async function requireAdmin(req, _res, next) {
    try {
        if (!req.user?.uid) {
            throw new HttpError(401, "You must be signed in to continue.", "unauthenticated");
        }

        const adminSnap = await db.collection("users").doc(req.user.uid).get();
        if (!adminSnap.exists || adminSnap.data()?.role !== "admin") {
            throw new HttpError(403, "Only administrators can perform this action.", "permission-denied");
        }

        req.adminProfile = adminSnap.data();
        next();
    } catch (error) {
        next(error);
    }
}

module.exports = { requireAuth, requireAdmin };
