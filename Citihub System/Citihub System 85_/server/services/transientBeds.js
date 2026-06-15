const { admin, db } = require("../firebaseAdmin");
const { HttpError } = require("../utils/errors");

const TRANSIENT_RATES = {
    standard: 250,
    premium: 500
};

const ACTIVE_TRANSIENT_STATUSES = ["pending_payment", "pending", "approved", "checked_in"];

function requireText(value, message) {
    const safeValue = String(value || "").trim();
    if (!safeValue) {
        throw new HttpError(400, message, "invalid-argument");
    }

    return safeValue;
}

function getAdminName(adminUser, adminProfile) {
    return adminProfile?.username || adminProfile?.fullName || adminUser.email || "Admin";
}

function getTenantName(user, profile) {
    return profile?.fullName || profile?.username || user.email || "Guest";
}

function normalizeApplicantType(value) {
    return String(value || "").replace("type-", "").trim();
}

function normalizeDocuments(documents) {
    if (!Array.isArray(documents)) {
        return [];
    }

    return documents.map((doc) => ({
        id: String(doc.id || "").trim(),
        label: String(doc.label || "Document").trim(),
        files: Array.isArray(doc.files) ? doc.files.map((file) => ({
            name: String(file.name || "").trim(),
            size: Number(file.size || 0),
            type: String(file.type || "").trim(),
            url: String(file.url || "").trim(),
            storagePath: String(file.storagePath || "").trim()
        })) : []
    }));
}

function parseDateOnly(value, label) {
    const text = requireText(value, `${label} is required.`);
    const parsed = new Date(`${text}T00:00:00`);

    if (Number.isNaN(parsed.getTime())) {
        throw new HttpError(400, `${label} is invalid.`, "invalid-argument");
    }

    parsed.setHours(0, 0, 0, 0);
    return parsed;
}

function dateOnlyString(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function countNights(checkInDate, checkOutDate) {
    return Math.round((checkOutDate - checkInDate) / (1000 * 60 * 60 * 24));
}

function isActiveTransientStatus(status) {
    return ACTIVE_TRANSIENT_STATUSES.includes(status);
}

function hasDateOverlap(leftStart, leftEnd, rightStart, rightEnd) {
    return leftStart < rightEnd && rightStart < leftEnd;
}

async function assertBedAvailable({ room, bed, roomType, checkInDate, checkOutDate, userGender = "", ignoreBookingId = "" }) {
    const roomId = `${room}_${bed}`;
    const roomSnap = await db.collection("ROOMS").doc(roomId).get();

    if (!roomSnap.exists) {
        throw new HttpError(404, "Selected bedspace was not found.", "not-found");
    }

    const roomData = roomSnap.data();
    if (String(roomData.avail || "").toLowerCase() === "maintenance") {
        throw new HttpError(412, "Selected bedspace is currently under maintenance.", "failed-precondition");
    }

    if (String(roomData.type || "").toLowerCase() !== roomType) {
        throw new HttpError(412, "Selected bedspace does not match the requested room type.", "failed-precondition");
    }

    const roomGender = String(roomData.gender || "").toLowerCase();
    const safeUserGender = String(userGender || "").toLowerCase();
    if (roomGender !== "mixed" && safeUserGender !== "mixed" && roomGender !== safeUserGender) {
        throw new HttpError(403, "Selected bedspace is not available for your profile gender.", "permission-denied");
    }

    const bookingsSnap = await db.collection("transientBedBookings")
        .where("room", "==", room)
        .where("bed", "==", bed)
        .get();

    bookingsSnap.forEach((doc) => {
        if (doc.id === ignoreBookingId) {
            return;
        }

        const data = doc.data();
        if (!ACTIVE_TRANSIENT_STATUSES.includes(data.status)) {
            return;
        }

        const existingCheckIn = parseDateOnly(data.checkInDate, "Existing check-in date");
        const existingCheckOut = parseDateOnly(data.checkOutDate, "Existing check-out date");

        if (hasDateOverlap(checkInDate, checkOutDate, existingCheckIn, existingCheckOut)) {
            throw new HttpError(409, "This bedspace is already reserved for the selected dates.", "date-conflict");
        }
    });
}

async function writeAdminHistory(adminUser, adminProfile, { action, targetId, targetName, details }) {
    await db.collection("adminHistory").add({
        adminUid: adminUser.uid,
        adminName: getAdminName(adminUser, adminProfile),
        adminEmail: adminUser.email || "",
        action,
        module: "transient_bed",
        targetId,
        targetName,
        details,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
}

async function sendTenantMessage(userId, { text, systemType, transientBookingId }) {
    if (!userId) {
        return;
    }

    const userRef = db.collection("users").doc(userId);
    await userRef.collection("messages").add({
        text,
        senderType: "admin",
        senderName: "CitiHub Management",
        systemType,
        transientBookingId,
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

async function deleteTransientStorageFiles(documents = []) {
    const storagePaths = [];
    documents.forEach((doc) => {
        (doc.files || []).forEach((file) => {
            if (file?.storagePath) {
                storagePaths.push(file.storagePath);
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

async function createTransientBedBooking(user, payload) {
    const roomType = requireText(payload.roomType, "Room type is required.").toLowerCase();
    if (!TRANSIENT_RATES[roomType]) {
        throw new HttpError(400, "Room type must be standard or premium.", "invalid-argument");
    }

    const room = requireText(payload.room, "Room is required.");
    const bed = requireText(payload.bed, "Bedspace is required.");
    const checkInDate = parseDateOnly(payload.checkInDate, "Check-in date");
    const checkOutDate = parseDateOnly(payload.checkOutDate, "Check-out date");
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (checkInDate < today) {
        throw new HttpError(400, "Check-in date cannot be in the past.", "invalid-argument");
    }

    const nights = countNights(checkInDate, checkOutDate);
    if (nights < 1) {
        throw new HttpError(400, "Transient Bed stay must be at least one day.", "invalid-argument");
    }

    if (nights > 30) {
        throw new HttpError(400, "Transient Bed stay can be booked for up to 30 days only.", "invalid-argument");
    }

    const profileSnap = await db.collection("users").doc(user.uid).get();
    const profile = profileSnap.exists ? profileSnap.data() : {};
    const profileGender = String(profile.gender || "").toLowerCase();
    if (!profileGender) {
        throw new HttpError(412, "Please complete your profile gender before booking a Transient Bed.", "failed-precondition");
    }

    await assertBedAvailable({
        room,
        bed,
        roomType,
        checkInDate,
        checkOutDate,
        userGender: profileGender
    });
    const ratePerDay = TRANSIENT_RATES[roomType];
    const totalAmount = ratePerDay * nights;
    const referenceId = String(payload.referenceId || "").trim()
        || `TB-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const bookingRef = db.collection("transientBedBookings").doc();
    const firstName = String(payload.firstName || profile.firstName || "").trim();
    const lastName = String(payload.lastName || profile.lastName || "").trim();
    const fullName = [firstName, lastName].filter(Boolean).join(" ") || getTenantName(user, profile);

    await bookingRef.set({
        userId: user.uid,
        fullName,
        email: user.email || profile.email || "",
        gender: profile.gender || "",
        firstName,
        lastName,
        phone: String(payload.phone || profile.phone || "").trim(),
        birthDate: String(payload.birthDate || "").trim(),
        address: String(payload.address || "").trim(),
        emergencyName: String(payload.emergencyName || "").trim(),
        relationship: String(payload.relationship || "").trim(),
        emergencyPhone: String(payload.emergencyPhone || "").trim(),
        emergencyAlt: String(payload.emergencyAlt || "").trim(),
        emergencyAddress: String(payload.emergencyAddress || "").trim(),
        applicantType: normalizeApplicantType(payload.applicantType),
        documents: normalizeDocuments(payload.documents),
        identityVerificationStatus: "pending_review",
        identityVerificationNote: "",
        identityVerificationReviewedAt: null,
        identityVerificationReviewedBy: "",
        roomType,
        room,
        bed,
        checkInDate: dateOnlyString(checkInDate),
        checkOutDate: dateOnlyString(checkOutDate),
        nights,
        ratePerDay,
        totalAmount,
        currency: "PHP",
        paymentStatus: "unpaid",
        status: "pending",
        referenceId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
        success: true,
        bookingId: bookingRef.id,
        referenceId,
        totalAmount,
        nights,
        ratePerDay
    };
}

async function getUnavailableBedsForMonthly(user, { moveInDate, roomType }) {
    const safeRoomType = requireText(roomType, "Room type is required.").toLowerCase();
    if (!TRANSIENT_RATES[safeRoomType]) {
        throw new HttpError(400, "Room type must be standard or premium.", "invalid-argument");
    }

    const monthlyMoveIn = parseDateOnly(moveInDate, "Move-in date");
    const profileSnap = await db.collection("users").doc(user.uid).get();
    const profile = profileSnap.exists ? profileSnap.data() : {};
    const profileGender = String(profile.gender || "").toLowerCase();

    if (!profileGender) {
        throw new HttpError(412, "Please complete your profile gender before booking a bedspace.", "failed-precondition");
    }

    const snapshot = await db.collection("transientBedBookings")
        .where("roomType", "==", safeRoomType)
        .get();

    const unavailableBeds = [];
    snapshot.forEach((doc) => {
        const data = doc.data();
        if (!isActiveTransientStatus(data.status)) {
            return;
        }

        const checkOutDate = parseDateOnly(data.checkOutDate, "Transient check-out date");
        if (checkOutDate > monthlyMoveIn) {
            unavailableBeds.push({
                room: data.room || "",
                bed: data.bed || "",
                key: `${data.room || ""}_${data.bed || ""}`,
                checkOutDate: data.checkOutDate || ""
            });
        }
    });

    return {
        success: true,
        unavailableBeds
    };
}

async function getTransientBedForPayment(userId, bookingId) {
    const bookingRef = db.collection("transientBedBookings").doc(String(bookingId || "").trim());
    const bookingSnap = await bookingRef.get();

    if (!bookingSnap.exists) {
        throw new HttpError(404, "Transient Bed booking was not found.", "not-found");
    }

    const bookingData = bookingSnap.data();
    if (bookingData.userId !== userId) {
        throw new HttpError(403, "You do not have access to this Transient Bed booking.", "permission-denied");
    }

    if (bookingData.status !== "approved") {
        throw new HttpError(412, "Payment is available only after admin approval.", "failed-precondition");
    }

    if (bookingData.paymentStatus === "paid") {
        throw new HttpError(412, "This Transient Bed bill is already paid.", "failed-precondition");
    }

    return { ref: bookingRef, id: bookingSnap.id, data: bookingData };
}

async function markTransientBedPaid(bookingId, paymentId) {
    const bookingRef = db.collection("transientBedBookings").doc(String(bookingId || "").trim());
    const bookingSnap = await bookingRef.get();

    if (!bookingSnap.exists) {
        return;
    }

    const booking = bookingSnap.data();
    if (booking.paymentStatus === "paid") {
        return;
    }

    await bookingRef.set({
        paymentStatus: "paid",
        paymentId,
        status: booking.status,
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
}

async function approveTransientBedAsAdmin(adminUser, adminProfile, { bookingId }) {
    const safeBookingId = requireText(bookingId, "Transient Bed booking ID is required.");
    const bookingRef = db.collection("transientBedBookings").doc(safeBookingId);
    let booking = null;

    await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(bookingRef);
        if (!snap.exists) {
            throw new HttpError(404, "Transient Bed booking was not found.", "not-found");
        }

        booking = snap.data();
        if (booking.status !== "pending") {
            throw new HttpError(412, "Only pending Transient Bed requests can be approved.", "failed-precondition");
        }

        transaction.update(bookingRef, {
            status: "approved",
            approvedAt: admin.firestore.FieldValue.serverTimestamp(),
            approvedBy: adminUser.email || adminUser.uid,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
    });

    await writeAdminHistory(adminUser, adminProfile, {
        action: "approved_transient_bed",
        targetId: safeBookingId,
        targetName: booking.fullName || booking.email || "Transient Guest",
        details: `Approved Transient Bed ${booking.referenceId || safeBookingId} for Room ${booking.room}, Bed ${booking.bed}.`
    });

    await sendTenantMessage(booking.userId, {
        text: `Your Transient Bed booking ${booking.referenceId || safeBookingId} has been approved for Room ${booking.room}, Bed ${booking.bed}. You can now pay your bill from the Transient Bed page.`,
        systemType: "transient_bed_approved",
        transientBookingId: safeBookingId
    });

    return { success: true, status: "approved" };
}

async function updateTransientBedStatus(adminUser, adminProfile, { bookingId, status, reason }) {
    const safeBookingId = requireText(bookingId, "Transient Bed booking ID is required.");
    const safeStatus = requireText(status, "Status is required.");
    const allowed = ["rejected", "cancelled", "checked_in", "checked_out"];
    if (!allowed.includes(safeStatus)) {
        throw new HttpError(400, "Unsupported Transient Bed status action.", "invalid-argument");
    }

    const bookingRef = db.collection("transientBedBookings").doc(safeBookingId);
    const snap = await bookingRef.get();
    if (!snap.exists) {
        throw new HttpError(404, "Transient Bed booking was not found.", "not-found");
    }

    const booking = snap.data();
    const update = {
        status: safeStatus,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    if (safeStatus === "rejected" || safeStatus === "cancelled") {
        update.reason = requireText(reason, "Please provide a reason.");
    }
    if (safeStatus === "checked_in") {
        if (booking.status !== "approved") {
            throw new HttpError(412, "Only approved Transient Bed bookings can be checked in.", "failed-precondition");
        }
        if (booking.paymentStatus !== "paid") {
            throw new HttpError(412, "Transient Bed payment must be confirmed before check-in.", "failed-precondition");
        }
        update.checkedInAt = admin.firestore.FieldValue.serverTimestamp();
    }
    if (safeStatus === "checked_out") {
        if (booking.status !== "checked_in") {
            throw new HttpError(412, "Only checked-in Transient Bed bookings can be checked out.", "failed-precondition");
        }
        update.checkedOutAt = admin.firestore.FieldValue.serverTimestamp();
    }

    await bookingRef.update(update);

    const actionLabel = safeStatus.replace(/_/g, " ");
    await writeAdminHistory(adminUser, adminProfile, {
        action: `${safeStatus}_transient_bed`,
        targetId: safeBookingId,
        targetName: booking.fullName || booking.email || "Transient Guest",
        details: `Marked Transient Bed ${booking.referenceId || safeBookingId} as ${actionLabel}.`
    });

    await sendTenantMessage(booking.userId, {
        text: `Your Transient Bed booking ${booking.referenceId || safeBookingId} was marked as ${actionLabel}${update.reason ? `. Reason: ${update.reason}` : "."}`,
        systemType: `transient_bed_${safeStatus}`,
        transientBookingId: safeBookingId
    });

    return { success: true, status: safeStatus };
}

async function deleteTransientBedAsAdmin(adminUser, adminProfile, { bookingId }) {
    const safeBookingId = requireText(bookingId, "Transient Bed booking ID is required.");
    const bookingRef = db.collection("transientBedBookings").doc(safeBookingId);
    const bookingSnap = await bookingRef.get();

    if (!bookingSnap.exists) {
        throw new HttpError(404, "Transient Bed booking was not found.", "not-found");
    }

    const booking = bookingSnap.data();
    const normalizedStatus = String(booking.status || "").toLowerCase();
    if (normalizedStatus !== "cancelled") {
        throw new HttpError(412, "Only cancelled Transient Bed requests can be deleted permanently.", "failed-precondition");
    }

    await deleteTransientStorageFiles(booking.documents || []);
    await bookingRef.delete();

    await writeAdminHistory(adminUser, adminProfile, {
        action: "deleted_transient_bed_permanently",
        targetId: safeBookingId,
        targetName: booking.fullName || booking.email || "Transient Guest",
        details: `Permanently deleted cancelled Transient Bed request ${booking.referenceId || safeBookingId} and its uploaded documents.`
    });

    return { success: true, deleted: true };
}

module.exports = {
    TRANSIENT_RATES,
    approveTransientBedAsAdmin,
    createTransientBedBooking,
    deleteTransientBedAsAdmin,
    getUnavailableBedsForMonthly,
    getTransientBedForPayment,
    markTransientBedPaid,
    updateTransientBedStatus
};
