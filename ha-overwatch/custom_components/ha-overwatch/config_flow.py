"""Config flow for HA Overwatch integration."""
from __future__ import annotations

import aiohttp
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.const import CONF_URL

from .const import DOMAIN, DEFAULT_URL


class OverwatchConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for HA Overwatch."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        """Handle the initial step."""
        # Only allow one instance
        if self._async_current_entries():
            return self.async_abort(reason="already_configured")

        errors = {}

        if user_input is not None:
            url = user_input[CONF_URL].rstrip("/")
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.get(
                        f"{url}/ow/health",
                        timeout=aiohttp.ClientTimeout(total=5),
                    ) as resp:
                        if resp.status == 200:
                            data = await resp.json(content_type=None)
                            if data.get("ok"):
                                await self.async_set_unique_id(DOMAIN)
                                self._abort_if_unique_id_configured()
                                return self.async_create_entry(
                                    title="HA Overwatch",
                                    data={CONF_URL: url},
                                )
                errors["base"] = "cannot_connect"
            except Exception:
                errors["base"] = "cannot_connect"

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({
                vol.Required(CONF_URL, default=DEFAULT_URL): str,
            }),
            errors=errors,
        )