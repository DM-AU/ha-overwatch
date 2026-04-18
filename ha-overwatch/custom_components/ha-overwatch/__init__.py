"""HA Overwatch integration."""
from __future__ import annotations

import logging
from datetime import timedelta

import aiohttp
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_URL, Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [Platform.SWITCH, Platform.BINARY_SENSOR]


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up the HA Overwatch component."""
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up HA Overwatch from a config entry."""
    url = entry.data[CONF_URL]

    coordinator = OverwatchCoordinator(hass, url)
    try:
        await coordinator.async_config_entry_first_refresh()
    except Exception as err:
        _LOGGER.error("Failed to connect to Overwatch add-on: %s", err)
        return False

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return unload_ok


class OverwatchCoordinator(DataUpdateCoordinator):
    """Fetches entity states from the Overwatch add-on."""

    def __init__(self, hass: HomeAssistant, url: str) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name="HA Overwatch",
            update_interval=timedelta(seconds=30),
        )
        self.url = url

    async def _async_update_data(self) -> dict:
        """Fetch entity states from add-on."""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    f"{self.url}/ow/entity-states",
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    if resp.status != 200:
                        raise UpdateFailed(f"Add-on returned {resp.status}")
                    return await resp.json(content_type=None)
        except aiohttp.ClientError as err:
            raise UpdateFailed(f"Cannot reach Overwatch add-on: {err}") from err

    async def async_set_entity(self, entity_type: str, entity_key: str, state: bool) -> None:
        """Push a state change to the add-on."""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{self.url}/ow/entity-set",
                    json={"type": entity_type, "key": entity_key, "state": state},
                    timeout=aiohttp.ClientTimeout(total=5),
                ) as resp:
                    if resp.status != 200:
                        _LOGGER.warning("Overwatch entity-set returned %s", resp.status)
                    else:
                        # Refresh coordinator with new state
                        data = await resp.json(content_type=None)
                        if data.get("state"):
                            self.async_set_updated_data(data["state"])
        except aiohttp.ClientError as err:
            _LOGGER.error("Cannot push state to Overwatch: %s", err)