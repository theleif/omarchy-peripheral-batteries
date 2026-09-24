const M = require('../AccessoryModel.js')
let pass = 0, fail = 0
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log('ok  ' + label) }
  else { fail++; console.log('FAIL ' + label + '\n   expected ' + e + '\n   actual   ' + a) }
}
const cp = n => String.fromCodePoint(n)
const T = M.TYPE

const display = { nativePath: 'DisplayDevice', type: T.Battery, isPresent: false, isLaptopBattery: false, percentage: 0 }
const laptop = { model: 'Laptop Battery', nativePath: 'BAT0', type: T.Battery, isPresent: true, isLaptopBattery: true, percentage: 0.80, state: M.STATE.Discharging }

// MX Master 3 is reported by UPower as a Keyboard (KDE bug #525589) — name must win.
const mxMaster = { model: 'Logitech MX Master 3', nativePath: 'hidpp_battery_1', type: T.Keyboard, isPresent: true, isLaptopBattery: false, percentage: 1.0, state: M.STATE.FullyCharged }
const mxKeys = { model: 'Logitech MX Keys', nativePath: 'hidpp_battery_0', type: T.Keyboard, isPresent: true, isLaptopBattery: false, percentage: 0.10, state: M.STATE.Discharging, timeToEmpty: 7200 }
const xbox = { model: 'Microsoft Xbox Controller', nativePath: 'gip0.0', type: T.GamingInput, isPresent: true, isLaptopBattery: false, percentage: 0.70, state: M.STATE.Discharging }
const headset = { model: 'WH-1000XM5', nativePath: '00:1A:7D:DA:71:13', type: T.Headphones, isPresent: true, isLaptopBattery: false, percentage: 0.45, state: M.STATE.Discharging }
const sleeping = { model: 'Some Mouse', nativePath: 'hidpp_battery_9', type: T.Mouse, isPresent: true, isLaptopBattery: false, percentage: -0.01, state: M.STATE.Unknown }

// ---- kind inference (name overrides UPower type) ----
eq(M.inferKind(mxMaster), 'mouse', 'MX Master name -> mouse despite UPower keyboard type')
eq(M.inferKind(mxKeys), 'keyboard', 'MX Keys -> keyboard')
eq(M.inferKind(xbox), 'gamepad', 'Xbox -> gamepad')
eq(M.inferKind(headset), 'headset', 'WH-1000XM5 -> headset')
eq(M.inferKind({ model: 'JBL Charge 6', type: T.BluetoothGeneric }), 'speaker', 'JBL -> speaker')
eq(M.inferKind({ model: 'Pixel 8', type: T.BluetoothGeneric }), 'phone', 'Pixel -> phone')
eq(M.inferKind({ model: 'Unknown', type: T.Mouse }), 'mouse', 'falls back to UPower type')
eq(M.kindIcon('gamepad'), cp(0xF0296), 'gamepad icon glyph')
eq(M.transportIcon('bluetooth'), cp(0xF00AF), 'bluetooth transport glyph')

// ---- classification ----
eq(M.isAccessory(mxKeys, false), true, 'keyboard is accessory')
eq(M.isAccessory(laptop, false), false, 'laptop pack is not accessory')
eq(M.isAccessory(display, true), false, 'display device excluded')

// ---- percentage and invalid readings ----
eq(M.percentOf(mxKeys), 10, 'fraction 0.10 -> 10')
eq(M.percentOf(mxMaster), 100, 'fraction 1.0 -> 100')
eq(M.percentOf(sleeping), -1, 'negative reading treated as unknown')
eq(M.collect([sleeping], [], display, {}).length, 0, 'sleeping device is not listed')

// ---- state / duration ----
eq(M.stateLabel(mxKeys, false, false), 'Discharging', 'state discharging')
eq(M.stateLabel({ state: M.STATE.Charging }, true, false), 'Charging', 'state charging')
eq(M.stateLabel(mxMaster, false, true), 'Fully charged', 'state full')
eq(M.formatDuration(7200), '2h', 'duration 2h')
eq(M.formatDuration(3900), '1h 5m', 'duration 1h 5m')
eq(M.formatDuration(45), '<1m', 'duration sub-minute')
eq(M.formatDuration(0), '', 'duration zero -> empty')
eq(M.detailFor(mxKeys, false, false), '2h left', 'time left detail')
eq(M.detailFor({ timeToFull: 3600 }, true, false), 'Full in 1h', 'time to full detail')

// ---- severity thresholds ----
eq([M.severity(10, 30, 15), M.severity(25, 30, 15), M.severity(50, 30, 15), M.severity(90, 30, 15)], ['critical','low','medium','good'], 'severity bands')

// ---- transport ----
eq(M.transportFor(mxKeys, [], null), 'wireless', 'HID++ -> wireless')
eq(M.transportFor(xbox, [], null), 'wired', 'GIP default -> wired')
const bt = { connected: true, name: 'MX Keys', address: 'E8:AB:FA:11:22:33', batteryAvailable: true, battery: 0.1 }
eq(M.transportFor(mxKeys, [bt], null), 'bluetooth', 'name match -> bluetooth')

// ---- collect / sort / hide / external ----
const list = M.collect([display, laptop, mxMaster, xbox, mxKeys], [], display, {})
eq(list.map(x => x.name), ['Logitech MX Keys', 'Microsoft Xbox Controller', 'Logitech MX Master 3'], 'sorted ascending, system dropped')
eq(list[0].percent, 10, 'lowest first')
eq(list[0].typeIcon, cp(0xF030C), 'mx keys keyboard icon')
eq(list[2].typeIcon, cp(0xF037D), 'mx master mouse icon despite UPower type')
eq(M.summary(list).lowest, 10, 'summary lowest')
eq(M.summary(list).count, 3, 'summary count')
eq(M.summary(list).severity, 'critical', 'summary worst severity')
eq(M.barText(list, true, false, false), cp(0xF007B) + ' 10%', 'bar text')

const hidden = M.collect([mxKeys, xbox], [], display, { hiddenDevices: ['Xbox'] })
eq(hidden.map(x => x.name), ['Logitech MX Keys'], 'hidden device filtered out')
const noWired = M.collect([mxKeys, xbox], [], display, { hideWired: true })
eq(noWired.map(x => x.name), ['Logitech MX Keys'], 'hideWired drops wired')

const external = M.normalizeExternal([
  { id: 'phone', name: 'Pixel 8', kind: 'phone', pct: 72, charging: false, ts: 1150 },
  { id: 'old', name: 'Old Box', kind: 'generic', pct: 40, ts: 500 }
], 1200, 100)
eq(external.map(x => [x.name, x.online]), [['Pixel 8', true], ['Old Box', false]], 'external TTL marks stale offline')
eq(external[0].typeIcon, cp(0xF011C), 'external phone icon')
const merged = M.collect([mxKeys], [], display, { external: [{ id: 'p', name: 'Pixel 8', kind: 'phone', pct: 5, ts: 1000, ttl: 99999 }], now: 1000 })
eq(merged.map(x => x.name), ['Pixel 8', 'Logitech MX Keys'], 'external merged and sorted')
eq(M.onlineEntries(merged).length, 2, 'online entries count')
eq(merged[0].transportLabel, 'External', 'external default transport label')
eq(merged[0].transportIcon, cp(0xF0FB0), 'external transport icon')

// ---- KDE Connect source (merged through `additional`) ----
const kdc = M.normalizeExternal([{ id: 'k1', name: 'Pixel 8', kind: 'phone', pct: 63, charging: true, transport: 'kdeconnect', source: 'kdeconnect', ts: 1000 }], 1000, 900)
eq(kdc[0].transportLabel, 'KDE Connect', 'kdeconnect transport label')
eq(kdc[0].transportIcon, cp(0xF012E), 'kdeconnect transport icon')
eq(kdc[0].source, 'kdeconnect', 'kdeconnect source tag')
eq(kdc[0].stateLabel, 'Charging', 'kdeconnect charging state')
const withKdc = M.collect([mxKeys], [], display, { additional: [JSON.stringify([{ id: 'k1', name: 'Pixel 8', kind: 'phone', pct: 3, transport: 'kdeconnect', ts: 1000 }])], now: 1000 })
eq(withKdc.map(x => x.name), ['Pixel 8', 'Logitech MX Keys'], 'additional source merged and sorted')
eq(withKdc[0].transport, 'kdeconnect', 'additional entry transport')

// ---- battery glyphs ----
eq(M.batteryGlyph(10, false), cp(0xF007B), 'glyph 10%')
eq(M.batteryGlyph(0, false), cp(0xF007A), 'glyph 0%')
eq(M.batteryGlyph(100, false), cp(0xF0079), 'glyph 100%')
eq(M.batteryGlyph(50, true), cp(0xF0089), 'charging glyph 50%')
eq(M.batteryGlyph(100, true), cp(0xF0085), 'charging glyph 100%')
eq(M.batteryGlyph(-1, false), cp(0xF008E), 'unknown glyph outline')
let allSingle = true
for (let p = -1; p <= 100; p++) {
  for (const ch of [false, true]) {
    const g = M.batteryGlyph(p, ch)
    if ([...g].length !== 1 || /[0-9A-F]/.test(g)) { allSingle = false; console.log('   bad glyph', p, ch, JSON.stringify(g)) }
  }
}
eq(allSingle, true, 'every glyph is a single codepoint')

// ---- critical keys for notifications ----
eq(M.criticalKeys(list, 15), [mxKeys.nativePath], 'criticalKeys returns low device key')
eq(M.criticalKeys([mxMaster], 15), [], 'full device not critical')

// ---- tooltip ----
eq(M.tooltipText([]), 'No peripheral batteries', 'empty tooltip')
eq(M.tooltipText([{ name: 'A', percent: 10, charging: true, transportLabel: 'Bluetooth', online: true }]),
   'A \u2014 10%' + cp(0xF140B) + ' \u00B7 Bluetooth', 'tooltip row with charging bolt')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
