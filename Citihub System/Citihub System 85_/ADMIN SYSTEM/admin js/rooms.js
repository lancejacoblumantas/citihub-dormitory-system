requireAdminAccess();

const roomsState = {
    rows: [],
    rooms: [],
    monthlyBookings: [],
    transientBookings: [],
    activeRoom: null,
    selectedRoomIds: new Set(),
    viewMode: "table"
};

document.addEventListener("DOMContentLoaded", () => {
    bindRoomUi();
    setupFilters();
    setupExport();
    loadRooms();
});

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

function getRoomKey(room, bedNo) {
    return `${String(room || "").trim()}_${String(bedNo || "").trim()}`;
}

function formatDate(value) {
    if (!value) return "No date";
    const date = value?.toDate?.() || new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return "No date";
    return date.toLocaleDateString("en-PH", {
        month: "short",
        day: "numeric",
        year: "numeric"
    });
}

function formatStatusLabel(status) {
    return String(status || "available")
        .replace(/_/g, " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function isMonthlyActive(status) {
    return ["approved", "checked_in", "active"].includes(normalize(status));
}

function isMonthlyPending(status) {
    return ["pending", "pending_review", "approved_pending_down_payment"].includes(normalize(status));
}

function isTransientActive(status) {
    return ["pending_payment", "pending", "approved", "checked_in"].includes(normalize(status));
}

function isMaintenanceStatus(value) {
    const text = normalize(value);
    return text.includes("maintenance") || text.includes("maintainance") || text.includes("under repair") || text === "unavailable";
}

function isLegacyMaintenanceRoom(room, { activeMonthly, pendingMonthly, activeTransient } = {}) {
    const availability = normalize(room.avail);
    const occupant = normalize(room.occupant);
    return availability === "occupied" &&
        (!occupant || isMaintenanceStatus(occupant)) &&
        !activeMonthly &&
        !pendingMonthly &&
        !activeTransient;
}

function getMonthlyBookingsForRoom(room) {
    const roomName = String(room.room || "").trim();
    const bedNo = String(room.bedNo || "").trim();
    return roomsState.monthlyBookings.filter((booking) =>
        String(booking.room || "").trim() === roomName &&
        String(booking.bed || booking.bedNo || "").trim() === bedNo
    );
}

function getTransientBookingsForRoom(room) {
    const roomName = String(room.room || "").trim();
    const bedNo = String(room.bedNo || "").trim();
    return roomsState.transientBookings.filter((booking) =>
        String(booking.room || "").trim() === roomName &&
        String(booking.bed || booking.bedNo || "").trim() === bedNo &&
        isTransientActive(booking.status)
    );
}

function getUnifiedRoomStatus(room) {
    const availability = normalize(room.avail);
    const monthlyBookings = getMonthlyBookingsForRoom(room);
    const activeMonthly = monthlyBookings.find((booking) => isMonthlyActive(booking.status));
    const pendingMonthly = monthlyBookings.find((booking) => isMonthlyPending(booking.status));
    const activeTransient = getTransientBookingsForRoom(room)[0];

    if (isMaintenanceStatus(availability) || isMaintenanceStatus(room.occupant) || isLegacyMaintenanceRoom(room, { activeMonthly, pendingMonthly, activeTransient })) {
        return {
            key: "maintenance",
            label: "Maintenance",
            occupant: room.occupant || "Unavailable for booking",
            source: availability === "occupied" ? "Room maintenance record" : "Room maintenance"
        };
    }

    if (activeMonthly || availability === "occupied") {
        return {
            key: "monthly_occupied",
            label: "Monthly Occupied",
            occupant: room.occupant || activeMonthly?.fullName || activeMonthly?.email || "Occupied",
            source: activeMonthly ? "Monthly booking" : "Room record"
        };
    }

    if (availability === "reserved") {
        return {
            key: "reserved",
            label: "Reserved",
            occupant: room.reservationOccupant || pendingMonthly?.fullName || pendingMonthly?.email || "Reserved applicant",
            source: "Awaiting down payment"
        };
    }

    if (activeTransient) {
        return {
            key: "transient_reserved",
            label: activeTransient.status === "checked_in" ? "Transient Checked In" : "Transient Reserved",
            occupant: activeTransient.fullName || activeTransient.email || "Transient guest",
            source: `Transient ${formatDate(activeTransient.checkInDate)} - ${formatDate(activeTransient.checkOutDate)}`
        };
    }

    if (pendingMonthly) {
        return {
            key: "pending_booking",
            label: "Pending Booking",
            occupant: pendingMonthly.fullName || pendingMonthly.email || "Pending applicant",
            source: "Monthly request awaiting decision"
        };
    }

    return {
        key: "available",
        label: "Available",
        occupant: "",
        source: "Ready for booking"
    };
}

async function loadRooms() {
    const tableBody = document.getElementById("rooms-table-body");
    if (tableBody) {
        tableBody.innerHTML = "<tr><td colspan='8'>Loading room statuses...</td></tr>";
    }

    try {
        const [roomsSnapshot, monthlySnapshot, transientSnapshot] = await Promise.all([
            db.collection("ROOMS").get(),
            db.collection("bookingRequest").get(),
            db.collection("transientBedBookings").get()
        ]);

        roomsState.rooms = roomsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        roomsState.monthlyBookings = monthlySnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        roomsState.transientBookings = transientSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

        renderRooms();
    } catch (error) {
        console.error("Failed to load room statuses:", error);
        if (tableBody) {
            tableBody.innerHTML = "<tr><td colspan='8'>Error loading room statuses.</td></tr>";
        }
    }
}

function renderRooms() {
    roomsState.rows = [];
    const tableBody = document.getElementById("rooms-table-body");
    const cardsContainer = document.getElementById("adminRoomsContainer");
    if (!tableBody) return;

    tableBody.innerHTML = "";
    if (cardsContainer) cardsContainer.innerHTML = "";

    const counts = {
        available: 0,
        monthly_occupied: 0,
        transient_reserved: 0,
        pending_booking: 0,
        maintenance: 0
    };

    roomsState.rooms.forEach((room) => {
        const status = getUnifiedRoomStatus(room);
        counts[status.key] = (counts[status.key] || 0) + 1;

        const row = document.createElement("tr");
        row.dataset.id = room.id;
        row.innerHTML = `
            <td class="room-select-cell"><input type="checkbox" class="room-select-checkbox" data-room-id="${escapeHtml(room.id)}" aria-label="Select Room ${escapeHtml(room.room || "")}, Bed ${escapeHtml(room.bedNo || "")}"></td>
            <td>${escapeHtml(room.room || "")}</td>
            <td>${escapeHtml(room.bedNo || "")}</td>
            <td><span class="room-type-pill ${normalize(room.type) === "premium" ? "premium" : "standard"}">${escapeHtml(room.type || "")}</span></td>
            <td>
                <span class="room-status-pill ${status.key}">${escapeHtml(status.label)}</span>
                <div class="room-status-source">${escapeHtml(status.source)}</div>
            </td>
            <td>${escapeHtml(room.gender || "")}</td>
            <td>
                <div class="room-occupant">${escapeHtml(status.occupant || "No assigned tenant")}</div>
                <div class="room-status-source">${escapeHtml(room.maintenanceNote || "")}</div>
            </td>
            <td>
                <div class="room-row-actions">
                    <button type="button" class="room-action-btn small" data-action="details">Details</button>
                    ${status.key === "maintenance"
                        ? `<button type="button" class="room-action-btn small success" data-action="available">Mark Available</button>`
                        : `<button type="button" class="room-action-btn small warning" data-action="maintenance">Maintenance</button>`}
                </div>
            </td>
        `;

        tableBody.appendChild(row);
        row.querySelector(".room-select-checkbox").checked = roomsState.selectedRoomIds.has(room.id);

        roomsState.rows.push({
            element: row,
            cardElement: null,
            cardSection: null,
            id: room.id,
            room,
            status,
            roomLabel: String(room.room || ""),
            bedNo: String(room.bedNo || ""),
            type: String(room.type || ""),
            gender: String(room.gender || ""),
            occupant: status.occupant,
            searchText: `${room.room || ""} ${room.bedNo || ""} ${room.type || ""} ${room.gender || ""} ${status.label} ${status.occupant || ""}`.toLowerCase()
        });
    });

    renderRoomCards();
    updateStats(counts);
    renderRoomAnalytics(counts);
    renderRoomTrends();
    applyRoomViewMode();
    applyRoomFilters();
    syncBulkSelectionUi();
}

function renderRoomCards() {
    const container = document.getElementById("adminRoomsContainer");
    if (!container) return;

    container.innerHTML = "";
    const groupedRooms = new Map();
    roomsState.rows.forEach((rowData) => {
        const roomName = String(rowData.room.room || "Unassigned Room").trim();
        if (!groupedRooms.has(roomName)) groupedRooms.set(roomName, []);
        groupedRooms.get(roomName).push(rowData);
    });

    [...groupedRooms.entries()]
        .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
        .forEach(([roomName, rows]) => {
            const firstRoom = rows[0]?.room || {};
            const section = document.createElement("section");
            section.className = "admin-room-section";
            section.innerHTML = `
                <div class="admin-room-section-header">
                    <div>
                        <div class="admin-room-section-name">Room ${escapeHtml(roomName)}</div>
                        <div class="admin-room-section-meta">${escapeHtml(firstRoom.type || "Room")} - ${escapeHtml(firstRoom.gender || "Mixed")} Policy</div>
                    </div>
                    <div class="admin-room-section-count">${rows.length} bedspace${rows.length === 1 ? "" : "s"}</div>
                </div>
                <div class="admin-beds-grid"></div>
            `;

            const bedsGrid = section.querySelector(".admin-beds-grid");
            rows
                .sort((left, right) => String(left.bedNo).localeCompare(String(right.bedNo), undefined, { numeric: true }))
                .forEach((rowData) => {
                    const { room, status } = rowData;
                    const showStatusSource = status.source && status.source !== "Ready for booking";
                    const showOccupant = status.occupant && status.occupant !== "No assigned tenant";
                    const bedBox = document.createElement("div");
                    bedBox.className = `admin-bed-box ${status.key}`;
                    bedBox.dataset.id = rowData.id;
                    bedBox.innerHTML = `
                <div class="admin-bed-topline">
                    <span class="admin-bed-number">${escapeHtml(room.bedNo || "")}</span>
                    <span class="room-type-pill ${normalize(room.type) === "premium" ? "premium" : "standard"}">${escapeHtml(room.type || "")}</span>
                </div>
                <div class="admin-bed-status">
                    <span class="room-status-pill ${status.key}">${escapeHtml(status.label)}</span>
                    ${showStatusSource ? `<span>${escapeHtml(status.source)}</span>` : ""}
                </div>
                ${showOccupant ? `<div class="admin-bed-tenant">${escapeHtml(status.occupant)}</div>` : ""}
                ${room.maintenanceNote ? `<div class="admin-bed-note">${escapeHtml(room.maintenanceNote)}</div>` : ""}
                <label class="admin-room-select">
                    <input type="checkbox" class="room-select-checkbox" data-room-id="${escapeHtml(room.id)}" aria-label="Select Room ${escapeHtml(room.room || "")}, Bed ${escapeHtml(room.bedNo || "")}">
                    <span>Select bedspace</span>
                </label>
                <div class="admin-bed-actions">
                    <button type="button" class="room-action-btn small" data-action="details">Details</button>
                    ${status.key === "maintenance"
                        ? `<button type="button" class="room-action-btn small success" data-action="available">Mark Available</button>`
                        : `<button type="button" class="room-action-btn small warning" data-action="maintenance">Maintenance</button>`}
                </div>
            `;
                    bedBox.querySelector(".room-select-checkbox").checked = roomsState.selectedRoomIds.has(room.id);
                    rowData.cardElement = bedBox;
                    rowData.cardSection = section;
                    bedsGrid.appendChild(bedBox);
                });

            container.appendChild(section);
        });
}

function applyRoomViewMode() {
    const tableWrap = document.querySelector(".table-wrap");
    const cardsContainer = document.getElementById("adminRoomsContainer");
    const tableBtn = document.getElementById("roomsTableViewBtn");
    const cardBtn = document.getElementById("roomsCardViewBtn");
    const isCards = roomsState.viewMode === "cards";

    if (tableWrap) tableWrap.hidden = isCards;
    if (cardsContainer) cardsContainer.hidden = !isCards;
    tableBtn?.classList.toggle("active", !isCards);
    cardBtn?.classList.toggle("active", isCards);
}

function updateStats(counts) {
    const total = roomsState.rooms.length;
    const occupied = counts.monthly_occupied + counts.transient_reserved;
    const available = counts.available;
    const rate = total ? ((occupied / total) * 100).toFixed(1) : 0;
    const uniqueRooms = new Set(roomsState.rooms.map((room) => String(room.room || "").trim()).filter(Boolean)).size;

    document.getElementById("stat-totalrooms").textContent = uniqueRooms;
    document.getElementById("stat-value").textContent = total;
    document.getElementById("stat-occupied").textContent = `${occupied} In Use`;
    document.getElementById("stat-available").textContent = `${available} available, ${counts.maintenance} maintenance`;
    document.getElementById("stat-occupancy").textContent = `${rate}%`;
    const summary = document.getElementById("roomsTableSummary");
    if (summary) {
        summary.textContent = `${total} bedspaces total - ${available} available, ${occupied} in use, ${counts.pending_booking} pending, ${counts.maintenance} maintenance`;
    }
}

function renderRoomAnalytics(counts) {
    const container = document.getElementById("roomAnalyticsGrid");
    if (!container) return;

    const cards = [
        { label: "Available", value: counts.available, note: "Ready for monthly or transient booking" },
        { label: "Monthly Occupied", value: counts.monthly_occupied, note: "Long-term tenants" },
        { label: "Transient Reserved", value: counts.transient_reserved, note: "Short-stay requests using shared beds" },
        { label: "Maintenance", value: counts.maintenance, note: "Blocked from booking" }
    ];

    container.innerHTML = cards.map((card) => `
        <div class="room-analytics-card">
            <div class="room-analytics-label">${escapeHtml(card.label)}</div>
            <div class="room-analytics-value">${escapeHtml(card.value)}</div>
            <div class="room-analytics-note">${escapeHtml(card.note)}</div>
        </div>
    `).join("");
}

function renderRoomTrends() {
    const container = document.getElementById("roomTrendList");
    if (!container) return;

    const now = new Date();
    const trendValues = [];

    for (let offset = 5; offset >= 0; offset -= 1) {
        const current = new Date(now.getFullYear(), now.getMonth() - offset, 1);
        const approved = roomsState.monthlyBookings.filter((booking) => {
            const createdAt = booking.createdAt?.toDate?.() || null;
            return normalize(booking.status) === "approved" &&
                createdAt &&
                createdAt.getMonth() === current.getMonth() &&
                createdAt.getFullYear() === current.getFullYear();
        }).length;

        trendValues.push({
            month: current.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
            approved
        });
    }

    const maxApproved = Math.max(...trendValues.map((item) => item.approved), 1);
    container.innerHTML = trendValues.map((item) => `
        <div>
            <div class="room-trend-row">
                <span>${escapeHtml(item.month)}</span>
                <span>${item.approved} approved move-ins</span>
            </div>
            <div class="room-trend-track">
                <div class="room-trend-fill" style="width:${(item.approved / maxApproved) * 100}%;"></div>
            </div>
        </div>
    `).join("");
}

function createDetailItem(label, value) {
    return `
        <div class="room-detail-item">
            <div class="room-detail-label">${escapeHtml(label)}</div>
            <div class="room-detail-value">${escapeHtml(value || "None")}</div>
        </div>
    `;
}

function showRoomNotice(message) {
    if (typeof showFormalAlert === "function") {
        showFormalAlert(message);
        return;
    }

    console.info(message);
}

function confirmRoomAction({
    title,
    message,
    confirmLabel = "Confirm",
    confirmClass = "warning",
    noteVisible = false,
    notePlaceholder = "Optional note",
    noteValue = "",
    icon = "&#9888;"
}) {
    const overlay = document.getElementById("roomActionConfirm");
    const titleEl = document.getElementById("roomConfirmTitle");
    const textEl = document.getElementById("roomConfirmText");
    const iconEl = document.getElementById("roomConfirmIcon");
    const noteEl = document.getElementById("roomConfirmNote");
    const cancelBtn = document.getElementById("roomConfirmCancel");
    const submitBtn = document.getElementById("roomConfirmSubmit");

    if (!overlay || !titleEl || !textEl || !noteEl || !cancelBtn || !submitBtn) {
        return Promise.resolve({ confirmed: false, note: "" });
    }

    titleEl.textContent = title;
    textEl.textContent = message;
    iconEl.innerHTML = icon;
    noteEl.value = noteValue || "";
    noteEl.placeholder = notePlaceholder;
    noteEl.classList.toggle("visible", Boolean(noteVisible));
    submitBtn.textContent = confirmLabel;
    submitBtn.className = `room-action-btn ${confirmClass}`;
    overlay.classList.add("open");

    if (noteVisible) {
        setTimeout(() => noteEl.focus(), 50);
    }

    return new Promise((resolve) => {
        const close = (confirmed) => {
            const note = noteEl.value.trim();
            overlay.classList.remove("open");
            cancelBtn.removeEventListener("click", handleCancel);
            submitBtn.removeEventListener("click", handleSubmit);
            overlay.removeEventListener("click", handleOverlay);
            document.removeEventListener("keydown", handleKeydown);
            resolve({ confirmed, note });
        };

        const handleCancel = () => close(false);
        const handleSubmit = () => close(true);
        const handleOverlay = (event) => {
            if (event.target === overlay) close(false);
        };
        const handleKeydown = (event) => {
            if (event.key === "Escape") close(false);
        };

        cancelBtn.addEventListener("click", handleCancel);
        submitBtn.addEventListener("click", handleSubmit);
        overlay.addEventListener("click", handleOverlay);
        document.addEventListener("keydown", handleKeydown);
    });
}

function openRoomDetails(rowData) {
    roomsState.activeRoom = rowData;
    const room = rowData.room;
    const monthly = getMonthlyBookingsForRoom(room).filter((booking) =>
        isMonthlyActive(booking.status) || isMonthlyPending(booking.status)
    );
    const transient = getTransientBookingsForRoom(room);

    document.getElementById("roomDetailTitle").textContent = `Room ${room.room || ""}, Bed ${room.bedNo || ""}`;
    document.getElementById("roomDetailSubtitle").textContent = `${rowData.status.label} - ${rowData.status.source}`;
    document.getElementById("roomMaintenanceNote").value = room.maintenanceNote || "";

    document.getElementById("roomDetailGrid").innerHTML = [
        createDetailItem("Room Type", room.type || ""),
        createDetailItem("Gender Policy", room.gender || ""),
        createDetailItem("Unified Status", rowData.status.label),
        createDetailItem("Room Record Status", room.avail || ""),
        createDetailItem("Current Tenant / Guest", rowData.status.occupant || ""),
        createDetailItem("Document ID", rowData.id)
    ].join("");

    const related = [
        ...monthly.map((booking) => ({
            type: "Monthly Booking",
            title: booking.fullName || booking.email || "Applicant",
            meta: `${formatStatusLabel(booking.status)}${booking.moveInDate ? ` - Move in ${formatDate(booking.moveInDate)}` : ""}`,
            link: "bookings.html"
        })),
        ...transient.map((booking) => ({
            type: "Transient Bed",
            title: booking.fullName || booking.email || "Guest",
            meta: `${formatStatusLabel(booking.status)} - ${formatDate(booking.checkInDate)} to ${formatDate(booking.checkOutDate)}`,
            link: "transient-beds.html"
        }))
    ];

    document.getElementById("roomRelatedList").innerHTML = related.length
        ? related.map((item) => `
            <a class="room-related-item" href="${escapeHtml(item.link)}">
                <div>
                    <div class="room-related-type">${escapeHtml(item.type)}</div>
                    <div class="room-related-title">${escapeHtml(item.title)}</div>
                    <div class="room-related-meta">${escapeHtml(item.meta)}</div>
                </div>
                <span>&rsaquo;</span>
            </a>
        `).join("")
        : `<div class="room-related-empty">No monthly or transient request is currently attached to this bedspace.</div>`;

    const maintenanceBtn = document.getElementById("roomMaintenanceBtn");
    const availableBtn = document.getElementById("roomAvailableBtn");
    maintenanceBtn.style.display = rowData.status.key === "maintenance" ? "none" : "";
    availableBtn.style.display = rowData.status.key === "maintenance" ? "" : "none";

    document.getElementById("room-detail-modal").classList.add("open");
    document.body.style.overflow = "hidden";
}

function closeRoomDetails() {
    roomsState.activeRoom = null;
    document.getElementById("room-detail-modal")?.classList.remove("open");
    document.body.style.overflow = "";
}

async function updateRoomAvailability(rowData, avail, button) {
    if (!rowData) return;

    const room = rowData.room;
    const maintenanceNote = document.getElementById("roomMaintenanceNote")?.value || room.maintenanceNote || "";

    try {
        setAdminButtonLoading?.(button, avail === "Maintenance" ? "Marking..." : "Saving...");
        await callAdminApi("/api/admin/rooms/update", {
            roomId: rowData.id,
            room: room.room || "",
            bedNo: room.bedNo || "",
            type: room.type || "",
            avail,
            gender: room.gender || "",
            occupant: avail === "Available" ? "" : avail === "Maintenance" ? "Maintenance" : room.occupant || "",
            maintenanceNote
        });
        await loadRooms();
        closeRoomDetails();
        showRoomNotice(avail === "Maintenance"
            ? "Bedspace was marked as maintenance."
            : "Bedspace was marked as available.");
    } catch (error) {
        console.error("Room status update failed:", error);
        showRoomNotice(error.message || "Unable to update room status.");
    } finally {
        restoreAdminButton?.(button);
    }
}

function getVisibleSelectedRoomIds() {
    return roomsState.rows
        .filter((row) => row.element.style.display !== "none" && roomsState.selectedRoomIds.has(row.id))
        .map((row) => row.id);
}

function syncBulkSelectionUi() {
    const selectedCount = roomsState.selectedRoomIds.size;
    const bulkBar = document.getElementById("roomsBulkBar");
    const bulkCount = document.getElementById("roomsBulkCount");
    const selectAll = document.getElementById("selectAllRooms");
    const visibleRows = roomsState.rows.filter((row) => row.element.style.display !== "none");
    const visibleSelected = visibleRows.filter((row) => roomsState.selectedRoomIds.has(row.id));

    document.querySelectorAll(".room-select-checkbox").forEach((checkbox) => {
        checkbox.checked = roomsState.selectedRoomIds.has(checkbox.dataset.roomId);
    });

    if (bulkBar) {
        bulkBar.classList.toggle("active", selectedCount > 0);
    }
    if (bulkCount) {
        bulkCount.textContent = `${selectedCount} selected`;
    }
    if (selectAll) {
        selectAll.checked = visibleRows.length > 0 && visibleSelected.length === visibleRows.length;
        selectAll.indeterminate = visibleSelected.length > 0 && visibleSelected.length < visibleRows.length;
    }
}

function clearBulkSelection() {
    roomsState.selectedRoomIds.clear();
    syncBulkSelectionUi();
}

async function updateSelectedRooms(avail, button) {
    const selectedIds = [...roomsState.selectedRoomIds];
    if (!selectedIds.length) {
        showRoomNotice("Please select at least one bedspace first.");
        return;
    }

    const isMaintenance = avail === "Maintenance";
    const result = await confirmRoomAction({
        title: isMaintenance ? "Mark Selected Bedspaces as Maintenance?" : "Mark Selected Bedspaces as Available?",
        message: isMaintenance
            ? `This will block ${selectedIds.length} selected bedspace(s) from monthly and transient bookings.`
            : `This will reopen ${selectedIds.length} selected bedspace(s) for booking requests.`,
        confirmLabel: isMaintenance ? "Mark Maintenance" : "Mark Available",
        confirmClass: isMaintenance ? "warning" : "success",
        noteVisible: isMaintenance,
        notePlaceholder: "Add one maintenance note for all selected bedspaces",
        icon: isMaintenance ? "&#9888;" : "&#10004;"
    });

    if (!result.confirmed) return;

    try {
        setAdminButtonLoading?.(button, isMaintenance ? "Marking..." : "Saving...");
        await callAdminApi("/api/admin/rooms/bulk-update", {
            roomIds: selectedIds,
            avail,
            maintenanceNote: result.note
        });
        showRoomNotice(isMaintenance
            ? `${selectedIds.length} bedspace(s) were marked as maintenance.`
            : `${selectedIds.length} bedspace(s) were marked as available.`);
        clearBulkSelection();
        await loadRooms();
    } catch (error) {
        console.error("Bulk room update failed:", error);
        showRoomNotice(error.message || "Unable to update selected bedspaces.");
    } finally {
        restoreAdminButton?.(button);
    }
}

function bindRoomUi() {
    const tableBody = document.getElementById("rooms-table-body");
    const handleRoomActionClick = async (event) => {
        const checkbox = event.target.closest(".room-select-checkbox");
        if (checkbox) {
            if (checkbox.checked) {
                roomsState.selectedRoomIds.add(checkbox.dataset.roomId);
            } else {
                roomsState.selectedRoomIds.delete(checkbox.dataset.roomId);
            }
            syncBulkSelectionUi();
            return;
        }

        const button = event.target.closest("button[data-action]");
        if (!button) return;

        const roomElement = button.closest("tr, .admin-bed-box");
        const rowData = roomsState.rows.find((row) => row.id === roomElement?.dataset.id);
        if (!rowData) return;

        if (button.dataset.action === "details") {
            openRoomDetails(rowData);
            return;
        }

        if (button.dataset.action === "maintenance") {
            const result = await confirmRoomAction({
                title: "Mark Bedspace as Maintenance?",
                message: `This will block Room ${rowData.room.room || ""}, Bed ${rowData.room.bedNo || ""} from monthly and transient bookings.`,
                confirmLabel: "Mark Maintenance",
                confirmClass: "warning",
                noteVisible: true,
                notePlaceholder: "Add a maintenance note for this bedspace",
                noteValue: rowData.room.maintenanceNote || ""
            });
            if (!result.confirmed) return;
            rowData.room.maintenanceNote = result.note;
            await updateRoomAvailability(rowData, "Maintenance", button);
            return;
        }

        if (button.dataset.action === "available") {
            const result = await confirmRoomAction({
                title: "Mark Bedspace as Available?",
                message: `This will reopen Room ${rowData.room.room || ""}, Bed ${rowData.room.bedNo || ""} for booking requests.`,
                confirmLabel: "Mark Available",
                confirmClass: "success",
                icon: "&#10004;"
            });
            if (!result.confirmed) return;
            await updateRoomAvailability(rowData, "Available", button);
        }
    };

    tableBody?.addEventListener("click", handleRoomActionClick);
    document.getElementById("adminRoomsContainer")?.addEventListener("click", handleRoomActionClick);

    document.querySelectorAll(".room-view-toggle").forEach((button) => {
        button.addEventListener("click", () => {
            roomsState.viewMode = button.dataset.view === "cards" ? "cards" : "table";
            applyRoomViewMode();
        });
    });

    document.getElementById("roomDetailClose")?.addEventListener("click", closeRoomDetails);
    document.getElementById("roomModalCloseBtn")?.addEventListener("click", closeRoomDetails);
    document.getElementById("room-detail-modal")?.addEventListener("click", (event) => {
        if (event.target.id === "room-detail-modal") closeRoomDetails();
    });
    document.getElementById("roomMaintenanceBtn")?.addEventListener("click", async (event) => {
        if (!roomsState.activeRoom) return;
        const result = await confirmRoomAction({
            title: "Mark Bedspace as Maintenance?",
            message: `This will block Room ${roomsState.activeRoom.room.room || ""}, Bed ${roomsState.activeRoom.room.bedNo || ""} from monthly and transient bookings.`,
            confirmLabel: "Mark Maintenance",
            confirmClass: "warning",
            noteVisible: false
        });
        if (!result.confirmed) return;
        updateRoomAvailability(roomsState.activeRoom, "Maintenance", event.currentTarget);
    });
    document.getElementById("roomAvailableBtn")?.addEventListener("click", async (event) => {
        if (!roomsState.activeRoom) return;
        const result = await confirmRoomAction({
            title: "Mark Bedspace as Available?",
            message: `This will reopen Room ${roomsState.activeRoom.room.room || ""}, Bed ${roomsState.activeRoom.room.bedNo || ""} for booking requests.`,
            confirmLabel: "Mark Available",
            confirmClass: "success",
            icon: "&#10004;"
        });
        if (!result.confirmed) return;
        updateRoomAvailability(roomsState.activeRoom, "Available", event.currentTarget);
    });

    document.getElementById("selectAllRooms")?.addEventListener("change", (event) => {
        const checked = event.currentTarget.checked;
        roomsState.rows
            .filter((row) => row.element.style.display !== "none")
            .forEach((row) => {
                if (checked) {
                    roomsState.selectedRoomIds.add(row.id);
                } else {
                    roomsState.selectedRoomIds.delete(row.id);
                }
            });
        syncBulkSelectionUi();
    });

    document.getElementById("bulkMaintenanceBtn")?.addEventListener("click", (event) => {
        updateSelectedRooms("Maintenance", event.currentTarget);
    });
    document.getElementById("bulkAvailableBtn")?.addEventListener("click", (event) => {
        updateSelectedRooms("Available", event.currentTarget);
    });
    document.getElementById("bulkClearBtn")?.addEventListener("click", clearBulkSelection);
}

function applyRoomFilters() {
    const search = normalize(document.getElementById("room-search")?.value || "");
    const type = normalize(document.getElementById("room-type-filter")?.value || "");
    const availability = normalize(document.getElementById("room-availability-filter")?.value || "");
    const gender = normalize(document.getElementById("room-gender-filter")?.value || "");

    roomsState.rows.forEach((rowData) => {
        const matchesSearch = !search || rowData.searchText.includes(search);
        const matchesType = !type || normalize(rowData.type) === type;
        const matchesAvailability = !availability ||
            rowData.status.key === availability ||
            (availability === "maintenance" && isMaintenanceStatus(rowData.room.avail));
        const matchesGender = !gender || normalize(rowData.gender) === gender;

        rowData.element.style.display = matchesSearch && matchesType && matchesAvailability && matchesGender ? "" : "none";
        if (rowData.cardElement) {
            rowData.cardElement.style.display = matchesSearch && matchesType && matchesAvailability && matchesGender ? "" : "none";
        }
    });

    document.querySelectorAll(".admin-room-section").forEach((section) => {
        const visibleBeds = [...section.querySelectorAll(".admin-bed-box")]
            .filter((bed) => bed.style.display !== "none");
        section.style.display = visibleBeds.length ? "" : "none";
    });

    syncBulkSelectionUi();
}

function setupFilters() {
    ["room-search", "room-type-filter", "room-availability-filter", "room-gender-filter"].forEach((id) => {
        const element = document.getElementById(id);
        element?.addEventListener("input", applyRoomFilters);
        element?.addEventListener("change", applyRoomFilters);
    });
}

function setupExport() {
    const getVisibleRows = () => roomsState.rows.filter((row) => row.element.style.display !== "none");
    const escapeCsv = (value) => {
        const text = String(value ?? "");
        return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const downloadTextFile = (filename, content, type = "text/csv;charset=utf-8") => {
        const blob = new Blob([content], { type });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        link.click();
        URL.revokeObjectURL(link.href);
    };

    document.getElementById("export-csv-btn")?.addEventListener("click", () => {
        const rows = getVisibleRows();
        if (!rows.length) {
            showRoomNotice("There are no room records to export using the current filters.");
            return;
        }

        const headers = [
            "Room",
            "Bedspace Number",
            "Room Type",
            "Bed Status",
            "Status Source",
            "Gender Policy",
            "Tenant/Request",
            "Maintenance Note",
            "Room Record Status",
            "Record ID"
        ];
        const lines = [
            headers.map(escapeCsv).join(","),
            ...rows.map((row) => [
                row.roomLabel,
                row.bedNo,
                row.type,
                row.status.label,
                row.status.source,
                row.gender,
                row.occupant || "None",
                row.room.maintenanceNote || "",
                row.room.avail || "",
                row.id
            ].map(escapeCsv).join(","))
        ];

        downloadTextFile(`citihub_rooms_${new Date().toISOString().slice(0, 10)}.csv`, lines.join("\n"));
        showRoomNotice("Rooms CSV export has been downloaded.");
    });

    document.getElementById("export-btn")?.addEventListener("click", () => {
        const rows = getVisibleRows();
        const counts = rows.reduce((acc, row) => {
            acc[row.status.key] = (acc[row.status.key] || 0) + 1;
            return acc;
        }, {});

        if (!window.jspdf?.jsPDF) {
            const content = [
                "CITIHUB DORMITORY - ROOMS REPORT",
                "=".repeat(58),
                `Generated: ${new Date().toLocaleString()}`,
                "",
                `Visible bedspaces: ${rows.length}`,
                `Available: ${counts.available || 0}`,
                `Monthly occupied: ${counts.monthly_occupied || 0}`,
                `Transient reserved: ${counts.transient_reserved || 0}`,
                `Pending booking: ${counts.pending_booking || 0}`,
                `Maintenance: ${counts.maintenance || 0}`,
                "",
                ...rows.map((row) => `Room ${row.roomLabel}, Bed ${row.bedNo} | ${row.type} | ${row.status.label} | ${row.gender} | ${row.occupant || "None"}`)
            ].join("\n");
            downloadTextFile("rooms_report.txt", content, "text/plain;charset=utf-8");
            return;
        }

        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF({ orientation: "landscape" });
        const pageWidth = pdf.internal.pageSize.getWidth();
        const pageHeight = pdf.internal.pageSize.getHeight();
        let y = 38;

        const ensureSpace = () => {
            if (y > pageHeight - 18) {
                pdf.addPage();
                y = 18;
            }
        };

        pdf.setFillColor(26, 122, 74);
        pdf.rect(0, 0, pageWidth, 28, "F");
        pdf.setTextColor(255, 255, 255);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(16);
        pdf.text("CITIHUB DORMITORY", 14, 13);
        pdf.setFontSize(10);
        pdf.setFont("helvetica", "normal");
        pdf.text("Rooms and Bedspaces Report", 14, 21);
        pdf.setTextColor(26, 26, 46);

        pdf.setFontSize(10);
        pdf.text(`Generated: ${new Date().toLocaleString()}`, 14, y); y += 8;
        pdf.text(`Shown: ${rows.length}   Available: ${counts.available || 0}   Monthly: ${counts.monthly_occupied || 0}   Transient: ${counts.transient_reserved || 0}   Pending: ${counts.pending_booking || 0}   Maintenance: ${counts.maintenance || 0}`, 14, y); y += 12;

        pdf.setFont("helvetica", "bold");
        pdf.text("Room", 14, y);
        pdf.text("Bed", 42, y);
        pdf.text("Type", 62, y);
        pdf.text("Status", 98, y);
        pdf.text("Gender", 152, y);
        pdf.text("Tenant / Request", 184, y);
        pdf.text("Source", 238, y);
        y += 6;
        pdf.setDrawColor(229, 231, 235);
        pdf.line(14, y, pageWidth - 14, y);
        y += 7;
        pdf.setFont("helvetica", "normal");

        rows.forEach((row) => {
            ensureSpace();
            pdf.text(String(row.roomLabel || "").slice(0, 12), 14, y);
            pdf.text(String(row.bedNo || "").slice(0, 10), 42, y);
            pdf.text(String(row.type || "").slice(0, 16), 62, y);
            pdf.text(String(row.status.label || "").slice(0, 24), 98, y);
            pdf.text(String(row.gender || "").slice(0, 12), 152, y);
            pdf.text(String(row.occupant || "None").slice(0, 26), 184, y);
            pdf.text(String(row.status.source || "").slice(0, 24), 238, y);
            y += 7;
        });

        pdf.setFontSize(8);
        pdf.setTextColor(107, 114, 128);
        pdf.text("Generated by CitiHub Admin Rooms", 14, pageHeight - 8);
        pdf.save("rooms_bedspaces_report.pdf");
    });
}

document.querySelectorAll("#btnLogout").forEach((button) => {
    button.addEventListener("click", logoutAdmin);
});
