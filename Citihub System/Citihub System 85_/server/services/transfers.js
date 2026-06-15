const { admin, db } = require("../firebaseAdmin");
const { HttpError } = require("../utils/errors");

const TRANSFER_FEE = 200;
const UPGRADE_BASE_FEE = 1000;
const TRANSFER_PAYMENT_WINDOW_HOURS = 48;
const ROOM_TYPE_RANK = {
    standard: 1,
    premium: 2
};
const CONTRACT_RATES = {
    standard: {
        "1_5_months": 3600,
        "6_11_months": 2893,
        "1_year": 1900
    },
    premium: {
        "1_5_months": 5075,
        "6_11_months": 4095,
        "1_year": 2500
    }
};

function requireText(value, message) {
    const safeValue = String(value || "").trim();
    if (!safeValue) {
        throw new HttpError(400, message, "invalid-argument");
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

function getBillingRestrictionMessage(userData = {}, bookingData = {}) {
    if (userData.manualBillingHold === true || bookingData.manualBillingHold === true) {
        return "This account is currently on billing hold and cannot request a room transfer until the hold is removed.";
    }

    return "This account has overdue billing and cannot request a room transfer until the outstanding balance is settled.";
}

function getAdminName(adminUser, adminProfile) {
    return adminProfile?.username || adminProfile?.fullName || adminUser.email || "Admin";
}

function getTenantName(user, profile, booking = {}) {
    const fullName = [booking.firstName, booking.lastName].filter(Boolean).join(" ").trim();
    return fullName || profile?.fullName || profile?.username || user?.email || "Tenant";
}

function getTransferPaymentDueDate() {
    const dueDate = new Date();
    dueDate.setHours(dueDate.getHours() + TRANSFER_PAYMENT_WINDOW_HOURS);
    return dueDate;
}

function getTransferTimestampDate(value) {
    if (!value) {
        return null;
    }

    if (typeof value.toDate === "function") {
        return value.toDate();
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isTransferPaymentExpired(transfer = {}) {
    if (normalizeText(transfer.status) !== "approved_pending_payment") {
        return false;
    }

    const dueDate = getTransferTimestampDate(transfer.paymentDueAt);
    return Boolean(dueDate && dueDate.getTime() <= Date.now() && normalizeText(transfer.paymentStatus) !== "paid");
}

async function expireTransferRequest(ref, transfer = {}) {
    await ref.update({
        status: "expired",
        expiredAt: admin.firestore.FieldValue.serverTimestamp(),
        expirationReason: `Transfer fee was not paid within ${TRANSFER_PAYMENT_WINDOW_HOURS} hours.`,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
}

async function expireOverdueTransferRequestsForUser(userId) {
    if (!userId) {
        return;
    }

    const snapshot = await db.collection("transferRequests")
        .where("userId", "==", userId)
        .where("status", "==", "approved_pending_payment")
        .get();

    await Promise.all(
        snapshot.docs
            .filter((doc) => isTransferPaymentExpired(doc.data() || {}))
            .map((doc) => expireTransferRequest(doc.ref, doc.data() || {}))
    );
}

async function expireAllOverdueTransferRequests() {
    const snapshot = await db.collection("transferRequests")
        .where("status", "==", "approved_pending_payment")
        .get();

    await Promise.all(
        snapshot.docs
            .filter((doc) => isTransferPaymentExpired(doc.data() || {}))
            .map((doc) => expireTransferRequest(doc.ref, doc.data() || {}))
    );
}

function formatLeasePrice(amount) {
    return new Intl.NumberFormat("en-PH", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    }).format(Number(amount || 0));
}

function getTargetMonthlyRate(targetType, booking) {
    const term = String(booking.contractTerm || "").trim();
    return CONTRACT_RATES[targetType]?.[term] || Number(booking.monthlyRate || 0);
}

function calculateTransferFee(currentType, targetType, booking) {
    if (!ROOM_TYPE_RANK[currentType] || !ROOM_TYPE_RANK[targetType]) {
        throw new HttpError(400, "Room type must be standard or premium.", "invalid-argument");
    }

    if (ROOM_TYPE_RANK[targetType] < ROOM_TYPE_RANK[currentType]) {
        throw new HttpError(412, "Downgrades are not permitted.", "failed-precondition");
    }

    if (currentType === targetType) {
        return {
            transferKind: "same_type",
            baseFee: TRANSFER_FEE,
            rateDifference: 0,
            feeAmount: TRANSFER_FEE,
            targetMonthlyRate: Number(booking.monthlyRate || 0)
        };
    }

    const currentRate = Number(booking.monthlyRate || 0);
    const targetMonthlyRate = getTargetMonthlyRate(targetType, booking);
    const rateDifference = Math.max(0, targetMonthlyRate - currentRate);

    return {
        transferKind: "upgrade",
        baseFee: UPGRADE_BASE_FEE,
        rateDifference,
        feeAmount: UPGRADE_BASE_FEE + rateDifference,
        targetMonthlyRate
    };
}

async function writeAdminHistory(adminUser, adminProfile, { action, targetId, targetName, details }) {
    await db.collection("adminHistory").add({
        adminUid: adminUser.uid,
        adminName: getAdminName(adminUser, adminProfile),
        adminEmail: adminUser.email || "",
        action,
        module: "room_transfer",
        targetId,
        targetName,
        details,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
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

async function sendTenantMessage(userId, { text, systemType, transferRequestId }) {
    if (!userId) return;

    const userRef = db.collection("users").doc(userId);
    await userRef.collection("messages").add({
        text,
        senderType: "admin",
        senderName: "CitiHub Management",
        systemType,
        transferRequestId,
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

async function getLatestApprovedBooking(userId) {
    const snapshot = await db.collection("bookingRequest")
        .where("userId", "==", userId)
        .where("status", "==", "approved")
        .get();

    if (snapshot.empty) {
        throw new HttpError(412, "Only approved tenants can request a room transfer.", "failed-precondition");
    }

    const doc = snapshot.docs.slice().sort((left, right) => {
        const leftDate = left.data().createdAt?.toDate?.() || new Date(0);
        const rightDate = right.data().createdAt?.toDate?.() || new Date(0);
        return rightDate - leftDate;
    })[0];

    return {
        id: doc.id,
        ref: doc.ref,
        data: doc.data()
    };
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

async function assertDownPaymentPaid(userId, bookingRequestId, bookingReferenceId) {
    const downPayment = await getExistingDownPayment(userId, bookingRequestId, bookingReferenceId);

    if (!downPayment || downPayment.data.status !== "paid") {
        throw new HttpError(412, "Please complete your down payment before requesting a room transfer.", "failed-precondition");
    }
}

async function assertNoExistingTransfer(userId) {
    await expireOverdueTransferRequestsForUser(userId);

    const snapshot = await db.collection("transferRequests")
        .where("userId", "==", userId)
        .get();

    const existing = snapshot.docs.find((doc) => !["rejected", "expired"].includes(normalizeText(doc.data()?.status)));
    if (existing) {
        throw new HttpError(409, "You already have a transfer request. Please wait for management to finish it before requesting another.", "already-exists");
    }
}

function validateTargetBed(targetRoomSnap, { targetRoom, targetBed, targetType, profileGender }) {
    if (!targetRoomSnap.exists) {
        throw new HttpError(404, "Selected target bedspace was not found.", "not-found");
    }

    const target = targetRoomSnap.data() || {};
    const roomType = normalizeText(target.type);
    const roomGender = normalizeText(target.gender);
    const roomStatus = normalizeText(target.avail || "available");

    if (roomType !== targetType) {
        throw new HttpError(412, "Selected target bedspace does not match the selected room type.", "failed-precondition");
    }

    if (roomStatus !== "available") {
        throw new HttpError(409, `Room ${targetRoom}, Bed ${targetBed} is not available.`, "bed-unavailable");
    }

    if (roomGender && roomGender !== "mixed" && profileGender && profileGender !== "mixed" && roomGender !== profileGender) {
        throw new HttpError(403, "Selected target bedspace does not match your profile gender.", "permission-denied");
    }
}

async function createTransferRequest(user, payload = {}) {
    const userId = user.uid;
    const targetRoom = requireText(payload.targetRoom, "Target room is required.");
    const targetBed = requireText(payload.targetBed, "Target bedspace is required.");
    const targetType = requireText(payload.targetType, "Target room type is required.").toLowerCase();
    const reason = String(payload.reason || "").trim();

    await assertNoExistingTransfer(userId);

    const [profileSnap, approvedBooking] = await Promise.all([
        db.collection("users").doc(userId).get(),
        getLatestApprovedBooking(userId)
    ]);
    const profile = profileSnap.exists ? profileSnap.data() : {};
    const booking = approvedBooking.data;

    if (isAccountBillingRestricted(profile, booking)) {
        throw new HttpError(403, getBillingRestrictionMessage(profile, booking), "billing-restricted");
    }

    await assertDownPaymentPaid(userId, approvedBooking.id, booking.referenceId || approvedBooking.id);

    const currentRoom = requireText(booking.room, "Current room is missing from your approved booking.");
    const currentBed = requireText(booking.bed, "Current bed is missing from your approved booking.");
    const currentType = requireText(booking.type || booking.contractType, "Current room type is missing from your approved booking.").toLowerCase();

    if (currentRoom === targetRoom && String(currentBed) === String(targetBed)) {
        throw new HttpError(400, "Please choose a different bedspace for transfer.", "invalid-argument");
    }

    const targetRoomSnap = await db.collection("ROOMS").doc(`${targetRoom}_${targetBed}`).get();
    validateTargetBed(targetRoomSnap, {
        targetRoom,
        targetBed,
        targetType,
        profileGender: normalizeText(profile.gender || booking.gender)
    });

    const fee = calculateTransferFee(currentType, targetType, booking);
    const tenantName = getTenantName(user, profile, booking);
    const transferRef = db.collection("transferRequests").doc();

    await transferRef.set({
        userId,
        tenantName,
        tenantEmail: user.email || profile.email || booking.email || "",
        bookingRequestId: approvedBooking.id,
        bookingReferenceId: booking.referenceId || approvedBooking.id,
        currentRoom,
        currentBed,
        currentType,
        targetRoom,
        targetBed,
        targetType,
        contractTerm: booking.contractTerm || "",
        contractLabel: booking.contractLabel || "",
        currentMonthlyRate: Number(booking.monthlyRate || 0),
        targetMonthlyRate: Number(fee.targetMonthlyRate || 0),
        transferKind: fee.transferKind,
        baseFee: fee.baseFee,
        rateDifference: fee.rateDifference,
        feeAmount: fee.feeAmount,
        currency: "PHP",
        reason,
        adminNote: "",
        paymentStatus: "unpaid",
        paymentId: "",
        status: "pending_admin",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
        success: true,
        transferRequestId: transferRef.id,
        status: "pending_admin",
        feeAmount: fee.feeAmount,
        transferKind: fee.transferKind
    };
}

async function listMyTransferRequests(user) {
    await expireOverdueTransferRequestsForUser(user.uid);

    const snapshot = await db.collection("transferRequests")
        .where("userId", "==", user.uid)
        .get();

    const transfers = snapshot.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .sort((left, right) => {
            const leftDate = left.createdAt?.toDate?.() || new Date(0);
            const rightDate = right.createdAt?.toDate?.() || new Date(0);
            return rightDate - leftDate;
        });

    return { success: true, transfers };
}

async function listTransferRequestsAsAdmin() {
    await expireAllOverdueTransferRequests();

    const snapshot = await db.collection("transferRequests").get();
    const transfers = snapshot.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .sort((left, right) => {
            const leftDate = left.createdAt?.toDate?.() || new Date(0);
            const rightDate = right.createdAt?.toDate?.() || new Date(0);
            return rightDate - leftDate;
        });

    return { success: true, transfers };
}

async function approveTransferAsAdmin(adminUser, adminProfile, { transferRequestId }) {
    const safeId = requireText(transferRequestId, "Transfer request ID is required.");
    const transferRef = db.collection("transferRequests").doc(safeId);
    const snap = await transferRef.get();

    if (!snap.exists) {
        throw new HttpError(404, "Transfer request was not found.", "not-found");
    }

    const transfer = snap.data();
    if (transfer.status !== "pending_admin") {
        throw new HttpError(412, "Only pending transfer requests can be approved.", "failed-precondition");
    }

    await transferRef.update({
        status: "approved_pending_payment",
        paymentDueAt: admin.firestore.Timestamp.fromDate(getTransferPaymentDueDate()),
        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        approvedBy: adminUser.email || adminUser.uid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await writeAdminHistory(adminUser, adminProfile, {
        action: "approved_transfer_request",
        targetId: safeId,
        targetName: transfer.tenantName || transfer.tenantEmail || "Tenant",
        details: `Approved transfer from Room ${transfer.currentRoom}, Bed ${transfer.currentBed} to Room ${transfer.targetRoom}, Bed ${transfer.targetBed}. Fee: PHP ${transfer.feeAmount}.`
    });

    await sendTenantMessage(transfer.userId, {
        text: `Your room transfer request has been approved. Please pay PHP ${Number(transfer.feeAmount || 0).toLocaleString("en-PH")} within ${TRANSFER_PAYMENT_WINDOW_HOURS} hours or this transfer request will expire.`,
        systemType: "transfer_approved",
        transferRequestId: safeId
    });

    return { success: true, status: "approved_pending_payment" };
}

async function rejectTransferAsAdmin(adminUser, adminProfile, { transferRequestId, adminNote }) {
    const safeId = requireText(transferRequestId, "Transfer request ID is required.");
    const note = requireText(adminNote, "Please provide a rejection reason.");
    const transferRef = db.collection("transferRequests").doc(safeId);
    const snap = await transferRef.get();

    if (!snap.exists) {
        throw new HttpError(404, "Transfer request was not found.", "not-found");
    }

    const transfer = snap.data();
    if (transfer.status !== "pending_admin") {
        throw new HttpError(412, "Only pending transfer requests can be rejected.", "failed-precondition");
    }

    await transferRef.update({
        status: "rejected",
        adminNote: note,
        rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
        rejectedBy: adminUser.email || adminUser.uid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await writeAdminHistory(adminUser, adminProfile, {
        action: "rejected_transfer_request",
        targetId: safeId,
        targetName: transfer.tenantName || transfer.tenantEmail || "Tenant",
        details: `Rejected transfer request. Reason: ${note}`
    });

    await sendTenantMessage(transfer.userId, {
        text: `Your room transfer request was rejected. Reason: ${note}`,
        systemType: "transfer_rejected",
        transferRequestId: safeId
    });

    return { success: true, status: "rejected" };
}

async function deleteTransferAsAdmin(adminUser, adminProfile, { transferRequestId, deleteBillingInvoices = false }) {
    const safeId = requireText(transferRequestId, "Transfer request ID is required.");
    const transferRef = db.collection("transferRequests").doc(safeId);
    const snap = await transferRef.get();

    if (!snap.exists) {
        throw new HttpError(404, "Transfer request was not found.", "not-found");
    }

    const transfer = snap.data() || {};
    if (transfer.status !== "rejected") {
        throw new HttpError(412, "Only rejected transfer requests can be deleted permanently.", "failed-precondition");
    }

    const deletedBillingInvoices = deleteBillingInvoices
        ? await deleteBillingInvoicesForBooking(transfer.bookingRequestId)
        : 0;

    await transferRef.delete();

    await writeAdminHistory(adminUser, adminProfile, {
        action: "deleted_transfer_request_permanently",
        targetId: safeId,
        targetName: transfer.tenantName || transfer.tenantEmail || "Tenant",
        details: `Permanently deleted rejected transfer request from Room ${transfer.currentRoom || "N/A"}, Bed ${transfer.currentBed || "N/A"} to Room ${transfer.targetRoom || "N/A"}, Bed ${transfer.targetBed || "N/A"}.${deletedBillingInvoices ? ` Deleted ${deletedBillingInvoices} related billing invoice(s).` : ""}`
    });

    return { success: true, deleted: true, deletedBillingInvoices };
}

async function getTransferForPayment(userId, transferRequestId) {
    const safeId = requireText(transferRequestId, "Transfer request ID is required.");
    const ref = db.collection("transferRequests").doc(safeId);
    const snap = await ref.get();

    if (!snap.exists) {
        throw new HttpError(404, "Transfer request was not found.", "not-found");
    }

    const transfer = snap.data();
    if (transfer.userId !== userId) {
        throw new HttpError(403, "You do not have access to this transfer request.", "permission-denied");
    }

    if (isTransferPaymentExpired(transfer)) {
        await expireTransferRequest(ref, transfer);
        throw new HttpError(412, `This transfer request expired because the fee was not paid within ${TRANSFER_PAYMENT_WINDOW_HOURS} hours.`, "transfer-expired");
    }

    if (transfer.status !== "approved_pending_payment") {
        throw new HttpError(412, "Transfer fee payment is available only after admin approval.", "failed-precondition");
    }

    if (transfer.paymentStatus === "paid") {
        throw new HttpError(412, "This transfer fee is already paid.", "failed-precondition");
    }

    return { id: safeId, ref, data: transfer };
}

async function markTransferPaidAndComplete(transferRequestId, paymentId) {
    const safeId = requireText(transferRequestId, "Transfer request ID is required.");
    const transferRef = db.collection("transferRequests").doc(safeId);
    let completedTransfer = null;
    let wasAlreadyCompleted = false;

    await db.runTransaction(async (transaction) => {
        const transferSnap = await transaction.get(transferRef);
        if (!transferSnap.exists) {
            throw new HttpError(404, "Transfer request was not found.", "not-found");
        }

        const transfer = transferSnap.data();
        if (transfer.status === "completed") {
            completedTransfer = transfer;
            wasAlreadyCompleted = true;
            return;
        }

        if (isTransferPaymentExpired(transfer)) {
            transaction.update(transferRef, {
                status: "expired",
                expiredAt: admin.firestore.FieldValue.serverTimestamp(),
                expirationReason: `Transfer fee was not paid within ${TRANSFER_PAYMENT_WINDOW_HOURS} hours.`,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            throw new HttpError(412, `This transfer request expired because the fee was not paid within ${TRANSFER_PAYMENT_WINDOW_HOURS} hours.`, "transfer-expired");
        }

        if (transfer.status !== "approved_pending_payment") {
            throw new HttpError(412, "Transfer request is not ready to be completed.", "failed-precondition");
        }

        const oldRoomRef = db.collection("ROOMS").doc(`${transfer.currentRoom}_${transfer.currentBed}`);
        const newRoomRef = db.collection("ROOMS").doc(`${transfer.targetRoom}_${transfer.targetBed}`);
        const bookingRef = db.collection("bookingRequest").doc(transfer.bookingRequestId);
        const userRef = db.collection("users").doc(transfer.userId);
        const [newRoomSnap, bookingSnap] = await Promise.all([
            transaction.get(newRoomRef),
            transaction.get(bookingRef)
        ]);

        if (!newRoomSnap.exists) {
            throw new HttpError(404, "Target bedspace was not found.", "not-found");
        }

        const newRoom = newRoomSnap.data() || {};
        if (normalizeText(newRoom.avail || "available") !== "available") {
            throw new HttpError(409, "Target bedspace is no longer available.", "bed-unavailable");
        }

        if (!bookingSnap.exists) {
            throw new HttpError(404, "Approved booking was not found.", "not-found");
        }

        const booking = bookingSnap.data() || {};
        const targetMonthlyRate = Number(transfer.targetMonthlyRate || booking.monthlyRate || 0);

        transaction.set(oldRoomRef, {
            avail: "Available",
            occupant: "",
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        transaction.set(newRoomRef, {
            avail: "Occupied",
            occupant: transfer.tenantName || transfer.tenantEmail || "Tenant",
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        transaction.update(bookingRef, {
            room: transfer.targetRoom,
            bed: transfer.targetBed,
            type: transfer.targetType,
            contractType: transfer.targetType,
            monthlyRate: targetMonthlyRate,
            leasePrice: formatLeasePrice(targetMonthlyRate),
            transferredAt: admin.firestore.FieldValue.serverTimestamp(),
            transferRequestId: safeId,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        transaction.set(userRef, {
            room: `Room ${transfer.targetRoom}`,
            bed: transfer.targetBed,
            type: transfer.targetType,
            monthlyRate: targetMonthlyRate,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        transaction.update(transferRef, {
            status: "completed",
            paymentStatus: "paid",
            paymentId,
            paidAt: admin.firestore.FieldValue.serverTimestamp(),
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        completedTransfer = transfer;
    });

    if (completedTransfer?.userId && !wasAlreadyCompleted) {
        await sendTenantMessage(completedTransfer.userId, {
            text: `Your room transfer is complete. You are now assigned to Room ${completedTransfer.targetRoom}, Bed ${completedTransfer.targetBed}.`,
            systemType: "transfer_completed",
            transferRequestId: safeId
        });
    }

    return {
        success: true,
        status: "completed",
        userId: completedTransfer?.userId || "",
        bookingRequestId: completedTransfer?.bookingRequestId || ""
    };
}

module.exports = {
    approveTransferAsAdmin,
    createTransferRequest,
    deleteTransferAsAdmin,
    getTransferForPayment,
    listMyTransferRequests,
    listTransferRequestsAsAdmin,
    markTransferPaidAndComplete,
    rejectTransferAsAdmin
};
