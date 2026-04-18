"""Binary sensor platform for HA Overwatch — zone triggered states."""
from __future__ import annotations

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from . import OverwatchCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up Overwatch binary sensor entities."""
    coordinator: OverwatchCoordinator = hass.data[DOMAIN][entry.entry_id]
    data = coordinator.data or {}

    entities: list[BinarySensorEntity] = []

    # Master triggered sensor
    entities.append(OverwatchMasterTriggered(coordinator))

    # Per-group triggered sensors
    for group in data.get("groups", []):
        entities.append(OverwatchGroupTriggered(coordinator, group))

    # Per-zone triggered sensors
    for zone in data.get("zones", []):
        entities.append(OverwatchZoneTriggered(coordinator, zone))

    async_add_entities(entities)


def _device_info(coordinator: OverwatchCoordinator) -> DeviceInfo:
    return DeviceInfo(
        identifiers={(DOMAIN, "overwatch")},
        name="HA Overwatch",
        manufacturer="HA Overwatch",
        model="Floor Plan Dashboard",
        configuration_url=coordinator.url,
    )


class OverwatchBaseTriggered(CoordinatorEntity, BinarySensorEntity):
    """Base triggered binary sensor."""

    _attr_has_entity_name = True
    _attr_device_class = BinarySensorDeviceClass.MOTION

    def __init__(self, coordinator: OverwatchCoordinator, unique_suffix: str) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"overwatch_{unique_suffix}_triggered"
        self._attr_device_info = _device_info(coordinator)

    @property
    def is_on(self) -> bool:
        return False


class OverwatchMasterTriggered(OverwatchBaseTriggered):
    """Any zone triggered sensor."""

    _attr_icon = "mdi:shield-alert"

    def __init__(self, coordinator: OverwatchCoordinator) -> None:
        super().__init__(coordinator, "master")
        self._attr_name = "Master Triggered"

    @property
    def is_on(self) -> bool:
        zones = (self.coordinator.data or {}).get("zones", [])
        return any(z.get("triggered", False) for z in zones)


class OverwatchGroupTriggered(OverwatchBaseTriggered):
    """Group triggered — true if any member zone is triggered."""

    _attr_icon = "mdi:shield-alert"

    def __init__(self, coordinator: OverwatchCoordinator, group: dict) -> None:
        super().__init__(coordinator, f"group_{group['id']}")
        self._group_id = group["id"]
        self._zone_ids: list[str] = group.get("zone_ids", [])
        self._attr_name = f"{group.get('name', group['id'])} Triggered"

    @property
    def is_on(self) -> bool:
        zones = (self.coordinator.data or {}).get("zones", [])
        return any(
            z.get("triggered", False)
            for z in zones
            if z["id"] in self._zone_ids
        )


class OverwatchZoneTriggered(OverwatchBaseTriggered):
    """Zone triggered binary sensor."""

    _attr_icon = "mdi:shield-alert"

    def __init__(self, coordinator: OverwatchCoordinator, zone: dict) -> None:
        super().__init__(coordinator, f"zone_{zone['id']}")
        self._zone_id = zone["id"]
        self._attr_name = f"{zone.get('name', zone['id'])} Triggered"

    @property
    def is_on(self) -> bool:
        zones = (self.coordinator.data or {}).get("zones", [])
        z = next((z for z in zones if z["id"] == self._zone_id), None)
        return bool(z.get("triggered", False)) if z else False
