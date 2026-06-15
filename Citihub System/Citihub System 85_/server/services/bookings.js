const { admin, db } = require("../firebaseAdmin");
const { sendResendEmail } = require("./email");
const { ensureBillingInvoicesForBooking } = require("./payments");
const { sanitizeRequestedAddons } = require("./addonsCatalog");
const { HttpError } = require("../utils/errors");
const BOOKING_STATUS_APPROVED_PENDING_DOWN_PAYMENT = "approved_pending_down_payment";
const RESERVATION_PAYMENT_WINDOW_HOURS = 48;
const BOOKING_STATUS_TENANT_CANCEL_REQUESTED = "tenant_cancel_requested";

function getFullName(data) {
    return `${data.firstName || ""} ${data.lastName || ""}`.trim();
}

function getAdminName(adminUser, adminProfile) {
    return adminProfile?.username || adminProfile?.fullName || adminUser.email || "Admin";
}

function normalizeText(value) {
    return String(value || "").trim().toLowerCase();
}

function isApprovedBookingStatus(status) {
    return normalizeText(status) === "approved";
}

function isReservedBookingStatus(status) {
    return normalizeText(status) === BOOKING_STATUS_APPROVED_PENDING_DOWN_PAYMENT;
}

function isApprovedOrReservedBookingStatus(status) {
    return isApprovedBookingStatus(status) || isReservedBookingStatus(status);
}

function isAccountBillingRestricted(userData = {}, bookingData = {}) {
    return userData.manualBillingHold === true
        || bookingData.manualBillingHold === true
        || userData.delinquentAccount === true
        || bookingData.delinquentAccount === true
        || normalizeText(userData.billingStatus) === "delinquent"
        || normalizeText(bookingData.billingStatus) === "delinquent";
}

function getBillingRestrictionMessage(userData = {}, bookingData = {}) {
    if (userData.manualBillingHold === true || bookingData.manualBillingHold === true) {
        return "This account is currently on billing hold and cannot renew until an administrator removes the hold.";
    }

    return "This account has overdue billing and cannot renew until the outstanding balance is settled.";
}

async function hasOutstandingBillingForBooking(userId, bookingRequestId, bookingReferenceId = "") {
    const identifiers = [bookingRequestId, bookingReferenceId]
        .map((value) => String(value || "").trim())
        .filter((value, index, list) => value && list.indexOf(value) === index);

    if (!userId || !identifiers.length) {
        return false;
    }

    for (const field of ["bookingRequestId", "bookingReferenceId"]) {
        for (const identifier of identifiers) {
            const snapshot = await db.collection("billingInvoices")
                .where("userId", "==", userId)
                .where(field, "==", identifier)
                .get();

            const hasOutstanding = snapshot.docs.some((doc) => {
                const invoice = doc.data() || {};
                const status = normalizeText(invoice.status || "unpaid");
                return !["paid", "deducted_by_deposit", "cancelled"].includes(status)
                    && Number(invoice.amount || 0) > 0;
            });

            if (hasOutstanding) {
                return true;
            }
        }
    }

    return false;
}

function requireString(value, message, code = "invalid-argument") {
    const safeValue = String(value || "").trim();
    if (!safeValue) {
        throw new HttpError(400, message, code);
    }

    return safeValue;
}

function parseDateOnly(value, message) {
    const safeValue = requireString(value, message);
    const parsed = new Date(`${safeValue}T00:00:00`);

    if (Number.isNaN(parsed.getTime())) {
        throw new HttpError(400, message, "invalid-argument");
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

function getDateOnlyFromValue(value) {
    if (!value) {
        return null;
    }

    const parsed = typeof value.toDate === "function"
        ? value.toDate()
        : new Date(`${String(value).slice(0, 10)}T00:00:00`);

    if (Number.isNaN(parsed.getTime())) {
        return null;
    }

    parsed.setHours(0, 0, 0, 0);
    return parsed;
}

function addMonthsClamped(date, months) {
    const result = new Date(date);
    const originalDay = result.getDate();

    result.setDate(1);
    result.setMonth(result.getMonth() + Number(months || 0));
    const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
    result.setDate(Math.min(originalDay, lastDay));
    result.setHours(0, 0, 0, 0);
    return result;
}

function getInitialAddonBillingMonth(moveInDateValue) {
    const moveInDate = parseDateOnly(moveInDateValue, "A valid move-in date is required before approving this booking.");
    return formatBillingMonth(addMonthsClamped(moveInDate, 1));
}

function buildApprovedContractFields(bookingData) {
    const contractStart = parseDateOnly(bookingData.moveInDate, "A valid move-in date is required before approving this booking.");
    const contractMonths = Number(bookingData.contractMonths || 0);

    if (!Number.isFinite(contractMonths) || contractMonths <= 0) {
        throw new HttpError(412, "This booking is missing a valid contract length.", "failed-precondition");
    }

    const contractEnd = addMonthsClamped(contractStart, contractMonths);
    contractEnd.setDate(contractEnd.getDate() - 1);

    return {
        contractStartDate: formatDateOnly(contractStart),
        contractEndDate: formatDateOnly(contractEnd),
        contractStartAt: admin.firestore.Timestamp.fromDate(contractStart),
        contractEndAt: admin.firestore.Timestamp.fromDate(contractEnd),
        contractMonths,
        monthlyRate: Number(bookingData.monthlyRate || 0),
        billingDueDay: 1,
        billingDueRule: "first_day_of_month",
        contractStatus: "active"
    };
}

function activeTransientStatus(status) {
    return ["pending_payment", "pending", "approved", "checked_in"].includes(status);
}

async function assertNoTransientConflictForMonthly(transaction, bookingData) {
    const moveInDate = parseDateOnly(bookingData.moveInDate, "A valid move-in date is required before approving this booking.");
    const snapshot = await transaction.get(
        db.collection("transientBedBookings")
            .where("room", "==", bookingData.room)
            .where("bed", "==", bookingData.bed)
    );

    snapshot.forEach((doc) => {
        const transient = doc.data();
        if (!activeTransientStatus(transient.status)) {
            return;
        }

        const transientCheckOut = parseDateOnly(transient.checkOutDate, "Transient booking has an invalid check-out date.");
        if (transientCheckOut > moveInDate) {
            throw new HttpError(409, "This bedspace has an active Transient Bed reservation that conflicts with the monthly move-in date.", "date-conflict");
        }
    });
}

function hasSelfieWithIdDocument(documents = []) {
    return documents.some((doc) => {
        const normalizedLabel = String(doc?.label || "").trim().toLowerCase();
        return normalizedLabel === "selfie holding id" && Array.isArray(doc.files) && doc.files.length > 0;
    });
}

function isMaintenanceStatus(value) {
    const text = normalizeText(value);
    return text.includes("maintenance") || text.includes("maintainance") || text.includes("under repair") || text === "unavailable";
}

const CONTRACT_OPTIONS = {
    standard: {
        "1_5_months": { label: "1 - 5 Months", monthlyRate: 3600, contractMonths: 5, leasePrice: "3,600" },
        "6_11_months": { label: "6 - 11 Months", monthlyRate: 2893, contractMonths: 11, leasePrice: "2,893" },
        "1_year": { label: "1 Year", monthlyRate: 1900, contractMonths: 12, leasePrice: "1,900" }
    },
    premium: {
        "1_5_months": { label: "1 - 5 Months", monthlyRate: 5075, contractMonths: 5, leasePrice: "5,075" },
        "6_11_months": { label: "6 - 11 Months", monthlyRate: 4095, contractMonths: 11, leasePrice: "4,095" },
        "1_year": { label: "1 Year", monthlyRate: 2500, contractMonths: 12, leasePrice: "2,500" }
    }
};

function getContractForRequest(roomType, payload = {}) {
    const safeTerm = String(payload.contractTerm || "").trim().toLowerCase();
    const contract = CONTRACT_OPTIONS[roomType]?.[safeTerm];

    if (!contract) {
        throw new HttpError(400, "Please choose a valid lease contract.", "invalid-argument");
    }

    return {
        contractType: roomType,
        contractTerm: safeTerm,
        contractLabel: contract.label,
        contractMonths: contract.contractMonths,
        monthlyRate: contract.monthlyRate,
        leasePrice: contract.leasePrice
    };
}

function sanitizeDocuments(documents) {
    if (!Array.isArray(documents)) {
        return [];
    }

    return documents.slice(0, 20).map((document) => ({
        id: String(document?.id || "").trim(),
        label: String(document?.label || "").trim(),
        files: Array.isArray(document?.files)
            ? document.files.slice(0, 10).map((file) => ({
                name: String(file?.name || "").trim(),
                url: String(file?.url || "").trim(),
                path: String(file?.path || "").trim(),
                storagePath: String(file?.storagePath || file?.path || "").trim(),
                type: String(file?.type || "").trim(),
                size: Number(file?.size || 0)
            }))
            : []
    }));
}

async function writeAdminHistory(adminUser, adminProfile, { action, module, targetId, targetName, details }) {
    await db.collection("adminHistory").add({
        adminUid: adminUser.uid,
        adminName: getAdminName(adminUser, adminProfile),
        adminEmail: adminUser.email || "",
        action,
        module,
        targetId,
        targetName,
        details,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
}

async function sendTenantMessage(userId, { text, systemType, bookingRequestId }) {
    if (!userId) {
        return;
    }

    const userRef = db.collection("users").doc(userId);
    await userRef.collection("messages").add({
        text,
        senderType: "admin",
        senderName: "CitiHub Management",
        systemType,
        bookingRequestId,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await userRef.set({
        chatLastMessage: text,
        chatLastSender: "admin",
        chatLastAt: admin.firestore.FieldValue.serverTimestamp(),
        chatUnreadForTenant: admin.firestore.FieldValue.increment(1),
        chatUnreadForAdmin: 0
    }, { merge: true });
}

async function cancelPendingPaymentsForBooking(bookingRequestId, userId) {
    const snapshot = await db.collection("payments")
        .where("bookingRequestId", "==", bookingRequestId)
        .get();

    const updates = snapshot.docs
        .filter((doc) => {
            const data = doc.data();
            return data.userId === userId && data.status === "pending_gateway";
        })
        .map((doc) => doc.ref.update({
            status: "cancelled",
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }));

    await Promise.all(updates);
}

async function deleteBookingStorageFiles(documents = []) {
    const storagePaths = [];
    documents.forEach((doc) => {
        (doc.files || []).forEach((file) => {
            const storagePath = String(file?.storagePath || file?.path || "").trim();
            if (storagePath) {
                storagePaths.push(storagePath);
            }
        });
    });

    if (!storagePaths.length) {
        return;
    }

    const bucket = admin.storage().bucket();
    await Promise.all(storagePaths.map((path) =>
        bucket.file(path).delete({ ignoreNotFound: true })
    ));
}

async function deleteBillingInvoicesForBooking(bookingRequestId) {
    if (!bookingRequestId) {
        return 0;
    }

    const snapshot = await db.collection("billingInvoices")
        .where("bookingRequestId", "==", bookingRequestId)
        .get();

    if (snapshot.empty) {
        return 0;
    }

    let deletedCount = 0;
    for (let index = 0; index < snapshot.docs.length; index += 450) {
        const batch = db.batch();
        snapshot.docs.slice(index, index + 450).forEach((doc) => {
            batch.delete(doc.ref);
            deletedCount += 1;
        });
        await batch.commit();
    }

    return deletedCount;
}

async function cancelAddonSubscriptionsForBooking(bookingRequestId, userId) {
    if (!bookingRequestId || !userId) {
        return 0;
    }

    const snapshot = await db.collection("userAddons")
        .where("bookingRequestId", "==", bookingRequestId)
        .where("userId", "==", userId)
        .get();

    if (snapshot.empty) {
        return 0;
    }

    let updatedCount = 0;
    const now = admin.firestore.FieldValue.serverTimestamp();
    for (let index = 0; index < snapshot.docs.length; index += 450) {
        const batch = db.batch();
        snapshot.docs.slice(index, index + 450).forEach((doc) => {
            batch.set(doc.ref, {
                status: "cancelled",
                cancelledAt: now,
                updatedAt: now
            }, { merge: true });
            updatedCount += 1;
        });
        await batch.commit();
    }

    return updatedCount;
}

async function hasPaidDownPaymentForBooking(userId, bookingRequestId, bookingReferenceId = "") {
    const identifiers = [bookingRequestId, bookingReferenceId]
        .map((value) => String(value || "").trim())
        .filter((value, index, list) => value && list.indexOf(value) === index);

    if (!userId || !identifiers.length) {
        return false;
    }

    const queries = [];
    identifiers.forEach((identifier) => {
        queries.push(
            db.collection("payments")
                .where("userId", "==", userId)
                .where("bookingRequestId", "==", identifier)
                .where("type", "==", "down_payment")
                .where("status", "==", "paid")
                .limit(1)
                .get()
        );
        queries.push(
            db.collection("payments")
                .where("userId", "==", userId)
                .where("bookingReferenceId", "==", identifier)
                .where("type", "==", "down_payment")
                .where("status", "==", "paid")
                .limit(1)
                .get()
        );
    });

    const snapshots = await Promise.all(queries);
    return snapshots.some((snapshot) => !snapshot.empty);
}

function getDocumentStoragePathSet(documents = []) {
    const paths = new Set();

    documents.forEach((doc) => {
        (doc.files || []).forEach((file) => {
            const storagePath = String(file?.storagePath || file?.path || "").trim();
            if (storagePath) {
                paths.add(storagePath);
            }
        });
    });

    return paths;
}

function getDetachedBookingDocuments(oldDocuments = [], newDocuments = []) {
    const keptPaths = getDocumentStoragePathSet(newDocuments);
    return oldDocuments.map((doc) => ({
        ...doc,
        files: (doc.files || []).filter((file) => {
            const storagePath = String(file?.storagePath || file?.path || "").trim();
            return storagePath && !keptPaths.has(storagePath);
        })
    })).filter((doc) => doc.files.length > 0);
}

async function sendBookingApprovedEmail(data) {
    const fullName = getFullName(data) || "Applicant";
    if (!data.email || !data.room || !data.bed) {
        throw new HttpError(412, "Booking request is missing email or room details.", "failed-precondition");
    }

    return sendResendEmail({
        toEmail: data.email,
        subject: "Your CitiHub booking has been approved",
        textPart: `Hello ${fullName}, your booking for Room ${data.room}, Bed ${data.bed} has been approved.`,
        htmlPart: `
            <div style="font-family: Arial, sans-serif; line-height: 1.6;">
                <h2>Booking Approved</h2>
                <p>Hello ${fullName},</p>
                <p>Your booking request has been approved.</p>
                <p><strong>Room:</strong> ${data.room}</p>
                <p><strong>Bed:</strong> ${data.bed}</p>
                <p>Please wait for the next instructions from CitiHub Dormitory.</p>
            </div>
        `
    });
}

async function sendBookingRejectedEmail(data) {
    const fullName = getFullName(data) || "Applicant";
    const rejectionReason = String(data.rejectionReason || "").trim();
    if (!data.email || !rejectionReason) {
        throw new HttpError(412, "Booking request is missing email or rejection reason.", "failed-precondition");
    }

    return sendResendEmail({
        toEmail: data.email,
        subject: "Update on your CitiHub booking request",
        textPart: `Hello ${fullName}, your booking request was not approved. Reason: ${rejectionReason}`,
        htmlPart: `
            <div style="font-family: Arial, sans-serif; line-height: 1.6;">
                <h2>Booking Request Update</h2>
                <p>Hello ${fullName},</p>
                <p>We regret to inform you that your booking request was not approved at this time.</p>
                <p><strong>Reason:</strong> ${rejectionReason}</p>
                <p>You may contact CitiHub Dormitory for clarification or submit a new request if applicable.</p>
            </div>
        `
    });
}

async function getBookingRequestForEmail(bookingRequestId) {
    const snap = await db.collection("bookingRequest").doc(bookingRequestId).get();
    if (!snap.exists) {
        throw new HttpError(404, "Booking request not found.", "not-found");
    }

    return {
        id: snap.id,
        data: snap.data()
    };
}

async function createBookingRequest(user, payload = {}) {
    const userId = user?.uid;
    if (!userId) {
        throw new HttpError(401, "Authentication is required.", "unauthenticated");
    }

    const safeReferenceId = requireString(payload.referenceId, "Missing booking reference ID.");
    const safeRoom = requireString(payload.room, "Please choose a room.");
    const safeBed = requireString(payload.bed, "Please choose a bedspace.");
    const safeType = requireString(payload.type, "Please choose a room type.").toLowerCase();
    const safeMoveInDate = requireString(payload.moveInDate, "Please choose a move-in date.");
    const safeMoveInTime = requireString(payload.moveInTime, "Please choose a move-in time.");
    parseDateOnly(safeMoveInDate, "Please choose a valid move-in date.");
    const contract = getContractForRequest(safeType, payload);
    const requestedAddons = sanitizeRequestedAddons(payload.requestedAddons);

    const bookingData = {
        referenceId: safeReferenceId,
        userId,
        email: user.email || "",
        firstName: requireString(payload.firstName, "First name is required."),
        lastName: requireString(payload.lastName, "Last name is required."),
        phone: requireString(payload.phone, "Phone number is required."),
        birthDate: requireString(payload.birthDate, "Birth date is required."),
        address: requireString(payload.address, "Address is required."),
        emergencyName: requireString(payload.emergencyName, "Emergency contact name is required."),
        relationship: requireString(payload.relationship, "Emergency contact relationship is required."),
        emergencyPhone: requireString(payload.emergencyPhone, "Emergency contact phone is required."),
        emergencyAlt: String(payload.emergencyAlt || "").trim(),
        emergencyAddress: requireString(payload.emergencyAddress, "Emergency contact address is required."),
        applicantType: requireString(payload.applicantType, "Applicant type is required."),
        room: safeRoom,
        bed: safeBed,
        type: safeType,
        contractType: contract.contractType,
        contractTerm: contract.contractTerm,
        contractLabel: contract.contractLabel,
        contractMonths: contract.contractMonths,
        monthlyRate: contract.monthlyRate,
        leasePrice: contract.leasePrice,
        moveInDate: safeMoveInDate,
        moveInTime: safeMoveInTime,
        requestedAddons,
        documents: sanitizeDocuments(payload.documents),
        identityVerificationStatus: "pending_review",
        identityVerificationNote: "",
        identityVerificationReviewedAt: null,
        identityVerificationReviewedBy: "",
        status: "pending"
    };

    if (!hasSelfieWithIdDocument(bookingData.documents)) {
        throw new HttpError(400, "Selfie holding ID is required before submitting a booking request.", "invalid-argument");
    }

    const bookingRef = db.collection("bookingRequest").doc(safeReferenceId);
    let detachedDocuments = [];

    await db.runTransaction(async (transaction) => {
        const userRef = db.collection("users").doc(userId);
        const roomRef = db.collection("ROOMS").doc(`${safeRoom}_${safeBed}`);

        const existingBookingSnap = await transaction.get(bookingRef);
        const userSnap = await transaction.get(userRef);
        const activeBookingSnap = await transaction.get(
            db.collection("bookingRequest").where("userId", "==", userId)
        );
        const transientSnap = await transaction.get(
            db.collection("transientBedBookings").where("userId", "==", userId)
        );
        const roomSnap = await transaction.get(roomRef);
        await assertNoTransientConflictForMonthly(transaction, bookingData);

        if (!userSnap.exists) {
            throw new HttpError(404, "User profile not found.", "not-found");
        }

        const profile = userSnap.data() || {};
        if (profile.bookingBlocked === true) {
            throw new HttpError(
                403,
                profile.bookingBlockedReason
                    ? `Your account is no longer allowed to book a bedspace. Reason: ${profile.bookingBlockedReason}`
                    : "Your account is no longer allowed to book a bedspace.",
                "booking-blocked"
            );
        }

        if (existingBookingSnap.exists) {
            const existing = existingBookingSnap.data() || {};
            if (existing.userId === userId && ["pending", "approved"].includes(normalizeText(existing.status))) {
                return;
            }

            if (!(existing.userId === userId && normalizeText(existing.status) === "rejected")) {
                throw new HttpError(409, "This booking reference is already used.", "already-exists");
            }

            detachedDocuments = getDetachedBookingDocuments(existing.documents || [], bookingData.documents || []);
        }

        activeBookingSnap.forEach((doc) => {
            const activeBooking = doc.data() || {};
            if (doc.id !== safeReferenceId && ["pending", "approved", BOOKING_STATUS_APPROVED_PENDING_DOWN_PAYMENT].includes(normalizeText(activeBooking.status))) {
                throw new HttpError(409, "You already have a pending or approved monthly booking request.", "already-exists");
            }
        });

        transientSnap.forEach((doc) => {
            const transient = doc.data() || {};
            if (activeTransientStatus(normalizeText(transient.status))) {
                throw new HttpError(409, "You already have an active Transient Bed request.", "already-exists");
            }
        });

        if (!roomSnap.exists) {
            throw new HttpError(404, "Selected bedspace was not found.", "not-found");
        }

        const roomData = roomSnap.data() || {};
        const roomStatus = normalizeText(roomData.avail || "Available");
        if (roomStatus !== "available" || isMaintenanceStatus(roomData.avail) || isMaintenanceStatus(roomData.occupant)) {
            throw new HttpError(409, "Selected bedspace is no longer available.", "bed-unavailable");
        }

        const roomType = normalizeText(roomData.type);
        if (roomType && roomType !== safeType) {
            throw new HttpError(409, "Selected bedspace does not match the requested room type.", "bed-unavailable");
        }

        const profileGender = normalizeText(profile.gender);
        const roomGender = normalizeText(roomData.gender);
        if (roomGender && roomGender !== "mixed" && profileGender && profileGender !== "mixed" && roomGender !== profileGender) {
            throw new HttpError(409, "Selected bedspace does not match your profile gender.", "bed-unavailable");
        }

        transaction.set(bookingRef, {
            ...bookingData,
            email: user.email || profile.email || "",
            gender: profile.gender || payload.gender || "Not specified",
            createdAt: existingBookingSnap.exists
                ? existingBookingSnap.data().createdAt || admin.firestore.FieldValue.serverTimestamp()
                : admin.firestore.FieldValue.serverTimestamp(),
            resubmittedAt: existingBookingSnap.exists
                ? admin.firestore.FieldValue.serverTimestamp()
                : null,
            rejectionReason: "",
            rejectedAt: null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
    });

    await deleteBookingStorageFiles(detachedDocuments);

    return {
        success: true,
        id: safeReferenceId,
        referenceId: safeReferenceId
    };
}

async function createRenewalRequest(user, payload = {}) {
    const userId = user?.uid;
    if (!userId) {
        throw new HttpError(401, "Authentication is required.", "unauthenticated");
    }

    const safeBookingRequestId = requireString(payload.bookingRequestId, "Missing booking request ID.");
    const sourceRef = db.collection("bookingRequest").doc(safeBookingRequestId);
    let renewalId = "";

    await db.runTransaction(async (transaction) => {
        const sourceSnap = await transaction.get(sourceRef);
        const userSnap = await transaction.get(db.collection("users").doc(userId));

        if (!sourceSnap.exists) {
            throw new HttpError(404, "Approved booking was not found.", "not-found");
        }

        const source = sourceSnap.data() || {};
        if (source.userId !== userId || normalizeText(source.status) !== "approved") {
            throw new HttpError(403, "Only your approved booking can be renewed.", "permission-denied");
        }

        if (userSnap.exists && userSnap.data()?.bookingBlocked === true) {
            throw new HttpError(403, "Your account is no longer allowed to renew this bedspace.", "booking-blocked");
        }

        const userData = userSnap.data() || {};
        if (isAccountBillingRestricted(userData, source)) {
            throw new HttpError(403, getBillingRestrictionMessage(userData, source), "billing-restricted");
        }

        const contractEnd = getDateOnlyFromValue(source.contractEndAt) || getDateOnlyFromValue(source.contractEndDate);
        if (!contractEnd) {
            throw new HttpError(412, "This booking is missing a contract end date.", "failed-precondition");
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const daysUntilEnd = Math.ceil((contractEnd - today) / (1000 * 60 * 60 * 24));
        if (daysUntilEnd > 30) {
            throw new HttpError(412, "Renewal is available when your contract is within 30 days of ending.", "failed-precondition");
        }

        const existingRenewalSnap = await transaction.get(
            db.collection("bookingRequest")
                .where("userId", "==", userId)
                .where("renewalOfBookingId", "==", safeBookingRequestId)
        );

        existingRenewalSnap.forEach((doc) => {
            const renewal = doc.data() || {};
            if (["pending", "approved"].includes(normalizeText(renewal.status))) {
                throw new HttpError(409, "You already have a pending or approved renewal request for this contract.", "already-exists");
            }
        });

        const roomType = normalizeText(source.contractType || source.type);
        const contract = getContractForRequest(roomType, payload);
        const nextStart = new Date(contractEnd);
        nextStart.setDate(nextStart.getDate() + 1);
        const moveInDate = formatDateOnly(nextStart);
        renewalId = `${source.referenceId || sourceSnap.id}-REN-${Date.now()}`;
        const renewalRef = db.collection("bookingRequest").doc(renewalId);

        transaction.set(renewalRef, {
            ...source,
            referenceId: renewalId,
            originalReferenceId: source.referenceId || sourceSnap.id,
            renewalOfBookingId: sourceSnap.id,
            renewalOfReferenceId: source.referenceId || sourceSnap.id,
            requestType: "renewal",
            isRenewal: true,
            status: "pending",
            contractType: contract.contractType,
            contractTerm: contract.contractTerm,
            contractLabel: contract.contractLabel,
            contractMonths: contract.contractMonths,
            monthlyRate: contract.monthlyRate,
            leasePrice: contract.leasePrice,
            moveInDate,
            moveInTime: source.moveInTime || "08:00",
            contractStatus: "pending_renewal",
            contractStartDate: null,
            contractEndDate: null,
            contractStartAt: null,
            contractEndAt: null,
            contractAlertStatus: null,
            expirationAlertSent: false,
            expirationAlertSentAt: null,
            billingScheduleCreated: false,
            billingInvoiceCount: 0,
            rejectionReason: "",
            rejectedAt: null,
            cancellationReason: "",
            cancelledAt: null,
            identityVerificationStatus: "verified",
            identityVerificationNote: "Reused verified identity from previous approved booking.",
            identityVerificationReviewedAt: admin.firestore.FieldValue.serverTimestamp(),
            identityVerificationReviewedBy: "system-renewal",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
    });

    await sendTenantMessage(userId, {
        text: "Your renewal request was sent to the admin team for review. You can continue using your current profile while waiting for approval.",
        systemType: "renewal_requested",
        bookingRequestId: renewalId
    });

    return {
        success: true,
        id: renewalId,
        referenceId: renewalId,
        status: "pending"
    };
}

async function cancelTenantBooking(user, { bookingRequestId, cancellationReason }) {
    const userId = user.uid;
    const safeBookingRequestId = String(bookingRequestId || "").trim();
    const safeReason = String(cancellationReason || "").trim();
    const bookingPreviewSnap = safeBookingRequestId
        ? await db.collection("bookingRequest").doc(safeBookingRequestId).get()
        : null;
    const bookingPreview = bookingPreviewSnap?.exists ? bookingPreviewSnap.data() : null;
    const paidDownPayment = await hasPaidDownPaymentForBooking(
        userId,
        safeBookingRequestId,
        bookingPreview?.referenceId || ""
    );
    const hasOutstandingBilling = await hasOutstandingBillingForBooking(
        userId,
        safeBookingRequestId,
        bookingPreview?.referenceId || ""
    );
    let bookingData = null;
    let statusBeforeCancellation = "";
    let finalAction = "cancelled";

    if (!safeBookingRequestId) {
        throw new HttpError(400, "Missing booking request ID.", "invalid-argument");
    }

    if (!safeReason) {
        throw new HttpError(400, "Please provide a cancellation reason.", "invalid-argument");
    }

    if (safeReason.length > 260) {
        throw new HttpError(400, "Cancellation reason is too long.", "invalid-argument");
    }

    const bookingRef = db.collection("bookingRequest").doc(safeBookingRequestId);
    const userRef = db.collection("users").doc(userId);

    await db.runTransaction(async (transaction) => {
        const bookingSnap = await transaction.get(bookingRef);
        if (!bookingSnap.exists) {
            throw new HttpError(404, "Booking request not found.", "not-found");
        }

        bookingData = bookingSnap.data();
        if (bookingData.userId !== userId) {
            throw new HttpError(403, "You do not have access to this booking request.", "permission-denied");
        }

        if (!["pending", "approved", BOOKING_STATUS_APPROVED_PENDING_DOWN_PAYMENT].includes(bookingData.status)) {
            throw new HttpError(412, "Only pending or approved booking requests can be cancelled.", "failed-precondition");
        }

        statusBeforeCancellation = normalizeText(bookingData.status);
        const userSnap = await transaction.get(userRef);
        const userData = userSnap.exists ? (userSnap.data() || {}) : {};
        const shouldTreatAsActiveApprovedBooking = statusBeforeCancellation === "approved"
            || (
                statusBeforeCancellation === BOOKING_STATUS_APPROVED_PENDING_DOWN_PAYMENT
                && (
                    paidDownPayment
                    || Boolean(bookingData.downPaymentSettledAt)
                    || normalizeText(bookingData.reservationStatus) === "activated"
                    || normalizeText(userData.status) === "approved"
                    || normalizeText(userData.contractStatus) === "active"
                )
            );

        if (shouldTreatAsActiveApprovedBooking) {
            const fullName = getFullName(bookingData) || bookingData.email || "Tenant";
            if (bookingData.tenantCancellationRequested === true) {
                throw new HttpError(412, "Your cancellation request for this approved booking is already pending admin review.", "failed-precondition");
            }
            if (isAccountBillingRestricted(userData, bookingData) || hasOutstandingBilling) {
                throw new HttpError(412, "Please settle your outstanding billing before requesting cancellation of this active booking.", "failed-precondition");
            }

            transaction.update(bookingRef, {
                status: "approved",
                reservationStatus: "activated",
                reservationExpiresAt: null,
                downPaymentSettledAt: bookingData.downPaymentSettledAt || admin.firestore.FieldValue.serverTimestamp(),
                tenantCancellationRequested: true,
                tenantCancellationRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
                tenantCancellationReason: safeReason,
                tenantCancellationRequestStatus: "pending_review",
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            if (bookingData.userId) {
                transaction.set(userRef, {
                    status: "approved",
                    room: bookingData.room ? `Room ${bookingData.room}` : "",
                    contractStatus: "active"
                }, { merge: true });
            }

            if (bookingData.room && bookingData.bed) {
                transaction.set(db.collection("ROOMS").doc(`${bookingData.room}_${bookingData.bed}`), {
                    avail: "Occupied",
                    occupant: fullName,
                    reservationType: null,
                    reservedForBookingId: null,
                    reservedForUserId: null,
                    reservedUntil: null,
                    reservationOccupant: null
                }, { merge: true });
            }
            finalAction = "cancel_requested";
            return;
        }

        let roomRef = null;
        let roomSnap = null;

        if (isApprovedOrReservedBookingStatus(bookingData.status) && bookingData.room && bookingData.bed) {
            roomRef = db.collection("ROOMS").doc(`${bookingData.room}_${bookingData.bed}`);
            roomSnap = await transaction.get(roomRef);
        }

        transaction.update(bookingRef, {
            status: "cancelled",
            cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
            cancelledBy: "tenant",
            cancellationReason: safeReason,
            tenantCancellationRequested: false,
            tenantCancellationRequestStatus: null,
            tenantCancellationRequestedAt: null,
            tenantCancellationReason: null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        if (userSnap.exists) {
            transaction.set(userRef, {
                room: "",
                status: "registered",
                contractStatus: ""
            }, { merge: true });
        }

        if (roomRef && roomSnap?.exists) {
            const roomData = roomSnap.data() || {};
            const canReleaseReservation = roomData.reservedForBookingId === safeBookingRequestId
                || roomData.reservedForUserId === userId
                || (!roomData.reservedForBookingId && !roomData.reservedForUserId);
            if (!canReleaseReservation) {
                return;
            }

            transaction.set(roomRef, {
                avail: "Available",
                occupant: "",
                reservationType: null,
                reservedForBookingId: null,
                reservedForUserId: null,
                reservedUntil: null,
                reservationOccupant: null
            }, { merge: true });
        }
    });

    if (finalAction === "cancel_requested") {
        await sendTenantMessage(userId, {
            text: "Your request to cancel your active CitiHub booking was sent to management for review. CitiHub will settle any remaining booking obligations before final cancellation.",
            systemType: "booking_cancellation_requested",
            bookingRequestId: safeBookingRequestId
        });

        await db.collection("adminHistory").add({
            adminUid: userId,
            adminName: "Tenant Self-Service",
            adminEmail: user.email || "",
            action: "tenant_requested_booking_cancellation",
            module: "bookings",
            targetId: safeBookingRequestId,
            targetName: user.email || "Tenant Booking",
            details: `Tenant requested cancellation of an approved booking. Reason: ${safeReason}`,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return {
            success: true,
            status: BOOKING_STATUS_TENANT_CANCEL_REQUESTED,
            message: "Your cancellation request was sent to CitiHub management for review."
        };
    }

    await cancelPendingPaymentsForBooking(safeBookingRequestId, userId);
    if (statusBeforeCancellation === BOOKING_STATUS_APPROVED_PENDING_DOWN_PAYMENT) {
        await Promise.all([
            cancelAddonSubscriptionsForBooking(safeBookingRequestId, userId),
            deleteBillingInvoicesForBooking(safeBookingRequestId)
        ]);
    }

    await db.collection("adminHistory").add({
        adminUid: userId,
        adminName: "Tenant Self-Service",
        adminEmail: user.email || "",
        action: "tenant_cancelled_booking",
        module: "bookings",
        targetId: safeBookingRequestId,
        targetName: user.email || "Tenant Booking",
        details: `Tenant cancelled their own booking request. Reason: ${safeReason}`,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
        success: true,
        status: "cancelled",
        message: statusBeforeCancellation === BOOKING_STATUS_APPROVED_PENDING_DOWN_PAYMENT
            ? "Your reserved booking has been cancelled and the bedspace has been released."
            : "Your booking request has been cancelled."
    };
}

async function approveBookingAsAdmin(adminUser, adminProfile, {
    bookingRequestId,
    identityVerificationStatus,
    identityVerificationNote
}) {
    const safeBookingRequestId = requireString(bookingRequestId, "Missing booking request ID.");
    const safeIdentityStatus = String(identityVerificationStatus || "pending_review").trim();
    const safeIdentityNote = String(identityVerificationNote || "").trim();

    if (safeIdentityStatus !== "verified") {
        throw new HttpError(400, "Mark the identity review as Verified before approving this booking.", "invalid-argument");
    }

    const bookingRef = db.collection("bookingRequest").doc(safeBookingRequestId);
    let bookingData = null;
    let fullName = "";
    let contractFields = null;

    await db.runTransaction(async (transaction) => {
        const bookingSnap = await transaction.get(bookingRef);
        if (!bookingSnap.exists) {
            throw new HttpError(404, "Booking request not found.", "not-found");
        }

        bookingData = bookingSnap.data();
        if (bookingData.status !== "pending") {
            throw new HttpError(412, "Only pending booking requests can be approved.", "failed-precondition");
        }

        if (!hasSelfieWithIdDocument(bookingData.documents || [])) {
            throw new HttpError(412, "A selfie holding ID must be uploaded before this booking can be approved.", "failed-precondition");
        }

        fullName = getFullName(bookingData);
        const roomDocId = `${bookingData.room}_${bookingData.bed}`;
        const roomRef = db.collection("ROOMS").doc(roomDocId);
        const roomSnap = await transaction.get(roomRef);
        if (!roomSnap.exists) {
            throw new HttpError(404, `Room document not found: ${roomDocId}`, "not-found");
        }

        const roomData = roomSnap.data();
        if (String(roomData.avail || "").toLowerCase() === "maintenance") {
            throw new HttpError(412, "This bedspace is currently under maintenance.", "failed-precondition");
        }

        if (roomData.avail === "Occupied" && roomData.occupant && roomData.occupant !== fullName) {
            throw new HttpError(412, "This bedspace is already occupied.", "failed-precondition");
        }

        await assertNoTransientConflictForMonthly(transaction, bookingData);
        contractFields = buildApprovedContractFields(bookingData);
        const addonStartMonth = getInitialAddonBillingMonth(contractFields.contractStartDate);
        const requestedAddons = sanitizeRequestedAddons(bookingData.requestedAddons);
        const reservationExpiry = new Date();
        reservationExpiry.setHours(reservationExpiry.getHours() + RESERVATION_PAYMENT_WINDOW_HOURS);

        transaction.update(bookingRef, {
            status: BOOKING_STATUS_APPROVED_PENDING_DOWN_PAYMENT,
            ...contractFields,
            requestedAddons,
            approvedAt: admin.firestore.FieldValue.serverTimestamp(),
            downPaymentDueAt: admin.firestore.Timestamp.fromDate(reservationExpiry),
            reservationStatus: "pending_down_payment",
            reservationExpiresAt: admin.firestore.Timestamp.fromDate(reservationExpiry),
            identityVerificationStatus: safeIdentityStatus,
            identityVerificationNote: safeIdentityNote,
            identityVerificationReviewedAt: admin.firestore.FieldValue.serverTimestamp(),
            identityVerificationReviewedBy: adminUser.email || adminUser.uid,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        if (bookingData.userId) {
            transaction.set(db.collection("users").doc(bookingData.userId), {
                status: BOOKING_STATUS_APPROVED_PENDING_DOWN_PAYMENT,
                fullName,
                phone: bookingData.phone || "",
                address: bookingData.address || "",
                room: "",
                contractType: bookingData.contractType || bookingData.type || "",
                contractTerm: bookingData.contractTerm || "",
                contractLabel: bookingData.contractLabel || "",
                contractStartDate: contractFields.contractStartDate,
                contractEndDate: contractFields.contractEndDate,
                contractStartAt: contractFields.contractStartAt,
                contractEndAt: contractFields.contractEndAt,
                contractMonths: contractFields.contractMonths,
                monthlyRate: contractFields.monthlyRate,
                billingDueDay: contractFields.billingDueDay,
                billingDueRule: contractFields.billingDueRule,
                contractStatus: "pending_down_payment"
            }, { merge: true });

            requestedAddons.forEach((addon) => {
                transaction.set(db.collection("userAddons").doc(`${safeBookingRequestId}_${addon.addonId}`), {
                    userId: bookingData.userId,
                    bookingRequestId: safeBookingRequestId,
                    bookingReferenceId: bookingData.referenceId || safeBookingRequestId,
                    addonId: addon.addonId,
                    addonName: addon.addonName,
                    price: Number(addon.price || 0),
                    billingType: addon.billingType || "monthly",
                    description: addon.description || "",
                    status: "active",
                    effectiveStartMonth: addonStartMonth,
                    effectiveEndMonth: null,
                    source: "booking_request",
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    cancelledAt: null
                }, { merge: true });
            });
        }

        transaction.update(roomRef, {
            avail: "Reserved",
            occupant: "",
            reservationType: "monthly_pending_down_payment",
            reservedForBookingId: safeBookingRequestId,
            reservedForUserId: bookingData.userId || "",
            reservedUntil: admin.firestore.Timestamp.fromDate(reservationExpiry),
            reservationOccupant: fullName
        });
    });

    let renewalInvoicesCreated = null;
    if (bookingData?.isRenewal && bookingData?.userId) {
        try {
            renewalInvoicesCreated = await ensureBillingInvoicesForBooking(bookingData.userId, safeBookingRequestId, "");
        } catch (error) {
            console.error("Renewal invoice creation failed:", error);
        }
    }

    let emailSent = true;
    try {
        await sendBookingApprovedEmail(bookingData);
    } catch (error) {
        emailSent = false;
        console.error("Booking approval email failed:", error);
    }
    await writeAdminHistory(adminUser, adminProfile, {
        action: "approved_booking",
        module: "bookings",
        targetId: safeBookingRequestId,
        targetName: fullName,
        details: `Approved booking for Room ${bookingData.room}, Bed ${bookingData.bed}.`
    });

    return { success: true, status: BOOKING_STATUS_APPROVED_PENDING_DOWN_PAYMENT, emailSent, renewalInvoicesCreated };
}

async function rejectBookingAsAdmin(adminUser, adminProfile, {
    bookingRequestId,
    rejectionReason,
    identityVerificationStatus,
    identityVerificationNote
}) {
    const safeBookingRequestId = requireString(bookingRequestId, "Missing booking request ID.");
    const safeReason = requireString(rejectionReason, "Please enter a rejection reason before rejecting this request.");
    const bookingRef = db.collection("bookingRequest").doc(safeBookingRequestId);
    const bookingSnap = await bookingRef.get();

    if (!bookingSnap.exists) {
        throw new HttpError(404, "Booking request not found.", "not-found");
    }

    const bookingData = bookingSnap.data();
    if (bookingData.status !== "pending") {
        throw new HttpError(412, "Only pending booking requests can be rejected.", "failed-precondition");
    }

    await bookingRef.update({
        status: "rejected",
        rejectionReason: safeReason,
        identityVerificationStatus: String(identityVerificationStatus || "pending_review").trim(),
        identityVerificationNote: String(identityVerificationNote || "").trim(),
        identityVerificationReviewedAt: admin.firestore.FieldValue.serverTimestamp(),
        identityVerificationReviewedBy: adminUser.email || adminUser.uid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const emailData = { ...bookingData, rejectionReason: safeReason };
    let emailSent = true;
    try {
        await sendBookingRejectedEmail(emailData);
    } catch (error) {
        emailSent = false;
        console.error("Booking rejection email failed:", error);
    }
    await writeAdminHistory(adminUser, adminProfile, {
        action: "rejected_booking",
        module: "bookings",
        targetId: safeBookingRequestId,
        targetName: getFullName(bookingData) || "Booking Request",
        details: `Rejected a booking request. Reason: ${safeReason}`
    });

    return { success: true, status: "rejected", emailSent };
}

async function cancelApprovedBookingAsAdmin(adminUser, adminProfile, {
    bookingRequestId,
    cancellationReason,
    blockFutureBooking
}) {
    const safeBookingRequestId = requireString(bookingRequestId, "Missing booking request ID.");
    const safeReason = requireString(cancellationReason, "Please enter a cancellation reason before terminating this booking.");
    const shouldBlock = Boolean(blockFutureBooking);
    const bookingRef = db.collection("bookingRequest").doc(safeBookingRequestId);
    let bookingData = null;
    let tenantName = "Tenant";

    await db.runTransaction(async (transaction) => {
        const bookingSnap = await transaction.get(bookingRef);
        if (!bookingSnap.exists) {
            throw new HttpError(404, "Booking request not found.", "not-found");
        }

        bookingData = bookingSnap.data();
        if (!isApprovedOrReservedBookingStatus(bookingData.status)) {
            throw new HttpError(412, "Only approved or reserved bookings can be cancelled from this action.", "failed-precondition");
        }

        tenantName = getFullName(bookingData) || bookingData.email || "Tenant";
        transaction.update(bookingRef, {
            status: "cancelled",
            cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
            cancelledBy: "admin",
            cancellationReason: safeReason,
            tenantCancellationRequested: false,
            tenantCancellationRequestStatus: null,
            tenantCancellationRequestedAt: null,
            tenantCancellationReason: null,
            bookingBlocked: shouldBlock,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        if (bookingData.userId) {
            const userUpdate = {
                status: "registered",
                room: "",
                contractStatus: ""
            };

            if (shouldBlock) {
                userUpdate.bookingBlocked = true;
                userUpdate.bookingBlockedReason = safeReason;
                userUpdate.bookingBlockedBy = adminUser.email || adminUser.uid;
                userUpdate.bookingBlockedAt = admin.firestore.FieldValue.serverTimestamp();
            }

            transaction.set(db.collection("users").doc(bookingData.userId), userUpdate, { merge: true });
        }

        if (bookingData.room && bookingData.bed) {
            transaction.set(db.collection("ROOMS").doc(`${bookingData.room}_${bookingData.bed}`), {
                avail: "Available",
                occupant: "",
                reservationType: null,
                reservedForBookingId: null,
                reservedForUserId: null,
                reservedUntil: null,
                reservationOccupant: null
            }, { merge: true });
        }
    });

    await cancelPendingPaymentsForBooking(safeBookingRequestId, bookingData.userId || "");
    const roomLabel = bookingData.room && bookingData.bed
        ? `Room ${bookingData.room}, Bed ${bookingData.bed}`
        : "your approved booking";
    const message = `Your approved CitiHub booking for ${roomLabel} has been cancelled by management. Reason: ${safeReason}${shouldBlock ? " Future bedspace booking has also been disabled for this account." : ""}`;
    await sendTenantMessage(bookingData.userId, {
        text: message,
        systemType: "booking_cancelled",
        bookingRequestId: safeBookingRequestId
    });
    await writeAdminHistory(adminUser, adminProfile, {
        action: "cancelled_approved_booking",
        module: "bookings",
        targetId: safeBookingRequestId,
        targetName: tenantName,
        details: `Cancelled approved booking for Room ${bookingData.room || "N/A"}, Bed ${bookingData.bed || "N/A"}. Reason: ${safeReason}${shouldBlock ? " Future booking blocked." : ""}`
    });

    return { success: true, status: "cancelled", bookingBlocked: shouldBlock };
}

async function deleteBookingAsAdmin(adminUser, adminProfile, { bookingRequestId, deleteBillingInvoices = false }) {
    const safeBookingRequestId = requireString(bookingRequestId, "Missing booking request ID.");
    const bookingRef = db.collection("bookingRequest").doc(safeBookingRequestId);
    const bookingSnap = await bookingRef.get();

    if (!bookingSnap.exists) {
        throw new HttpError(404, "Booking request not found.", "not-found");
    }

    const bookingData = bookingSnap.data();
    const normalizedStatus = String(bookingData.status || "").toLowerCase();
    if (!["rejected", "cancelled"].includes(normalizedStatus)) {
        throw new HttpError(412, "Only rejected or cancelled booking requests can be deleted permanently.", "failed-precondition");
    }

    await deleteBookingStorageFiles(bookingData.documents || []);
    const deletedBillingInvoices = deleteBillingInvoices
        ? await deleteBillingInvoicesForBooking(safeBookingRequestId)
        : 0;
    await bookingRef.delete();

    await writeAdminHistory(adminUser, adminProfile, {
        action: "deleted_booking_permanently",
        module: "bookings",
        targetId: safeBookingRequestId,
        targetName: getFullName(bookingData) || "Booking Request",
        details: `Permanently deleted a ${normalizedStatus} booking request and its uploaded documents.${deletedBillingInvoices ? ` Deleted ${deletedBillingInvoices} related billing invoice(s).` : ""}`
    });

    return { success: true, deleted: true, deletedBillingInvoices };
}

module.exports = {
    approveBookingAsAdmin,
    cancelApprovedBookingAsAdmin,
    cancelTenantBooking,
    createBookingRequest,
    createRenewalRequest,
    deleteBookingAsAdmin,
    rejectBookingAsAdmin,
    getBookingRequestForEmail
};
