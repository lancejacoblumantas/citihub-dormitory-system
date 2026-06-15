const express = require("express");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { asyncHandler } = require("../utils/asyncHandler");
const {
    approveTransientBedAsAdmin,
    createTransientBedBooking,
    deleteTransientBedAsAdmin,
    getUnavailableBedsForMonthly,
    updateTransientBedStatus
} = require("../services/transientBeds");

const router = express.Router();

router.post(
    "/create",
    requireAuth,
    asyncHandler(async (req, res) => {
        const result = await createTransientBedBooking(req.user, req.body || {});
        res.json(result);
    })
);

router.post(
    "/unavailable-for-monthly",
    requireAuth,
    asyncHandler(async (req, res) => {
        const result = await getUnavailableBedsForMonthly(req.user, req.body || {});
        res.json(result);
    })
);

router.post(
    "/admin/approve",
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
        const result = await approveTransientBedAsAdmin(req.user, req.adminProfile, req.body || {});
        res.json(result);
    })
);

router.post(
    "/admin/status",
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
        const result = await updateTransientBedStatus(req.user, req.adminProfile, req.body || {});
        res.json(result);
    })
);

router.post(
    "/admin/delete",
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
        const result = await deleteTransientBedAsAdmin(req.user, req.adminProfile, req.body || {});
        res.json(result);
    })
);

module.exports = router;
