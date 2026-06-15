const express = require("express");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { asyncHandler } = require("../utils/asyncHandler");
const {
    approveTransferAsAdmin,
    createTransferRequest,
    deleteTransferAsAdmin,
    listMyTransferRequests,
    listTransferRequestsAsAdmin,
    rejectTransferAsAdmin
} = require("../services/transfers");

const router = express.Router();

router.post("/create", requireAuth, asyncHandler(async (req, res) => {
    const result = await createTransferRequest(req.user, req.body || {});
    res.json(result);
}));

router.post("/mine", requireAuth, asyncHandler(async (req, res) => {
    const result = await listMyTransferRequests(req.user);
    res.json(result);
}));

router.post("/admin/list", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const result = await listTransferRequestsAsAdmin();
    res.json(result);
}));

router.post("/admin/approve", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const result = await approveTransferAsAdmin(req.user, req.adminProfile, req.body || {});
    res.json(result);
}));

router.post("/admin/reject", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const result = await rejectTransferAsAdmin(req.user, req.adminProfile, req.body || {});
    res.json(result);
}));

router.post("/admin/delete", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const result = await deleteTransferAsAdmin(req.user, req.adminProfile, req.body || {});
    res.json(result);
}));

module.exports = router;
