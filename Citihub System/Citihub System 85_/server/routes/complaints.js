const express = require("express");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { asyncHandler } = require("../utils/asyncHandler");
const {
    createTenantComplaint,
    updateTenantComplaint
} = require("../services/complaints");

const router = express.Router();

router.post("/create", requireAuth, asyncHandler(async (req, res) => {
    const result = await createTenantComplaint(req.user, req.body || {});
    res.json(result);
}));

router.post("/admin/update", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const result = await updateTenantComplaint(req.user, req.adminProfile, req.body || {});
    res.json(result);
}));

module.exports = router;
