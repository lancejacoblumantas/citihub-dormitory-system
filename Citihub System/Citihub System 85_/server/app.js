require("dotenv").config();

const cors = require("cors");
const express = require("express");
const rateLimit = require("express-rate-limit");
const morgan = require("morgan");

const bookingsRoutes = require("./routes/bookings");
const paymentsRoutes = require("./routes/payments");
const addonsRoutes = require("./routes/addons");
const emailsRoutes = require("./routes/emails");
const adminRoutes = require("./routes/admin");
const transientBedRoutes = require("./routes/transientBeds");
const complaintsRoutes = require("./routes/complaints");
const transfersRoutes = require("./routes/transfers");
const ratingsRoutes = require("./routes/ratings");
const sessionsRoutes = require("./routes/sessions");
const { HttpError } = require("./utils/errors");

const app = express();

function getRateLimitNumber(envName, fallback) {
    const value = Number(process.env[envName]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

const apiLimiter = rateLimit({
    windowMs: getRateLimitNumber("RATE_LIMIT_WINDOW_MS", 15 * 60 * 1000),
    limit: getRateLimitNumber("RATE_LIMIT_MAX", 300),
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: "Too many requests. Please wait a moment and try again.",
        code: "rate-limit-exceeded"
    }
});

const sensitiveApiLimiter = rateLimit({
    windowMs: getRateLimitNumber("SENSITIVE_RATE_LIMIT_WINDOW_MS", 15 * 60 * 1000),
    limit: getRateLimitNumber("SENSITIVE_RATE_LIMIT_MAX", 30),
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: "Too many sensitive requests. Please wait before trying again.",
        code: "sensitive-rate-limit-exceeded"
    }
});

function buildAllowedOrigins() {
    const configured = String(process.env.FRONTEND_ORIGIN || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

    return new Set([
        ...configured,
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "null"
    ]);
}

function isAllowedOrigin(origin) {
    if (!origin) {
        return true;
    }

    const allowedOrigins = buildAllowedOrigins();
    if (allowedOrigins.has(origin)) {
        return true;
    }

    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

app.use(cors({
    origin(origin, callback) {
        if (isAllowedOrigin(origin)) {
            callback(null, true);
            return;
        }

        callback(new HttpError(403, `This page address is not allowed to use the backend: ${origin}`, "cors-not-allowed"));
    },
    credentials: true
}));
app.use(express.json({ limit: "2mb" }));
app.use(morgan("dev"));

app.get("/health", (_req, res) => {
    res.json({ ok: true });
});

app.use("/api", apiLimiter);
app.use("/api/bookings/admin", sensitiveApiLimiter);
app.use("/api/payments", sensitiveApiLimiter);
app.use("/api/admin", sensitiveApiLimiter);
app.use("/api/transient-beds/admin", sensitiveApiLimiter);
app.use("/api/transfers/admin", sensitiveApiLimiter);

app.use("/api/bookings", bookingsRoutes);
app.use("/api/payments", paymentsRoutes);
app.use("/api/addons", addonsRoutes);
app.use("/api/emails", emailsRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/transient-beds", transientBedRoutes);
app.use("/api/complaints", complaintsRoutes);
app.use("/api/transfers", transfersRoutes);
app.use("/api/ratings", ratingsRoutes);
app.use("/api/sessions", sessionsRoutes);

app.use((_req, _res, next) => {
    next(new HttpError(404, "Route not found.", "not-found"));
});

app.use((error, _req, res, _next) => {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error?.message || "Internal server error.";
    const code = error instanceof HttpError ? error.code : "internal";

    if (!(error instanceof HttpError)) {
        console.error(error);
    }

    res.status(status).json({
        error: message,
        code
    });
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
    console.log(`CitiHub Express backend running on port ${port}`);
});
