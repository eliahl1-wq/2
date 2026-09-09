import { SURVIV, applySurvivFireInput, beginSurvivReload } from './surviv-engine.js';

const survivItemKeys = new Set(['weapon', 'money', 'medkits', 'ammo', 'grenades', 'armor']);
const survivAmmoTypes = new Set(['9mm', '12g', '556', '762']);

// Shared by normal Surviv and BR after server-side room/match authorization.
export function applySurvivInputPayload(player, payload = {}) {
    if (!player || player.disconnected || player.hp <= 0 || player._eliminated
        || !payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const finiteClamp = (value, min, max, fallback = 0) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
    };
    const safeId = (value, maxLength = 128) => (
        typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null
    );
    const {
        dx,
        dy,
        aimAngle,
        aimDistance,
        shooting,
        firePressId,
        reload,
        useMedkit,
        pickupWeapon,
        pickupVestId,
        toggleDoorId,
        equipSlot,
        throwGrenade,
        openChestId,
        chestHoldId,
        swapWeaponSlots,
        closeChest,
        dropItem,
    } = payload;

    if (player.cashoutHoldActive || player.isCashingOut) {
        player.inputDx = 0;
        player.inputDy = 0;
        player.shooting = false;
        return;
    }

    player.inputDx = finiteClamp(dx, -1, 1);
    player.inputDy = finiteClamp(dy, -1, 1);
    const parsedAim = Number(aimAngle);
    if (Number.isFinite(parsedAim)) {
        player.aimAngle = Math.atan2(Math.sin(parsedAim), Math.cos(parsedAim));
    }
    player.aimDistance = finiteClamp(aimDistance, SURVIV.grenadeMinRange, SURVIV.grenadeMaxRange, 300);

    applySurvivFireInput(player, shooting, firePressId);
    if (useMedkit === true) player.useMedkit = true;
    if (pickupWeapon === true) player.pickupWeaponPending = true;
    else {
        const requestedWeaponId = safeId(pickupWeapon);
        if (requestedWeaponId) player.pickupWeaponPending = requestedWeaponId;
    }
    const requestedVestId = safeId(pickupVestId);
    if (requestedVestId) player.pickupVestId = requestedVestId;
    const requestedDoorId = safeId(toggleDoorId);
    if (requestedDoorId) player.toggleDoorId = requestedDoorId;
    if (throwGrenade === true) player.throwGrenadePending = true;

    const requestedChestId = safeId(openChestId);
    if (requestedChestId) player.openChestId = requestedChestId;
    player.chestHoldId = safeId(chestHoldId);
    player.chestHoldSeenAt = Date.now();

    if (swapWeaponSlots && typeof swapWeaponSlots === 'object' && !Array.isArray(swapWeaponSlots)) {
        const fromSlot = Number.isInteger(swapWeaponSlots.fromSlot) && swapWeaponSlots.fromSlot >= 0 && swapWeaponSlots.fromSlot < 2
            ? swapWeaponSlots.fromSlot
            : null;
        const toSlot = Number.isInteger(swapWeaponSlots.toSlot) && swapWeaponSlots.toSlot >= 0 && swapWeaponSlots.toSlot < 2
            ? swapWeaponSlots.toSlot
            : null;
        if (fromSlot != null && toSlot != null && fromSlot !== toSlot) player.swapWeaponSlots = { fromSlot, toSlot };
    }
    if (dropItem && typeof dropItem === 'object' && !Array.isArray(dropItem)) {
        const itemKey = safeId(dropItem.itemKey, 24);
        const ammoType = safeId(dropItem.ammoType, 8);
        const slotIdx = Number.isInteger(dropItem.slotIdx) && dropItem.slotIdx >= 0 && dropItem.slotIdx <= 2
            ? dropItem.slotIdx
            : null;
        if (itemKey && survivItemKeys.has(itemKey)) player.dropItemPending = { itemKey, slotIdx, ammoType: survivAmmoTypes.has(ammoType) ? ammoType : null };
    }
    if (closeChest === true) {
        player.openedContainerId = null;
        player.openedContainer = null;
    }
    if (Number.isInteger(equipSlot) && equipSlot >= 0 && equipSlot <= 2) player.equipSlotPending = equipSlot;
    if (reload === true) beginSurvivReload(player);
}
