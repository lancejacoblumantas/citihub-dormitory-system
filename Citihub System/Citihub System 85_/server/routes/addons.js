const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { asyncHandler } = require("../utils/asyncHandler");
const {
    activateTenantAddon,
    cancelTenantAddon,
    listTenantAddons
} = require("../services/addons");

const router = express.Router();

router.post(
    "/list",
    requireAuth,
    asyncHandler(async (req, res) => {
        const result = await listTenantAddons(req.user, req.body || {});
        res.json(result);
    })
);

router.post(
    "/activate",
    requireAuth,
    asyncHandler(async (req, res) => {
        const result = await activateTenantAddon(req.user, req.body || {});
        res.json(result);
    })
);

router.post(
    "/cancel",
    requireAuth,
    asyncHandler(async (req, res) => {
        const result = await cancelTenantAddon(req.user, req.body || {});
        res.json(result);
    })
);

module.exports = router;
