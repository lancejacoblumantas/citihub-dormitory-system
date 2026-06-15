const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { asyncHandler } = require("../utils/asyncHandler");
const {
    createDownPaymentCheckout,
    createMonthlyRentCheckout,
    createTransferFeeCheckout,
    createTransientBedCheckout,
    handlePaymongoWebhook,
    verifyPaymongoCheckout
} = require("../services/payments");

const router = express.Router();

router.post(
    "/down-payment/create",
    requireAuth,
    asyncHandler(async (req, res) => {
        const result = await createDownPaymentCheckout(req.user, req.body || {});
        res.json(result);
    })
);

router.post(
    "/monthly-rent/create",
    requireAuth,
    asyncHandler(async (req, res) => {
        const result = await createMonthlyRentCheckout(req.user, req.body || {});
        res.json(result);
    })
);

router.post(
    "/transient-bed/create",
    requireAuth,
    asyncHandler(async (req, res) => {
        const result = await createTransientBedCheckout(req.user, req.body || {});
        res.json(result);
    })
);

router.post(
    "/transfer/create",
    requireAuth,
    asyncHandler(async (req, res) => {
        const result = await createTransferFeeCheckout(req.user, req.body || {});
        res.json(result);
    })
);

router.post(
    "/verify",
    requireAuth,
    asyncHandler(async (req, res) => {
        const result = await verifyPaymongoCheckout(req.user, req.body || {});
        res.json(result);
    })
);

router.post(
    "/webhook/paymongo",
    asyncHandler(async (req, res) => {
        const result = await handlePaymongoWebhook(req.body || {});
        res.json(result);
    })
);

module.exports = router;
