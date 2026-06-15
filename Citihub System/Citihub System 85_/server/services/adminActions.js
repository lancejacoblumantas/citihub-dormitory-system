const { admin, db } = require("../firebaseAdmin");
const { HttpError } = require("../utils/errors");

const DELINQUENCY_GRACE_DAYS = 15;
const CONTRACT_EXPIRATION_ALERT_DAYS = 5;

function getAdminName(adminUser, adminProfile) {
    return adminProfile?.username || adminProfile?.fullName || adminUser.email || "Admin";
}

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

async function writeAdminHistory(adminUser, adminProfile, { action, module, targetId = "", targetName = "", details = "" }) {
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

function getDateOnly(value) {
    if (!value) return null;
    const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    date.setHours(0, 0, 0, 0);
    return date;
}

function daysBetween(left, right) {
    const leftDate = new Date(left);
    const rightDate = new Date(right);
    leftDate.setHours(0, 0, 0, 0);
    rightDate.setHours(0, 0, 0, 0);
    return Math.floor((rightDate - leftDate) / (1000 * 60 * 60 * 24));
}

function formatDateOnly(date) {
    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0")
    ].join("-");
}

function chunkList(items, size = 450) {
    const chunks = [];
    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }
    return chunks;
}

async function addTenantSystemMessage(userId, message) {
    if (!userId) return;

    const userRef = db.collection("users").doc(userId);
    await userRef.collection("messages").add({
        ...message,
        senderType: "admin",
        senderName: "CitiHub Management",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await userRef.set({
        chatLastMessage: message.text || "",
        chatLastSender: "admin",
        chatLastAt: admin.firestore.FieldValue.serverTimestamp(),
        chatUnreadForTenant: admin.firestore.FieldValue.increment(1),
        chatUnreadForAdmin: 0
    }, { merge: true });
}

async function syncDelinquentAccounts(adminUser, adminProfile) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const invoicesSnap = await db.collection("billingInvoices").get();
    const delinquentByUser = new Map();
    const activeBookingIds = new Set();

    invoicesSnap.forEach((doc) => {
        const invoice = doc.data() || {};
        const status = String(invoice.status || "unpaid").toLowerCase();
        if (["paid", "deducted_by_deposit", "cancelled"].includes(status)) {
            return;
        }

        const dueDate = getDateOnly(invoice.dueDate);
        if (!dueDate) {
            return;
        }

        const daysPastDue = daysBetween(dueDate, today);
        if (daysPastDue <= DELINQUENCY_GRACE_DAYS || !invoice.userId) {
            return;
        }

        const existing = delinquentByUser.get(invoice.userId) || {
            userId: invoice.userId,
            tenantName: invoice.tenantName || "",
            tenantEmail: invoice.tenantEmail || "",
            outstandingBalance: 0,
            invoiceCount: 0,
            invoiceIds: [],
            oldestDueDate: dueDate,
            maxDaysPastDue: daysPastDue,
            bookingRequestIds: new Set()
        };

        existing.outstandingBalance += Number(invoice.amount || 0);
        existing.invoiceCount += 1;
        existing.invoiceIds.push(doc.id);
        if (dueDate < existing.oldestDueDate) {
            existing.oldestDueDate = dueDate;
        }
        existing.maxDaysPastDue = Math.max(existing.maxDaysPastDue, daysPastDue);
        if (invoice.bookingRequestId) {
            existing.bookingRequestIds.add(invoice.bookingRequestId);
            activeBookingIds.add(invoice.bookingRequestId);
        }
        delinquentByUser.set(invoice.userId, existing);
    });

    const existingDelinquentUsersSnap = await db.collection("users")
        .where("delinquentAccount", "==", true)
        .get();
    const userIdsToClear = existingDelinquentUsersSnap.docs
        .map((doc) => doc.id)
        .filter((userId) => !delinquentByUser.has(userId));

    const existingDelinquentBookingsSnap = await db.collection("bookingRequest")
        .where("billingStatus", "==", "delinquent")
        .get();
    const bookingIdsToClear = existingDelinquentBookingsSnap.docs
        .map((doc) => doc.id)
        .filter((bookingId) => !activeBookingIds.has(bookingId));

    let markedUsers = 0;
    let clearedUsers = 0;
    let markedBookings = 0;
    let clearedBookings = 0;
    const writes = [];

    delinquentByUser.forEach((entry, userId) => {
        const update = {
            billingStatus: "delinquent",
            delinquentAccount: true,
            delinquentSince: admin.firestore.Timestamp.fromDate(entry.oldestDueDate),
            delinquentOutstandingBalance: entry.outstandingBalance,
            delinquentInvoiceCount: entry.invoiceCount,
            delinquentInvoiceIds: entry.invoiceIds,
            delinquentLastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
            enforcementFlagged: true,
            enforcementFlaggedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        writes.push({ ref: db.collection("users").doc(userId), data: update, options: { merge: true } });
        markedUsers += 1;

        entry.bookingRequestIds.forEach((bookingId) => {
            writes.push({
                ref: db.collection("bookingRequest").doc(bookingId),
                data: {
                    billingStatus: "delinquent",
                    delinquentAccount: true,
                    delinquentSince: admin.firestore.Timestamp.fromDate(entry.oldestDueDate),
                    delinquentOutstandingBalance: entry.outstandingBalance,
                    delinquentInvoiceCount: entry.invoiceCount,
                    delinquentInvoiceIds: entry.invoiceIds,
                    delinquentLastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
                    enforcementFlagged: true,
                    enforcementFlaggedAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                },
                options: { merge: true }
            });
            markedBookings += 1;
        });
    });

    userIdsToClear.forEach((userId) => {
        writes.push({
            ref: db.collection("users").doc(userId),
            data: {
                billingStatus: "current",
                delinquentAccount: false,
                delinquentSince: null,
                delinquentOutstandingBalance: 0,
                delinquentInvoiceCount: 0,
                delinquentInvoiceIds: [],
                delinquentLastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
                enforcementFlagged: false,
                enforcementFlaggedAt: null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            },
            options: { merge: true }
        });
        clearedUsers += 1;
    });

    bookingIdsToClear.forEach((bookingId) => {
        writes.push({
            ref: db.collection("bookingRequest").doc(bookingId),
            data: {
                billingStatus: "current",
                delinquentAccount: false,
                delinquentSince: null,
                delinquentOutstandingBalance: 0,
                delinquentInvoiceCount: 0,
                delinquentInvoiceIds: [],
                delinquentLastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
                enforcementFlagged: false,
                enforcementFlaggedAt: null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            },
            options: { merge: true }
        });
        clearedBookings += 1;
    });

    for (const chunk of chunkList(writes)) {
        const batch = db.batch();
        chunk.forEach((write) => batch.set(write.ref, write.data, write.options));
        await batch.commit();
    }

    await writeAdminHistory(adminUser, adminProfile, {
        action: "synced_delinquent_accounts",
        module: "billing",
        details: `Marked ${markedUsers} account(s) delinquent and cleared ${clearedUsers}.`
    });

    return {
        success: true,
        graceDays: DELINQUENCY_GRACE_DAYS,
        markedUsers,
        clearedUsers,
        markedBookings,
        clearedBookings,
        delinquentAccounts: [...delinquentByUser.values()].map((entry) => ({
            userId: entry.userId,
            tenantName: entry.tenantName,
            tenantEmail: entry.tenantEmail,
            outstandingBalance: entry.outstandingBalance,
            invoiceCount: entry.invoiceCount,
            maxDaysPastDue: entry.maxDaysPastDue
        }))
    };
}

async function setTenantBillingHold(adminUser, adminProfile, payload = {}) {
    const safeUserId = requireText(payload.userId, "Tenant account ID is required.");
    const action = requireText(payload.action, "Billing hold action is required.").toLowerCase();
    const safeReason = String(payload.reason || "").trim();

    if (!["apply", "clear"].includes(action)) {
        throw new HttpError(400, "Unsupported billing hold action.", "invalid-argument");
    }

    const userRef = db.collection("users").doc(safeUserId);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
        throw new HttpError(404, "Tenant account was not found.", "not-found");
    }

    const userData = userSnap.data() || {};
    if (normalizeText(userData.role) === "admin") {
        throw new HttpError(412, "Administrator accounts cannot be placed on billing hold.", "failed-precondition");
    }

    const bookingSnap = await db.collection("bookingRequest")
        .where("userId", "==", safeUserId)
        .get();

    const eligibleBookings = bookingSnap.docs.filter((doc) => {
        const booking = doc.data() || {};
        const status = normalizeText(booking.status);
        return ["approved", "approved_pending_down_payment"].includes(status);
    });

    const now = admin.firestore.FieldValue.serverTimestamp();
    const writes = [];

    if (action === "apply") {
        const reasonText = safeReason || "Manual billing hold applied by admin.";
        writes.push({
            ref: userRef,
            data: {
                manualBillingHold: true,
                manualBillingHoldReason: reasonText,
                manualBillingHoldBy: getAdminName(adminUser, adminProfile),
                manualBillingHoldAt: now,
                manualBillingHoldClearedAt: null,
                updatedAt: now
            },
            options: { merge: true }
        });

        eligibleBookings.forEach((doc) => {
            writes.push({
                ref: doc.ref,
                data: {
                    manualBillingHold: true,
                    manualBillingHoldReason: reasonText,
                    manualBillingHoldBy: getAdminName(adminUser, adminProfile),
                    manualBillingHoldAt: now,
                    manualBillingHoldClearedAt: null,
                    updatedAt: now
                },
                options: { merge: true }
            });
        });

        await addTenantSystemMessage(safeUserId, {
            text: `Your account has been placed on billing hold by CitiHub Management.${reasonText ? ` Reason: ${reasonText}` : ""}`,
            type: "billing_hold"
        });

        await writeAdminHistory(adminUser, adminProfile, {
            action: "applied_billing_hold",
            module: "accounts",
            targetId: safeUserId,
            targetName: userData.fullName || userData.username || userData.email || safeUserId,
            details: reasonText
        });
    } else {
        writes.push({
            ref: userRef,
            data: {
                manualBillingHold: false,
                manualBillingHoldReason: "",
                manualBillingHoldBy: "",
                manualBillingHoldAt: null,
                manualBillingHoldClearedAt: now,
                updatedAt: now
            },
            options: { merge: true }
        });

        eligibleBookings.forEach((doc) => {
            writes.push({
                ref: doc.ref,
                data: {
                    manualBillingHold: false,
                    manualBillingHoldReason: "",
                    manualBillingHoldBy: "",
                    manualBillingHoldAt: null,
                    manualBillingHoldClearedAt: now,
                    updatedAt: now
                },
                options: { merge: true }
            });
        });

        await addTenantSystemMessage(safeUserId, {
            text: "Your billing hold has been removed by CitiHub Management.",
            type: "billing_hold_cleared"
        });

        await writeAdminHistory(adminUser, adminProfile, {
            action: "cleared_billing_hold",
            module: "accounts",
            targetId: safeUserId,
            targetName: userData.fullName || userData.username || userData.email || safeUserId,
            details: safeReason
        });
    }

    const batch = db.batch();
    writes.forEach((write) => batch.set(write.ref, write.data, write.options));
    await batch.commit();

    return {
        success: true,
        userId: safeUserId,
        manualBillingHold: action === "apply",
        affectedBookingCount: eligibleBookings.length,
        reason: action === "apply" ? (safeReason || "Manual billing hold applied by admin.") : ""
    };
}

async function syncContractExpirationAlerts(adminUser, adminProfile) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const snapshot = await db.collection("bookingRequest")
        .where("status", "==", "approved")
        .get();

    const updates = [];
    const messages = [];
    let alertedCount = 0;
    let expiringSoonCount = 0;

    snapshot.forEach((doc) => {
        const booking = doc.data() || {};
        const contractEnd = getDateOnly(booking.contractEndAt) || getDateOnly(booking.contractEndDate);
        if (!contractEnd) {
            return;
        }

        const daysUntilExpiration = daysBetween(today, contractEnd);
        const isExpiringSoon = daysUntilExpiration >= 0 && daysUntilExpiration <= CONTRACT_EXPIRATION_ALERT_DAYS;
        const alreadySent = Boolean(booking.expirationAlertSent);

        if (!isExpiringSoon) {
            if (booking.contractAlertStatus === "expiring_soon") {
                updates.push({
                    ref: doc.ref,
                    data: {
                        contractAlertStatus: daysUntilExpiration < 0 ? "expired" : "current",
                        contractDaysUntilExpiration: daysUntilExpiration,
                        updatedAt: admin.firestore.FieldValue.serverTimestamp()
                    },
                    options: { merge: true }
                });
            }
            return;
        }

        expiringSoonCount += 1;
        updates.push({
            ref: doc.ref,
            data: {
                contractAlertStatus: "expiring_soon",
                contractDaysUntilExpiration: daysUntilExpiration,
                expirationAlertDueDate: formatDateOnly(contractEnd),
                expirationAlertLastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
                ...(alreadySent ? {} : {
                    expirationAlertSent: true,
                    expirationAlertSentAt: admin.firestore.FieldValue.serverTimestamp()
                }),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            },
            options: { merge: true }
        });

        if (!alreadySent && booking.userId) {
            alertedCount += 1;
            messages.push(addTenantSystemMessage(booking.userId, {
                text: `Your CitiHub contract ends on ${formatDateOnly(contractEnd)}. Please coordinate with management if you plan to renew or move out.`,
                systemType: "contract_expiring",
                bookingRequestId: doc.id,
                contractEndDate: formatDateOnly(contractEnd),
                readByTenant: false
            }));
        }
    });

    for (const chunk of chunkList(updates)) {
        const batch = db.batch();
        chunk.forEach((write) => batch.set(write.ref, write.data, write.options));
        await batch.commit();
    }

    await Promise.all(messages);

    await writeAdminHistory(adminUser, adminProfile, {
        action: "synced_contract_expiration_alerts",
        module: "tenants",
        details: `Found ${expiringSoonCount} contract(s) expiring within ${CONTRACT_EXPIRATION_ALERT_DAYS} days and sent ${alertedCount} tenant alert(s).`
    });

    return {
        success: true,
        alertDays: CONTRACT_EXPIRATION_ALERT_DAYS,
        expiringSoonCount,
        alertedCount
    };
}

async function logAdminActivity(adminUser, adminProfile, payload) {
    const safeAction = requireText(payload.action, "Activity action is required.");
    const safeModule = requireText(payload.module, "Activity module is required.");

    await writeAdminHistory(adminUser, adminProfile, {
        action: safeAction,
        module: safeModule,
        targetId: String(payload.targetId || "").trim(),
        targetName: String(payload.targetName || "").trim(),
        details: String(payload.details || "").trim()
    });

    return { success: true };
}

async function createAnnouncement(adminUser, adminProfile, { title, body, type }) {
    const safeTitle = requireText(title, "Announcement title is required.");
    const safeBody = requireText(body, "Announcement message is required.");
    const safeType = ["general", "urgent", "notice"].includes(type) ? type : "general";
    const now = new Date();
    const displayDate = now.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric"
    });

    const docRef = await db.collection("announcements").add({
        title: safeTitle,
        body: safeBody,
        type: safeType,
        date: now,
        displayDate,
        author: getAdminName(adminUser, adminProfile),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await writeAdminHistory(adminUser, adminProfile, {
        action: "posted_announcement",
        module: "bulletin",
        targetId: docRef.id,
        targetName: safeTitle,
        details: "Posted a new bulletin announcement."
    });

    return { success: true, id: docRef.id };
}

async function deleteAnnouncement(adminUser, adminProfile, { announcementId }) {
    const safeAnnouncementId = requireText(announcementId, "Announcement ID is required.");
    const docRef = db.collection("announcements").doc(safeAnnouncementId);
    const snap = await docRef.get();

    if (!snap.exists) {
        throw new HttpError(404, "Announcement not found.", "not-found");
    }

    const data = snap.data();
    await docRef.delete();
    await writeAdminHistory(adminUser, adminProfile, {
        action: "deleted_announcement",
        module: "bulletin",
        targetId: safeAnnouncementId,
        targetName: data.title || "Announcement",
        details: "Deleted a bulletin announcement."
    });

    return { success: true, deleted: true };
}

async function updateRoom(adminUser, adminProfile, { roomId, room, bedNo, type, avail, gender, occupant, maintenanceNote }) {
    const safeRoomId = requireText(roomId, "Room record ID is required.");
    const safeRoom = requireText(room, "Room name is required.");
    const safeBedNo = requireText(bedNo, "Bedspace number is required.");
    const safeType = requireText(type, "Room type is required.");
    const safeAvailInput = String(avail || "").trim().toLowerCase();
    const safeAvail = safeAvailInput.includes("maintenance") || safeAvailInput.includes("maintainance") || safeAvailInput.includes("under repair") || safeAvailInput === "unavailable"
        ? "Maintenance"
        : safeAvailInput.includes("available")
            ? "Available"
            : "Occupied";
    const safeGender = requireText(gender, "Gender assignment is required.");
    const safeOccupant = String(occupant || "").trim();
    const safeMaintenanceNote = String(maintenanceNote || "").trim();

    await db.collection("ROOMS").doc(safeRoomId).update({
        room: safeRoom,
        bedNo: safeBedNo,
        type: safeType,
        avail: safeAvail,
        gender: safeGender,
        occupant: safeOccupant,
        maintenanceNote: safeAvail === "Maintenance" ? safeMaintenanceNote : "",
        maintenanceUpdatedAt: safeAvail === "Maintenance" ? admin.firestore.FieldValue.serverTimestamp() : null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: adminUser.uid
    });

    await writeAdminHistory(adminUser, adminProfile, {
        action: "updated_room",
        module: "rooms",
        targetId: safeRoomId,
        targetName: safeRoom,
        details: `Updated room ${safeRoom} (${safeBedNo}) to ${safeAvail}${safeMaintenanceNote ? `: ${safeMaintenanceNote}` : ""}.`
    });

    return { success: true };
}

async function bulkUpdateRooms(adminUser, adminProfile, { roomIds, avail, maintenanceNote }) {
    const safeRoomIds = Array.isArray(roomIds)
        ? roomIds.map((id) => String(id || "").trim()).filter(Boolean)
        : [];

    if (!safeRoomIds.length) {
        throw new HttpError(400, "Please select at least one bedspace.", "invalid-argument");
    }

    const safeAvailInput = String(avail || "").trim().toLowerCase();
    const safeAvail = safeAvailInput.includes("maintenance") || safeAvailInput.includes("maintainance") || safeAvailInput.includes("under repair") || safeAvailInput === "unavailable"
        ? "Maintenance"
        : safeAvailInput.includes("available")
            ? "Available"
            : "";

    if (!safeAvail) {
        throw new HttpError(400, "Bulk room status must be Maintenance or Available.", "invalid-argument");
    }

    const safeMaintenanceNote = String(maintenanceNote || "").trim();
    const batch = db.batch();
    const roomSnaps = await Promise.all(safeRoomIds.map((roomId) => db.collection("ROOMS").doc(roomId).get()));
    const missing = roomSnaps.find((snap) => !snap.exists);
    if (missing) {
        throw new HttpError(404, `Room record not found: ${missing.id}`, "not-found");
    }

    roomSnaps.forEach((snap) => {
        batch.update(snap.ref, {
            avail: safeAvail,
            occupant: safeAvail === "Available" ? "" : "Maintenance",
            maintenanceNote: safeAvail === "Maintenance" ? safeMaintenanceNote : "",
            maintenanceUpdatedAt: safeAvail === "Maintenance" ? admin.firestore.FieldValue.serverTimestamp() : null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedBy: adminUser.uid
        });
    });

    await batch.commit();

    await writeAdminHistory(adminUser, adminProfile, {
        action: safeAvail === "Maintenance" ? "bulk_marked_rooms_maintenance" : "bulk_marked_rooms_available",
        module: "rooms",
        targetId: safeRoomIds.join(","),
        targetName: `${safeRoomIds.length} bedspaces`,
        details: `Marked ${safeRoomIds.length} bedspace(s) as ${safeAvail}${safeMaintenanceNote ? `: ${safeMaintenanceNote}` : ""}.`
    });

    return { success: true, updated: safeRoomIds.length, status: safeAvail };
}

async function updateMaintenanceTicket(adminUser, adminProfile, { ticketId, status, adminNote }) {
    const safeTicketId = requireText(ticketId, "Maintenance ticket ID is required.");
    const safeStatus = ["open", "in_progress", "resolved"].includes(status) ? status : "open";
    const safeNote = String(adminNote || "").trim();
    const ticketRef = db.collection("maintenanceTickets").doc(safeTicketId);
    const ticketSnap = await ticketRef.get();

    if (!ticketSnap.exists) {
        throw new HttpError(404, "Maintenance ticket not found.", "not-found");
    }

    const ticket = ticketSnap.data();
    await ticketRef.update({
        status: safeStatus,
        adminNote: safeNote,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: adminUser.uid
    });

    const detailParts = [];
    if (ticket.status !== safeStatus) {
        detailParts.push(`Changed status from ${ticket.status || "open"} to ${safeStatus}.`);
    }
    if ((ticket.adminNote || "") !== safeNote) {
        detailParts.push(safeNote ? "Updated the admin note." : "Cleared the admin note.");
    }

    await writeAdminHistory(adminUser, adminProfile, {
        action: "updated_maintenance_ticket",
        module: "maintenance",
        targetId: safeTicketId,
        targetName: ticket.subject || "Maintenance Ticket",
        details: detailParts.join(" ") || "Updated a maintenance ticket."
    });

    return { success: true };
}

function getTenantMessagesRef(userId) {
    return db.collection("users").doc(userId).collection("messages");
}

async function syncTenantChatSummary(userId) {
    const snapshot = await getTenantMessagesRef(userId)
        .orderBy("createdAt", "desc")
        .limit(1)
        .get();
    const userRef = db.collection("users").doc(userId);

    if (snapshot.empty) {
        await userRef.set({
            chatLastMessage: "",
            chatLastSender: "",
            chatLastAt: null,
            chatUnreadForAdmin: 0,
            chatUnreadForTenant: 0
        }, { merge: true });
        return;
    }

    const latestMessage = snapshot.docs[0].data();
    await userRef.set({
        chatLastMessage: latestMessage.text || "",
        chatLastSender: latestMessage.senderType || "",
        chatLastAt: latestMessage.createdAt || admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
}

async function sendTenantMessage(adminUser, adminProfile, { userId, text }) {
    const safeUserId = requireText(userId, "Tenant ID is required.");
    const safeText = requireText(text, "Message text is required.");
    const tenantRef = db.collection("users").doc(safeUserId);
    const tenantSnap = await tenantRef.get();

    if (!tenantSnap.exists) {
        throw new HttpError(404, "Tenant account not found.", "not-found");
    }

    await getTenantMessagesRef(safeUserId).add({
        text: safeText,
        senderType: "admin",
        senderName: getAdminName(adminUser, adminProfile),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await tenantRef.set({
        chatLastMessage: safeText,
        chatLastSender: "admin",
        chatLastAt: admin.firestore.FieldValue.serverTimestamp(),
        chatUnreadForTenant: admin.firestore.FieldValue.increment(1),
        chatUnreadForAdmin: 0
    }, { merge: true });

    return { success: true };
}

async function deleteTenantMessage(_adminUser, _adminProfile, { userId, messageId }) {
    const safeUserId = requireText(userId, "Tenant ID is required.");
    const safeMessageId = requireText(messageId, "Message ID is required.");
    const messageRef = getTenantMessagesRef(safeUserId).doc(safeMessageId);
    const messageSnap = await messageRef.get();

    if (!messageSnap.exists) {
        throw new HttpError(404, "Message not found.", "not-found");
    }

    const message = messageSnap.data();
    if (message.senderType !== "admin") {
        throw new HttpError(403, "Only admin messages can be removed by this action.", "permission-denied");
    }

    await messageRef.delete();
    await syncTenantChatSummary(safeUserId);
    return { success: true, deleted: true };
}

async function markTenantMessagesReadByAdmin(_adminUser, _adminProfile, { userId }) {
    const safeUserId = requireText(userId, "Tenant ID is required.");
    await db.collection("users").doc(safeUserId).set({
        chatUnreadForAdmin: 0
    }, { merge: true });
    return { success: true };
}

module.exports = {
    createAnnouncement,
    deleteAnnouncement,
    deleteTenantMessage,
    bulkUpdateRooms,
    logAdminActivity,
    markTenantMessagesReadByAdmin,
    sendTenantMessage,
    setTenantBillingHold,
    syncContractExpirationAlerts,
    syncDelinquentAccounts,
    updateMaintenanceTicket,
    updateRoom
};
