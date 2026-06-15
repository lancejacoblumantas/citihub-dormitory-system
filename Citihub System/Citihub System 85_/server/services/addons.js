const { admin, db } = require("../firebaseAdmin");
const { HttpError } = require("../utils/errors");
const {
    getAddonCatalog,
    getAddonDefinition,
    normalizeAddonId,
    sanitizeRequestedAddons
} = require("./addonsCatalog");
const {
    getApprovedBookingForUser,
    getTenantProfile,
    getNextAdjustableBillingMonth,
    refreshFutureBillingInvoicesForBooking
} = require("./payments");

function requireString(value, message, code = "invalid-argument") {
    const safeValue = String(value || "").trim();
    if (!safeValue) {
        throw new HttpError(400, message, code);
    }

    return safeValue;
}

function normalizeText(value) {
    return String(value || "").trim().toLowerCase();
}

function isAccountBillingRestricted(userData = {}, bookingData = {}) {
    return userData.manualBillingHold === true
        || bookingData.manualBillingHold === true
        || userData.delinquentAccount === true
        || bookingData.delinquentAccount === true
        || normalizeText(userData.billingStatus) === "delinquent"
        || normalizeText(bookingData.billingStatus) === "delinquent";
}

function assertAddonChangesAllowed(userData = {}, bookingData = {}) {
    if (userData.manualBillingHold === true || bookingData.manualBillingHold === true) {
        throw new HttpError(403, "This account is currently on billing hold and cannot change add-on services until the hold is removed.", "billing-restricted");
    }

    if (userData.delinquentAccount === true || bookingData.delinquentAccount === true || normalizeText(userData.billingStatus) === "delinquent" || normalizeText(bookingData.billingStatus) === "delinquent") {
        throw new HttpError(403, "This account has overdue billing and cannot change add-on services until the outstanding balance is settled.", "billing-restricted");
    }
}

function getPreviousBillingMonth(billingMonth) {
    if (!/^\d{4}-\d{2}$/.test(String(billingMonth || ""))) {
        return "";
    }

    const [year, month] = String(billingMonth).split("-").map(Number);
    const date = new Date(year, month - 1, 1);
    date.setMonth(date.getMonth() - 1, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

async function getAddonSubscriptionDoc(userId, bookingRequestId, addonId) {
    const docRef = db.collection("userAddons").doc(`${bookingRequestId}_${addonId}`);
    const snap = await docRef.get();

    if (!snap.exists) {
        return { ref: docRef, exists: false, data: null };
    }

    const data = snap.data() || {};
    if (data.userId !== userId || data.bookingRequestId !== bookingRequestId) {
        throw new HttpError(403, "This add-on subscription does not belong to your account.", "permission-denied");
    }

    return { ref: docRef, exists: true, data };
}

async function ensureRequestedBookingAddons(userId, approvedBooking, nextAdjustableBillingMonth) {
    const requestedAddons = sanitizeRequestedAddons(approvedBooking.data.requestedAddons);
    if (!requestedAddons.length || !nextAdjustableBillingMonth) {
        return 0;
    }

    const existingSnapshot = await db.collection("userAddons")
        .where("bookingRequestId", "==", approvedBooking.id)
        .get();
    const existingIds = new Set(
        existingSnapshot.docs
            .map((doc) => doc.data() || {})
            .filter((addon) => addon.userId === userId)
            .map((addon) => String(addon.addonId || "").trim().toLowerCase())
    );
    const missingAddons = requestedAddons.filter((addon) => !existingIds.has(addon.addonId));

    if (!missingAddons.length) {
        return 0;
    }

    const batch = db.batch();
    missingAddons.forEach((addon) => {
        const ref = db.collection("userAddons").doc(`${approvedBooking.id}_${addon.addonId}`);
        batch.set(ref, {
            userId,
            bookingRequestId: approvedBooking.id,
            bookingReferenceId: approvedBooking.data.referenceId || approvedBooking.id,
            addonId: addon.addonId,
            addonName: addon.addonName,
            price: Number(addon.price || 0),
            billingType: addon.billingType || "monthly",
            description: addon.description || "",
            status: "active",
            effectiveStartMonth: nextAdjustableBillingMonth,
            effectiveEndMonth: null,
            source: "booking_request_backfill",
            cancelledAt: null,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    });

    await batch.commit();
    await refreshFutureBillingInvoicesForBooking(userId, approvedBooking.id);
    return missingAddons.length;
}

async function listTenantAddons(user, payload = {}) {
    const userId = user?.uid;
    if (!userId) {
        throw new HttpError(401, "Authentication is required.", "unauthenticated");
    }

    const bookingRequestId = requireString(payload.bookingRequestId, "Missing booking request ID.");
    const approvedBooking = await getApprovedBookingForUser(userId, bookingRequestId);
    const tenantProfile = await getTenantProfile(userId);
    assertAddonChangesAllowed(tenantProfile, approvedBooking.data);
    const nextAdjustableBillingMonth = await getNextAdjustableBillingMonth(userId, approvedBooking.id);
    const backfilledCount = await ensureRequestedBookingAddons(userId, approvedBooking, nextAdjustableBillingMonth);
    const snapshot = await db.collection("userAddons")
        .where("bookingRequestId", "==", approvedBooking.id)
        .get();

    return {
        success: true,
        catalog: getAddonCatalog(),
        bookingRequestId: approvedBooking.id,
        bookingReferenceId: approvedBooking.data.referenceId || approvedBooking.id,
        requestedAddons: Array.isArray(approvedBooking.data.requestedAddons) ? approvedBooking.data.requestedAddons : [],
        backfilledCount,
        addOns: snapshot.docs.map((doc) => ({
            id: doc.id,
            ...doc.data()
        })).filter((addon) => addon.userId === userId),
        nextAdjustableBillingMonth,
        tenantName: tenantProfile.fullName || tenantProfile.username || user.email || "Tenant"
    };
}

async function activateTenantAddon(user, payload = {}) {
    const userId = user?.uid;
    if (!userId) {
        throw new HttpError(401, "Authentication is required.", "unauthenticated");
    }

    const bookingRequestId = requireString(payload.bookingRequestId, "Missing booking request ID.");
    const addonId = normalizeAddonId(requireString(payload.addonId, "Please choose an add-on."));
    const addon = getAddonDefinition(addonId);
    if (!addon) {
        throw new HttpError(404, "Selected add-on was not found.", "not-found");
    }

    const approvedBooking = await getApprovedBookingForUser(userId, bookingRequestId);
    const tenantProfile = await getTenantProfile(userId);
    assertAddonChangesAllowed(tenantProfile, approvedBooking.data);
    const effectiveStartMonth = await getNextAdjustableBillingMonth(userId, approvedBooking.id);
    if (!effectiveStartMonth) {
        throw new HttpError(412, "No upcoming unpaid billing month is available for this add-on change.", "failed-precondition");
    }

    const subscription = await getAddonSubscriptionDoc(userId, approvedBooking.id, addon.id);
    const existingStatus = String(subscription.data?.status || "").toLowerCase();

    if (subscription.exists && existingStatus === "active" && !subscription.data?.effectiveEndMonth) {
        throw new HttpError(409, "This add-on is already active on your account.", "already-exists");
    }

    await subscription.ref.set({
        userId,
        bookingRequestId: approvedBooking.id,
        bookingReferenceId: approvedBooking.data.referenceId || approvedBooking.id,
        addonId: addon.id,
        addonName: addon.name,
        price: addon.price,
        billingType: addon.billingType,
        description: addon.description,
        status: "active",
        effectiveStartMonth,
        effectiveEndMonth: null,
        source: "tenant_self_service",
        cancelledAt: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: subscription.data?.createdAt || admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    const invoiceRefresh = await refreshFutureBillingInvoicesForBooking(userId, approvedBooking.id);
    return {
        success: true,
        bookingRequestId: approvedBooking.id,
        addonId: addon.id,
        effectiveStartMonth,
        invoiceRefresh
    };
}

async function cancelTenantAddon(user, payload = {}) {
    const userId = user?.uid;
    if (!userId) {
        throw new HttpError(401, "Authentication is required.", "unauthenticated");
    }

    const bookingRequestId = requireString(payload.bookingRequestId, "Missing booking request ID.");
    const addonId = normalizeAddonId(requireString(payload.addonId, "Missing add-on ID."));
    const addon = getAddonDefinition(addonId);
    if (!addon) {
        throw new HttpError(404, "Selected add-on was not found.", "not-found");
    }

    const approvedBooking = await getApprovedBookingForUser(userId, bookingRequestId);
    const tenantProfile = await getTenantProfile(userId);
    assertAddonChangesAllowed(tenantProfile, approvedBooking.data);
    const subscription = await getAddonSubscriptionDoc(userId, approvedBooking.id, addon.id);
    if (!subscription.exists) {
        throw new HttpError(404, "This add-on is not active on your account.", "not-found");
    }

    const existingStatus = String(subscription.data?.status || "").toLowerCase();
    if (!["active", "scheduled_cancel"].includes(existingStatus)) {
        throw new HttpError(412, "This add-on is not active on your account.", "failed-precondition");
    }

    const nextAdjustableBillingMonth = await getNextAdjustableBillingMonth(userId, approvedBooking.id);
    if (!nextAdjustableBillingMonth) {
        throw new HttpError(412, "There is no future unpaid billing month left to cancel this add-on from.", "failed-precondition");
    }

    const finalBilledMonth = getPreviousBillingMonth(nextAdjustableBillingMonth);
    const update = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        cancelledAt: admin.firestore.FieldValue.serverTimestamp()
    };

    if (!finalBilledMonth || finalBilledMonth < String(subscription.data.effectiveStartMonth || "")) {
        update.status = "cancelled";
        update.effectiveEndMonth = getPreviousBillingMonth(String(subscription.data.effectiveStartMonth || ""));
    } else {
        update.status = "scheduled_cancel";
        update.effectiveEndMonth = finalBilledMonth;
    }

    await subscription.ref.set(update, { merge: true });

    const invoiceRefresh = await refreshFutureBillingInvoicesForBooking(userId, approvedBooking.id);
    return {
        success: true,
        bookingRequestId: approvedBooking.id,
        addonId: addon.id,
        effectiveEndMonth: update.effectiveEndMonth || "",
        status: update.status,
        invoiceRefresh
    };
}

module.exports = {
    activateTenantAddon,
    cancelTenantAddon,
    listTenantAddons
};
