# CitiHub Express Backend

This backend mirrors the current Firebase Functions behavior using Node.js + Express.

## Routes

- `GET /health`
- `POST /api/bookings/create`
- `POST /api/bookings/cancel`
- `POST /api/bookings/admin/approve`
- `POST /api/bookings/admin/reject`
- `POST /api/bookings/admin/cancel`
- `POST /api/bookings/admin/delete`
- `POST /api/transient-beds/create`
- `POST /api/transient-beds/admin/approve`
- `POST /api/transient-beds/admin/status`
- `POST /api/admin/announcements/create`
- `POST /api/admin/announcements/delete`
- `POST /api/admin/history/log`
- `POST /api/admin/rooms/update`
- `POST /api/admin/maintenance/update`
- `POST /api/admin/messages/send`
- `POST /api/admin/messages/delete`
- `POST /api/admin/messages/mark-read`
- `POST /api/payments/down-payment/create`
- `POST /api/payments/monthly-rent/create`
- `POST /api/payments/transient-bed/create`
- `POST /api/payments/verify`
- `POST /api/payments/webhook/paymongo`
- `POST /api/emails/booking-approved`
- `POST /api/emails/booking-rejected`
- `POST /api/emails/payment-confirmed`

## Setup

1. Copy `.env.example` to `.env`
2. Fill in `PAYMONGO_SECRET_KEY` and `RESEND_API_KEY`
3. Configure Firebase Admin credentials using:
   - `GOOGLE_APPLICATION_CREDENTIALS`, or
   - `FIREBASE_SERVICE_ACCOUNT_JSON`
4. Install packages:
   - `npm install`
5. Start the server:
   - `npm start`

## Auth

Protected routes expect:

`Authorization: Bearer <firebase-id-token>`

## Notes

- Sensitive admin writes are handled by backend routes that require a Firebase ID token and an admin user role.
- This backend keeps Firestore as the source of truth.
- `POST /api/payments/verify` is generic and supports both `down_payment` and `monthly_rent`.
