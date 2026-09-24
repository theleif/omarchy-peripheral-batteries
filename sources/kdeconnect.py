#!/usr/bin/env python3
"""KDE Connect battery source for the Omarchy Peripheral Batteries widget.

KDE Connect exposes a paired device's own battery (the phone acting as a
server, for example) over the session bus:

    interface  org.kde.kdeconnect.device.battery
    path       /modules/kdeconnect/devices/<device-id>/battery
    props      charge (int), isCharging (bool), hasBattery (bool)

This collector enumerates the paired devices, reads that battery, and prints a
JSON array on stdout in the widget's external-source shape:

    [{"id","name","kind","pct","charging","transport","source","ts"}]

It is deliberately a separate program so the widget only ever runs a command
and parses JSON. It always exits 0 and prints [] when anything is missing:
no KDE Connect, no gdbus, no battery, or any D-Bus error. Safe to run on a
machine that has none of it.
"""

import json
import re
import shutil
import subprocess
import sys
import time

BUS_NAME = "org.kde.kdeconnect"
DAEMON_PATH = "/modules/kdeconnect"
DAEMON_IFACE = "org.kde.kdeconnect.daemon"
DEVICE_IFACE = "org.kde.kdeconnect.device"
BATTERY_IFACE = "org.kde.kdeconnect.device.battery"
TIMEOUT = 5

_PROP_RE = re.compile(r"'([^']+)': <([^>]*)>")


def parse_props(text):
    """Turn a gdbus Properties.GetAll reply into a plain dict.

    Example input:
        ({'charge': <int64 72>, 'isCharging': <false>, 'hasBattery': <true>},)
    """
    props = {}
    for name, raw in _PROP_RE.findall(text or ""):
        raw = raw.strip()
        if raw.startswith("'"):
            props[name] = raw.strip("'")
        elif raw.lower() in ("true", "false"):
            props[name] = raw.lower() == "true"
        else:
            number = re.match(r"^[A-Za-z0-9_]+ (-?\d+)$", raw)
            if number:
                props[name] = int(number.group(1))
            else:
                try:
                    props[name] = int(raw)
                except ValueError:
                    props[name] = raw
    return props


def parse_device_ids(text):
    return re.findall(r"'([^']+)'", text or "")


def guess_kind(name, device_type):
    text = "{} {}".format(name or "", device_type or "").lower()
    if "tablet" in text or "ipad" in text:
        return "tablet"
    if "laptop" in text or "desktop" in text or "macbook" in text or "thinkpad" in text:
        return "laptop"
    if "watch" in text:
        return "watch"
    return "phone"


def gdbus(*args):
    if shutil.which("gdbus") is None:
        return ""
    command = ["gdbus", "call", "--session", "--dest", BUS_NAME] + list(args)
    try:
        finished = subprocess.run(command, capture_output=True, text=True, timeout=TIMEOUT)
    except (OSError, subprocess.SubprocessError):
        return ""
    return finished.stdout if finished.returncode == 0 else ""


def get_all(interface, path):
    reply = gdbus("--object-path", path, "--method",
                  "org.freedesktop.DBus.Properties.GetAll", interface)
    return parse_props(reply)


def list_device_ids():
    reply = gdbus("--object-path", DAEMON_PATH, "--method",
                  "{}.devices".format(DAEMON_IFACE), "false", "false")
    return parse_device_ids(reply)


def battery_for(device_id):
    props = get_all(BATTERY_IFACE,
                    "/modules/kdeconnect/devices/{}/battery".format(device_id))
    if props.get("hasBattery") is False:
        return None
    charge = props.get("charge")
    if not isinstance(charge, int) or charge < 0:
        return None
    return {"charge": charge, "isCharging": props.get("isCharging") is True}


def device_info(device_id):
    props = get_all(DEVICE_IFACE, "/modules/kdeconnect/devices/{}".format(device_id))
    return {
        "name": props.get("name") or device_id,
        "type": props.get("type") or "",
    }


def collect():
    now = time.time()
    devices = []
    for device_id in list_device_ids():
        battery = battery_for(device_id)
        if battery is None:
            continue
        info = device_info(device_id)
        devices.append({
            "id": device_id,
            "name": info["name"],
            "kind": guess_kind(info["name"], info["type"]),
            "pct": battery["charge"],
            "charging": battery["isCharging"],
            "transport": "kdeconnect",
            "source": "kdeconnect",
            "ts": now,
        })
    return devices


def main():
    try:
        devices = collect()
    except Exception:
        devices = []
    json.dump(devices, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
