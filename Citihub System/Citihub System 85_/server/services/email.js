const { Resend } = require("resend");
const { HttpError } = require("../utils/errors");

function getResendClient() {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
        throw new HttpError(500, "RESEND_API_KEY is not configured.", "internal");
    }

    return new Resend(apiKey);
}

async function sendResendEmail({ toEmail, subject, textPart, htmlPart }) {
    const resend = getResendClient();
    const { data, error } = await resend.emails.send({
        from: "CitiHub Dormitory <onboarding@resend.dev>",
        to: [toEmail],
        subject,
        text: textPart,
        html: htmlPart
    });

    if (error) {
        throw new HttpError(502, error.message || "Resend email send failed.", "email-send-failed");
    }

    return data;
}

module.exports = { sendResendEmail };
