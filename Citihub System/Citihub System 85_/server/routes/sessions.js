const express = require("express");
const { admin, db } = require("../firebaseAdmin");
const { requireAuth } = require("../middleware/auth");
const { asyncHandler } = require("../utils/asyncHandler");
const { HttpError } = require("../utils/errors");

const router = express.Router();

function cleanSessionId(value) {
    const sessionId = String(value || "").trim();
    return /^[a-zA-Z0-9_-]{16,80}$/.test(sessionId) ? sessionId : "";
}

function getIpAddress(req) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    return forwarded || req.socket?.remoteAddress || "Unknown";
}

function parseUserAgent(userAgent = "") {
    const ua = String(userAgent);
    const browser = /Edg\//.test(ua) ? "Microsoft Edge"
        : /Chrome\//.test(ua) ? "Chrome"
            : /Firefox\//.test(ua) ? "Firefox"
                : /Safari\//.test(ua) ? "Safari"
                    : "Unknown Browser";

    const os = /Windows/i.test(ua) ? "Windows"
        : /Android/i.test(ua) ? "Android"
            : /iPhone|iPad|iPod/i.test(ua) ? "iOS"
                : /Mac OS X/i.test(ua) ? "macOS"
                    : /Linux/i.test(ua) ? "Linux"
                        : "Unknown OS";

    const deviceType = /Mobile|Android|iPhone|iPad|iPod/i.test(ua) ? "Mobile" : "Desktop";
    return { browser, os, deviceType };
}

function toMillis(value) {
    if (!value) return 0;
    if (typeof value.toDate === "function") return value.toDate().getTime();
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function serializeSession(doc, currentSessionId) {
    const data = doc.data() || {};
    return {
        id: doc.id,
        browser: data.browser || "Unknown Browser",
        os: data.os || "Unknown OS",
        deviceType: data.deviceType || "Unknown Device",
        ipAddress: data.ipAddress || "Unknown",
        timezone: data.timezone || "",
        createdAt: toMillis(data.createdAt),
        lastActiveAt: toMillis(data.lastActiveAt),
        revokedAt: toMillis(data.revokedAt),
        isCurrent: doc.id === currentSessionId
    };
}

router.use(requireAuth);

router.post("/touch", asyncHandler(async (req, res) => {
    const sessionId = cleanSessionId(req.body?.sessionId);
    if (!sessionId) {
        throw new HttpError(400, "Invalid session id.", "invalid-session-id");
    }

    const sessionRef = db.collection("users").doc(req.user.uid).collection("sessions").doc(sessionId);
    const sessionSnap = await sessionRef.get();

    if (sessionSnap.exists && sessionSnap.data()?.revokedAt) {
        res.status(401).json({
            error: "This session was signed out from another device.",
            code: "session-revoked",
            revoked: true
        });
        return;
    }

    const userAgent = req.headers["user-agent"] || "";
    const device = parseUserAgent(userAgent);
    const now = admin.firestore.FieldValue.serverTimestamp();

    await sessionRef.set({
        userId: req.user.uid,
        ...device,
        userAgent: String(userAgent).slice(0, 500),
        ipAddress: getIpAddress(req),
        timezone: String(req.body?.timezone || "").slice(0, 80),
        createdAt: sessionSnap.exists ? sessionSnap.data()?.createdAt || now : now,
        lastActiveAt: now,
        revokedAt: null
    }, { merge: true });

    res.json({ ok: true, sessionId });
}));

router.post("/list", asyncHandler(async (req, res) => {
    const currentSessionId = cleanSessionId(req.body?.sessionId);
    const snapshot = await db.collection("users").doc(req.user.uid).collection("sessions").get();
    const sessions = snapshot.docs
        .map((doc) => serializeSession(doc, currentSessionId))
        .sort((left, right) => right.lastActiveAt - left.lastActiveAt);

    res.json({ sessions });
}));

router.post("/revoke-others", asyncHandler(async (req, res) => {
    const currentSessionId = cleanSessionId(req.body?.sessionId);
    if (!currentSessionId) {
        throw new HttpError(400, "Invalid current session id.", "invalid-session-id");
    }

    const snapshot = await db.collection("users").doc(req.user.uid).collection("sessions").get();
    const batch = db.batch();
    let revokedCount = 0;

    snapshot.docs.forEach((doc) => {
        if (doc.id === currentSessionId || doc.data()?.revokedAt) return;

        batch.set(doc.ref, {
            revokedAt: admin.firestore.FieldValue.serverTimestamp(),
            revokedBySessionId: currentSessionId
        }, { merge: true });
        revokedCount += 1;
    });

    if (revokedCount) {
        await batch.commit();
    }

    res.json({ ok: true, revokedCount });
}));

module.exports = router;
