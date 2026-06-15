const { admin, db } = require("../firebaseAdmin");
const { HttpError } = require("../utils/errors");
const {
    hasPaidCheckout,
    mapMethodToPayMongo,
    normalizeBaseUrl,
    paymongoRequest,
    requireValidMethod
} = require("./paymongo");
const { sanitizeRequestedAddons } = require("./addonsCatalog");
const {
    getTransientBedForPayment,
    markTransientBedPaid
} = require("./transientBeds");
const {
    getTransferForPayment,
    markTransferPaidAndComplete
} = require("./transfers");

const DOWN_PAYMENT_AMOUNT = 1000;
const SUPPORTED_PAYMENT_TYPES = ["down_payment", "monthly_rent", "transient_bed", "transfer_fee"];
const BOOKING_STATUS_APPROVED_PENDING_DOWN_PAYMENT = "approved_pending_down_payment";
const SERVER_CREATED_PAYMENT_MARKER = "server";

function normalizeBookingStatus(value) {
    return String(value || "").trim().toLowerCase();
}

function generatePaymentVerificationNonce() {
    return db.collection("_").doc().id;
}

function buildPaymentSecurityFields({ paymentType, userId, bookingRequestId = "", bookingReferenceId = "", billingMonth = "", transientBookingId = "", transferRequestId = "" }) {
    return {
        createdBy: SERVER_CREATED_PAYMENT_MARKER,
        paymentVerificationNonce: generatePaymentVerificationNonce(),
        paymentMetadata: {
            paymentType: String(paymentType || "").trim(),
            userId: String(userId || "").trim(),
            bookingRequestId: String(bookingRequestId || "").trim(),
            bookingReferenceId: String(bookingReferenceId || "").trim(),
            billingMonth: String(billingMonth || "").trim(),
            transientBookingId: String(transientBookingId || "").trim(),
            transferRequestId: String(transferRequestId || "").trim()
        }
    };
}

function buildPaymongoCheckoutMetadata(paymentId, securityFields = {}) {
    const metadata = {
        paymentId: String(paymentId || "").trim()
    };

    const nonce = String(securityFields.paymentVerificationNonce || "").trim();
    if (nonce) {
        metadata.paymentVerificationNonce = nonce;
    }

    const paymentMetadata = securityFields.paymentMetadata || {};
    Object.entries(paymentMetadata).forEach(([key, value]) => {
        const safeValue = String(value || "").trim();
        if (safeValue) {
            metadata[key] = safeValue;
        }
    });

    return metadata;
}

function getPaymongoSessionMetadata(sessionAttributes = {}) {
    return sessionAttributes?.metadata
        || sessionAttributes?.checkout_metadata
        || {};
}

function assertServerManagedPaymentRecord(paymentData = {}) {
    if (String(paymentData.createdBy || "").trim() !== SERVER_CREATED_PAYMENT_MARKER) {
        throw new HttpError(
            412,
            "This payment record was not created by the secure CitiHub checkout flow. Please start a new payment checkout.",
            "untrusted-payment-record"
        );
    }

    if (!String(paymentData.paymentVerificationNonce || "").trim()) {
        throw new HttpError(
            412,
            "This payment record is missing its verification token. Please start a new payment checkout.",
            "untrusted-payment-record"
        );
    }
}

function isServerManagedPaymentRecord(paymentData = {}) {
    return String(paymentData.createdBy || "").trim() === SERVER_CREATED_PAYMENT_MARKER
        && Boolean(String(paymentData.paymentVerificationNonce || "").trim());
}

function assertMatchingCheckoutMetadata(paymentData = {}, sessionAttributes = {}) {
    const metadata = getPaymongoSessionMetadata(sessionAttributes);
    const expected = {
        paymentId: String(paymentData.id || "").trim(),
        paymentVerificationNonce: String(paymentData.paymentVerificationNonce || "").trim(),
        paymentType: String(paymentData.type || "").trim(),
        userId: String(paymentData.userId || "").trim(),
        bookingRequestId: String(paymentData.bookingRequestId || "").trim(),
        bookingReferenceId: String(paymentData.bookingReferenceId || "").trim(),
        billingMonth: String(paymentData.billingMonth || "").trim(),
        transientBookingId: String(paymentData.transientBookingId || "").trim(),
        transferRequestId: String(paymentData.transferRequestId || "").trim()
    };

    const mismatchedKey = Object.entries(expected).find(([key, value]) => String(metadata?.[key] || "").trim() !== value);
    if (mismatchedKey) {
        throw new HttpError(
            412,
            "The payment checkout details do not match this CitiHub payment record. Please start a new checkout.",
            "payment-metadata-mismatch"
        );
    }
}

function isPayableBookingStatus(status) {
    return ["approved", BOOKING_STATUS_APPROVED_PENDING_DOWN_PAYMENT].includes(normalizeBookingStatus(status));
}

function getApprovedRequestedAddons(bookingData = {}) {
    return sanitizeRequestedAddons(bookingData.requestedAddons);
}

function getApprovedRequestedAddonTotal(bookingData = {}) {
    return getApprovedRequestedAddons(bookingData)
        .reduce((sum, addon) => sum + Number(addon.price || 0), 0);
}

async function getApprovedBookingForUser(userId, bookingRequestId) {
    const bookingRef = db.collection("bookingRequest").doc(bookingRequestId);
    const bookingSnap = await bookingRef.get();

    if (!bookingSnap.exists) {
        throw new HttpError(404, "Approved booking request was not found.", "not-found");
    }

    const bookingData = bookingSnap.data();
    if (bookingData.userId !== userId || !isPayableBookingStatus(bookingData.status)) {
        throw new HttpError(403, "This booking request is not eligible for payment.", "permission-denied");
    }

    return {
        ref: bookingRef,
        id: bookingSnap.id,
        data: bookingData
    };
}

async function activateBookingAfterDownPayment(userId, bookingRequestId) {
    const bookingRef = db.collection("bookingRequest").doc(bookingRequestId);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) {
        return;
    }

    const bookingData = bookingSnap.data() || {};
    if (bookingData.userId !== userId) {
        return;
    }

    if (normalizeBookingStatus(bookingData.status) === "approved") {
        return;
    }

    const fullName = [bookingData.firstName, bookingData.lastName].filter(Boolean).join(" ").trim() || bookingData.email || "Tenant";
    const batch = db.batch();

    batch.set(bookingRef, {
        status: "approved",
        reservationStatus: "activated",
        reservationExpiresAt: null,
        downPaymentSettledAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    if (bookingData.userId) {
        batch.set(db.collection("users").doc(bookingData.userId), {
            status: "approved",
            room: bookingData.room ? `Room ${bookingData.room}` : "",
            contractStatus: "active",
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    }

    if (bookingData.room && bookingData.bed) {
        batch.set(db.collection("ROOMS").doc(`${bookingData.room}_${bookingData.bed}`), {
            avail: "Occupied",
            occupant: fullName,
            reservationType: null,
            reservedForBookingId: null,
            reservedForUserId: null,
            reservedUntil: null,
            reservationOccupant: null
        }, { merge: true });
    }

    await batch.commit();
}

async function getTenantProfile(userId) {
    const userSnap = await db.collection("users").doc(userId).get();
    if (!userSnap.exists) {
        throw new HttpError(404, "Tenant profile was not found.", "not-found");
    }

    return userSnap.data();
}

function getPaymentCreatedAt(record) {
    return record?.data?.createdAt?.toDate?.() || new Date(0);
}

async function getExistingDownPayment(userId, bookingRequestId, bookingReferenceId = "") {
    const identifiers = [bookingRequestId, bookingReferenceId]
        .map((value) => String(value || "").trim())
        .filter((value, index, list) => value && list.indexOf(value) === index);
    const recordsById = new Map();

    for (const field of ["bookingRequestId", "bookingReferenceId"]) {
        for (const identifier of identifiers) {
            const snapshot = await db.collection("payments")
                .where("userId", "==", userId)
                .where(field, "==", identifier)
                .where("type", "==", "down_payment")
                .get();

            snapshot.forEach((doc) => {
                recordsById.set(doc.id, { id: doc.id, ref: doc.ref, data: doc.data() });
            });
        }
    }

    const records = [...recordsById.values()].sort((left, right) => getPaymentCreatedAt(right) - getPaymentCreatedAt(left));
    return records.find((record) => record.data.status === "paid") || records[0] || null;
}

async function getPaymentRecordsForBooking(userId, bookingRequestId, bookingReferenceId = "") {
    const identifiers = [bookingRequestId, bookingReferenceId]
        .map((value) => String(value || "").trim())
        .filter((value, index, list) => value && list.indexOf(value) === index);
    const recordsById = new Map();

    for (const field of ["bookingRequestId", "bookingReferenceId"]) {
        for (const identifier of identifiers) {
            const snapshot = await db.collection("payments")
                .where("userId", "==", userId)
                .where(field, "==", identifier)
                .get();

            snapshot.forEach((doc) => {
                recordsById.set(doc.id, { id: doc.id, ref: doc.ref, data: doc.data() });
            });
        }
    }

    return [...recordsById.values()].sort((left, right) => getPaymentCreatedAt(right) - getPaymentCreatedAt(left));
}

function parseMoveInDateValue(value) {
    if (!value) {
        return null;
    }

    const parsed = new Date(`${value}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) {
        return null;
    }

    parsed.setHours(0, 0, 0, 0);
    return parsed;
}

function formatDateOnly(date) {
    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0")
    ].join("-");
}

function formatBillingMonth(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function daysInMonth(date) {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function monthStart(date) {
    const result = new Date(date.getFullYear(), date.getMonth(), 1);
    result.setHours(0, 0, 0, 0);
    return result;
}

function monthEnd(date) {
    const result = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    result.setHours(0, 0, 0, 0);
    return result;
}

function addMonths(date, count) {
    const result = new Date(date.getFullYear(), date.getMonth() + Number(count || 0), 1);
    result.setHours(0, 0, 0, 0);
    return result;
}

function addMonthsClamped(date, count) {
    const result = new Date(date);
    const originalDay = result.getDate();
    result.setMonth(result.getMonth() + Number(count || 0), 1);
    const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
    result.setDate(Math.min(originalDay, lastDay));
    result.setHours(0, 0, 0, 0);
    return result;
}

function getDateOnlyFromBooking(value) {
    if (!value) return null;
    if (typeof value.toDate === "function") {
        const date = value.toDate();
        date.setHours(0, 0, 0, 0);
        return date;
    }
    return parseMoveInDateValue(String(value).slice(0, 10));
}

function createBillingDueDate(year, monthIndex, dayOfMonth) {
    const lastDay = new Date(year, monthIndex + 1, 0).getDate();
    const safeDay = Math.min(dayOfMonth, lastDay);
    const dueDate = new Date(year, monthIndex, safeDay);
    dueDate.setHours(0, 0, 0, 0);
    return dueDate;
}

function parseLeaseAmount(value) {
    const digits = String(value || "").replace(/[^\d.]/g, "");
    const parsed = Number(digits);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function getApprovedMonthlyRate(bookingData) {
    const monthlyRate = Number(bookingData?.monthlyRate || 0);
    return Number.isFinite(monthlyRate) && monthlyRate > 0
        ? monthlyRate
        : parseLeaseAmount(bookingData?.leasePrice);
}

function getApprovedContractMonths(bookingData) {
    const months = Number(bookingData?.contractMonths || 0);
    return Number.isFinite(months) && months > 0 ? months : 12;
}

function parseBillingMonthValue(value) {
    if (!/^\d{4}-\d{2}$/.test(String(value || ""))) {
        return null;
    }

    const [year, month] = String(value).split("-").map(Number);
    const date = new Date(year, month - 1, 1);
    date.setHours(0, 0, 0, 0);
    return Number.isNaN(date.getTime()) ? null : date;
}

function getPreviousBillingMonth(billingMonth) {
    const parsed = parseBillingMonthValue(billingMonth);
    if (!parsed) {
        return "";
    }

    parsed.setMonth(parsed.getMonth() - 1, 1);
    parsed.setHours(0, 0, 0, 0);
    return formatBillingMonth(parsed);
}

function isAddonActiveForBillingMonth(addon, billingMonth) {
    const startMonth = String(addon?.effectiveStartMonth || "").trim();
    const endMonth = String(addon?.effectiveEndMonth || "").trim();
    const status = String(addon?.status || "").trim().toLowerCase();

    if (!startMonth || !billingMonth) {
        return false;
    }

    if (status === "cancelled") {
        return false;
    }

    if (billingMonth < startMonth) {
        return false;
    }

    if (endMonth && billingMonth > endMonth) {
        return false;
    }

    return ["active", "scheduled_cancel"].includes(status);
}

function buildInvoiceAddonSnapshot(userAddons = [], billingMonth = "") {
    const addons = userAddons
        .filter((addon) => isAddonActiveForBillingMonth(addon, billingMonth))
        .map((addon) => ({
            addonId: addon.addonId,
            addonName: addon.addonName,
            price: Number(addon.price || 0),
            billingType: addon.billingType || "monthly",
            status: addon.status || "active"
        }));

    const addonsAmount = addons.reduce((total, addon) => total + Number(addon.price || 0), 0);
    return { addons, addonsAmount };
}

async function getUserAddonsForBooking(userId, bookingRequestId) {
    if (!userId || !bookingRequestId) {
        return [];
    }

    const snapshot = await db.collection("userAddons")
        .where("bookingRequestId", "==", bookingRequestId)
        .get();

    return snapshot.docs
        .map((doc) => ({
        id: doc.id,
        ...doc.data()
    }))
        .filter((addon) => addon.userId === userId);
}

function buildMonthlyBillingSchedule(bookingData, paymentRecords, userAddons = []) {
    const moveInDate = parseMoveInDateValue(bookingData.moveInDate);
    if (!moveInDate) {
        throw new HttpError(412, "This booking is missing a valid approved move-in date.", "failed-precondition");
    }

    const monthlyAmount = getApprovedMonthlyRate(bookingData);
    if (!monthlyAmount) {
        throw new HttpError(412, "This booking is missing a valid monthly rent amount.", "failed-precondition");
    }
    const contractMonths = getApprovedContractMonths(bookingData);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const anchorDay = moveInDate.getDate();
    const firstDueDate = createBillingDueDate(moveInDate.getFullYear(), moveInDate.getMonth() + 1, anchorDay);
    const entries = [];

    for (let index = 0; index < contractMonths; index += 1) {
        const dueDate = createBillingDueDate(firstDueDate.getFullYear(), firstDueDate.getMonth() + index, anchorDay);
        const billingMonth = `${dueDate.getFullYear()}-${String(dueDate.getMonth() + 1).padStart(2, "0")}`;
        const paymentRecord = paymentRecords.find((record) =>
            record.data.type === "monthly_rent" && record.data.billingMonth === billingMonth
        ) || null;
        const addonSnapshot = buildInvoiceAddonSnapshot(userAddons, billingMonth);

        let status = "unpaid";
        if (paymentRecord?.data?.status === "paid") {
            status = "paid";
        } else if (paymentRecord?.data?.status === "pending_gateway") {
            status = "pending_gateway";
        }

        entries.push({
            billingMonth,
            dueDate,
            amount: monthlyAmount + addonSnapshot.addonsAmount,
            rentAmount: monthlyAmount,
            addonsAmount: addonSnapshot.addonsAmount,
            addons: addonSnapshot.addons,
            status,
            paymentRecord
        });
    }

    return {
        moveInDate,
        monthlyAmount,
        contractMonths,
        entries
    };
}

function buildContractInvoiceSchedule(bookingData, userAddons = []) {
    const contractStart = getDateOnlyFromBooking(bookingData.contractStartAt)
        || parseMoveInDateValue(bookingData.contractStartDate)
        || parseMoveInDateValue(bookingData.moveInDate);
    let contractEnd = getDateOnlyFromBooking(bookingData.contractEndAt)
        || parseMoveInDateValue(bookingData.contractEndDate);

    if (!contractEnd && contractStart) {
        contractEnd = addMonthsClamped(contractStart, getApprovedContractMonths(bookingData));
        contractEnd.setDate(contractEnd.getDate() - 1);
    }

    if (!contractStart || !contractEnd || contractEnd < contractStart) {
        throw new HttpError(412, "This booking is missing a valid contract start or end date.", "failed-precondition");
    }

    const monthlyAmount = getApprovedMonthlyRate(bookingData);
    if (!monthlyAmount) {
        throw new HttpError(412, "This booking is missing a valid monthly rent amount.", "failed-precondition");
    }

    const invoices = [];
    let cursor = monthStart(contractStart);
    const finalMonth = monthStart(contractEnd);

    while (cursor <= finalMonth) {
        const periodStart = cursor.getFullYear() === contractStart.getFullYear() && cursor.getMonth() === contractStart.getMonth()
            ? new Date(contractStart)
            : monthStart(cursor);
        const periodEnd = cursor.getFullYear() === contractEnd.getFullYear() && cursor.getMonth() === contractEnd.getMonth()
            ? new Date(contractEnd)
            : monthEnd(cursor);
        const coveredDays = periodEnd.getDate() - periodStart.getDate() + 1;
        const rentAmount = Math.round((monthlyAmount / daysInMonth(cursor)) * coveredDays);
        const addonSnapshot = buildInvoiceAddonSnapshot(userAddons, formatBillingMonth(cursor));
        const grossAmount = rentAmount + addonSnapshot.addonsAmount;
        const isFirst = invoices.length === 0;
        const isFinal = cursor.getFullYear() === finalMonth.getFullYear() && cursor.getMonth() === finalMonth.getMonth();
        const depositCredit = isFinal ? Math.min(DOWN_PAYMENT_AMOUNT, grossAmount) : 0;
        const amount = Math.max(0, grossAmount - depositCredit);

        invoices.push({
            billingMonth: formatBillingMonth(cursor),
            invoiceType: isFirst ? "first_prorated_rent" : isFinal ? "final_rent" : "monthly_rent",
            periodStart: formatDateOnly(periodStart),
            periodEnd: formatDateOnly(periodEnd),
            dueDate: isFirst ? formatDateOnly(periodStart) : formatDateOnly(monthStart(cursor)),
            rentAmount,
            addonsAmount: addonSnapshot.addonsAmount,
            addons: addonSnapshot.addons,
            grossAmount,
            depositCredit,
            amount
        });

        cursor = addMonths(cursor, 1);
    }

    return invoices;
}

async function ensureBillingInvoicesForBooking(userId, bookingRequestId, paymentId = "") {
    const approvedBooking = await getApprovedBookingForUser(userId, bookingRequestId);
    const booking = approvedBooking.data;
    const bookingReferenceId = booking.referenceId || approvedBooking.id;
    const userAddons = await getUserAddonsForBooking(userId, approvedBooking.id);
    const invoices = buildContractInvoiceSchedule(booking, userAddons);
    const batch = db.batch();
    let createdCount = 0;

    for (const invoice of invoices) {
        const invoiceRef = db.collection("billingInvoices").doc(`${approvedBooking.id}_${invoice.billingMonth}`);
        const invoiceSnap = await invoiceRef.get();
        if (invoiceSnap.exists) {
            continue;
        }

        batch.set(invoiceRef, {
            userId,
            bookingRequestId: approvedBooking.id,
            bookingReferenceId,
            tenantName: [booking.firstName, booking.lastName].filter(Boolean).join(" ").trim(),
            tenantEmail: booking.email || "",
            room: booking.room || "",
            bed: booking.bed || "",
            roomType: booking.type || booking.contractType || "",
            contractStartDate: booking.contractStartDate || booking.moveInDate || "",
            contractEndDate: booking.contractEndDate || "",
            monthlyRate: getApprovedMonthlyRate(booking),
            requestedAddons: Array.isArray(booking.requestedAddons) ? booking.requestedAddons : [],
            currency: "PHP",
            status: invoice.amount === 0 ? "deducted_by_deposit" : "unpaid",
            downPaymentPaymentId: paymentId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            ...invoice
        });
        createdCount += 1;
    }

    batch.set(approvedBooking.ref, {
        billingScheduleCreated: true,
        billingScheduleCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
        billingInvoiceCount: invoices.length,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    if (booking.userId) {
        batch.set(db.collection("users").doc(booking.userId), {
            billingScheduleCreated: true,
            billingInvoiceCount: invoices.length,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    }

    await batch.commit();
    return {
        createdCount,
        totalCount: invoices.length
    };
}

async function refreshFutureBillingInvoicesForBooking(userId, bookingRequestId) {
    const approvedBooking = await getApprovedBookingForUser(userId, bookingRequestId);
    const booking = approvedBooking.data;
    const bookingReferenceId = booking.referenceId || approvedBooking.id;
    const userAddons = await getUserAddonsForBooking(userId, approvedBooking.id);
    const invoices = buildContractInvoiceSchedule(booking, userAddons);
    const batch = db.batch();
    let refreshedCount = 0;
    let createdCount = 0;

    for (const invoice of invoices) {
        const invoiceRef = db.collection("billingInvoices").doc(`${approvedBooking.id}_${invoice.billingMonth}`);
        const invoiceSnap = await invoiceRef.get();
        const existing = invoiceSnap.exists ? invoiceSnap.data() || {} : null;
        const existingStatus = String(existing?.status || "").toLowerCase();
        const isLocked = ["paid", "pending_gateway", "deducted_by_deposit"].includes(existingStatus);

        if (invoiceSnap.exists && isLocked) {
            continue;
        }

        batch.set(invoiceRef, {
            userId,
            bookingRequestId: approvedBooking.id,
            bookingReferenceId,
            tenantName: [booking.firstName, booking.lastName].filter(Boolean).join(" ").trim(),
            tenantEmail: booking.email || "",
            room: booking.room || "",
            bed: booking.bed || "",
            roomType: booking.type || booking.contractType || "",
            contractStartDate: booking.contractStartDate || booking.moveInDate || "",
            contractEndDate: booking.contractEndDate || "",
            monthlyRate: getApprovedMonthlyRate(booking),
            requestedAddons: Array.isArray(booking.requestedAddons) ? booking.requestedAddons : [],
            currency: "PHP",
            status: invoice.amount === 0 ? "deducted_by_deposit" : "unpaid",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            createdAt: existing?.createdAt || admin.firestore.FieldValue.serverTimestamp(),
            ...invoice
        }, { merge: true });

        if (invoiceSnap.exists) {
            refreshedCount += 1;
        } else {
            createdCount += 1;
        }
    }

    batch.set(approvedBooking.ref, {
        billingScheduleCreated: true,
        billingScheduleCreatedAt: booking.billingScheduleCreatedAt || admin.firestore.FieldValue.serverTimestamp(),
        billingInvoiceCount: invoices.length,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    if (booking.userId) {
        batch.set(db.collection("users").doc(booking.userId), {
            billingScheduleCreated: true,
            billingInvoiceCount: invoices.length,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    }

    await batch.commit();

    return {
        createdCount,
        refreshedCount,
        totalCount: invoices.length
    };
}

async function getNextAdjustableBillingMonth(userId, bookingRequestId) {
    await ensureBillingInvoicesForBooking(userId, bookingRequestId, "");

    const snapshot = await db.collection("billingInvoices")
        .where("userId", "==", userId)
        .where("bookingRequestId", "==", bookingRequestId)
        .get();

    const invoices = snapshot.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .sort((left, right) => String(left.billingMonth || "").localeCompare(String(right.billingMonth || "")));

    const adjustable = invoices.find((invoice) => {
        const status = String(invoice.status || "").toLowerCase();
        return !["paid", "pending_gateway", "deducted_by_deposit"].includes(status);
    });

    return adjustable?.billingMonth || "";
}

async function getBillingInvoiceForMonth(userId, bookingRequestId, billingMonth) {
    const invoiceRef = db.collection("billingInvoices").doc(`${bookingRequestId}_${billingMonth}`);
    const invoiceSnap = await invoiceRef.get();
    if (invoiceSnap.exists && invoiceSnap.data()?.userId === userId) {
        return { id: invoiceSnap.id, ref: invoiceRef, data: invoiceSnap.data() };
    }

    const snapshot = await db.collection("billingInvoices")
        .where("userId", "==", userId)
        .where("bookingRequestId", "==", bookingRequestId)
        .where("billingMonth", "==", billingMonth)
        .limit(1)
        .get();

    if (snapshot.empty) {
        return null;
    }

    const doc = snapshot.docs[0];
    return { id: doc.id, ref: doc.ref, data: doc.data() };
}

async function markBillingInvoicePaid(paymentData, paymentId) {
    if (paymentData.type !== "monthly_rent" || !paymentData.userId || !paymentData.bookingRequestId || !paymentData.billingMonth) {
        return;
    }

    const invoice = await getBillingInvoiceForMonth(paymentData.userId, paymentData.bookingRequestId, paymentData.billingMonth);
    if (!invoice) {
        return;
    }

    await invoice.ref.set({
        status: "paid",
        paymentId,
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
}

async function completeTransferPaymentAndRefreshInvoices(transferRequestId, paymentId) {
    const result = await markTransferPaidAndComplete(transferRequestId, paymentId);
    if (result?.userId && result?.bookingRequestId) {
        await refreshFutureBillingInvoicesForBooking(result.userId, result.bookingRequestId);
    }

    return result;
}

async function createDownPaymentCheckout(user, { bookingRequestId, method, baseUrl }) {
    const userId = user.uid;
    const safeBookingRequestId = String(bookingRequestId || "").trim();
    const safeMethod = String(method || "").trim().toLowerCase();
    const safeBaseUrl = String(baseUrl || "").trim();

    if (!safeBookingRequestId || !safeBaseUrl) {
        throw new HttpError(400, "Missing booking request or base URL.", "invalid-argument");
    }

    requireValidMethod(safeMethod);

    const normalizedBaseUrl = normalizeBaseUrl(safeBaseUrl);
    const approvedBooking = await getApprovedBookingForUser(userId, safeBookingRequestId);
    const tenantProfile = await getTenantProfile(userId);
    const bookingReferenceId = approvedBooking.data.referenceId || approvedBooking.id;
    const existingPayment = await getExistingDownPayment(userId, safeBookingRequestId, bookingReferenceId);
    const trustedExistingPayment = existingPayment && isServerManagedPaymentRecord(existingPayment.data) ? existingPayment : null;
    const requestedAddons = getApprovedRequestedAddons(approvedBooking.data);
    const requestedAddonsTotal = getApprovedRequestedAddonTotal(approvedBooking.data);
    const totalDownPaymentAmount = DOWN_PAYMENT_AMOUNT + requestedAddonsTotal;

    if (trustedExistingPayment?.data?.status === "paid") {
        return {
            paymentId: trustedExistingPayment.id,
            status: "paid"
        };
    }

    const paymentRef = trustedExistingPayment?.ref || db.collection("payments").doc();
    const paymentId = paymentRef.id;
    const securityFields = buildPaymentSecurityFields({
        paymentType: "down_payment",
        userId,
        bookingRequestId: safeBookingRequestId,
        bookingReferenceId
    });
    const successUrl = `${normalizedBaseUrl}?paymentId=${encodeURIComponent(paymentId)}&result=success`;
    const cancelUrl = `${normalizedBaseUrl}?paymentId=${encodeURIComponent(paymentId)}&result=cancelled`;

    const checkoutPayload = {
        data: {
            attributes: {
                billing: {
                    name: tenantProfile.fullName || tenantProfile.username || user.email || "CitiHub Tenant",
                    email: user.email || tenantProfile.email || ""
                },
                send_email_receipt: true,
                show_description: true,
                show_line_items: true,
                line_items: [
                    {
                        currency: "PHP",
                        amount: totalDownPaymentAmount * 100,
                        name: "CitiHub Down Payment",
                        quantity: 1,
                        description: requestedAddonsTotal
                            ? `Required PHP 1,000.00 down payment plus selected add-ons worth PHP ${requestedAddonsTotal.toFixed(2)}`
                            : "Required PHP 1,000.00 down payment for approved booking"
                    }
                ],
                payment_method_types: mapMethodToPayMongo(safeMethod),
                success_url: successUrl,
                cancel_url: cancelUrl,
                description: `CitiHub down payment for ${bookingReferenceId}`,
                metadata: buildPaymongoCheckoutMetadata(paymentId, securityFields)
            }
        }
    };

    const checkoutResponse = await paymongoRequest("/checkout_sessions", {
        method: "POST",
        body: checkoutPayload
    });

    const checkoutData = checkoutResponse.data;
    await paymentRef.set({
        userId,
        bookingRequestId: safeBookingRequestId,
        bookingReferenceId,
        room: approvedBooking.data.room || "",
        bed: approvedBooking.data.bed || "",
        amount: totalDownPaymentAmount,
        currency: "PHP",
        type: "down_payment",
        method: safeMethod,
        status: "pending_gateway",
        gateway: "paymongo",
        paymongoCheckoutId: checkoutData.id,
        paymongoCheckoutUrl: checkoutData.attributes.checkout_url,
        paymongoSuccessUrl: successUrl,
        paymongoCancelUrl: cancelUrl,
        tenantName: tenantProfile.fullName || tenantProfile.username || user.email || "Tenant",
        tenantEmail: user.email || tenantProfile.email || "",
        requestedAddons,
        requestedAddonsTotal,
        depositAmount: DOWN_PAYMENT_AMOUNT,
        createdBy: securityFields.createdBy,
        paymentVerificationNonce: securityFields.paymentVerificationNonce,
        paymentMetadata: securityFields.paymentMetadata,
        createdAt: trustedExistingPayment?.data?.createdAt || admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        paidAt: trustedExistingPayment?.data?.paidAt || null
    }, { merge: true });

    return {
        paymentId,
        checkoutId: checkoutData.id,
        checkoutUrl: checkoutData.attributes.checkout_url,
        status: "pending_gateway"
    };
}

async function createMonthlyRentCheckout(user, { bookingRequestId, method, baseUrl, billingMonth }) {
    const userId = user.uid;
    const safeBookingRequestId = String(bookingRequestId || "").trim();
    const safeMethod = String(method || "").trim().toLowerCase();
    const safeBaseUrl = String(baseUrl || "").trim();
    const requestedBillingMonth = String(billingMonth || "").trim();

    if (!safeBookingRequestId || !safeBaseUrl || !requestedBillingMonth) {
        throw new HttpError(400, "Missing booking request, base URL, or billing month.", "invalid-argument");
    }

    requireValidMethod(safeMethod);

    const normalizedBaseUrl = normalizeBaseUrl(safeBaseUrl);
    const approvedBooking = await getApprovedBookingForUser(userId, safeBookingRequestId);
    const tenantProfile = await getTenantProfile(userId);
    const bookingReferenceId = approvedBooking.data.referenceId || approvedBooking.id;
    const paymentRecords = await getPaymentRecordsForBooking(userId, safeBookingRequestId, bookingReferenceId);
    const userAddons = await getUserAddonsForBooking(userId, safeBookingRequestId);
    const downPaymentRecords = paymentRecords.filter((record) => record.data.type === "down_payment");
    const downPaymentRecord = downPaymentRecords.find((record) => record.data.status === "paid") || downPaymentRecords[0] || null;
    const isRenewalBooking = approvedBooking.data.isRenewal === true || approvedBooking.data.requestType === "renewal";

    if ((!downPaymentRecord || downPaymentRecord.data.status !== "paid") && !isRenewalBooking) {
        throw new HttpError(412, "The down payment must be marked as paid before monthly rent can be settled.", "failed-precondition");
    }

    await ensureBillingInvoicesForBooking(userId, safeBookingRequestId, downPaymentRecord?.id || "");
    const invoice = await getBillingInvoiceForMonth(userId, safeBookingRequestId, requestedBillingMonth);
    const schedule = invoice ? null : buildMonthlyBillingSchedule(approvedBooking.data, paymentRecords, userAddons);
    const targetEntry = invoice
        ? {
            billingMonth: requestedBillingMonth,
            amount: Number(invoice.data.amount || 0),
            status: invoice.data.status === "paid" || invoice.data.status === "deducted_by_deposit"
                ? "paid"
                : "unpaid",
            dueDate: getDateOnlyFromBooking(invoice.data.dueDate) || parseMoveInDateValue(String(invoice.data.dueDate || "").slice(0, 10)) || new Date(),
            paymentRecord: paymentRecords.find((record) => record.data.type === "monthly_rent" && record.data.billingMonth === requestedBillingMonth) || null,
            invoice
        }
        : schedule.entries.find((entry) => entry.billingMonth === requestedBillingMonth);
    const trustedExistingPayment = targetEntry?.paymentRecord && isServerManagedPaymentRecord(targetEntry.paymentRecord.data)
        ? targetEntry.paymentRecord
        : null;

    if (!targetEntry) {
        throw new HttpError(412, "The selected monthly billing cycle is not available for payment.", "failed-precondition");
    }

    if (Number(targetEntry.amount || 0) <= 0) {
        return {
            paymentId: targetEntry.invoice?.id || "",
            status: "paid"
        };
    }

    if (targetEntry.status === "paid") {
        return {
            paymentId: targetEntry.paymentRecord?.id || targetEntry.invoice?.id || "",
            status: "paid"
        };
    }

    if (targetEntry.status === "pending_gateway" && trustedExistingPayment?.data?.paymongoCheckoutUrl) {
        return {
            paymentId: trustedExistingPayment.id,
            checkoutId: trustedExistingPayment.data.paymongoCheckoutId,
            checkoutUrl: trustedExistingPayment.data.paymongoCheckoutUrl,
            status: "pending_gateway"
        };
    }

    const paymentRef = trustedExistingPayment?.ref || db.collection("payments").doc();
    const paymentId = paymentRef.id;
    const securityFields = buildPaymentSecurityFields({
        paymentType: "monthly_rent",
        userId,
        bookingRequestId: safeBookingRequestId,
        bookingReferenceId,
        billingMonth: requestedBillingMonth
    });
    const successUrl = `${normalizedBaseUrl}?paymentId=${encodeURIComponent(paymentId)}&result=success`;
    const cancelUrl = `${normalizedBaseUrl}?paymentId=${encodeURIComponent(paymentId)}&result=cancelled`;

    const checkoutPayload = {
        data: {
            attributes: {
                billing: {
                    name: tenantProfile.fullName || tenantProfile.username || user.email || "CitiHub Tenant",
                    email: user.email || tenantProfile.email || ""
                },
                send_email_receipt: true,
                show_description: true,
                show_line_items: true,
                line_items: [
                    {
                        currency: "PHP",
                        amount: Math.round(targetEntry.amount * 100),
                        name: `CitiHub Monthly Rent - ${requestedBillingMonth}`,
                        quantity: 1,
                        description: `Monthly rent for ${requestedBillingMonth} based on ${approvedBooking.data.contractLabel || "approved"} contract`
                    }
                ],
                payment_method_types: mapMethodToPayMongo(safeMethod),
                success_url: successUrl,
                cancel_url: cancelUrl,
                description: `CitiHub monthly rent for ${bookingReferenceId} (${requestedBillingMonth})`,
                metadata: buildPaymongoCheckoutMetadata(paymentId, securityFields)
            }
        }
    };

    const checkoutResponse = await paymongoRequest("/checkout_sessions", {
        method: "POST",
        body: checkoutPayload
    });

    const checkoutData = checkoutResponse.data;
    await paymentRef.set({
        userId,
        bookingRequestId: safeBookingRequestId,
        bookingReferenceId,
        room: approvedBooking.data.room || "",
        bed: approvedBooking.data.bed || "",
        amount: targetEntry.amount,
        currency: "PHP",
        type: "monthly_rent",
        contractLabel: approvedBooking.data.contractLabel || "",
        contractTerm: approvedBooking.data.contractTerm || "",
        contractMonths: Number(approvedBooking.data.contractMonths || 0),
        monthlyRate: Number(approvedBooking.data.monthlyRate || targetEntry.amount || 0),
        billingMonth: requestedBillingMonth,
        billingInvoiceId: targetEntry.invoice?.id || "",
        invoiceType: targetEntry.invoice?.data?.invoiceType || "",
        grossAmount: Number(targetEntry.invoice?.data?.grossAmount || targetEntry.amount || 0),
        depositCredit: Number(targetEntry.invoice?.data?.depositCredit || 0),
        dueDate: admin.firestore.Timestamp.fromDate(targetEntry.dueDate),
        method: safeMethod,
        status: "pending_gateway",
        gateway: "paymongo",
        paymongoCheckoutId: checkoutData.id,
        paymongoCheckoutUrl: checkoutData.attributes.checkout_url,
        paymongoSuccessUrl: successUrl,
        paymongoCancelUrl: cancelUrl,
        tenantName: tenantProfile.fullName || tenantProfile.username || user.email || "Tenant",
        tenantEmail: user.email || tenantProfile.email || "",
        createdBy: securityFields.createdBy,
        paymentVerificationNonce: securityFields.paymentVerificationNonce,
        paymentMetadata: securityFields.paymentMetadata,
        createdAt: trustedExistingPayment?.data?.createdAt || admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        paidAt: trustedExistingPayment?.data?.paidAt || null
    }, { merge: true });

    return {
        paymentId,
        checkoutId: checkoutData.id,
        checkoutUrl: checkoutData.attributes.checkout_url,
        status: "pending_gateway"
    };
}

async function getExistingTransientBedPayment(userId, transientBookingId) {
    const snapshot = await db.collection("payments")
        .where("userId", "==", userId)
        .where("transientBookingId", "==", transientBookingId)
        .where("type", "==", "transient_bed")
        .limit(1)
        .get();

    if (snapshot.empty) {
        return null;
    }

    const doc = snapshot.docs[0];
    return { id: doc.id, ref: doc.ref, data: doc.data() };
}

async function createTransientBedCheckout(user, { transientBookingId, method, baseUrl }) {
    const userId = user.uid;
    const safeTransientBookingId = String(transientBookingId || "").trim();
    const safeMethod = String(method || "").trim().toLowerCase();
    const safeBaseUrl = String(baseUrl || "").trim();

    if (!safeTransientBookingId || !safeBaseUrl) {
        throw new HttpError(400, "Missing Transient Bed booking or base URL.", "invalid-argument");
    }

    requireValidMethod(safeMethod);

    const normalizedBaseUrl = normalizeBaseUrl(safeBaseUrl);
    const transientBooking = await getTransientBedForPayment(userId, safeTransientBookingId);
    const existingPayment = await getExistingTransientBedPayment(userId, safeTransientBookingId);
    const trustedExistingPayment = existingPayment && isServerManagedPaymentRecord(existingPayment.data) ? existingPayment : null;

    if (trustedExistingPayment?.data?.status === "paid") {
        return {
            paymentId: trustedExistingPayment.id,
            status: "paid"
        };
    }

    if (
        trustedExistingPayment?.data?.status === "pending_gateway"
        && trustedExistingPayment.data.paymongoCheckoutUrl
        && trustedExistingPayment.data.method === safeMethod
    ) {
        return {
            paymentId: trustedExistingPayment.id,
            checkoutId: trustedExistingPayment.data.paymongoCheckoutId,
            checkoutUrl: trustedExistingPayment.data.paymongoCheckoutUrl,
            status: "pending_gateway"
        };
    }

    const paymentRef = trustedExistingPayment?.ref || db.collection("payments").doc();
    const paymentId = paymentRef.id;
    const bookingReferenceId = transientBooking.data.referenceId || transientBooking.id;
    const securityFields = buildPaymentSecurityFields({
        paymentType: "transient_bed",
        userId,
        transientBookingId: safeTransientBookingId,
        bookingReferenceId
    });
    const successUrl = `${normalizedBaseUrl}?paymentId=${encodeURIComponent(paymentId)}&result=success`;
    const cancelUrl = `${normalizedBaseUrl}?paymentId=${encodeURIComponent(paymentId)}&result=cancelled`;

    const checkoutPayload = {
        data: {
            attributes: {
                billing: {
                    name: transientBooking.data.fullName || user.email || "Transient Bed Guest",
                    email: user.email || transientBooking.data.email || ""
                },
                send_email_receipt: true,
                show_description: true,
                show_line_items: true,
                line_items: [
                    {
                        currency: "PHP",
                        amount: Math.round(Number(transientBooking.data.totalAmount || 0) * 100),
                        name: "CitiHub Transient Bed",
                        quantity: 1,
                        description: `${transientBooking.data.nights} day stay, Room ${transientBooking.data.room}, Bed ${transientBooking.data.bed}`
                    }
                ],
                payment_method_types: mapMethodToPayMongo(safeMethod),
                success_url: successUrl,
                cancel_url: cancelUrl,
                description: `CitiHub Transient Bed payment for ${bookingReferenceId}`,
                metadata: buildPaymongoCheckoutMetadata(paymentId, securityFields)
            }
        }
    };

    const checkoutResponse = await paymongoRequest("/checkout_sessions", {
        method: "POST",
        body: checkoutPayload
    });

    const checkoutData = checkoutResponse.data;
    await paymentRef.set({
        userId,
        transientBookingId: safeTransientBookingId,
        bookingReferenceId,
        room: transientBooking.data.room || "",
        bed: transientBooking.data.bed || "",
        amount: Number(transientBooking.data.totalAmount || 0),
        currency: "PHP",
        type: "transient_bed",
        method: safeMethod,
        status: "pending_gateway",
        gateway: "paymongo",
        paymongoCheckoutId: checkoutData.id,
        paymongoCheckoutUrl: checkoutData.attributes.checkout_url,
        paymongoSuccessUrl: successUrl,
        paymongoCancelUrl: cancelUrl,
        tenantName: transientBooking.data.fullName || user.email || "Transient Bed Guest",
        tenantEmail: user.email || transientBooking.data.email || "",
        createdBy: securityFields.createdBy,
        paymentVerificationNonce: securityFields.paymentVerificationNonce,
        paymentMetadata: securityFields.paymentMetadata,
        createdAt: trustedExistingPayment?.data?.createdAt || admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        paidAt: trustedExistingPayment?.data?.paidAt || null
    }, { merge: true });

    return {
        paymentId,
        checkoutId: checkoutData.id,
        checkoutUrl: checkoutData.attributes.checkout_url,
        status: "pending_gateway"
    };
}

async function getExistingTransferPayment(userId, transferRequestId) {
    const snapshot = await db.collection("payments")
        .where("userId", "==", userId)
        .where("transferRequestId", "==", transferRequestId)
        .where("type", "==", "transfer_fee")
        .limit(1)
        .get();

    if (snapshot.empty) {
        return null;
    }

    const doc = snapshot.docs[0];
    return { id: doc.id, ref: doc.ref, data: doc.data() };
}

async function createTransferFeeCheckout(user, { transferRequestId, method, baseUrl }) {
    const userId = user.uid;
    const safeTransferRequestId = String(transferRequestId || "").trim();
    const safeMethod = String(method || "").trim().toLowerCase();
    const safeBaseUrl = String(baseUrl || "").trim();

    if (!safeTransferRequestId || !safeBaseUrl) {
        throw new HttpError(400, "Missing transfer request or base URL.", "invalid-argument");
    }

    requireValidMethod(safeMethod);

    const normalizedBaseUrl = normalizeBaseUrl(safeBaseUrl);
    const transferRequest = await getTransferForPayment(userId, safeTransferRequestId);
    const existingPayment = await getExistingTransferPayment(userId, safeTransferRequestId);
    const trustedExistingPayment = existingPayment && isServerManagedPaymentRecord(existingPayment.data) ? existingPayment : null;

    if (trustedExistingPayment?.data?.status === "paid") {
        return {
            paymentId: trustedExistingPayment.id,
            status: "paid"
        };
    }

    if (
        trustedExistingPayment?.data?.status === "pending_gateway"
        && trustedExistingPayment.data.paymongoCheckoutUrl
        && trustedExistingPayment.data.method === safeMethod
    ) {
        return {
            paymentId: trustedExistingPayment.id,
            checkoutId: trustedExistingPayment.data.paymongoCheckoutId,
            checkoutUrl: trustedExistingPayment.data.paymongoCheckoutUrl,
            status: "pending_gateway"
        };
    }

    const paymentRef = trustedExistingPayment?.ref || db.collection("payments").doc();
    const paymentId = paymentRef.id;
    const amount = Number(transferRequest.data.feeAmount || 0);
    const securityFields = buildPaymentSecurityFields({
        paymentType: "transfer_fee",
        userId,
        bookingRequestId: transferRequest.data.bookingRequestId || "",
        bookingReferenceId: transferRequest.data.bookingReferenceId || "",
        transferRequestId: safeTransferRequestId
    });
    const successUrl = `${normalizedBaseUrl}?paymentId=${encodeURIComponent(paymentId)}&result=success&transferRequestId=${encodeURIComponent(safeTransferRequestId)}&type=transfer`;
    const cancelUrl = `${normalizedBaseUrl}?paymentId=${encodeURIComponent(paymentId)}&result=cancelled&transferRequestId=${encodeURIComponent(safeTransferRequestId)}&type=transfer`;

    const checkoutPayload = {
        data: {
            attributes: {
                billing: {
                    name: transferRequest.data.tenantName || user.email || "CitiHub Tenant",
                    email: user.email || transferRequest.data.tenantEmail || ""
                },
                send_email_receipt: true,
                show_description: true,
                show_line_items: true,
                line_items: [
                    {
                        currency: "PHP",
                        amount: Math.round(amount * 100),
                        name: transferRequest.data.transferKind === "upgrade" ? "CitiHub Room Upgrade Fee" : "CitiHub Room Transfer Fee",
                        quantity: 1,
                        description: `Transfer from Room ${transferRequest.data.currentRoom}, Bed ${transferRequest.data.currentBed} to Room ${transferRequest.data.targetRoom}, Bed ${transferRequest.data.targetBed}`
                    }
                ],
                payment_method_types: mapMethodToPayMongo(safeMethod),
                success_url: successUrl,
                cancel_url: cancelUrl,
                description: `CitiHub transfer fee for ${safeTransferRequestId}`,
                metadata: buildPaymongoCheckoutMetadata(paymentId, securityFields)
            }
        }
    };

    const checkoutResponse = await paymongoRequest("/checkout_sessions", {
        method: "POST",
        body: checkoutPayload
    });

    const checkoutData = checkoutResponse.data;
    await paymentRef.set({
        userId,
        transferRequestId: safeTransferRequestId,
        bookingRequestId: transferRequest.data.bookingRequestId || "",
        bookingReferenceId: transferRequest.data.bookingReferenceId || "",
        room: transferRequest.data.targetRoom || "",
        bed: transferRequest.data.targetBed || "",
        amount,
        currency: "PHP",
        type: "transfer_fee",
        method: safeMethod,
        status: "pending_gateway",
        gateway: "paymongo",
        paymongoCheckoutId: checkoutData.id,
        paymongoCheckoutUrl: checkoutData.attributes.checkout_url,
        paymongoSuccessUrl: successUrl,
        paymongoCancelUrl: cancelUrl,
        tenantName: transferRequest.data.tenantName || user.email || "Tenant",
        tenantEmail: user.email || transferRequest.data.tenantEmail || "",
        createdBy: securityFields.createdBy,
        paymentVerificationNonce: securityFields.paymentVerificationNonce,
        paymentMetadata: securityFields.paymentMetadata,
        createdAt: trustedExistingPayment?.data?.createdAt || admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        paidAt: trustedExistingPayment?.data?.paidAt || null
    }, { merge: true });

    return {
        paymentId,
        checkoutId: checkoutData.id,
        checkoutUrl: checkoutData.attributes.checkout_url,
        status: "pending_gateway"
    };
}

async function verifyPaymongoCheckout(user, { paymentId }) {
    const userId = user.uid;
    const safePaymentId = String(paymentId || "").trim();

    if (!safePaymentId) {
        throw new HttpError(400, "Missing payment ID.", "invalid-argument");
    }

    const paymentRef = db.collection("payments").doc(safePaymentId);
    const paymentSnap = await paymentRef.get();
    if (!paymentSnap.exists) {
        throw new HttpError(404, "Payment request not found.", "not-found");
    }

    const paymentData = paymentSnap.data();
    if (paymentData.userId !== userId) {
        throw new HttpError(403, "You do not have access to this payment.", "permission-denied");
    }

    if (!SUPPORTED_PAYMENT_TYPES.includes(paymentData.type)) {
        throw new HttpError(412, "Unsupported payment type.", "failed-precondition");
    }

    const securedPaymentData = {
        id: safePaymentId,
        ...paymentData
    };

    const isTrustedPaymentRecord = isServerManagedPaymentRecord(securedPaymentData);
    if (!isTrustedPaymentRecord && securedPaymentData.status !== "paid") {
        assertServerManagedPaymentRecord(securedPaymentData);
    }

    if (securedPaymentData.status === "paid") {
        if (securedPaymentData.type === "transfer_fee") {
            await completeTransferPaymentAndRefreshInvoices(securedPaymentData.transferRequestId, safePaymentId);
        }
        if (securedPaymentData.type === "down_payment" && securedPaymentData.bookingRequestId) {
            await activateBookingAfterDownPayment(userId, securedPaymentData.bookingRequestId);
            await ensureBillingInvoicesForBooking(userId, securedPaymentData.bookingRequestId, safePaymentId);
        }
        if (securedPaymentData.type === "monthly_rent") {
            await markBillingInvoicePaid(securedPaymentData, safePaymentId);
        }
        return {
            paymentId: safePaymentId,
            type: securedPaymentData.type,
            status: "paid"
        };
    }

    if (!securedPaymentData.paymongoCheckoutId) {
        throw new HttpError(412, "No PayMongo checkout session is attached to this payment.", "failed-precondition");
    }

    const checkoutResponse = await paymongoRequest(`/checkout_sessions/${securedPaymentData.paymongoCheckoutId}`);
    const sessionAttributes = checkoutResponse.data?.attributes || {};
    assertMatchingCheckoutMetadata(securedPaymentData, sessionAttributes);
    const paid = hasPaidCheckout(sessionAttributes);

    if (paid) {
        if (securedPaymentData.type === "transfer_fee") {
            await completeTransferPaymentAndRefreshInvoices(securedPaymentData.transferRequestId, safePaymentId);
        }
        await paymentRef.update({
            status: "paid",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            paidAt: admin.firestore.FieldValue.serverTimestamp()
        });
        if (securedPaymentData.type === "transient_bed") {
            await markTransientBedPaid(securedPaymentData.transientBookingId, safePaymentId);
        }
        if (securedPaymentData.type === "down_payment" && securedPaymentData.bookingRequestId) {
            await activateBookingAfterDownPayment(userId, securedPaymentData.bookingRequestId);
            await ensureBillingInvoicesForBooking(userId, securedPaymentData.bookingRequestId, safePaymentId);
        }
        if (securedPaymentData.type === "monthly_rent") {
            await markBillingInvoicePaid(securedPaymentData, safePaymentId);
        }
        return {
            paymentId: safePaymentId,
            type: securedPaymentData.type,
            status: "paid"
        };
    }

    return {
        paymentId: safePaymentId,
        type: securedPaymentData.type,
        status: securedPaymentData.status || "pending_gateway"
    };
}

async function handlePaymongoWebhook(eventBody) {
    const attributes = eventBody?.data?.attributes || {};
    const resource = attributes?.data || {};
    const metadata = resource?.attributes?.metadata || {};
    const paymentId = String(metadata.paymentId || "").trim();

    if (!paymentId) {
        return { success: true, ignored: true, reason: "Missing paymentId in webhook metadata." };
    }

    const paymentRef = db.collection("payments").doc(paymentId);
    const paymentSnap = await paymentRef.get();
    if (!paymentSnap.exists) {
        return { success: true, ignored: true, reason: "Payment record not found." };
    }

    const paymentData = paymentSnap.data();
    const securedPaymentData = {
        id: paymentId,
        ...paymentData
    };

    const isTrustedPaymentRecord = isServerManagedPaymentRecord(securedPaymentData);
    if (!isTrustedPaymentRecord && securedPaymentData.status !== "paid") {
        assertServerManagedPaymentRecord(securedPaymentData);
    }

    if (securedPaymentData.status === "paid") {
        if (securedPaymentData.type === "transfer_fee") {
            await completeTransferPaymentAndRefreshInvoices(securedPaymentData.transferRequestId, paymentId);
        }
        if (securedPaymentData.type === "down_payment" && securedPaymentData.userId && securedPaymentData.bookingRequestId) {
            await activateBookingAfterDownPayment(securedPaymentData.userId, securedPaymentData.bookingRequestId);
            await ensureBillingInvoicesForBooking(securedPaymentData.userId, securedPaymentData.bookingRequestId, paymentId);
        }
        if (securedPaymentData.type === "monthly_rent") {
            await markBillingInvoicePaid(securedPaymentData, paymentId);
        }
        return { success: true, paymentId, status: "paid" };
    }

    const paymongoCheckoutId = securedPaymentData.paymongoCheckoutId || resource?.id || "";
    if (!paymongoCheckoutId) {
        return { success: true, ignored: true, reason: "Missing checkout session reference." };
    }

    const checkoutResponse = await paymongoRequest(`/checkout_sessions/${paymongoCheckoutId}`);
    const sessionAttributes = checkoutResponse.data?.attributes || {};
    assertMatchingCheckoutMetadata(securedPaymentData, sessionAttributes);
    const paid = hasPaidCheckout(sessionAttributes);

    if (!paid) {
        return { success: true, paymentId, status: securedPaymentData.status || "pending_gateway" };
    }

    if (securedPaymentData.type === "transfer_fee") {
        await completeTransferPaymentAndRefreshInvoices(securedPaymentData.transferRequestId, paymentId);
    }
    await paymentRef.update({
        status: "paid",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        paidAt: admin.firestore.FieldValue.serverTimestamp()
    });
    if (securedPaymentData.type === "transient_bed") {
        await markTransientBedPaid(securedPaymentData.transientBookingId, paymentId);
    }
    if (securedPaymentData.type === "down_payment" && securedPaymentData.userId && securedPaymentData.bookingRequestId) {
        await activateBookingAfterDownPayment(securedPaymentData.userId, securedPaymentData.bookingRequestId);
        await ensureBillingInvoicesForBooking(securedPaymentData.userId, securedPaymentData.bookingRequestId, paymentId);
    }
    if (securedPaymentData.type === "monthly_rent") {
        await markBillingInvoicePaid(securedPaymentData, paymentId);
    }

    return { success: true, paymentId, status: "paid" };
}

module.exports = {
    createDownPaymentCheckout,
    createMonthlyRentCheckout,
    createTransferFeeCheckout,
    createTransientBedCheckout,
    getNextAdjustableBillingMonth,
    getApprovedBookingForUser,
    getPaymentRecordsForBooking,
    getTenantProfile,
    handlePaymongoWebhook,
    ensureBillingInvoicesForBooking,
    refreshFutureBillingInvoicesForBooking,
    verifyPaymongoCheckout
};
