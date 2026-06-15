const ADDON_CATALOG = [
    {
        id: "locker_medium",
        name: "Medium Locker",
        price: 200,
        billingType: "monthly",
        description: "Extra secured medium-size locker for personal belongings."
    },
    {
        id: "motorcycle_parking",
        name: "Motorcycle Parking",
        price: 600,
        billingType: "monthly",
        description: "Reserved monthly motorcycle parking slot inside CitiHub."
    },
    {
        id: "car_parking",
        name: "Car Parking",
        price: 4000,
        billingType: "monthly",
        description: "Reserved monthly car parking slot for approved tenants."
    },
    {
        id: "wifi",
        name: "WiFi",
        price: 200,
        billingType: "monthly",
        description: "Shared monthly WiFi access for your approved tenancy."
    }
];

const ADDON_LOOKUP = ADDON_CATALOG.reduce((lookup, addon) => {
    lookup[addon.id] = addon;
    return lookup;
}, {});

function normalizeAddonId(value) {
    return String(value || "").trim().toLowerCase();
}

function getAddonCatalog() {
    return ADDON_CATALOG.map((addon) => ({ ...addon }));
}

function getAddonDefinition(addonId) {
    const normalizedId = normalizeAddonId(addonId);
    return normalizedId ? ADDON_LOOKUP[normalizedId] || null : null;
}

function sanitizeRequestedAddons(requestedAddons = []) {
    if (!Array.isArray(requestedAddons)) {
        return [];
    }

    const unique = new Set();
    return requestedAddons
        .map((entry) => {
            if (typeof entry === "string") {
                return normalizeAddonId(entry);
            }

            return normalizeAddonId(entry?.addonId || entry?.id);
        })
        .filter((addonId) => addonId && !unique.has(addonId) && unique.add(addonId))
        .map((addonId) => getAddonDefinition(addonId))
        .filter(Boolean)
        .map((addon) => ({
            addonId: addon.id,
            addonName: addon.name,
            price: addon.price,
            billingType: addon.billingType,
            description: addon.description
        }));
}

module.exports = {
    getAddonCatalog,
    getAddonDefinition,
    normalizeAddonId,
    sanitizeRequestedAddons
};
