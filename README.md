# Peripheral Batteries

An [Omarchy](https://omarchy.org/) shell plugin (a bar widget) that shows the
battery level of every connected peripheral — Bluetooth, 2.4 GHz receiver,
USB/cable, and anything you can feed in through a JSON source — in one place.

![status](https://img.shields.io/badge/omarchy-shell-plugin-blue)

## What it does

A single bar icon shows the lowest peripheral battery (red when low, with a
bare `10%` and an optional device count). Click it for a popup listing every
device, worst battery first:

- Battery level with a progress bar, kind icon, and percent
- Charging bolt, `Charging` / `Discharging` / `Fully charged`, and
  "2h left" / "Full in 1h" when the device estimates it
- Transport badge: Bluetooth, Wireless (2.4 GHz receiver), Wired (USB),
  KDE Connect, or External
- Only-once low-battery notifications
- Disconnect a Bluetooth device straight from the popup
  (`enter`, `x`, or double-click)
- Devices at or below a configurable critical threshold turn red

The icon hides itself when nothing is connected, so it never occupies empty
bar space.

## Devices without a real percentage

Some peripherals never report a percentage at all. Logitech HID++ keyboards
and mice behind a Unifying receiver, for example, expose only a coarse
`capacity_level` bucket in sysfs (`Unknown`, `Low`, `Normal`, `High`,
`Full`) — there is no `capacity` attribute. UPower fills its `Percentage`
property with a stand-in derived from that bucket (`10 %` for low, `50 %` for
unknown) and its own `upower -i` output prints `(should be ignored)` next to
it. The number never moves and says nothing about the charge.

The widget reads `/sys/class/power_supply/*` alongside UPower and, for those
devices:

- shows the level word (`Low`, `Unknown`, …) instead of a fabricated percent,
- draws no progress bar, and adds `level only` to the row,
- keeps them out of the bar's percentage and out of the lowest-battery
  summary,
- never raises a low-battery notification from the `Low` bucket, because that
  bucket is what made it cry wolf. A device-reported `Critical` still
  notifies.

### While charging

The kernel only sets `POWER_SUPPLY_ONLINE` for a Logitech device while it is
discharging or full, and UPower drops devices that report `online=0`. A
peripheral on the charger would therefore vanish from the widget. Receiver
devices UPower no longer lists are rebuilt from the sysfs snapshot (model,
level, charging state), with the Solaar percentage applied when available and
deduplicated by native path so nothing is listed twice.

Because UPower's model name is the one shown normally, the widget remembers it
per serial number and reuses it for the sysfs fallback — the row keeps the same
name before, during and after charging instead of switching to the kernel's
`Wireless Mouse MX Master 3` form. Names are learned whenever UPower reports a
device and stored in `~/.cache/omarchy-accessories/device-names.json`, so they
survive restarts. A device that has never been seen through UPower falls back to
the kernel's model name until it is.

### Solaar (optional, real percentages)

[Solaar](https://github.com/pwr-Solaar/Solaar) speaks HID++ to the devices
themselves and can return a percentage even when the kernel only exposes a
bucket. Install it (`sudo pacman -S solaar`, then `solaar show` to check that
it can read your devices) and the widget picks it up automatically:

- detected with `command -v solaar`, no configuration needed;
- `solaar show` runs at startup, when the popup is opened, and every five
  minutes; it is throttled because it wakes every device;
- readings are matched to UPower devices by **serial number** first, then by a
  normalised name, so a Solaar number replaces the `Low`/`Unknown` word and is
  used for the bar, the summary, the progress bar and notifications;
- when Solaar only reports a bucket as well, the word stays but is refreshed
  from the device;
- with Solaar absent or unreadable (`Device is offline`, permissions), the
  widget silently falls back to the level word.

Note that whether Solaar can produce a number at all is up to the device: a
peripheral that only advertises battery *levels* in HID++ reports the same
bucket to Solaar and to the kernel. `solaar show` tells you which case you are
in — `Battery: 82%, discharging.` is a real percentage, `Battery: low,
discharging.` is a bucket.

## Install

```bash
omarchy plugin add https://github.com/theleif/omarchy-peripheral-batteries.git --enable --yes
```

Then place it in the bar if it is not already there:

```bash
omarchy bar move theleif.accessories --section right --after omarchy.power
```

To remove:

```bash
omarchy plugin disable theleif.accessories
omarchy plugin remove theleif.accessories
```

## Sources

| Source | Reaches | Requirement |
|---|---|---|
| **UPower** | Bluetooth peripherals, 2.4 GHz receiver devices (Logitech HID++), USB/cable devices, game controllers | none |
| **BlueZ** (read-only) | labels a UPower device as Bluetooth and adds Bluetooth-only battery sources | none |
| **KDE Connect** | a paired phone/tablet's own battery (the phone-as-server case) | KDE Connect installed and paired |
| **External JSON** | anything at all | you write the file |

Every source is optional. Missing ones simply yield nothing; the widget does
not fail.

### KDE Connect

When `kdeconnect-cli`/`gdbus` and a running KDE Connect daemon are present, a
bundled collector (`sources/kdeconnect.py`) reads the battery module over the
session bus:

```
interface  org.kde.kdeconnect.device.battery
path       /modules/kdeconnect/devices/<device-id>/battery
props      charge, isCharging, hasBattery
```

It is a separate program by design — the widget only runs a command and parses
JSON, so new sources never touch the QML. Disable it with the
`kdeconnectSource` setting if you prefer.

### External JSON

Write an array to `~/.cache/omarchy-accessories/external.json` (path
configurable via the `externalPath` setting):

```json
[
  {
    "id": "kitchen-speaker",
    "name": "Kitchen Speaker",
    "kind": "speaker",
    "pct": 64,
    "charging": false,
    "ts": 1750000000,
    "ttl": 900
  }
]
```

- `id` — stable, so you can update your entry without touching others
- `kind` — picks the icon: `mouse`, `keyboard`, `touchpad`, `gamepad`,
  `headset`, `speaker`, `phone`, `tablet`, `watch`, `pen`, `remote`,
  `printer`, `camera`, `laptop`, `generic`
- `ts`/`ttl` — Unix timestamp and seconds. Past the TTL the device is shown
  dimmed as **Offline** instead of reporting a stale number
- `transport` — optional: `bluetooth`, `wireless`, `wired`, `external`,
  `kdeconnect`

The file is watched, so edits appear immediately.

## Settings

Settings live inline on the widget's entry in `~/.config/omarchy/shell.json`.

| Key | Default | Meaning |
|---|---|---|
| `showPercent` | `true` | Show the lowest percentage next to the bar icon |
| `showCount` | `false` | Show the device count next to the bar icon |
| `hideWhenEmpty` | `true` | Hide the icon when nothing is connected |
| `hideWired` | `false` | Hide wired (USB) devices |
| `notifyLow` | `true` | Notify once when a device crosses the critical threshold |
| `kdeconnectSource` | `true` | Read KDE Connect devices |
| `warningThreshold` | `30` | "low" threshold (%) |
| `criticalThreshold` | `15` | "critical" threshold (%) and notification trigger |
| `refreshInterval` | `10` | Refresh interval (seconds, minimum 5) |
| `externalPath` | `~/.cache/omarchy-accessories/external.json` | External JSON source |
| `hiddenDevices` | `[]` | Names (substrings) to hide, e.g. `["Xbox"]` |
| `transportOverrides` | `{}` | Force a transport per native path, e.g. `{"gip0.0": "wireless"}` |

Example:

```json
{ "id": "theleif.accessories", "hideWired": true, "hiddenDevices": ["Old Mouse"] }
```

## Design notes and credits

Behaviour is modelled on how other desktops solve this:

- **[BatteryWatch](https://github.com/itayavra/batterywatch)** (a KDE Plasma
  widget written by a Bazzite user for exactly this problem) — auto-hide when
  empty, hide devices, disconnect Bluetooth from the widget.
- **[Battery Widget](https://github.com/thieggs/battery-widget)** — a pluggable
  external JSON source with TTL/offline handling, warning/critical thresholds,
  and a collector-prints-JSON architecture.
- **Solaar** — the semantic `full/good/low/critical/empty[-charging]` icon
  scheme.
- **KDE bug [#525589](https://bugs.kde.org/show_bug.cgi?id=525589)** — UPower
  mislabels peripherals (an MX Master reported as a *keyboard*) and can report
  `-1%` when a device sleeps, so the device kind is inferred from the model
  name first and negative readings are treated as unknown.

## Development

The classification logic is deliberately framework-free so it can be tested
without a running shell:

```bash
node tests/test_accessory_model.js          # 62 assertions
python3 tests/test_kdeconnect_collector.py  # 20 assertions
```

`Accessories.qml` hot-reloads when saved. Changes to `AccessoryModel.js` are
cached by the QML engine — restart the shell with `omarchy restart shell` to
pick them up.

## License

MIT — see [LICENSE](LICENSE).
