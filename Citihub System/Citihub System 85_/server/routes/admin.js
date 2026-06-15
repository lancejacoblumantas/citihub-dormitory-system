const express = require("express");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { asyncHandler } = require("../utils/asyncHandler");
const {
    bulkUpdateRooms,
    createAnnouncement,
    deleteAnnouncement,
    deleteTenantMessage,
    logAdminActivity,
    markTenantMessagesReadByAdmin,
    sendTenantMessage,
    setTenantBillingHold,
    syncContractExpirationAlerts,
    syncDelinquentAccounts,
    updateMaintenanceTicket,
    updateRoom
} = require("../services/adminActions");

const router = express.Router();

router.use(requireAuth, requireAdmin);

router.post("/announcements/create", asyncHandler(async (req, res) => {
    const result = await createAnnouncement(req.user, req.adminProfile, req.body || {});
    res.json(result);
}));

router.post("/announcements/delete", asyncHandler(async (req, res) => {
    const result = await deleteAnnouncement(req.user, req.adminProfile, req.body || {});
    res.json(result);
}));

router.post("/history/log", asyncHandler(async (req, res) => {
    const result = await logAdminActivity(req.user, req.adminProfile, req.body || {});
    res.json(result);
}));

router.post("/billing/sync-delinquent", asyncHandler(async (req, res) => {
    const result = await syncDelinquentAccounts(req.user, req.adminProfile);
    res.json(result);
}));

router.post("/accounts/set-billing-hold", asyncHandler(async (req, res) => {
    const result = await setTenantBillingHold(req.user, req.adminProfile, req.body || {});
    res.json(result);
}));

router.post("/contracts/sync-expiration-alerts", asyncHandler(async (req, res) => {
    const result = await syncContractExpirationAlerts(req.user, req.adminProfile);
    res.json(result);
}));

router.post("/rooms/update", asyncHandler(async (req, res) => {
    const result = await updateRoom(req.user, req.adminProfile, req.body || {});
    res.json(result);
}));

router.post("/rooms/bulk-update", asyncHandler(async (req, res) => {
    const result = await bulkUpdateRooms(req.user, req.adminProfile, req.body || {});
    res.json(result);
}));

router.post("/maintenance/update", asyncHandler(async (req, res) => {
    const result = await updateMaintenanceTicket(req.user, req.adminProfile, req.body || {});
    res.json(result);
}));

router.post("/messages/send", asyncHandler(async (req, res) => {
    const result = await sendTenantMessage(req.user, req.adminProfile, req.body || {});
    res.json(result);
}));

router.post("/messages/delete", asyncHandler(async (req, res) => {
    const result = await deleteTenantMessage(req.user, req.adminProfile, req.body || {});
    res.json(result);
}));

router.post("/messages/mark-read", asyncHandler(async (req, res) => {
    const result = await markTenantMessagesReadByAdmin(req.user, req.adminProfile, req.body || {});
    res.json(result);
}));

module.exports = router;
