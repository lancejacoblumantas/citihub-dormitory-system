document.querySelector(".avatar-container")?.addEventListener("click", function (event) {
    this.classList.toggle("open");
    event.stopPropagation();
});

document.addEventListener("click", () => {
    document.querySelector(".avatar-container")?.classList.remove("open");
});

let reportsPayloadCache = null;

function showToast(msg) {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 3000);
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function normalize(value) {
    return String(value || "").trim().toLowerCase();
}

function getMonthIndexByName(monthName) {
    return [
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december"
    ].indexOf(normalize(monthName));
}

function getSelectedReportPeriod() {
    const startMonthSelect = document.getElementById("reportStartMonth");
    const endMonthSelect = document.getElementById("reportEndMonth");
    const year = Number(document.getElementById("reportYear").value);
    const startDateValue = document.getElementById("reportStartDate")?.value;
    const endDateValue = document.getElementById("reportEndDate")?.value;

    if (startDateValue && endDateValue) {
        let startDate = new Date(`${startDateValue}T00:00:00`);
        let endDate = new Date(`${endDateValue}T23:59:59.999`);

        if (endDate < startDate) {
            [startDate, endDate] = [endDate, startDate];
        }

        return {
            startMonth: startDate.toLocaleDateString("en-US", { month: "long" }),
            endMonth: endDate.toLocaleDateString("en-US", { month: "long" }),
            startMonthIndex: startDate.getMonth(),
            endMonthIndex: endDate.getMonth(),
            year: startDate.getFullYear(),
            startDate,
            endDate,
            isCustomRange: true
        };
    }

    let startMonthIndex = startMonthSelect?.selectedIndex ?? 0;
    let endMonthIndex = endMonthSelect?.selectedIndex ?? startMonthIndex;

    if (endMonthIndex < startMonthIndex) {
        [startMonthIndex, endMonthIndex] = [endMonthIndex, startMonthIndex];
    }

    return {
        startMonth: startMonthSelect?.options?.[startMonthIndex]?.textContent || "January",
        endMonth: endMonthSelect?.options?.[endMonthIndex]?.textContent || "January",
        startMonthIndex,
        endMonthIndex,
        year,
        startDate: new Date(year, startMonthIndex, 1),
        endDate: new Date(year, endMonthIndex + 1, 0, 23, 59, 59, 999)
    };
}

function getSelectedReportLabel() {
    const period = getSelectedReportPeriod();
    if (period.isCustomRange) {
        return `${period.startDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} to ${period.endDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
    }

    return period.startMonthIndex === period.endMonthIndex
        ? `${period.startMonth} ${period.year}`
        : `${period.startMonth} to ${period.endMonth} ${period.year}`;
}

function getReportTypeLabel() {
    const select = document.getElementById("reportType");
    return select?.options?.[select.selectedIndex]?.textContent || "Full Management Report";
}

function setupReportPeriodPicker() {
    const now = new Date();
    const startMonthSelect = document.getElementById("reportStartMonth");
    const endMonthSelect = document.getElementById("reportEndMonth");
    const yearSelect = document.getElementById("reportYear");
    const startDateInput = document.getElementById("reportStartDate");
    const endDateInput = document.getElementById("reportEndDate");

    if (startMonthSelect) {
        startMonthSelect.selectedIndex = now.getMonth();
    }
    if (endMonthSelect) {
        endMonthSelect.selectedIndex = now.getMonth();
    }

    if (yearSelect) {
        const currentYear = now.getFullYear();
        yearSelect.innerHTML = "";
        for (let year = currentYear - 2; year <= currentYear + 1; year += 1) {
            const option = document.createElement("option");
            option.value = String(year);
            option.textContent = String(year);
            option.selected = year === currentYear;
            yearSelect.appendChild(option);
        }
    }

    if (startDateInput && endDateInput) {
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        startDateInput.value = [
            monthStart.getFullYear(),
            String(monthStart.getMonth() + 1).padStart(2, "0"),
            String(monthStart.getDate()).padStart(2, "0")
        ].join("-");
        endDateInput.value = [
            monthEnd.getFullYear(),
            String(monthEnd.getMonth() + 1).padStart(2, "0"),
            String(monthEnd.getDate()).padStart(2, "0")
        ].join("-");
    }
}

function renderStarText(value) {
    const rounded = Math.round(value);
    return Array.from({ length: 5 }, (_, index) => index < rounded ? "\u2605" : "\u2606").join(" ");
}

function isOccupiedOrBlocked(room) {
    const status = normalize(room.avail);
    return status === "occupied" || status === "maintenance" || status === "unavailable";
}

function getBookingDate(booking) {
    if (booking.createdAt && typeof booking.createdAt.toDate === "function") {
        return booking.createdAt.toDate();
    }

    if (booking.createdAt) {
        const parsed = new Date(booking.createdAt);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    return null;
}

function isBookingInsidePeriod(booking, period) {
    const createdAt = getBookingDate(booking);
    return Boolean(createdAt && createdAt >= period.startDate && createdAt <= period.endDate);
}

function getRatingDate(rating) {
    const dateValue = rating.updatedAt || rating.createdAt;
    if (dateValue && typeof dateValue.toDate === "function") {
        return dateValue.toDate();
    }

    if (dateValue) {
        const parsed = new Date(dateValue);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    return null;
}

function isRatingInsidePeriod(rating, period) {
    const ratingDate = getRatingDate(rating);
    return Boolean(ratingDate && ratingDate >= period.startDate && ratingDate <= period.endDate);
}

function getBookingOccupancyDate(booking) {
    if (booking.moveInDate) {
        const parsed = new Date(`${booking.moveInDate}T00:00:00`);
        if (!Number.isNaN(parsed.getTime())) return parsed;
    }

    return getBookingDate(booking);
}

function isBookingOccupiedInsidePeriod(booking, period) {
    const stayStart = getReportDateValue(booking.contractStartAt)
        || getReportDateValue(booking.contractStartDate)
        || getReportDateValue(booking.moveInDate)
        || getBookingOccupancyDate(booking);
    const stayEnd = getReportDateValue(booking.contractEndAt)
        || getReportDateValue(booking.contractEndDate)
        || stayStart;

    return Boolean(stayStart && stayEnd && stayStart <= period.endDate && stayEnd >= period.startDate);
}

function getReportDateValue(value) {
    if (!value) {
        return null;
    }

    const date = typeof value.toDate === "function"
        ? value.toDate()
        : new Date(`${String(value).slice(0, 10)}T00:00:00`);

    if (Number.isNaN(date.getTime())) {
        return null;
    }

    date.setHours(0, 0, 0, 0);
    return date;
}

function getRoomBedKey(room, bed) {
    return `${String(room || "").trim()}_${String(bed || "").trim()}`.toLowerCase();
}

function getOccupiedTypeCounts(payload, period = getSelectedReportPeriod()) {
    const bookings = Array.isArray(payload) ? payload : payload?.bookings || [];
    const rooms = Array.isArray(payload?.rooms) ? payload.rooms : [];
    const countedBedspaces = new Set();

    const counts = bookings.reduce((currentCounts, booking) => {
        const status = normalize(booking.status);
        if (!["approved", "active", "checked_in"].includes(status) || !isBookingOccupiedInsidePeriod(booking, period)) {
            return currentCounts;
        }

        const type = normalize(booking.type || booking.roomType);
        if (type === "premium") {
            currentCounts.premium += 1;
            countedBedspaces.add(getRoomBedKey(booking.room, booking.bed || booking.bedNo));
        } else if (type === "standard") {
            currentCounts.standard += 1;
            countedBedspaces.add(getRoomBedKey(booking.room, booking.bed || booking.bedNo));
        }

        return currentCounts;
    }, { standard: 0, premium: 0 });

    rooms.forEach((room) => {
        if (!isOccupiedOrBlocked(room)) return;

        const roomKey = getRoomBedKey(room.room, room.bedNo || room.bed);
        if (roomKey && countedBedspaces.has(roomKey)) return;

        const type = normalize(room.type);
        if (type === "premium") {
            counts.premium += 1;
        } else if (type === "standard") {
            counts.standard += 1;
        }
    });

    return counts;
}

function getAvailableTypeCounts(payload) {
    const rooms = Array.isArray(payload?.rooms) ? payload.rooms : [];

    return rooms.reduce((counts, room) => {
        if (isOccupiedOrBlocked(room)) return counts;

        const type = normalize(room.type);
        if (type === "premium") {
            counts.premium += 1;
        } else if (type === "standard") {
            counts.standard += 1;
        }

        return counts;
    }, { standard: 0, premium: 0 });
}

function getRoomTypeChartSlices(payload) {
    const period = getSelectedReportPeriod();
    const mode = document.getElementById("pieChartMode")?.value || "occupied";
    const occupiedCounts = getOccupiedTypeCounts(payload, period);
    const availableCounts = getAvailableTypeCounts(payload);
    const showAll = mode === "all";
    const showAvailable = mode === "available";
    const slices = showAll
        ? [
            { key: "occupiedStandard", label: "Occupied Standard", value: occupiedCounts.standard, color: "#4285f4" },
            { key: "occupiedPremium", label: "Occupied Premium", value: occupiedCounts.premium, color: "#db4437" },
            { key: "availableStandard", label: "Available Standard", value: availableCounts.standard, color: "#fbbc04" },
            { key: "availablePremium", label: "Available Premium", value: availableCounts.premium, color: "#34a853" }
        ]
        : showAvailable
            ? [
                { key: "occupiedStandard", label: "Standard", value: availableCounts.standard, color: "#4285f4" },
                { key: "occupiedPremium", label: "Premium", value: availableCounts.premium, color: "#db4437" }
            ]
            : [
                { key: "occupiedStandard", label: "Standard", value: occupiedCounts.standard, color: "#4285f4" },
                { key: "occupiedPremium", label: "Premium", value: occupiedCounts.premium, color: "#db4437" }
            ];

    return { slices, occupiedCounts, availableCounts, showAll, showAvailable };
}

function renderOccupiedTypePie(payload) {
    const chart = document.getElementById("occupancyPieChart");
    const barChart = document.getElementById("occupancyBarChart");
    if (!chart) return;

    const chartType = document.getElementById("chartTypeToggle")?.dataset.chartType || "pie";
    const { slices, occupiedCounts, availableCounts, showAll, showAvailable } = getRoomTypeChartSlices(payload);
    const total = slices.reduce((sum, slice) => sum + slice.value, 0);

    chart.hidden = chartType === "bar";
    if (barChart) {
        barChart.hidden = chartType !== "bar";
    }

    let startDegree = 0;
    const gradientParts = slices.map((slice) => {
        const endDegree = startDegree + (total ? (slice.value / total) * 360 : 0);
        const part = `${slice.color} ${startDegree}deg ${endDegree}deg`;
        slice.startDegree = startDegree;
        slice.endDegree = endDegree;
        slice.midDegree = startDegree + ((endDegree - startDegree) / 2);
        startDegree = endDegree;
        return part;
    });
    chart.style.background = total ? `conic-gradient(${gradientParts.join(", ")})` : "conic-gradient(#e5e7eb 0deg 360deg)";
    renderRoomTypeBarChart(slices, total);

    const setText = (id, value) => {
        const element = document.getElementById(id);
        if (element) element.textContent = value;
    };
    const setDisplay = (id, visible) => {
        const element = document.getElementById(id);
        if (element) element.style.display = visible ? "" : "none";
    };
    const percent = (value) => `${(total ? (value / total) * 100 : 0).toFixed(1)}%`;

    setDisplay("availableStandardDetail", showAll);
    setDisplay("availablePremiumDetail", showAll);
    document.querySelectorAll(".report-pie-label-left-top, .report-pie-line-left-top, .report-pie-label-right-bottom, .report-pie-line-right-bottom")
        .forEach((element) => { element.style.display = showAll ? "" : "none"; });

    const occupiedStandardValue = showAvailable && !showAll ? availableCounts.standard : occupiedCounts.standard;
    const occupiedPremiumValue = showAvailable && !showAll ? availableCounts.premium : occupiedCounts.premium;
    const firstLabel = showAll ? "Occupied Standard" : "Standard";
    const secondLabel = showAll ? "Occupied Premium" : "Premium";

    setText("occupiedStandardCount", `${occupiedStandardValue} ${firstLabel}`);
    setText("occupiedPremiumCount", `${occupiedPremiumValue} ${secondLabel}`);
    setText("occupiedStandardPercent", `${percent(occupiedStandardValue)} of total`);
    setText("occupiedPremiumPercent", `${percent(occupiedPremiumValue)} of total`);
    setText("availableStandardCount", `${availableCounts.standard} Available Standard`);
    setText("availablePremiumCount", `${availableCounts.premium} Available Premium`);
    setText("availableStandardPercent", `${percent(availableCounts.standard)} of total`);
    setText("availablePremiumPercent", `${percent(availableCounts.premium)} of total`);

    setText("occupancyPiePeriod", showAvailable
        ? "Based on current available room records."
        : showAll
            ? `Showing occupied from ${getSelectedReportLabel()} and current available room records.`
        : `Based on ${getSelectedReportLabel()} plus current occupied room records.`);
    setText("occupancyPieNote", total
        ? showAll
            ? "All four categories are shown together: occupied standard, occupied premium, available standard, and available premium."
            : showAvailable
                ? "Counts use current available Standard and Premium room records."
            : "Counts use approved monthly bookings in the selected period plus current occupied room records."
        : showAll
            ? "No Standard or Premium room records were found for these categories."
            : showAvailable
            ? "No available Standard or Premium rooms were found."
            : "No occupied Standard or Premium monthly bookings were found for the selected period.");

}

function renderRoomTypeBarChart(slices, total) {
    const container = document.getElementById("occupancyBarChart");
    if (!container) return;

    renderSimpleBarChart(container, slices, total, "Room categories", formatRoomTypeBarLabel);
}

function renderSimpleBarChart(container, slices, total, xAxisLabel, labelFormatter = (label) => label) {
    const maxValue = getNiceChartMax(Math.max(...slices.map((slice) => slice.value), 1));
    const ticks = buildBarChartTicks(maxValue);
    container.innerHTML = `
        <div class="report-bar-y-label">Values</div>
        <div class="report-bar-plot">
            <div class="report-bar-ticks">${ticks}</div>
            ${slices.map((slice) => {
        const height = slice.value ? Math.max((slice.value / maxValue) * 100, 3) : 0;
        const percent = total ? ((slice.value / total) * 100).toFixed(1) : "0.0";
        return `
            <div class="report-bar-item" style="--bar-height:${height}%;">
                <div class="report-bar-value">${slice.value}</div>
                <div class="report-bar-fill" style="background:${slice.color};" title="${escapeHtml(slice.label)}: ${slice.value} (${percent}%)"></div>
                <div class="report-bar-label">${escapeHtml(labelFormatter(slice.label))}</div>
            </div>
        `;
    }).join("")}
        </div>
        <div class="report-bar-x-label">${escapeHtml(xAxisLabel)}</div>
    `;
}

function getNiceChartMax(value) {
    if (value <= 5) return 5;
    if (value <= 10) return 10;
    const magnitude = 10 ** Math.floor(Math.log10(value));
    return Math.ceil(value / magnitude) * magnitude;
}

function buildBarChartTicks(maxValue) {
    const stepCount = 5;
    return Array.from({ length: stepCount + 1 }, (_, index) => {
        const value = Math.round((maxValue / stepCount) * index);
        const bottom = (index / stepCount) * 100;
        return `<span class="report-bar-tick" style="bottom:${bottom}%">${value}</span>`;
    }).join("");
}

function formatRoomTypeBarLabel(label) {
    return String(label || "")
        .replace("Occupied ", "Occ. ")
        .replace("Available ", "Avail. ");
}

function getRatingMetricLabel(metric) {
    const labels = {
        overallRating: "Overall Rating",
        roomRating: "Room Comfort",
        adminServiceRating: "Admin Service"
    };

    return labels[metric] || labels.overallRating;
}

function getRatingChartSlices(ratings, period = getSelectedReportPeriod()) {
    const metric = document.getElementById("ratingChartMetric")?.value || "overallRating";
    const counts = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };

    ratings
        .filter((rating) => isRatingInsidePeriod(rating, period))
        .forEach((rating) => {
            const value = Math.round(Number(rating[metric] || 0));
            if (value >= 1 && value <= 5) {
                counts[value] += 1;
            }
        });

    return {
        metric,
        slices: [
            { key: "five", label: "5 Stars", shortLabel: "5\u2605", legendLabel: "five-star", value: counts[5], color: "#22c55e", countId: "ratingFiveCount", percentId: "ratingFivePercent" },
            { key: "four", label: "4 Stars", shortLabel: "4\u2605", legendLabel: "four-star", value: counts[4], color: "#3b82f6", countId: "ratingFourCount", percentId: "ratingFourPercent" },
            { key: "three", label: "3 Stars", shortLabel: "3\u2605", legendLabel: "three-star", value: counts[3], color: "#fbbc04", countId: "ratingThreeCount", percentId: "ratingThreePercent" },
            { key: "two", label: "2 Stars", shortLabel: "2\u2605", legendLabel: "two-star", value: counts[2], color: "#f97316", countId: "ratingTwoCount", percentId: "ratingTwoPercent" },
            { key: "one", label: "1 Star", shortLabel: "1\u2605", legendLabel: "one-star", value: counts[1], color: "#ef4444", countId: "ratingOneCount", percentId: "ratingOnePercent" }
        ]
    };
}

function renderTenantRatingChart(ratings) {
    const pieChart = document.getElementById("ratingsPieChart");
    const barChart = document.getElementById("ratingsBarChart");
    if (!pieChart) return;

    const chartType = document.getElementById("ratingChartTypeToggle")?.dataset.chartType || "pie";
    const { metric, slices } = getRatingChartSlices(ratings);
    const total = slices.reduce((sum, slice) => sum + slice.value, 0);

    pieChart.hidden = chartType === "bar";
    if (barChart) {
        barChart.hidden = chartType !== "bar";
    }

    let start = 0;
    const gradientParts = slices.map((slice) => {
        const degrees = total ? (slice.value / total) * 360 : 0;
        const end = start + degrees;
        const part = `${slice.color} ${start}deg ${end}deg`;
        start = end;
        return part;
    });

    pieChart.style.background = total ? `conic-gradient(${gradientParts.join(", ")})` : "conic-gradient(#e5e7eb 0deg 360deg)";

    if (barChart) {
        renderSimpleBarChart(barChart, slices, total, "Star ratings", (label) => {
            const slice = slices.find((item) => item.label === label);
            return slice?.shortLabel || label;
        });
    }

    const setText = (id, value) => {
        const element = document.getElementById(id);
        if (element) element.textContent = value;
    };
    const percent = (value) => `${total ? ((value / total) * 100).toFixed(1) : "0.0"}%`;

    slices.forEach((slice) => {
        setText(slice.countId, `${slice.value} ${slice.legendLabel} rating${slice.value === 1 ? "" : "s"}`);
        setText(slice.percentId, `${percent(slice.value)} of total`);
    });

    setText("ratingsChartPeriod", `${getRatingMetricLabel(metric)} from ${getSelectedReportLabel()}.`);
    setText("ratingsChartNote", total
        ? `${total} tenant rating${total === 1 ? "" : "s"} found for this period.`
        : `No tenant ratings found for ${getSelectedReportLabel()}.`);
}

function buildMonthlyTrend(bookings, period = null) {
    const selectedPeriod = period || getSelectedReportPeriod();
    const trend = [];
    const cursor = new Date(selectedPeriod.startDate.getFullYear(), selectedPeriod.startDate.getMonth(), 1);
    const finalMonth = new Date(selectedPeriod.endDate.getFullYear(), selectedPeriod.endDate.getMonth(), 1);

    while (cursor <= finalMonth) {
        const current = new Date(cursor);
        const month = current.toLocaleDateString("en-US", { month: "short" });
        const year = current.getFullYear();

        const approved = bookings.filter((booking) => {
            const createdAt = getBookingDate(booking);
            return booking.status === "approved" &&
                createdAt &&
                createdAt.getMonth() === current.getMonth() &&
                createdAt.getFullYear() === year;
        }).length;

        trend.push({ label: `${month} ${year}`, approved });
        cursor.setMonth(cursor.getMonth() + 1);
    }

    return trend;
}

function refreshPeriodBasedVisuals() {
    if (!reportsPayloadCache) return;
    const period = getSelectedReportPeriod();
    renderOccupiedTypePie(reportsPayloadCache);
    renderTenantRatingChart(reportsPayloadCache.ratings);
    renderRatingsSummary(reportsPayloadCache.ratings.filter((rating) => isRatingInsidePeriod(rating, period)));
    updateReportSummaryCards(reportsPayloadCache);
}

function updateReportSummaryCards({ rooms, bookings, ratings }) {
    const period = getSelectedReportPeriod();
    const total = rooms.length;
    const occupied = rooms.filter(isOccupiedOrBlocked).length;
    const available = total - occupied;
    const approvedBookings = bookings.filter((booking) => normalize(booking.status) === "approved" && isBookingOccupiedInsidePeriod(booking, period)).length;
    const periodRatings = ratings.filter((rating) => isRatingInsidePeriod(rating, period));
    const averageRating = periodRatings.length
        ? periodRatings.reduce((sum, rating) => sum + Number(rating.overallRating || 0), 0) / periodRatings.length
        : 0;

    const setText = (id, value) => {
        const element = document.getElementById(id);
        if (element) element.textContent = value;
    };

    setText("reportTotalBedspaces", String(total));
    setText("reportBedspaceNote", `${available} available, ${occupied} in use or blocked`);
    setText("reportOccupancyRate", `${total ? ((occupied / total) * 100).toFixed(1) : "0"}%`);
    setText("reportApprovedBookings", String(approvedBookings));
    setText("reportAverageRating", averageRating.toFixed(1));
    setText("reportRatingNote", periodRatings.length
        ? `Based on ${periodRatings.length} tenant review${periodRatings.length === 1 ? "" : "s"}`
        : "Waiting for reviews");
}

function renderRatingsSummary(ratings) {
    const overallValue = document.getElementById("ratingsOverallValue");
    const overallStars = document.getElementById("ratingsOverallStars");
    const roomValue = document.getElementById("ratingsRoomValue");
    const roomNote = document.getElementById("ratingsRoomNote");
    const serviceValue = document.getElementById("ratingsServiceValue");
    const serviceNote = document.getElementById("ratingsServiceNote");
    const feedbackList = document.getElementById("ratingsFeedbackList");

    if (!overallValue || !feedbackList) return;

    if (!ratings.length) {
        overallValue.textContent = "0.0 / 5";
        overallStars.textContent = "\u2606 \u2606 \u2606 \u2606 \u2606";
        roomValue.textContent = "0.0";
        roomNote.textContent = "Waiting for tenant reviews";
        serviceValue.textContent = "0.0";
        serviceNote.textContent = "Response and support rating";
        feedbackList.innerHTML = `
            <div class="report-feedback-item">
                <div class="report-feedback-comment">No feedback has been submitted yet.</div>
            </div>
        `;
        return;
    }

    const average = (field) => {
        const total = ratings.reduce((sum, item) => sum + Number(item[field] || 0), 0);
        return total / ratings.length;
    };

    const overall = average("overallRating");
    const room = average("roomRating");
    const service = average("adminServiceRating");

    overallValue.textContent = `${overall.toFixed(1)} / 5`;
    overallStars.textContent = renderStarText(overall);
    roomValue.textContent = room.toFixed(1);
    roomNote.textContent = `Based on ${ratings.length} submitted review${ratings.length === 1 ? "" : "s"}`;
    serviceValue.textContent = service.toFixed(1);
    serviceNote.textContent = "Response and support rating";

    const recentRatings = [...ratings]
        .sort((left, right) => {
            const leftTime = left.updatedAt && typeof left.updatedAt.toDate === "function" ? left.updatedAt.toDate().getTime() : 0;
            const rightTime = right.updatedAt && typeof right.updatedAt.toDate === "function" ? right.updatedAt.toDate().getTime() : 0;
            return rightTime - leftTime;
        })
        .slice(0, 3);

    feedbackList.innerHTML = recentRatings.map((rating) => `
        <div class="report-feedback-item">
            <div class="report-feedback-head">
                <strong>${escapeHtml(rating.fullName || rating.email || "Tenant")}</strong>
                <span>\u2605 ${(Number(rating.overallRating) || 0).toFixed(1)}</span>
            </div>
            <div class="report-feedback-comment">${escapeHtml(rating.comment || "No written comment provided.")}</div>
        </div>
    `).join("");
}

function hexToRgb(hex) {
    const clean = String(hex || "").replace("#", "");
    const value = parseInt(clean.length === 3
        ? clean.split("").map((char) => char + char).join("")
        : clean, 16);

    if (Number.isNaN(value)) return [107, 114, 128];
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function setPdfFillColor(pdf, color) {
    const [red, green, blue] = hexToRgb(color);
    pdf.setFillColor(red, green, blue);
}

function setPdfDrawColor(pdf, color) {
    const [red, green, blue] = hexToRgb(color);
    pdf.setDrawColor(red, green, blue);
}

function addPdfFooter(pdf, pageHeight) {
    pdf.setFontSize(8);
    pdf.setTextColor(107, 114, 128);
    pdf.text("Generated by CitiHub Admin Reports", 14, pageHeight - 8);
}

function drawPdfCard(pdf, x, y, width, height) {
    pdf.setFillColor(255, 255, 255);
    setPdfDrawColor(pdf, "#e5e7eb");
    pdf.roundedRect(x, y, width, height, 3, 3, "FD");
}

function drawPdfPieChart(pdf, title, subtitle, slices, x, y, width, height) {
    drawPdfCard(pdf, x, y, width, height);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(11);
    pdf.setTextColor(17, 24, 39);
    pdf.text(title, x + 8, y + 10);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8);
    pdf.setTextColor(107, 114, 128);
    pdf.text(pdf.splitTextToSize(subtitle, width - 16).slice(0, 2), x + 8, y + 16);

    const total = slices.reduce((sum, slice) => sum + slice.value, 0);
    const centerX = x + 39;
    const centerY = y + 43;
    const radius = 24;

    if (!total) {
        pdf.setFillColor(229, 231, 235);
        pdf.circle(centerX, centerY, radius, "F");
    } else {
        let startDegree = -90;
        slices.forEach((slice) => {
            if (!slice.value) return;
            const degrees = (slice.value / total) * 360;
            const endDegree = startDegree + degrees;
            setPdfFillColor(pdf, slice.color);

            for (let angle = startDegree; angle < endDegree; angle += 4) {
                const nextAngle = Math.min(angle + 4, endDegree);
                const angleRad = angle * Math.PI / 180;
                const nextAngleRad = nextAngle * Math.PI / 180;
                pdf.triangle(
                    centerX,
                    centerY,
                    centerX + Math.cos(angleRad) * radius,
                    centerY + Math.sin(angleRad) * radius,
                    centerX + Math.cos(nextAngleRad) * radius,
                    centerY + Math.sin(nextAngleRad) * radius,
                    "F"
                );
            }

            startDegree = endDegree;
        });
    }

    const legendX = x + 78;
    let legendY = y + 29;
    slices.forEach((slice) => {
        const percent = total ? ((slice.value / total) * 100).toFixed(1) : "0.0";
        setPdfFillColor(pdf, slice.color);
        pdf.circle(legendX, legendY - 1.5, 2.2, "F");
        pdf.setTextColor(17, 24, 39);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(8);
        pdf.text(`${slice.value} ${slice.label}`, legendX + 6, legendY);
        pdf.setTextColor(107, 114, 128);
        pdf.setFont("helvetica", "normal");
        pdf.text(`${percent}% of total`, legendX + 6, legendY + 5);
        legendY += 12;
    });
}

function drawPdfBarChart(pdf, title, subtitle, slices, x, y, width, height, xAxisLabel, labelFormatter = (label) => label) {
    drawPdfCard(pdf, x, y, width, height);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(11);
    pdf.setTextColor(17, 24, 39);
    pdf.text(title, x + 8, y + 10);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8);
    pdf.setTextColor(107, 114, 128);
    pdf.text(pdf.splitTextToSize(subtitle, width - 16).slice(0, 2), x + 8, y + 16);

    const plotX = x + 22;
    const plotY = y + 25;
    const plotWidth = width - 34;
    const plotHeight = height - 48;
    const maxValue = getNiceChartMax(Math.max(...slices.map((slice) => slice.value), 1));
    const stepCount = 5;

    setPdfDrawColor(pdf, "#9ca3af");
    pdf.setLineWidth(0.5);
    pdf.line(plotX, plotY, plotX, plotY + plotHeight);
    pdf.line(plotX, plotY + plotHeight, plotX + plotWidth, plotY + plotHeight);

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(7);
    pdf.setTextColor(107, 114, 128);
    pdf.text("Values", x + 8, plotY - 3);

    for (let index = 0; index <= stepCount; index += 1) {
        const value = Math.round((maxValue / stepCount) * index);
        const tickY = plotY + plotHeight - ((index / stepCount) * plotHeight);
        pdf.text(String(value), plotX - 12, tickY + 2);
        pdf.line(plotX - 3, tickY, plotX, tickY);
    }

    const gap = 7;
    const barSlot = plotWidth / Math.max(slices.length, 1);
    const barWidth = Math.min(14, Math.max(6, barSlot - gap));

    slices.forEach((slice, index) => {
        const barHeight = slice.value ? Math.max((slice.value / maxValue) * plotHeight, 1.5) : 0;
        const barX = plotX + (barSlot * index) + ((barSlot - barWidth) / 2);
        const barY = plotY + plotHeight - barHeight;
        setPdfFillColor(pdf, slice.color);
        if (barHeight) pdf.rect(barX, barY, barWidth, barHeight, "F");
        pdf.setTextColor(107, 114, 128);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(8);
        pdf.text(String(slice.value), barX + (barWidth / 2), Math.max(plotY + 4, barY - 3), { align: "center" });
        pdf.setFontSize(7);
        pdf.text(String(labelFormatter(slice.label)), barX + (barWidth / 2), plotY + plotHeight + 6, { align: "center" });
    });

    pdf.setFontSize(8);
    pdf.text(xAxisLabel, plotX + plotWidth, y + height - 7, { align: "right" });
}

function drawPdfReportChart(pdf, title, subtitle, slices, type, x, y, width, height, xAxisLabel, labelFormatter) {
    if (type === "bar") {
        drawPdfBarChart(pdf, title, subtitle, slices, x, y, width, height, xAxisLabel, labelFormatter);
        return;
    }

    drawPdfPieChart(pdf, title, subtitle, slices, x, y, width, height);
}

async function loadReportAnalytics() {
    const [roomsSnapshot, bookingsSnapshot, ratingsSnapshot] = await Promise.all([
        db.collection("ROOMS").get(),
        db.collection("bookingRequest").get(),
        db.collection("ratings").get()
    ]);

    const rooms = roomsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const bookings = bookingsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const ratings = ratingsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    reportsPayloadCache = { rooms, bookings, ratings };
    renderOccupiedTypePie(reportsPayloadCache);
    renderTenantRatingChart(ratings);
    renderRatingsSummary(ratings.filter((rating) => isRatingInsidePeriod(rating, getSelectedReportPeriod())));
    updateReportSummaryCards(reportsPayloadCache);

    return reportsPayloadCache;
}

function downloadReport(label, payload) {
    if (!window.jspdf?.jsPDF) {
        showToast("PDF generator is still loading. Please try again.");
        return;
    }

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF();
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    let y = 40;

    pdf.setFillColor(26, 122, 74);
    pdf.rect(0, 0, pageWidth, 28, "F");
    pdf.setTextColor(255, 255, 255);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(16);
    pdf.text("CITIHUB DORMITORY", 14, 13);
    pdf.setFontSize(10);
    pdf.setFont("helvetica", "normal");
    pdf.text(`${label} - ${getReportTypeLabel()}`, 14, 21);
    pdf.setTextColor(26, 26, 46);

    pdf.setFontSize(11);
    const period = getSelectedReportPeriod();
    const periodBookings = payload.bookings.filter((booking) => isBookingInsidePeriod(booking, period));
    const approved = payload.bookings.filter((booking) => normalize(booking.status) === "approved" && isBookingOccupiedInsidePeriod(booking, period)).length;

    pdf.text(`Generated: ${new Date().toLocaleString()}`, 14, y);
    y += 12;

    const total = payload.rooms.length;
    const occupied = payload.rooms.filter(isOccupiedOrBlocked).length;
    const available = total - occupied;
    pdf.setFont("helvetica", "bold");
    pdf.text("Operations Summary", 14, y);
    y += 8;
    pdf.setFont("helvetica", "normal");
    pdf.text(`Total bedspaces: ${total}`, 14, y); y += 8;
    pdf.text(`Available bedspaces: ${available}`, 14, y); y += 8;
    pdf.text(`In use or blocked: ${occupied}`, 14, y); y += 8;
    pdf.text(`Occupancy / blocked rate: ${total ? ((occupied / total) * 100).toFixed(1) : "0"}%`, 14, y); y += 8;
    pdf.text(`Approved monthly bookings in period: ${approved}`, 14, y); y += 8;
    pdf.text(`Total booking requests in period: ${periodBookings.length}`, 14, y); y += 12;

    const occupiedTypes = getOccupiedTypeCounts(payload, period);
    pdf.text(`Occupied standard in period: ${occupiedTypes.standard}`, 14, y); y += 8;
    pdf.text(`Occupied premium in period: ${occupiedTypes.premium}`, 14, y); y += 12;

    const ratings = (payload.ratings || []).filter((rating) => isRatingInsidePeriod(rating, period));
    pdf.setFont("helvetica", "bold");
    pdf.text("Tenant Ratings", 14, y);
    y += 8;
    pdf.setFont("helvetica", "normal");
    if (ratings.length) {
        const average = (field) => ratings.reduce((sum, item) => sum + Number(item[field] || 0), 0) / ratings.length;
        pdf.text(`Overall tenant rating: ${average("overallRating").toFixed(1)} / 5`, 14, y); y += 8;
        pdf.text(`Room comfort rating: ${average("roomRating").toFixed(1)} / 5`, 14, y); y += 8;
        pdf.text(`Admin service rating: ${average("adminServiceRating").toFixed(1)} / 5`, 14, y); y += 12;
    } else {
        pdf.text("No tenant ratings submitted yet.", 14, y); y += 12;
    }

    pdf.setFont("helvetica", "bold");
    pdf.text("Monthly Trends", 14, y);
    y += 8;
    pdf.setFont("helvetica", "normal");
    buildMonthlyTrend(payload.bookings, period).forEach((item) => {
        pdf.text(`${item.label}: ${item.approved} approved bookings`, 14, y);
        y += 7;
    });

    addPdfFooter(pdf, pageHeight);

    const roomChartType = document.getElementById("chartTypeToggle")?.dataset.chartType || "pie";
    const ratingChartType = document.getElementById("ratingChartTypeToggle")?.dataset.chartType || "pie";
    const { slices: roomTypeSlices } = getRoomTypeChartSlices(payload);
    const { metric: ratingMetric, slices: ratingSlices } = getRatingChartSlices(ratings, period);

    pdf.addPage();
    pdf.setFillColor(26, 122, 74);
    pdf.rect(0, 0, pageWidth, 28, "F");
    pdf.setTextColor(255, 255, 255);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(16);
    pdf.text("REPORT CHARTS", 14, 13);
    pdf.setFontSize(10);
    pdf.setFont("helvetica", "normal");
    pdf.text(`${label} - Visual Summary`, 14, 21);

    drawPdfReportChart(
        pdf,
        "Occupied Room Type Chart",
        document.getElementById("occupancyPiePeriod")?.textContent || `Based on ${label}.`,
        roomTypeSlices,
        roomChartType,
        14,
        40,
        pageWidth - 28,
        92,
        "Room categories",
        formatRoomTypeBarLabel
    );

    drawPdfReportChart(
        pdf,
        "Tenant Rating Chart",
        `${getRatingMetricLabel(ratingMetric)} from ${label}.`,
        ratingSlices,
        ratingChartType,
        14,
        146,
        pageWidth - 28,
        98,
        "Star ratings",
        (chartLabel) => {
            const slice = ratingSlices.find((item) => item.label === chartLabel);
            return slice?.shortLabel || chartLabel;
        }
    );

    addPdfFooter(pdf, pageHeight);
    pdf.save(`${label.replace(/\s+/g, "_").toLowerCase()}_report.pdf`);
}

async function downloadSelectedReport(startMonth = "", endMonth = "", year = "", typeValue = "") {
    const startMonthIndex = getMonthIndexByName(startMonth);
    const endMonthIndex = getMonthIndexByName(endMonth);
    if (startMonth && startMonthIndex >= 0) document.getElementById("reportStartMonth").selectedIndex = startMonthIndex;
    if (endMonth && endMonthIndex >= 0) document.getElementById("reportEndMonth").selectedIndex = endMonthIndex;
    if (year) document.getElementById("reportYear").value = year;
    if (typeValue) document.getElementById("reportType").value = typeValue;

    const label = getSelectedReportLabel();
    const payload = reportsPayloadCache || await loadReportAnalytics();
    downloadReport(label, payload);
    showToast(`${label} report downloaded.`);
}

function shareReport() {
    document.getElementById("shareReportLabel").value = `${getSelectedReportLabel()} Report`;
    document.getElementById("shareModal").style.display = "flex";
}

function confirmShare() {
    const email = document.getElementById("shareEmail")?.value.trim();
    if (!email) {
        showToast("Please enter the manager email address.");
        return;
    }

    document.getElementById("shareModal").style.display = "none";
    showToast("Report share request prepared.");
}

document.addEventListener("DOMContentLoaded", async () => {
    const adminData = await requireAdminAccess();
    if (!adminData) return;

    setupReportPeriodPicker();
    await loadReportAnalytics();

    document.getElementById("refreshReportsBtn")?.addEventListener("click", async () => {
        await loadReportAnalytics();
        showToast("Reports data refreshed.");
    });

    ["reportStartDate", "reportEndDate", "reportStartMonth", "reportEndMonth", "reportYear", "pieChartMode", "ratingChartMetric"].forEach((id) => {
        document.getElementById(id)?.addEventListener("change", refreshPeriodBasedVisuals);
    });

    document.getElementById("chartTypeToggle")?.addEventListener("click", (event) => {
        const button = event.currentTarget;
        const nextType = button.dataset.chartType === "pie" ? "bar" : "pie";
        button.dataset.chartType = nextType;
        button.textContent = nextType === "pie" ? "Show Bar Chart" : "Show Pie Chart";
        refreshPeriodBasedVisuals();
    });

    document.getElementById("ratingChartTypeToggle")?.addEventListener("click", (event) => {
        const button = event.currentTarget;
        const nextType = button.dataset.chartType === "pie" ? "bar" : "pie";
        button.dataset.chartType = nextType;
        button.textContent = nextType === "pie" ? "Show Bar Chart" : "Show Pie Chart";
        refreshPeriodBasedVisuals();
    });

    document.querySelectorAll("#btnLogout").forEach((button) => {
        button.addEventListener("click", logoutAdmin);
    });
});
