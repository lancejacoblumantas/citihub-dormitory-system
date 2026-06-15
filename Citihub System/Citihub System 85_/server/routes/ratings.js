const express = require("express");
const { db } = require("../firebaseAdmin");

const router = express.Router();

function toRatingNumber(value) {
    const rating = Number(value);
    return Number.isFinite(rating) && rating >= 1 && rating <= 5 ? rating : null;
}

function toMillis(value) {
    if (!value) return 0;
    if (typeof value.toDate === "function") return value.toDate().getTime();
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function cleanPublicComment(value) {
    return String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 220);
}

function average(items, field) {
    const values = items
        .map((item) => toRatingNumber(item[field]))
        .filter((value) => value !== null);

    if (!values.length) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

router.get("/summary", async (_req, res, next) => {
    try {
        const snapshot = await db.collection("ratings").get();
        const ratings = snapshot.docs
            .map((doc) => ({ id: doc.id, ...doc.data() }))
            .filter((rating) => toRatingNumber(rating.overallRating) !== null);

        const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        ratings.forEach((rating) => {
            const rounded = Math.round(toRatingNumber(rating.overallRating));
            distribution[rounded] += 1;
        });

        const recentComments = ratings
            .filter((rating) => rating.showOnHomepage === true || rating.publicApproved === true)
            .map((rating) => ({
                rating: toRatingNumber(rating.overallRating),
                comment: cleanPublicComment(rating.comment),
                updatedAt: toMillis(rating.updatedAt || rating.createdAt)
            }))
            .filter((rating) => rating.comment)
            .sort((left, right) => right.updatedAt - left.updatedAt)
            .slice(0, 3)
            .map((rating) => ({
                rating: rating.rating,
                comment: rating.comment,
                author: "Verified Tenant"
            }));

        res.json({
            totalReviews: ratings.length,
            averages: {
                overall: Number(average(ratings, "overallRating").toFixed(1)),
                roomComfort: Number(average(ratings, "roomRating").toFixed(1)),
                adminService: Number(average(ratings, "adminServiceRating").toFixed(1))
            },
            distribution,
            recentComments
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
