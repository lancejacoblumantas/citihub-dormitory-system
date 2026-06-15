const express = require("express");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { asyncHandler } = require("../utils/asyncHandler");
const { sendResendEmail } = require("../services/email");
const { getBookingRequestForEmail } = require("../services/bookings");
const { HttpError } = require("../utils/errors");

const router = express.Router();

router.post(
    "/booking-approved",
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
        const bookingRequestId = String(req.body?.bookingRequestId || "").trim();
        if (!bookingRequestId) {
            throw new HttpError(400, "Missing booking request ID.", "invalid-argument");
        }

        const { data } = await getBookingRequestForEmail(bookingRequestId);
        const fullName = `${data.firstName || ""} ${data.lastName || ""}`.trim() || "Applicant";

        if (!data.email || !data.room || !data.bed) {
            throw new HttpError(412, "Booking request is missing email or room details.", "failed-precondition");
        }

        const result = await sendResendEmail({
            toEmail: data.email,
            subject: "Your CitiHub booking has been approved",
            textPart: `Hello ${fullName}, your booking for Room ${data.room}, Bed ${data.bed} has been approved.`,
            htmlPart: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6;">
                    <h2>Booking Approved</h2>
                    <p>Hello ${fullName},</p>
                    <p>Your booking request has been approved.</p>
                    <p><strong>Room:</strong> ${data.room}</p>
                    <p><strong>Bed:</strong> ${data.bed}</p>
                    <p>Please wait for the next instructions from CitiHub Dormitory.</p>
                </div>
            `
        });

        res.json({ success: true, result });
    })
);

router.post(
    "/booking-rejected",
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
        const bookingRequestId = String(req.body?.bookingRequestId || "").trim();
        if (!bookingRequestId) {
            throw new HttpError(400, "Missing booking request ID.", "invalid-argument");
        }

        const { data } = await getBookingRequestForEmail(bookingRequestId);
        const fullName = `${data.firstName || ""} ${data.lastName || ""}`.trim() || "Applicant";
        const rejectionReason = String(data.rejectionReason || "").trim();

        if (!data.email || !rejectionReason) {
            throw new HttpError(412, "Booking request is missing email or rejection reason.", "failed-precondition");
        }

        const result = await sendResendEmail({
            toEmail: data.email,
            subject: "Update on your CitiHub booking request",
            textPart: `Hello ${fullName}, your booking request was not approved. Reason: ${rejectionReason}`,
            htmlPart: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6;">
                    <h2>Booking Request Update</h2>
                    <p>Hello ${fullName},</p>
                    <p>We regret to inform you that your booking request was not approved at this time.</p>
                    <p><strong>Reason:</strong> ${rejectionReason}</p>
                    <p>You may contact CitiHub Dormitory for clarification or submit a new request if applicable.</p>
                </div>
            `
        });

        res.json({ success: true, result });
    })
);

router.post(
    "/payment-confirmed",
    requireAuth,
    asyncHandler(async (req, res) => {
        const toEmail = String(req.body?.toEmail || "").trim();
        const fullName = String(req.body?.fullName || "").trim();
        const amount = req.body?.amount;
        const method = String(req.body?.method || "").trim();

        if (!toEmail || !fullName || !amount || !method) {
            throw new HttpError(400, "Missing required email fields.", "invalid-argument");
        }

        const result = await sendResendEmail({
            toEmail,
            subject: "Your CitiHub payment has been confirmed",
            textPart: `Hello ${fullName}, your payment of PHP ${amount} via ${method} has been confirmed.`,
            htmlPart: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6;">
                    <h2>Payment Confirmed</h2>
                    <p>Hello ${fullName},</p>
                    <p>We have successfully received your payment.</p>
                    <p><strong>Amount:</strong> PHP ${amount}</p>
                    <p><strong>Method:</strong> ${method}</p>
                    <p>Thank you for your payment.</p>
                </div>
            `
        });

        res.json({ success: true, result });
    })
);

module.exports = router;
