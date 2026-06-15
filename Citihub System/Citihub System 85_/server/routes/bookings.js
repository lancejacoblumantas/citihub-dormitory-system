const express = require("express");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { asyncHandler } = require("../utils/asyncHandler");
const {
    approveBookingAsAdmin,
    cancelApprovedBookingAsAdmin,
    cancelTenantBooking,
    createBookingRequest,
    createRenewalRequest,
    deleteBookingAsAdmin,
    rejectBookingAsAdmin
} = require("../services/bookings");

const router = express.Router();

router.post(
    "/create",
    requireAuth,
    asyncHandler(async (req, res) => {
        const result = await createBookingRequest(req.user, req.body || {});
        res.json(result);
    })
);

router.post(
    "/cancel",
    requireAuth,
    asyncHandler(async (req, res) => {
        const result = await cancelTenantBooking(req.user, req.body || {});
        res.json(result);
    })
);

router.post(
    "/renewal/create",
    requireAuth,
    asyncHandler(async (req, res) => {
        const result = await createRenewalRequest(req.user, req.body || {});
        res.json(result);
    })
);

router.post(
    "/admin/approve",
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
        const result = await approveBookingAsAdmin(req.user, req.adminProfile, req.body || {});
        res.json(result);
    })
);

router.post(
    "/admin/reject",
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
        const result = await rejectBookingAsAdmin(req.user, req.adminProfile, req.body || {});
        res.json(result);
    })
);

router.post(
    "/admin/cancel",
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
        const result = await cancelApprovedBookingAsAdmin(req.user, req.adminProfile, req.body || {});
        res.json(result);
    })
);

router.post(
    "/admin/delete",
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
        const result = await deleteBookingAsAdmin(req.user, req.adminProfile, req.body || {});
        res.json(result);
    })
);

module.exports = router;
