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
  var percent = percentOf(device)
  var charging = isCharging(device)
  var full = isFullyCharged(device, percent)
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
    percent: percent,
    charging: charging,
    full: full,
    stateLabel: stateLabel(device, charging, full),
    detail: detailFor(device, charging, full),
    severity: severity(percent, warning, critical),
    typeIcon: kindIcon(kind),
    batteryGlyph: batteryGlyph(percent, charging),
    transport: transport,
    transportLabel: TRANSPORT_LABELS[transport],
    transportIcon: transportIcon(transport),
    online: true
  }
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
  var shared = {
    warning: warning,
    critical: critical,
    bluetoothDevices: bluetooth,
    transportOverrides: options.transportOverrides || null
  }
  var entries = []
  var seen = {}

  var devices = upowerDevices || []
  for (var i = 0; i < devices.length; i++) {
    var device = devices[i]
    if (!isAccessory(device, device === displayDevice)) continue
    if (percentOf(device) < 0) continue
    var entry = baseEntry(device, shared, "upower")
    if (hideWired && entry.transport === "wired") continue
    if (hiddenByName(entry.name, hidden)) continue
    if (seen[entry.key]) continue
    seen[entry.key] = true
    entries.push(entry)
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

  entries.sort(function(a, b) {
    if (a.online !== b.online) return a.online ? -1 : 1
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

function summary(accessories) {
  var list = onlineEntries(accessories)
  if (list.length === 0)
    return { count: 0, lowest: -1, lowestName: "", average: -1, charging: false, severity: "unknown" }
  var total = 0
  var charging = false
  var worst = "good"
  var rank = { unknown: 0, critical: 0, low: 1, medium: 2, good: 3 }
  for (var i = 0; i < list.length; i++) {
    total += list[i].percent
    if (list[i].charging) charging = true
    if (rank[list[i].severity] < rank[worst]) worst = list[i].severity
  }
  return {
    count: list.length,
    lowest: list[0].percent,
    lowestName: list[0].name,
    average: Math.round(total / list.length),
    charging: charging,
    severity: worst
  }
}

function barGlyph(accessories) {
  var list = onlineEntries(accessories)
  if (list.length === 0) return codepoint(BATTERY_OUTLINE)
  return batteryGlyph(list[0].percent, list[0].charging)
}

function barText(accessories, showPercent, vertical, showCount) {
  var list = onlineEntries(accessories)
  var text = barGlyph(accessories)
  if (list.length === 0) return text
  var info = summary(accessories)
  if (showPercent && !vertical) text += " " + info.lowest + "%"
  if (showCount && !vertical && info.count > 1) text += " \u00B7 " + info.count
  return text
}

function tooltipText(accessories) {
  var list = onlineEntries(accessories)
  if (list.length === 0) return "No peripheral batteries"
  var parts = []
  for (var i = 0; i < list.length; i++) {
    var item = list[i]
    parts.push(item.name + " \u2014 " + item.percent + "%" +
      (item.charging ? codepoint(ICON_CHARGING_BOLT) : "") + " \u00B7 " + item.transportLabel)
  }
  return parts.join("\n")
}

// Devices whose battery is at or below the critical threshold, for the
// once-per-crossing low-battery notification.
function criticalKeys(accessories, critical) {
  var list = onlineEntries(accessories)
  var out = []
  for (var i = 0; i < list.length; i++) {
    if (list[i].percent <= critical && !list[i].charging) out.push(list[i].key)
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
