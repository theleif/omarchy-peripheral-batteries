#!/usr/bin/env python3
"""Unit tests for the KDE Connect collector's pure parsing (no live D-Bus)."""
import importlib.util
import io
import json
import pathlib
import sys
from contextlib import redirect_stdout

PATH = pathlib.Path(__file__).resolve().parents[1] / "sources" / "kdeconnect.py"
spec = importlib.util.spec_from_file_location("kdeconnect_collector", PATH)
kc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kc)

passed = 0
failed = 0


def eq(actual, expected, label):
    global passed, failed
    if actual == expected:
        passed += 1
        print("ok  " + label)
    else:
        failed += 1
        print("FAIL " + label + "\n   expected " + repr(expected) + "\n   actual   " + repr(actual))


eq(kc.parse_props("({'charge': <int64 72>, 'isCharging': <false>, 'hasBattery': <true>},)"),
   {"charge": 72, "isCharging": False, "hasBattery": True}, "parse int64 battery props")
eq(kc.parse_props("({'charge': <uint32 5>, 'isCharging': <true>, 'iconName': <'battery-low-symbolic'>},)"),
   {"charge": 5, "isCharging": True, "iconName": "battery-low-symbolic"}, "parse uint32 + string + true")
eq(kc.parse_props(""), {}, "parse empty")
eq(kc.parse_device_ids("(['d0e1', 'a1b2'],)"), ["d0e1", "a1b2"], "parse device ids")
eq(kc.parse_device_ids("(@ao [],)"), [], "parse empty device ids")
eq(kc.guess_kind("Pixel 8", "phone"), "phone", "guess phone")
eq(kc.guess_kind("Galaxy Tab", "tablet"), "tablet", "guess tablet")
eq(kc.guess_kind("workstation", "desktop"), "laptop", "guess desktop -> laptop")
eq(kc.guess_kind("Watch 5", ""), "watch", "guess watch by name")

# battery_for uses get_all; monkeypatch it.
original = kc.get_all
kc.get_all = lambda iface, path: {"hasBattery": True, "charge": 40, "isCharging": False}
eq(kc.battery_for("x"), {"charge": 40, "isCharging": False}, "battery_for reads charge")
kc.get_all = lambda iface, path: {"hasBattery": False, "charge": -1}
eq(kc.battery_for("x"), None, "battery_for skips no-battery")
kc.get_all = lambda iface, path: {"hasBattery": True, "charge": -1}
eq(kc.battery_for("x"), None, "battery_for skips negative charge")
kc.get_all = original

# collect() orchestration with monkeypatched helpers.
kc.list_device_ids = lambda: ["dev1", "dev2"]
kc.battery_for = lambda i: {"charge": 63, "isCharging": True} if i == "dev1" else None
kc.device_info = lambda i: {"name": "Pixel 8", "type": "phone"}
out = kc.collect()
eq(len(out), 1, "collect skips devices without battery")
eq(out[0]["name"], "Pixel 8", "collect name")
eq(out[0]["pct"], 63, "collect pct")
eq(out[0]["charging"], True, "collect charging")
eq(out[0]["transport"], "kdeconnect", "collect transport")
eq(out[0]["source"], "kdeconnect", "collect source")
eq(isinstance(out[0]["ts"], (int, float)), True, "collect timestamp")

# main() is safe when everything explodes.
kc.collect = lambda: (_ for _ in ()).throw(RuntimeError("boom"))
buffer = io.StringIO()
with redirect_stdout(buffer):
    kc.main()
eq(json.loads(buffer.getvalue()), [], "main returns [] on failure")

print("\n{} passed, {} failed".format(passed, failed))
sys.exit(1 if failed else 0)
