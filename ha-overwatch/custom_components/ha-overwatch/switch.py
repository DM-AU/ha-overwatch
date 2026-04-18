"""Switch platform for HA Overwatch."""
from __future__ import annotations

import logging

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from . import OverwatchCoordinator

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up Overwatch switch entities."""
    coordinator: OverwatchCoordinator = hass.data[DOMAIN][entry.entry_id]
    data = coordinator.data or {}

    entities: list[SwitchEntity] = []

    # Master switch
    entities.append(OverwatchMasterSwitch(coordinator))

    # Group switches
    for group in data.get("groups", []):
        entities.append(OverwatchGroupSwitch(coordinator, group))

    # Zone switches
    for zone in data.get("zones", []):
        entities.append(OverwatchZoneSwitch(coordinator, zone))

    # Camera switches
    entities.append(OverwatchCameraAllSwitch(coordinator))
    for group in data.get("camera_groups", []):
        entities.append(OverwatchCameraGroupSwitch(coordinator, group))
    for zone in data.get("camera_zones", []):
        entities.append(OverwatchCameraZoneSwitch(coordinator, zone))
    for camera in data.get("cameras", []):
        entities.append(OverwatchCameraSwitch(coordinator, camera))

    async_add_entities(entities)


def _device_info(coordinator: OverwatchCoordinator) -> DeviceInfo:
    return DeviceInfo(
        identifiers={(DOMAIN, "overwatch")},
        name="HA Overwatch",
        manufacturer="HA Overwatch",
        model="Floor Plan Dashboard",
        configuration_url=coordinator.url,
    )


class OverwatchBaseSwitch(CoordinatorEntity, SwitchEntity):
    """Base switch entity."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: OverwatchCoordinator, unique_suffix: str) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"overwatch_{unique_suffix}"
        self._attr_device_info = _device_info(coordinator)
        self._entity_type: str = ""
        self._entity_key: str = ""

    @property
    def is_on(self) -> bool:
        return False

    async def async_turn_on(self, **kwargs) -> None:
        await self.coordinator.async_set_entity(self._entity_type, self._entity_key, True)
        await self.coordinator.async_request_refresh()

    async def async_turn_off(self, **kwargs) -> None:
        await self.coordinator.async_set_entity(self._entity_type, self._entity_key, False)
        await self.coordinator.async_request_refresh()


# ── Floorplan switches ────────────────────────────────────────

class OverwatchMasterSwitch(OverwatchBaseSwitch):
    """Master zone switch."""

    _attr_icon = "mdi:shield-home"

    def __init__(self, coordinator: OverwatchCoordinator) -> None:
        super().__init__(coordinator, "master")
        self._attr_name = "Master"
        self._entity_type = "master"
        self._entity_key = "master"

    @property
    def is_on(self) -> bool:
        return bool((self.coordinator.data or {}).get("master", True))


class OverwatchGroupSwitch(OverwatchBaseSwitch):
    """Group enable/disable switch."""

    _attr_icon = "mdi:layers"

    def __init__(self, coordinator: OverwatchCoordinator, group: dict) -> None:
        super().__init__(coordinator, f"group_{group['id']}")
        self._group_id = group["id"]
        self._attr_name = group.get("name", group["id"])
        self._entity_type = "group"
        self._entity_key = group["id"]

    @property
    def is_on(self) -> bool:
        groups = (self.coordinator.data or {}).get("groups", [])
        g = next((g for g in groups if g["id"] == self._group_id), None)
        return bool(g.get("enabled", True)) if g else True


class OverwatchZoneSwitch(OverwatchBaseSwitch):
    """Zone enable/disable switch."""

    _attr_icon = "mdi:map-marker-radius"

    def __init__(self, coordinator: OverwatchCoordinator, zone: dict) -> None:
        super().__init__(coordinator, f"zone_{zone['id']}")
        self._zone_id = zone["id"]
        self._attr_name = zone.get("name", zone["id"])
        self._entity_type = "zone"
        self._entity_key = zone["id"]

    @property
    def is_on(self) -> bool:
        zones = (self.coordinator.data or {}).get("zones", [])
        z = next((z for z in zones if z["id"] == self._zone_id), None)
        return bool(z.get("enabled", True)) if z else True


# ── Camera switches ───────────────────────────────────────────

class OverwatchCameraAllSwitch(OverwatchBaseSwitch):
    """All cameras master switch."""

    _attr_icon = "mdi:cctv"

    def __init__(self, coordinator: OverwatchCoordinator) -> None:
        super().__init__(coordinator, "camera_all")
        self._attr_name = "All Cameras"
        self._entity_type = "camera_all"
        self._entity_key = "all"

    @property
    def is_on(self) -> bool:
        cameras = (self.coordinator.data or {}).get("cameras", [])
        return all(c.get("enabled", True) for c in cameras) if cameras else True


class OverwatchCameraGroupSwitch(OverwatchBaseSwitch):
    """Camera group switch."""

    _attr_icon = "mdi:cctv"

    def __init__(self, coordinator: OverwatchCoordinator, group: dict) -> None:
        super().__init__(coordinator, f"camera_group_{group['id']}")
        self._group_id = group["id"]
        self._attr_name = f"{group.get('name', group['id'])} Cameras"
        self._entity_type = "camera_group"
        self._entity_key = group["id"]

    @property
    def is_on(self) -> bool:
        groups = (self.coordinator.data or {}).get("camera_groups", [])
        g = next((g for g in groups if g["id"] == self._group_id), None)
        return bool(g.get("enabled", True)) if g else True


class OverwatchCameraZoneSwitch(OverwatchBaseSwitch):
    """Camera zone switch."""

    _attr_icon = "mdi:cctv"

    def __init__(self, coordinator: OverwatchCoordinator, zone: dict) -> None:
        super().__init__(coordinator, f"camera_zone_{zone['id']}")
        self._zone_id = zone["id"]
        self._attr_name = f"{zone.get('name', zone['id'])} Cameras"
        self._entity_type = "camera_zone"
        self._entity_key = zone["id"]

    @property
    def is_on(self) -> bool:
        zones = (self.coordinator.data or {}).get("camera_zones", [])
        z = next((z for z in zones if z["id"] == self._zone_id), None)
        return bool(z.get("enabled", True)) if z else True


class OverwatchCameraSwitch(OverwatchBaseSwitch):
    """Individual camera switch."""

    _attr_icon = "mdi:cctv"

    def __init__(self, coordinator: OverwatchCoordinator, camera: dict) -> None:
        cam_id = camera["id"].replace(".", "_").replace("-", "_")
        super().__init__(coordinator, f"camera_{cam_id}")
        self._camera_id = camera["id"]
        self._attr_name = camera.get("name", camera["id"])
        self._entity_type = "camera"
        self._entity_key = camera["id"]

    @property
    def is_on(self) -> bool:
        cameras = (self.coordinator.data or {}).get("cameras", [])
        c = next((c for c in cameras if c["id"] == self._camera_id), None)
        return bool(c.get("enabled", True)) if c else True
