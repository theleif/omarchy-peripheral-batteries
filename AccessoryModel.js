// Pure, framework-free logic for the Peripheral Batteries bar widget.
//
// The shell feeds this module plain snapshots of UPower, Bluetooth, and
// external JSON devices; nothing here touches QML or D-Bus, so the
// classification can be unit-tested with node.
//
// Design notes, borrowed from how other desktops solve this:
//   * UPower's Device.Type is unreliable for peripherals (KDE bug #525589:
//     an MX Master shows up as a keyboard), so the device kind is inferred
//     from the model name first and only falls back to the UPower type.
//   * A peripheral going to sleep can surface as a negative percentage; that
//     is treated as "unknown", never shown and never notified.
//   * Device kinds and battery levels map to the same semantic icon set
//     (empty/low/critical/good/full/charging) used by Solaar and KDE.
//   * Non-UPower sources (phones, vendor daemons) can be injected as JSON
//     with a timestamp and TTL, and are shown as offline past the TTL instead
//     of reporting a stale number.
//   * Some devices (notably Logitech HID++ peripherals behind a Unifying
//     receiver) expose only a coarse capacity_level in sysfs, with no
//     `capacity` attribute at all. UPower then synthesises a Percentage from
//     that bucket — 10 % for "Low", 50 % for "Unknown" — and its own tool
//     prints "(should be ignored)" next to it. Those devices are shown as a
//     level word instead of a made-up number, and never raise a low-battery
//     notification on the synthetic value.

var TYPE = {
  Unknown: 0,
  LinePower: 1,
  Battery: 2,
  Ups: 3,
  Monitor: 4,
  Mouse: 5,
  Keyboard: 6,
  Pda: 7,
  Phone: 8,
  MediaPlayer: 9,
  Tablet: 10,
  Computer: 11,
  GamingInput: 12,
  Pen: 13,
  Touchpad: 14,
  Modem: 15,
  Network: 16,
  Headset: 17,
  Speakers: 18,
  Headphones: 19,
  Video: 20,
  OtherAudio: 21,
  RemoteControl: 22,
  Printer: 23,
  Scanner: 24,
  Camera: 25,
  Wearable: 26,
  Toy: 27,
  BluetoothGeneric: 28
}

var STATE = {
  Unknown: 0,
  Charging: 1,
  Discharging: 2,
  Empty: 3,
  FullyCharged: 4,
  PendingCharge: 5,
  PendingDischarge: 6
}

// Device classes that belong to the machine itself rather than a peripheral.
var SYSTEM_TYPES = [
  TYPE.LinePower,
  TYPE.Ups,
  TYPE.Monitor,
  TYPE.Computer,
  TYPE.Modem,
  TYPE.Network,
  TYPE.Battery
]

var DEFAULT_WARNING = 30
var DEFAULT_CRITICAL = 15
var DEFAULT_TTL = 900

// A device that only reports a coarse capacity_level gives no percentage.
// The label is shown instead of a number; severity is deliberately soft for
// "low" because the bucket is device-reported and often stale, and alarming
// on it is what made this widget cry wolf.
var COARSE_LEVELS = {
  critical: { label: "Critical", severity: "critical", glyphPercent: 10 },
  low: { label: "Low", severity: "medium", glyphPercent: 25 },
  normal: { label: "Normal", severity: "good", glyphPercent: 60 },
  high: { label: "High", severity: "good", glyphPercent: 80 },
  full: { label: "Full", severity: "good", glyphPercent: 100 },
  unknown: { label: "Unknown", severity: "unknown", glyphPercent: -1 }
}

var TRANSPORT_LABELS = {
  bluetooth: "Bluetooth",
  wireless: "Wireless",
  wired: "Wired",
  external: "External",
  kdeconnect: "KDE Connect"
}

// Glyphs are five-hex Nerd Font codepoints, built with String.fromCodePoint:
// a JavaScript "\uXXXX" escape only reads four digits, so "\uF007A" would
// silently become U+F007 followed by "A".
var KIND_ICONS = {
  mouse: 0xF037D,
  keyboard: 0xF030C,
  touchpad: 0xF07F8,
  gamepad: 0xF0296,
  headset: 0xF02CE,
  speaker: 0xF04C3,
  phone: 0xF011C,
  tablet: 0xF04F6,
  watch: 0xF0589,
  pen: 0xF03EA,
  remote: 0xF0454,
  printer: 0xF042A,
  camera: 0xF0100,
  laptop: 0xF0322,
  generic: 0xF0FB0
}

var TRANSPORT_ICONS = {
  bluetooth: 0xF00AF,
  wireless: 0xF05A9,
  wired: 0xF0553,
  external: 0xF0FB0,
  kdeconnect: 0xF012E
}

var BATTERY_DEFAULT = [0xF007A, 0xF007B, 0xF007C, 0xF007D, 0xF007E, 0xF007F, 0xF0080, 0xF0081, 0xF0082, 0xF0079]
var BATTERY_CHARGING = [0xF089C, 0xF0086, 0xF0087, 0xF0088, 0xF089D, 0xF0089, 0xF089E, 0xF008A, 0xF008B, 0xF0085]
var BATTERY_OUTLINE = 0xF008E
var ICON_CHARGING_BOLT = 0xF140B

var KIND_KEYWORDS = [
  ["mouse", /\b(mouse|trackball|trackpoint|nitro|deathadder|basilisk|mx master|superlight|g pro)\b/i],
  ["keyboard", /\b(keyboard|keychron|kbd|\bkb\b)\b/i],
  ["touchpad", /\b(touchpad|trackpad|magic pad)\b/i],
  ["gamepad", /\b(gamepad|game controller|controller|joypad|joy-con|dualsense|dualshock|xbox|8bitdo|stadia)\b/i],
  ["headset", /\b(headset|headphone|earphone|earbud|buds|airpods|wh-1000|qc\d|bose qc)\b/i],
  ["speaker", /\b(speaker|soundbar|boombox|charge \d|flip \d|jbl)\b/i],
  ["watch", /\b(watch|band|wearable|fenix|forerunner)\b/i],
  ["pen", /\b(pen|stylus|pencil|s pen)\b/i],
  ["remote", /\b(remote|clicker|presenter)\b/i],
  ["printer", /\b(printer|scanner)\b/i],
  ["phone", /\b(phone|pixel|galaxy|iphone|oneplus|xiaomi|redmi)\b/i],
  ["tablet", /\b(tablet|ipad|tab \w+)\b/i],
  ["camera", /\b(camera|webcam|gopro)\b/i],
  ["laptop", /\b(laptop|notebook|thinkpad|macbook)\b/i]
]

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value))
}

function codepoint(cp) {
  return String.fromCodePoint(cp)
}

function kindIcon(kind) {
  var cp = KIND_ICONS[kind]
  return codepoint(cp === undefined ? KIND_ICONS.generic : cp)
}

function transportIcon(transport) {
  var cp = TRANSPORT_ICONS[transport]
  return codepoint(cp === undefined ? TRANSPORT_ICONS.external : cp)
}

function kindFromName(name) {
  var text = String(name || "")
  for (var i = 0; i < KIND_KEYWORDS.length; i++) {
    if (KIND_KEYWORDS[i][1].test(text)) return KIND_KEYWORDS[i][0]
  }
  return ""
}

function kindFromType(type) {
  switch (Number(type)) {
    case TYPE.Mouse: return "mouse"
    case TYPE.Keyboard: return "keyboard"
    case TYPE.Touchpad: return "touchpad"
    case TYPE.GamingInput: return "gamepad"
    case TYPE.Headset:
    case TYPE.Headphones: return "headset"
    case TYPE.Speakers:
    case TYPE.OtherAudio: return "speaker"
    case TYPE.Phone:
    case TYPE.Pda: return "phone"
    case TYPE.Tablet: return "tablet"
    case TYPE.Wearable: return "watch"
    case TYPE.Pen: return "pen"
    case TYPE.RemoteControl: return "remote"
    case TYPE.Printer:
    case TYPE.Scanner: return "printer"
    case TYPE.Camera: return "camera"
    case TYPE.Computer: return "laptop"
    default: return "generic"
  }
}

// Name wins over UPower type, because UPower regularly mislabels peripherals.
function inferKind(device) {
  var fromName = kindFromName(device && device.model)
  if (fromName !== "") return fromName
  return kindFromType(device && device.type)
}

function isSystemType(type) {
  return SYSTEM_TYPES.indexOf(Number(type)) !== -1
}

// An accessory is anything with a present, readable battery that is not the
// machine's own pack and not a system power class.
function isAccessory(device, isDisplay) {
  if (!device) return false
  if (isDisplay) return false
  if (device.isLaptopBattery === true) return false
  if (device.isPresent !== true) return false
  var type = Number(device.type)
  if (isFinite(type) && isSystemType(type)) return false
  return true
}

// Quickshell exposes UPower percentage as a 0..1 fraction. A negative value
// means "no reading" (a sleeping peripheral can report -1%).
function percentOf(device) {
  var value = Number(device.percentage)
  if (!isFinite(value) || value < 0) return -1
  return clamp(Math.round(value * 100), 0, 100)
}

// Parse the sysfs snapshot produced for options.powerSupply:
//   hidpp_battery_1<TAB>10<TAB>Low
// with an empty capacity field meaning "sysfs has no capacity attribute".
function parsePowerSupply(raw) {
  var out = {}
  var lines = String(raw === undefined || raw === null ? "" : raw).split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (line.trim() === "") continue
    var parts = line.split("\t")
    if (parts.length < 3) continue
    var name = parts[0].trim()
    if (name === "") continue
    var capacity = parts[1].trim()
    out[name] = {
      capacity: capacity === "" ? null : Number(capacity),
      level: parts[2].trim(),
      serial: parts.length > 3 ? parts[3].trim() : "",
      model: parts.length > 4 ? parts[4].trim() : "",
      status: parts.length > 5 ? parts[5].trim() : ""
    }
  }
  return out
}

function powerInfoFor(device, powerSupply) {
  if (!powerSupply || !device) return null
  var key = String(device.nativePath || "")
  if (key === "") return null
  return powerSupply[key] || null
}

// True when the kernel exposes a real numeric capacity for this device.
function hasRealCapacity(device, powerSupply) {
  var info = powerInfoFor(device, powerSupply)
  if (!info) return false
  return info.capacity !== null && isFinite(Number(info.capacity))
}

// True when UPower's percentage is a stand-in for a coarse level bucket
// rather than a measurement (HID++ peripherals with no capacity attribute).
function hasCoarseBattery(device, powerSupply) {
  var info = powerInfoFor(device, powerSupply)
  if (!info) return false
  return !hasRealCapacity(device, powerSupply)
}

function coarseLevelOf(device, powerSupply) {
  var info = powerInfoFor(device, powerSupply)
  if (!info) return "unknown"
  var level = String(info.level || "").toLowerCase().trim()
  return COARSE_LEVELS[level] ? level : "unknown"
}

function coarseInfo(device, powerSupply) {
  return COARSE_LEVELS[coarseLevelOf(device, powerSupply)]
}

// Solaar speaks HID++ to the device itself and can report a percentage the
// kernel does not expose. `solaar show` is parsed here; entries with a real
// number take over from UPower's synthetic value.
function normalizeSerial(value) {
  return String(value === undefined || value === null ? "" : value)
    .toLowerCase()
    .replace(/[^0-9a-z]/g, "")
}

// Drop vendor words and transport nouns so "Wireless Mouse MX Master 3"
// and "Logitech MX Master 3" compare as "mx master 3".
function nameCore(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b(logitech|wireless|usb|receiver|device|mouse|keyboard|optical|advanced|gaming)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function sameName(a, b) {
  var ca = nameCore(a)
  var cb = nameCore(b)
  if (ca === "" || cb === "") return false
  return ca === cb || ca.indexOf(cb) !== -1 || cb.indexOf(ca) !== -1
}

// Parse `solaar show`. Each device block looks like:
//     1: Wireless Mouse MX Master 3
//         Serial number: 27AD6789
//         ...
//         Battery: 80%, discharging.
function parseSolaar(raw) {
  var lines = String(raw === undefined || raw === null ? "" : raw).split("\n")
  var out = []
  var current = null
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (line.trim() === "") continue
    // Device headers sit at a shallow indent ("  1: MX Keys Keyboard").
    // Feature and firmware lines are indented further or carry a "{xxxx}"
    // feature id, and must not be mistaken for devices.
    var header = /^ {0,6}(\d+):\s+(\S.*)$/.exec(line)
    if (header && !/\{[0-9A-Fa-f]{4}\}/.test(header[2])) {
      current = {
        name: header[2].trim(),
        serial: "",
        percent: -1,
        level: "",
        charging: false
      }
      out.push(current)
      continue
    }
    if (!current) continue
    var serial = /^\s*Serial number:\s*(\S+)/.exec(line)
    if (serial) {
      current.serial = serial[1].trim()
      continue
    }
    var battery = /^\s*Battery:\s*(.+)$/.exec(line)
    if (battery && current.percent < 0 && current.level === "") {
      var text = battery[1].trim()
      var percent = /(\d+)\s*%/.exec(text)
      if (percent) {
        current.percent = clamp(Number(percent[1]), 0, 100)
      } else {
        var word = /(critical|low|good|full|empty)/i.exec(text)
        if (word) current.level = word[1].toLowerCase()
      }
      var tail = text.indexOf(",") >= 0 ? text.slice(text.indexOf(",") + 1) : ""
      current.charging = /recharg|charging/i.test(tail) && !/discharg/i.test(tail)
    }
  }
  var clean = []
  for (var j = 0; j < out.length; j++) {
    if (out[j].percent >= 0 || out[j].level !== "") clean.push(out[j])
  }
  return clean
}

// Best Solaar reading for a UPower device: exact serial first, then a
// normalised name match.
function solaarFor(device, powerSupply, readings) {
  if (!readings || typeof readings.length !== "number" || readings.length === 0) return null
  var info = powerInfoFor(device, powerSupply)
  var serial = info ? normalizeSerial(info.serial) : ""
  var name = device ? device.model : ""
  var byName = null
  for (var i = 0; i < readings.length; i++) {
    var reading = readings[i]
    var readingSerial = normalizeSerial(reading.serial)
    if (serial !== "" && readingSerial !== "" && readingSerial === serial) return reading
    if (byName === null && sameName(name, reading.name)) byName = reading
  }
  return byName
}

function isCharging(device) {
  var state = Number(device.state)
  return state === STATE.Charging || state === STATE.PendingCharge
}

function isFullyCharged(device, percent) {
  return Number(device.state) === STATE.FullyCharged || percent >= 100
}

function severity(percent, warning, critical) {
  if (percent < 0) return "unknown"
  if (percent <= critical) return "critical"
  if (percent <= warning) return "low"
  if (percent <= 60) return "medium"
  return "good"
}

function batteryGlyph(percent, charging) {
  if (percent < 0) return codepoint(BATTERY_OUTLINE)
  var index = clamp(Math.floor(percent / 10), 0, 9)
  return codepoint(charging ? BATTERY_CHARGING[index] : BATTERY_DEFAULT[index])
}

function stateLabel(device, charging, full) {
  var state = Number(device.state)
  if (charging) return "Charging"
  if (full) return "Fully charged"
  if (state === STATE.Discharging || state === STATE.PendingDischarge) return "Discharging"
  if (state === STATE.Empty) return "Empty"
  return ""
}

// Humanised remaining time from UPower's seconds fields. Returns "" when the
// device does not estimate.
function formatDuration(seconds) {
  var value = Number(seconds)
  if (!isFinite(value) || value <= 0) return ""
  if (value < 60) return "<1m"
  var totalMinutes = Math.round(value / 60)
  var days = Math.floor(totalMinutes / 1440)
  var hours = Math.floor((totalMinutes % 1440) / 60)
  var minutes = totalMinutes % 60
  var parts = []
  if (days > 0) parts.push(days + "d")
  if (hours > 0) parts.push(hours + "h")
  if (minutes > 0 && days === 0) parts.push(minutes + "m")
  return parts.join(" ")
}

function detailFor(device, charging, full) {
  if (full) return "Fully charged"
  if (charging) {
    var toFull = formatDuration(device.timeToFull)
    return toFull === "" ? "Charging" : "Full in " + toFull
  }
  var toEmpty = formatDuration(device.timeToEmpty)
  return toEmpty === "" ? "" : toEmpty + " left"
}

function normalizeAddress(value) {
  return String(value === undefined || value === null ? "" : value)
    .toLowerCase()
    .replace(/[^0-9a-f]/g, "")
}

// Find the connected BlueZ device backing a UPower device, by MAC address
// appearing in the native path or by a (case-insensitive) name match.
function matchBluetooth(device, bluetoothDevices) {
  var list = bluetoothDevices || []
  var name = String(device.model || "").toLowerCase().trim()
  var path = normalizeAddress(device.nativePath)
  for (var i = 0; i < list.length; i++) {
    var bt = list[i]
    if (!bt || bt.connected !== true) continue
    var address = normalizeAddress(bt.address)
    if (address !== "" && path !== "" && path.indexOf(address) !== -1) return bt
    var btName = String(bt.name || bt.deviceName || "").toLowerCase().trim()
    if (name !== "" && btName !== "" && (name.indexOf(btName) !== -1 || btName.indexOf(name) !== -1))
      return bt
  }
  return null
}

// Transport is a best-effort label. Explicit overrides (keyed by native path)
// win; then a connected BlueZ match means Bluetooth; then Logitech HID++ native
// paths are receiver-backed wireless; everything else is treated as wired.
function transportFor(device, bluetoothDevices, overrides) {
  var path = String(device.nativePath || "")
  if (overrides && overrides[path] !== undefined) {
    var forced = String(overrides[path])
    if (TRANSPORT_LABELS[forced]) return forced
  }
  if (matchBluetooth(device, bluetoothDevices)) return "bluetooth"
  if (path.toLowerCase().indexOf("hidpp") === 0) return "wireless"
  return "wired"
}

function hiddenByName(name, hidden) {
  var needle = String(name || "").toLowerCase().trim()
  if (needle === "" || !hidden) return false
  for (var i = 0; i < hidden.length; i++) {
    var pattern = String(hidden[i] || "").toLowerCase().trim()
    if (pattern !== "" && needle.indexOf(pattern) !== -1) return true
  }
  return false
}

function alreadyCovered(name, list) {
  var needle = String(name || "").toLowerCase().trim()
  if (needle === "") return false
  for (var i = 0; i < list.length; i++) {
    var existing = String(list[i].name || "").toLowerCase().trim()
    if (existing !== "" && (existing.indexOf(needle) !== -1 || needle.indexOf(existing) !== -1))
      return true
  }
  return false
}

function baseEntry(device, options, source) {
  var warning = options.warning
  var critical = options.critical
  var coarse = hasCoarseBattery(device, options.powerSupply)
  var level = coarse ? coarseInfo(device, options.powerSupply) : null
  var percent = percentOf(device)
  var charging = isCharging(device)

  // A Solaar reading beats UPower's synthetic value when it has a number,
  // and refreshes the bucket when it only has a level.
  var solaar = coarse ? solaarFor(device, options.powerSupply, options.solaar) : null
  var solaarPercent = -1
  if (solaar && solaar.percent !== undefined && solaar.percent !== null) {
    var asNumber = Number(solaar.percent)
    if (isFinite(asNumber) && asNumber >= 0) solaarPercent = clamp(Math.round(asNumber), 0, 100)
  }
  if (solaar && solaarPercent < 0 && solaar.level && COARSE_LEVELS[String(solaar.level).toLowerCase()]) {
    level = COARSE_LEVELS[String(solaar.level).toLowerCase()]
  }
  if (solaarPercent >= 0) {
    coarse = false
    level = null
    percent = solaarPercent
    if (solaar.charging === true) charging = true
  }

  var full = coarse ? coarseLevelOf(device, options.powerSupply) === "full" : isFullyCharged(device, percent)
  var name = String(device.model || device.nativePath || "Unknown device").trim() || "Unknown device"
  var kind = inferKind(device)
  var transport = transportFor(device, options.bluetoothDevices, options.transportOverrides)
  var btMatch = matchBluetooth(device, options.bluetoothDevices)
  return {
    key: String(device.nativePath || name),
    name: name,
    kind: kind,
    nativePath: String(device.nativePath || ""),
    bluetoothAddress: btMatch ? String(btMatch.address || "") : "",
    source: source,
    // A coarse device has no honest percentage; -1 keeps it out of every
    // threshold comparison while the level word is shown instead.
    percent: coarse ? -1 : percent,
    coarse: coarse,
    levelLabel: coarse ? level.label : "",
    charging: charging,
    full: full,
    stateLabel: stateLabel(device, charging, full),
    detail: coarse ? "level only" : detailFor(device, charging, full),
    severity: coarse ? level.severity : severity(percent, warning, critical),
    typeIcon: kindIcon(kind),
    batteryGlyph: batteryGlyph(coarse ? level.glyphPercent : percent, charging),
    transport: transport,
    transportLabel: TRANSPORT_LABELS[transport],
    transportIcon: transportIcon(transport),
    online: true
  }
}

// What to show where a percentage goes: a number only when it is real.
function valueText(item) {
  if (!item) return ""
  if (item.coarse) return item.levelLabel || "Level only"
  return Number(item.percent) + "%"
}

// Parse the optional external source: a JSON array of
//   { id, name, kind, pct, charging, ts, ttl }
// Entries older than their ttl are marked offline instead of lying.
function normalizeExternal(raw, now, defaultTtl) {
  var parsed = raw
  if (typeof raw === "string") {
    try { parsed = JSON.parse(raw) } catch (error) { return [] }
  }
  if (!parsed || typeof parsed.length !== "number") return []
  var out = []
  for (var i = 0; i < parsed.length; i++) {
    var item = parsed[i]
    if (!item) continue
    var percent = Number(item.pct)
    if (!isFinite(percent)) continue
    percent = clamp(Math.round(percent), 0, 100)
    var ttl = Number(item.ttl)
    if (!isFinite(ttl) || ttl <= 0) ttl = defaultTtl
    var ts = Number(item.ts)
    var online = !isFinite(ts) || ts <= 0 ? true : (now - ts) <= ttl
    var kind = String(item.kind || "")
    if (KIND_ICONS[kind] === undefined) kind = kindFromName(item.name) || "generic"
    var charging = item.charging === true
    var transport = item.transport && TRANSPORT_LABELS[String(item.transport)]
      ? String(item.transport) : "external"
    out.push({
      key: "external:" + String(item.id || item.name || i),
      name: String(item.name || item.id || "External device"),
      kind: kind,
      nativePath: "",
      source: item.source ? String(item.source) : "external",
      percent: percent,
      charging: charging,
      full: percent >= 100,
      stateLabel: charging ? "Charging" : "",
      detail: online ? "" : "Offline",
      severity: severity(percent, DEFAULT_WARNING, DEFAULT_CRITICAL),
      typeIcon: kindIcon(kind),
      batteryGlyph: batteryGlyph(percent, charging),
      transport: transport,
      transportLabel: TRANSPORT_LABELS[transport],
      transportIcon: transportIcon(transport),
      online: online
    })
  }
  return out
}

// Build the display list: UPower accessories, then Bluetooth-only battery
// sources, then external JSON entries. Sorted worst-battery-first so the bar
// surfaces the device most likely to need charging.
function collect(upowerDevices, bluetoothDevices, displayDevice, options) {
  options = options || {}
  var warning = isFinite(options.warning) ? Number(options.warning) : DEFAULT_WARNING
  var critical = isFinite(options.critical) ? Number(options.critical) : DEFAULT_CRITICAL
  var hideWired = options.hideWired === true
  var hidden = options.hiddenDevices || null
  var ttl = isFinite(options.ttl) ? Number(options.ttl) : DEFAULT_TTL
  var now = isFinite(options.now) ? Number(options.now) : Date.now() / 1000
  var bluetooth = bluetoothDevices || []
  var powerSupply = options.powerSupply || null
  var shared = {
    warning: warning,
    critical: critical,
    bluetoothDevices: bluetooth,
    transportOverrides: options.transportOverrides || null,
    powerSupply: powerSupply,
    solaar: options.solaar || null
  }
  var entries = []
  var seen = {}

  var devices = upowerDevices || []
  for (var i = 0; i < devices.length; i++) {
    var device = devices[i]
    if (!isAccessory(device, device === displayDevice)) continue
    if (percentOf(device) < 0 && !hasCoarseBattery(device, powerSupply)) continue
    var entry = baseEntry(device, shared, "upower")
    if (hideWired && entry.transport === "wired") continue
    if (hiddenByName(entry.name, hidden)) continue
    if (seen[entry.key]) continue
    seen[entry.key] = true
    entries.push(entry)
  }

  // UPower drops HID++ peripherals from its device list while they charge:
  // the kernel only sets POWER_SUPPLY_ONLINE while discharging or full, so a
  // charging device reports online=0 and UPower stops listing it. Re-add any
  // receiver device that sysfs still knows about.
  for (var sysName in powerSupply) {
    if (!Object.prototype.hasOwnProperty.call(powerSupply, sysName)) continue
    if (seen[sysName]) continue
    if (String(sysName).indexOf("hidpp_") !== 0) continue
    var sysInfo = powerSupply[sysName]
    if (!sysInfo || (sysInfo.level === "" && sysInfo.capacity === null)) continue
    var sysStatus = String(sysInfo.status || "").toLowerCase()
    var fake = {
      model: sysInfo.model || sysName,
      nativePath: sysName,
      type: TYPE.Unknown,
      isPresent: true,
      percentage: -1,
      state: sysStatus === "charging"
        ? STATE.Charging
        : (sysStatus === "full" ? STATE.FullyCharged : STATE.Discharging)
    }
    var synthesized = baseEntry(fake, shared, "sysfs")
    if (hideWired && synthesized.transport === "wired") continue
    if (hiddenByName(synthesized.name, hidden)) continue
    if (seen[synthesized.key]) continue
    seen[synthesized.key] = true
    entries.push(synthesized)
  }

  for (var j = 0; j < bluetooth.length; j++) {
    var bt = bluetooth[j]
    if (!bt || bt.connected !== true || bt.batteryAvailable !== true) continue
    var btName = String(bt.name || bt.deviceName || "").trim()
    if (btName === "" || alreadyCovered(btName, entries) || hiddenByName(btName, hidden)) continue
    var value = Number(bt.battery)
    if (!isFinite(value) || value < 0) continue
    var btPercent = clamp(Math.round(value * 100), 0, 100)
    var btKind = kindFromName(btName) || "generic"
    entries.push({
      key: "bt:" + String(bt.address || btName),
      name: btName,
      kind: btKind,
      nativePath: String(bt.address || ""),
      source: "bluetooth",
      percent: btPercent,
      charging: false,
      full: btPercent >= 100,
      stateLabel: "",
      detail: "",
      severity: severity(btPercent, warning, critical),
      typeIcon: kindIcon(btKind),
      batteryGlyph: batteryGlyph(btPercent, false),
      transport: "bluetooth",
      transportLabel: TRANSPORT_LABELS.bluetooth,
      transportIcon: transportIcon("bluetooth"),
      online: true
    })
  }

  var external = normalizeExternal(options.external, now, ttl)
  for (var k = 0; k < external.length; k++) {
    if (hiddenByName(external[k].name, hidden)) continue
    // Recompute severity with the caller's thresholds rather than the defaults.
    external[k].severity = severity(external[k].percent, warning, critical)
    entries.push(external[k])
  }

  // Additional programmatic sources (e.g. the bundled KDE Connect collector).
  var additional = options.additional
  if (additional && typeof additional.length === "number") {
    for (var a = 0; a < additional.length; a++) {
      var extra = normalizeExternal(additional[a], now, ttl)
      for (var e = 0; e < extra.length; e++) {
        if (hiddenByName(extra[e].name, hidden)) continue
        extra[e].severity = severity(extra[e].percent, warning, critical)
        entries.push(extra[e])
      }
    }
  }

  // Real percentages first, worst first; level-only devices follow (there is
  // nothing to rank them by), then offline entries.
  entries.sort(function(a, b) {
    if (a.online !== b.online) return a.online ? -1 : 1
    var aReal = a.percent >= 0
    var bReal = b.percent >= 0
    if (aReal !== bReal) return aReal ? -1 : 1
    if (!aReal) return 0
    return a.percent - b.percent
  })
  return entries
}

function onlineEntries(accessories) {
  var list = accessories || []
  var out = []
  for (var i = 0; i < list.length; i++) if (list[i].online) out.push(list[i])
  return out
}

// Aggregate view. Only real percentages feed lowest/average; level-only
// devices still contribute their severity so a device-reported "Critical"
// is not hidden.
function summary(accessories) {
  var list = onlineEntries(accessories)
  if (list.length === 0)
    return { count: 0, lowest: -1, lowestName: "", average: -1, coarseCount: 0, charging: false, severity: "unknown" }
  var total = 0
  var counted = 0
  var coarseCount = 0
  var lowest = -1
  var lowestName = ""
  var charging = false
  var worst = "good"
  // "unknown" is the least alarming state: it must never mask a real
  // critical device with a sleeping one.
  var rank = { unknown: 4, critical: 0, low: 1, medium: 2, good: 3 }
  for (var i = 0; i < list.length; i++) {
    var item = list[i]
    if (item.coarse || item.percent < 0) {
      coarseCount++
    } else {
      total += item.percent
      counted++
      if (lowest < 0 || item.percent < lowest) {
        lowest = item.percent
        lowestName = item.name
      }
    }
    if (item.charging) charging = true
    if (rank[item.severity] < rank[worst]) worst = item.severity
  }
  return {
    count: list.length,
    lowest: lowest,
    lowestName: lowestName,
    average: counted > 0 ? Math.round(total / counted) : -1,
    coarseCount: coarseCount,
    charging: charging,
    severity: worst
  }
}

function barGlyph(accessories) {
  var list = onlineEntries(accessories)
  if (list.length === 0) return codepoint(BATTERY_OUTLINE)
  return list[0].batteryGlyph || codepoint(BATTERY_OUTLINE)
}

function barText(accessories, showPercent, vertical, showCount) {
  var list = onlineEntries(accessories)
  var text = barGlyph(accessories)
  if (list.length === 0) return text
  var info = summary(accessories)
  // No number when every device only reports a level; the glyph carries it.
  if (showPercent && !vertical && info.lowest >= 0) text += " " + info.lowest + "%"
  if (showCount && !vertical && info.count > 1) text += " \u00B7 " + info.count
  return text
}

function tooltipText(accessories) {
  var list = onlineEntries(accessories)
  if (list.length === 0) return "No peripheral batteries"
  var parts = []
  for (var i = 0; i < list.length; i++) {
    var item = list[i]
    parts.push(item.name + " \u2014 " + valueText(item) +
      (item.charging ? codepoint(ICON_CHARGING_BOLT) : "") + " \u00B7 " + item.transportLabel)
  }
  return parts.join("\n")
}

// Devices that deserve a once-per-crossing notification. A device that only
// reports a coarse level is never announced on "Low" — that bucket is what
// made the widget cry wolf — but a device-reported "Critical" still is.
function criticalKeys(accessories, critical) {
  var list = onlineEntries(accessories)
  var out = []
  for (var i = 0; i < list.length; i++) {
    var item = list[i]
    if (item.charging) continue
    if (item.coarse) {
      if (item.severity === "critical") out.push(item.key)
      continue
    }
    if (item.percent >= 0 && item.percent <= critical) out.push(item.key)
  }
  return out
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    TYPE: TYPE,
    STATE: STATE,
    DEFAULT_WARNING: DEFAULT_WARNING,
    DEFAULT_CRITICAL: DEFAULT_CRITICAL,
    KIND_ICONS: KIND_ICONS,
    kindIcon: kindIcon,
    transportIcon: transportIcon,
    kindFromName: kindFromName,
    kindFromType: kindFromType,
    inferKind: inferKind,
    isSystemType: isSystemType,
    isAccessory: isAccessory,
    percentOf: percentOf,
    parsePowerSupply: parsePowerSupply,
    parseSolaar: parseSolaar,
    normalizeSerial: normalizeSerial,
    nameCore: nameCore,
    sameName: sameName,
    solaarFor: solaarFor,
    powerInfoFor: powerInfoFor,
    hasRealCapacity: hasRealCapacity,
    hasCoarseBattery: hasCoarseBattery,
    coarseLevelOf: coarseLevelOf,
    coarseInfo: coarseInfo,
    valueText: valueText,
    isCharging: isCharging,
    isFullyCharged: isFullyCharged,
    severity: severity,
    batteryGlyph: batteryGlyph,
    stateLabel: stateLabel,
    formatDuration: formatDuration,
    detailFor: detailFor,
    normalizeAddress: normalizeAddress,
    matchBluetooth: matchBluetooth,
    transportFor: transportFor,
    normalizeExternal: normalizeExternal,
    collect: collect,
    onlineEntries: onlineEntries,
    summary: summary,
    barGlyph: barGlyph,
    barText: barText,
    tooltipText: tooltipText,
    criticalKeys: criticalKeys,
    codepoint: codepoint,
    ICON_CHARGING_BOLT: ICON_CHARGING_BOLT
  }
}
