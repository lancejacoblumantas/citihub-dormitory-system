const { admin, db } = require("../firebaseAdmin");
const { HttpError } = require("../utils/errors");

const COMPLAINT_CATEGORIES = new Set([
    "unauthorized_visit",
    "vacant_bed_or_locker",
    "blocked_hallway",
    "smoking",
    "inappropriate_clothing",
    "unauthorized_visitor",
    "hanging_items",
    "loud_noise",
    "bullying_harassment",
    "alcohol",
    "drugs_weapons_fighting",
    "cooking",
    "washing_clothes",
    "pets",
    "sanitation_pests",
    "barangay_ordinance",
    "public_scandal",
    "other"
]);

const COMPLAINT_STATUSES = new Set(["open", "in_review", "resolved", "dismissed"]);
const VIOLATION_ACTIONS = new Set(["none", "verbal_warning", "memo_penalty", "termination_recommended"]);

function requireText(value, message, maxLength = 500) {
    const safeValue = String(value || "").trim();
    if (!safeValue) {
        throw new HttpError(400, message, "invalid-argument");
    }

    return safeValue.slice(0, maxLength);
}

function optionalText(value, maxLength = 160) {
    return String(value || "").trim().slice(0, maxLength);
}

function getProfileName(profile, fallback = "Tenant") {
    return profile?.fullName || profile?.username || profile?.displayName || fallback;
}

function getAdminName(adminUser, adminProfile) {
    return adminProfile?.username || adminProfile?.fullName || adminUser.email || "Admin";
}

async function writeAdminHistory(adminUser, adminProfile, { action, targetId, targetName, details }) {
    await db.collection("adminHistory").add({
        adminUid: adminUser.uid,
        adminName: getAdminName(adminUser, adminProfile),
        adminEmail: adminUser.email || "",
        action,
        module: "complaints",
        targetId,
        targetName,
        details,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
}

async function createTenantComplaint(user, payload) {
    const profileRef = db.collection("users").doc(user.uid);
    const profileSnap = await profileRef.get();

    if (!profileSnap.exists) {
        throw new HttpError(404, "Tenant account profile was not found.", "not-found");
    }

    const profile = profileSnap.data() || {};
    if (profile.status !== "approved") {
        throw new HttpError(403, "Only approved tenants can submit a co-tenant report.", "permission-denied");
    }

    const category = COMPLAINT_CATEGORIES.has(payload.category) ? payload.category : "other";
    const subject = requireText(payload.subject, "Report subject is required.", 120);
    const description = requireText(payload.description, "Report details are required.", 1200);
    const reportedTenantName = optionalText(payload.reportedTenantName, 120);
    const reportedTenantRoom = optionalText(payload.reportedTenantRoom, 60);
    const reportedTenantBed = optionalText(payload.reportedTenantBed, 60);

    const docRef = await db.collection("tenantComplaints").add({
        userId: user.uid,
        reporterName: getProfileName(profile, user.email || "Tenant"),
        reporterEmail: profile.email || user.email || "",
        reporterRoom: profile.room || "",
        reporterBed: profile.bedNo || profile.bed || "",
        category,
        subject,
        description,
        reportedTenantName,
        reportedTenantRoom,
        reportedTenantBed,
        status: "open",
        violationAction: "none",
        adminNote: "",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { success: true, id: docRef.id };
}

async function updateTenantComplaint(adminUser, adminProfile, payload) {
    const complaintId = requireText(payload.complaintId, "Complaint ID is required.", 80);
    const safeStatus = COMPLAINT_STATUSES.has(payload.status) ? payload.status : "open";
    const safeAction = VIOLATION_ACTIONS.has(payload.violationAction) ? payload.violationAction : "none";
    const safeNote = optionalText(payload.adminNote, 1200);
    const complaintRef = db.collection("tenantComplaints").doc(complaintId);
    const complaintSnap = await complaintRef.get();

    if (!complaintSnap.exists) {
        throw new HttpError(404, "Complaint report was not found.", "not-found");
    }

    const complaint = complaintSnap.data() || {};
    await complaintRef.update({
        status: safeStatus,
        violationAction: safeAction,
        adminNote: safeNote,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: adminUser.uid
    });

    if (complaint.userId) {
        await db.collection("users").doc(complaint.userId).collection("messages").add({
            text: `Your report "${complaint.subject || "Complaint Report"}" is now ${safeStatus.replace(/_/g, " ")}.${safeNote ? ` Admin note: ${safeNote}` : ""}`,
            senderId: adminUser.uid,
            senderName: getAdminName(adminUser, adminProfile),
            senderType: "admin",
            readByTenant: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
    }

    await writeAdminHistory(adminUser, adminProfile, {
        action: "updated_complaint_report",
        targetId: complaintId,
        targetName: complaint.subject || "Complaint Report",
        details: `Updated complaint to ${safeStatus.replace(/_/g, " ")} with action ${safeAction.replace(/_/g, " ")}.`
    });

    return { success: true };
}

module.exports = {
    createTenantComplaint,
    updateTenantComplaint
};
