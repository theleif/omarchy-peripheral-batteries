import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Services.UPower
import Quickshell.Bluetooth
import qs.Commons
import qs.Ui
import "AccessoryModel.js" as Model

// Bar widget + popup listing the battery level of every connected peripheral:
// Bluetooth devices, 2.4GHz receiver devices (Logitech HID++), USB/cable
// devices, and anything a user feeds in through the external JSON source.
//
// Behaviour is modelled on BatteryWatch (Bazzite/KDE): the icon hides itself
// when nothing is connected, low batteries are announced once, specific
// devices can be hidden, and Bluetooth devices can be disconnected from the
// popup. Device kinds are inferred from the model name because UPower
// mislabels peripherals (KDE bug #525589).
Panel {
  id: root
  moduleName: "theleif.accessories"
  ipcTarget: "theleif.accessories"

  readonly property bool vertical: bar ? bar.vertical : false
  readonly property bool showPercent: setting("showPercent", true) === true
  readonly property bool showCount: setting("showCount", false) === true
  readonly property bool hideWhenEmpty: setting("hideWhenEmpty", true) === true
  readonly property bool hideWired: setting("hideWired", false) === true
  readonly property bool notifyLow: setting("notifyLow", true) === true
  readonly property bool kdeconnectSource: setting("kdeconnectSource", true) === true
  readonly property int warningThreshold: Number(setting("warningThreshold", 30))
  readonly property int criticalThreshold: Number(setting("criticalThreshold", 15))
  readonly property int refreshSeconds: Math.max(5, Number(setting("refreshInterval", 10)))
  readonly property var hiddenDevices: setting("hiddenDevices", [])
  readonly property var transportOverrides: setting("transportOverrides", null)
  readonly property string externalPath: setting("externalPath", Quickshell.env("HOME") + "/.cache/omarchy-accessories/external.json")
  readonly property string kdeconnectScript: String(Qt.resolvedUrl("sources/kdeconnect.py")).replace(/^file:\/\//, "")

  property var accessories: []
  // Raw sysfs snapshot keyed by power_supply name, so the model can tell a
  // real percentage from UPower's stand-in for a coarse capacity_level.
  property var powerSupply: ({})
  property bool powerSupplyReady: false
  // Optional Solaar readings: real HID++ percentages for devices whose kernel
  // power_supply only exposes a coarse level.
  property var solaarReadings: []
  property bool solaarAvailable: false
  property double solaarChecked: 0
  property string barLabel: ""
  property string barTooltip: ""
  property bool alert: false
  property bool anyCharging: false
  property bool hasDevices: false
  property bool cursorActive: false
  property int cursorIndex: 0
  property string kdeconnectJson: "[]"
  property bool kdeconnectAvailable: false

  // Persistent set of device keys already announced, so a low battery fires
  // once per crossing rather than on every refresh.
  PersistentProperties {
    id: persisted
    reloadableId: "omarchy-accessories"
    property string notified: ""
  }

  // UPower's model names, remembered per serial on disk: UPower stops
  // reporting a peripheral while it charges, and the kernel's model name
  // ("Wireless Mouse MX Master 3") is not what the user normally sees.
  readonly property string namesPath: Quickshell.env("HOME") + "/.cache/omarchy-accessories/device-names.json"
  property var knownNames: ({})
  property string namesWritten: ""
  // False until the names file has been read, so an early rebuild cannot
  // overwrite remembered names with the empty initial map.
  property bool namesReady: false

  function parseKnownNames(raw) {
    if (!raw) return ({})
    try {
      var parsed = JSON.parse(String(raw))
      return parsed && typeof parsed === "object" ? parsed : ({})
    } catch (error) {
      return ({})
    }
  }

  function saveKnownNames(map) {
    var json = JSON.stringify(map)
    if (json === root.namesWritten) return
    root.namesWritten = json
    Quickshell.execDetached([
      "sh", "-c", "mkdir -p \"$(dirname \"$2\")\" && printf '%s' \"$1\" > \"$2\"",
      "sh", json, root.namesPath
    ])
  }

  // Record the UPower name for every peripheral it currently reports, keyed by
  // serial (falling back to the native path), and persist only on change.
  function rememberDeviceNames() {
    var existing = root.knownNames || ({})
    if (!root.namesReady) return existing
    var known = ({})
    for (var key in existing) known[key] = existing[key]
    var changed = false
    var devices = UPower.devices ? UPower.devices.values : []
    for (var i = 0; i < devices.length; i++) {
      var device = devices[i]
      if (!device || device.isPresent !== true) continue
      // No sysfs entry means the snapshot has not run yet; recording a name
      // under the native path then would create a duplicate key.
      var info = root.powerSupply[String(device.nativePath || "")]
      if (!info) continue
      var serial = info.serial ? Model.normalizeSerial(info.serial) : ""
      var nameKey = serial !== "" ? serial : String(device.nativePath || "")
      var name = String(device.model || "").trim()
      if (nameKey === "" || name === "") continue
      if (known[nameKey] === name) continue
      known[nameKey] = name
      changed = true
    }
    if (changed) {
      root.knownNames = known
      saveKnownNames(known)
    }
    return known
  }

  function refresh() {
    rebuild()
    if (!sysfsProc.running) sysfsProc.running = true
    refreshSolaar(false)
    if (root.kdeconnectSource && root.kdeconnectAvailable && !kdeconnectProc.running)
      kdeconnectProc.running = true
  }

  function rebuild() {
    accessories = Model.collect(
      UPower.devices ? UPower.devices.values : [],
      Bluetooth.devices ? Bluetooth.devices.values : [],
      UPower.displayDevice,
      {
        hideWired: root.hideWired,
        warning: root.warningThreshold,
        critical: root.criticalThreshold,
        hiddenDevices: root.hiddenDevices,
        transportOverrides: root.transportOverrides,
        powerSupply: root.powerSupply,
        knownNames: rememberDeviceNames(),
        solaar: root.solaarReadings,
        external: externalFile.text(),
        additional: [root.kdeconnectJson],
        now: Date.now() / 1000
      }
    )
    var info = Model.summary(accessories)
    hasDevices = info.count > 0
    anyCharging = info.charging
    barLabel = Model.barText(accessories, showPercent, vertical, showCount)
    barTooltip = Model.tooltipText(accessories)
    alert = info.severity === "critical" || info.severity === "low"
    if (cursorIndex > accessories.length - 1)
      cursorIndex = Math.max(0, accessories.length - 1)
    maybeNotify()
  }

  function deviceForKey(key) {
    for (var i = 0; i < accessories.length; i++)
      if (accessories[i].key === key) return accessories[i]
    return null
  }

  // Announce devices that have just crossed into the critical band.
  function maybeNotify() {
    if (!notifyLow) return
    // Wait for the sysfs snapshot, otherwise the first build classifies a
    // level-only device from its synthetic percentage and alerts on it.
    if (!root.powerSupplyReady) return
    var keys = Model.criticalKeys(accessories, criticalThreshold)
    var already = persisted.notified.split(",")
    for (var i = 0; i < keys.length; i++) {
      if (already.indexOf(keys[i]) !== -1) continue
      var item = deviceForKey(keys[i])
      if (item) notifyDevice(item)
    }
    persisted.notified = keys.join(",")
  }

  function notifyDevice(item) {
    Quickshell.execDetached([
      "notify-send",
      "-a", "Peripheral Batteries",
      "-u", "critical",
      "-i", "battery-caution",
      item.name + " battery low",
      Model.valueText(item) + " \u00B7 " + item.transportLabel
    ])
  }

  function bluetoothAddress(item) {
    if (!item) return ""
    if (item.bluetoothAddress) return item.bluetoothAddress
    if (item.source === "bluetooth") return item.nativePath
    return ""
  }

  function disconnectDevice(item) {
    var address = bluetoothAddress(item)
    if (!address) return
    var devices = Bluetooth.devices ? Bluetooth.devices.values : []
    for (var i = 0; i < devices.length; i++) {
      if ((devices[i].address || "") === address) {
        if (devices[i].disconnect) devices[i].disconnect()
        break
      }
    }
  }

  function severityColor(item) {
    if (!item || !item.online) return Qt.darker(root.bar.foreground, 1.6)
    if (item.severity === "critical" || item.severity === "low") return root.bar.urgent
    return root.bar.foreground
  }

  function moveCursor(delta) {
    if (accessories.length === 0) return
    cursorActive = true
    cursorIndex = Math.max(0, Math.min(accessories.length - 1, cursorIndex + delta))
  }

  function activateCursor() {
    var item = accessories[cursorIndex]
    if (item) root.disconnectDevice(item)
  }

  visible: root.hasDevices || !root.hideWhenEmpty
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  Component.onCompleted: { refresh(); probeKdeconnect(); solaarProbe.running = true }
  onBarChanged: refresh()
  onSettingsChanged: refresh()
  onHideWiredChanged: refresh()
  onWarningThresholdChanged: refresh()
  onCriticalThresholdChanged: refresh()
  onHiddenDevicesChanged: refresh()
  onTransportOverridesChanged: refresh()
  onExternalPathChanged: refresh()
  onKdeconnectSourceChanged: {
    if (root.kdeconnectSource) probeKdeconnect()
    else { root.kdeconnectJson = "[]"; root.rebuild() }
  }
  onOpenedChanged: {
    if (opened) {
      refresh()
      refreshSolaar(false)
      cursorActive = false
      cursorIndex = 0
    }
  }

  Timer {
    interval: root.refreshSeconds * 1000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Connections {
    target: UPower
    function onOnBatteryChanged() { root.refresh() }
  }

  // Optional external source: [{"id","name","kind","pct","charging","ts","ttl"}].
  FileView {
    id: externalFile
    path: root.externalPath
    watchChanges: true
    printErrors: false
    onFileChanged: root.refresh()
    onLoaded: root.refresh()
    onLoadFailed: root.refresh()
  }

  // Remembered UPower model names (serial -> name), written by saveKnownNames.
  FileView {
    id: namesFile
    path: root.namesPath
    watchChanges: true
    printErrors: false
    onLoaded: {
      root.namesWritten = String(namesFile.text() || "")
      root.knownNames = root.parseKnownNames(root.namesWritten)
      root.namesReady = true
      root.rebuild()
    }
    onFileChanged: {
      var text = String(namesFile.text() || "")
      // Ignore a transient empty read of a file we know has content.
      if (text === "" && root.namesWritten !== "") return
      root.namesWritten = text
      root.knownNames = root.parseKnownNames(text)
      root.namesReady = true
      root.rebuild()
    }
    onLoadFailed: {
      // No file yet: start from empty and let the next rebuild create it.
      root.knownNames = ({})
      root.namesReady = true
      root.rebuild()
    }
  }

  // Snapshot every power_supply: name, numeric capacity (empty when the
  // kernel has none) and the coarse capacity_level. HID++ peripherals behind
  // a Unifying receiver only ever expose the level, which is how UPower's
  // synthesised 10 %/50 % values are recognised.
  Process {
    id: sysfsProc
    command: ["sh", "-c", "for d in /sys/class/power_supply/*; do [ -d \"$d\" ] || continue; c=$(cat \"$d/capacity\" 2>/dev/null); l=$(cat \"$d/capacity_level\" 2>/dev/null); if [ -n \"$c\" ] || [ -n \"$l\" ]; then printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \"$(basename \"$d\")\" \"$c\" \"$l\" \"$(cat \"$d/serial_number\" 2>/dev/null)\" \"$(cat \"$d/model_name\" 2>/dev/null)\" \"$(cat \"$d/status\" 2>/dev/null)\"; fi; done"]
    stdout: StdioCollector {
      id: sysfsOutput
      waitForEnd: true
      onStreamFinished: {
        root.powerSupply = Model.parsePowerSupply(String(sysfsOutput.text || ""))
        root.powerSupplyReady = true
        root.rebuild()
      }
    }
  }

  // Solaar is optional: when installed it can read a real HID++ percentage
  // for devices whose kernel power_supply only reports a level bucket.
  Process {
    id: solaarProbe
    command: ["sh", "-c", "command -v solaar >/dev/null 2>&1"]
    onExited: function(code) {
      root.solaarAvailable = code === 0
      if (root.solaarAvailable) root.refreshSolaar(true)
    }
  }

  Process {
    id: solaarProc
    command: ["timeout", "25", "solaar", "show"]
    stdout: StdioCollector {
      id: solaarOutput
      waitForEnd: true
      onStreamFinished: {
        root.solaarReadings = Model.parseSolaar(String(solaarOutput.text || ""))
        root.rebuild()
      }
    }
  }

  // `solaar show` takes ~12 s (it queries every feature), and charge moves
  // slowly, so a quarter-hourly poll is plenty.
  Timer {
    interval: 900000
    running: root.solaarAvailable
    repeat: true
    onTriggered: root.refreshSolaar(true)
  }

  // `solaar show` wakes every device and takes a couple of seconds, so it is
  // throttled instead of running on the 10 s refresh tick.
  function refreshSolaar(force) {
    if (solaarProc.running || solaarProbe.running) return
    var now = Date.now() / 1000
    if (!force && now - root.solaarChecked < 300) return
    root.solaarChecked = now
    // Re-probe when Solaar is missing, so installing it needs no shell restart.
    if (!root.solaarAvailable) {
      solaarProbe.running = true
      return
    }
    solaarProc.running = true
  }

  // Cheap probe so we don't spawn the collector on machines without KDE
  // Connect. Exit 0 means the daemon answered on the session bus.
  Process {
    id: kdeconnectProbe
    command: ["sh", "-c", "command -v gdbus >/dev/null 2>&1 && gdbus call --session --dest org.kde.kdeconnect --object-path /modules/kdeconnect --method org.kde.kdeconnect.daemon.devices false false >/dev/null 2>&1"]
    onExited: function(code) {
      root.kdeconnectAvailable = code === 0
      if (root.kdeconnectAvailable) root.refresh()
    }
  }

  // KDE Connect battery collector; prints the external-source JSON shape.
  Process {
    id: kdeconnectProc
    command: ["python3", root.kdeconnectScript]
    stdout: StdioCollector {
      id: kdeconnectOutput
      waitForEnd: true
      onStreamFinished: {
        var text = String(kdeconnectOutput.text || "").trim()
        if (text !== "") root.kdeconnectJson = text
        root.rebuild()
      }
    }
  }

  function probeKdeconnect() {
    if (root.kdeconnectSource && !kdeconnectProbe.running)
      kdeconnectProbe.running = true
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.barLabel
    active: root.alert
    // Reserve the wide slot only when a number or count is actually drawn;
    // level-only devices show the glyph alone.
    slotSize: Style.bar.iconSlot * (root.barLabel.indexOf(" ") !== -1 ? 2.0 : 1)
    tooltipText: root.barTooltip
    onPressed: function(b) { root.toggle() }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        if (!root.cursorActive) { root.cursorActive = true; return }
        if (dy !== 0) root.moveCursor(dy)
      }
      onActivateRequested: if (root.cursorActive) root.activateCursor()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onDeleteRequested: if (root.cursorActive) root.activateCursor()
      onTextKey: function(t) { if (t === "r" || t === "R") root.refresh() }

      Column {
        id: column
        anchors.fill: parent
        spacing: Style.space(14)

        // ---------- Hero: aggregate glyph · title/count · state ----------
        Item {
          width: parent.width
          implicitHeight: Math.max(heroIcon.implicitHeight, heroLabels.implicitHeight)

          Text {
            id: heroIcon
            textFormat: Text.PlainText
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            text: Model.barGlyph(root.accessories)
            color: root.alert ? root.bar.urgent : root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.display
          }

          Column {
            id: heroLabels
            anchors.left: heroIcon.right
            anchors.leftMargin: Style.space(14)
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              textFormat: Text.PlainText
              text: "Peripherals"
              color: root.bar.foreground
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
              elide: Text.ElideRight
              width: parent.width
            }

            Text {
              textFormat: Text.PlainText
              text: {
                if (root.accessories.length === 0) return "No batteries detected"
                var info = Model.summary(root.accessories)
                var parts = [info.count + (info.count === 1 ? " device" : " devices")]
                if (info.lowest >= 0) parts.push("lowest " + info.lowest + "%")
                else if (info.coarseCount > 0) parts.push("level only")
                if (root.anyCharging) parts.push("charging")
                return parts.join(" \u00B7 ")
              }
              color: Qt.darker(root.bar.foreground, 1.4)
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.2
              elide: Text.ElideRight
              width: parent.width
            }
          }
        }

        PanelSeparator {
          foreground: root.bar.foreground
        }

        Text {
          textFormat: Text.PlainText
          visible: root.accessories.length === 0
          width: parent.width
          text: "Connect a Bluetooth, wireless, or USB peripheral that reports a battery, or add one to the external source."
          color: Qt.darker(root.bar.foreground, 1.5)
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
        }

        ListView {
          id: list
          visible: root.accessories.length > 0
          width: parent.width
          height: Math.min(contentHeight, Style.space(440))
          spacing: Style.space(6)
          clip: true
          interactive: contentHeight > height
          boundsBehavior: Flickable.StopAtBounds

          model: root.accessories
          currentIndex: root.cursorActive ? root.cursorIndex : -1
          onCurrentIndexChanged: if (currentIndex >= 0) Qt.callLater(keepCurrentVisible)
          function keepCurrentVisible() {
            if (currentIndex >= 0) positionViewAtIndex(currentIndex, ListView.Contain)
          }

          delegate: AccessoryRow {
            required property var modelData
            required property int index
            width: ListView.view.width
            item: modelData
            rowIndex: index
          }
        }

        Text {
          textFormat: Text.PlainText
          visible: root.accessories.length > 0
          width: parent.width
          text: "j/k navigate \u00B7 enter or x disconnect \u00B7 r refresh"
          color: Qt.darker(root.bar.foreground, 1.6)
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }
  }

  component AccessoryRow: CursorSurface {
    id: row
    required property var item
    required property int rowIndex

    readonly property bool rowSelected: root.cursorActive && root.cursorIndex === row.rowIndex
    readonly property color itemColor: root.severityColor(row.item)
    readonly property bool offline: row.item.online !== true
    readonly property bool canDisconnect: root.bluetoothAddress(row.item) !== ""
    readonly property bool showDisconnect: row.canDisconnect && (rowMouse.containsMouse || row.rowSelected)
    readonly property string metaText: {
      var parts = [row.item.transportLabel]
      if (row.item.detail) parts.push(row.item.detail)
      else if (row.item.stateLabel) parts.push(row.item.stateLabel)
      return parts.join(" \u00B7 ")
    }

    hasCursor: rowSelected
    foreground: root.bar.foreground
    opacity: offline ? 0.55 : 1.0
    implicitHeight: rowContent.implicitHeight + Style.spacing.rowPaddingX
    height: implicitHeight

    // Row-level hover and double-click. Colour never reads containsMouse
    // directly; it flows through the panel cursor (CursorSurface contract).
    MouseArea {
      id: rowMouse
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onContainsMouseChanged: if (containsMouse) {
        root.cursorActive = true
        root.cursorIndex = row.rowIndex
      }
      onDoubleClicked: root.disconnectDevice(row.item)
    }

    Item {
      id: rowContent
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(10)
      implicitHeight: Math.max(typeGlyph.implicitHeight, info.implicitHeight, trailing.implicitHeight)

      Text {
        id: typeGlyph
        textFormat: Text.PlainText
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        text: row.item.typeIcon
        color: row.itemColor
        font.family: root.bar.fontFamily
        font.pixelSize: Style.font.heading
      }

      Text {
        textFormat: Text.PlainText
        visible: row.item.charging
        anchors.left: typeGlyph.right
        anchors.leftMargin: -Style.space(3)
        anchors.bottom: typeGlyph.bottom
        text: Model.codepoint(Model.ICON_CHARGING_BOLT)
        color: row.itemColor
        font.family: root.bar.fontFamily
        font.pixelSize: Style.font.caption
      }

      Column {
        id: info
        anchors.left: typeGlyph.right
        anchors.leftMargin: Style.space(10)
        anchors.right: trailing.left
        anchors.rightMargin: Style.space(10)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(4)

        Text {
          textFormat: Text.PlainText
          width: parent.width
          text: row.item.name
          color: root.bar.foreground
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.body
          elide: Text.ElideRight
        }

        Item {
          width: parent.width
          implicitHeight: Math.max(progress.implicitHeight, meta.implicitHeight)

          Rectangle {
            id: progress
            // No progress bar without a real percentage.
            visible: row.item.percent >= 0
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            width: Math.max(0, parent.width - meta.implicitWidth - Style.space(8))
            height: Style.space(4)
            radius: height / 2
            color: Qt.rgba(root.bar.foreground.r, root.bar.foreground.g, root.bar.foreground.b, 0.16)

            Rectangle {
              width: Math.max(0, parent.width * (row.item.percent / 100))
              height: parent.height
              radius: parent.radius
              color: row.itemColor
            }
          }

          Row {
            id: meta
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(4)

            Text {
              textFormat: Text.PlainText
              anchors.verticalCenter: parent.verticalCenter
              text: row.item.transportIcon
              color: Qt.darker(root.bar.foreground, 1.4)
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.caption
            }

            Text {
              textFormat: Text.PlainText
              anchors.verticalCenter: parent.verticalCenter
              text: row.metaText
              color: Qt.darker(root.bar.foreground, 1.4)
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.caption
            }
          }
        }
      }

      Row {
        id: trailing
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(6)

        Text {
          textFormat: Text.PlainText
          anchors.verticalCenter: parent.verticalCenter
          text: row.item.batteryGlyph
          color: row.itemColor
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.body
        }

        Text {
          textFormat: Text.PlainText
          anchors.verticalCenter: parent.verticalCenter
          text: Model.valueText(row.item)
          color: row.itemColor
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.body
          font.bold: true
        }

        PanelActionButton {
          anchors.verticalCenter: parent.verticalCenter
          visible: row.showDisconnect
          iconText: Model.codepoint(0xF0159)
          tooltipText: "Disconnect"
          foreground: root.bar.foreground
          fontFamily: root.bar.fontFamily
          hasCursor: row.rowSelected
          onHovered: function(isHovered) {
            if (isHovered) {
              root.cursorActive = true
              root.cursorIndex = row.rowIndex
            }
          }
          onClicked: root.disconnectDevice(row.item)
        }
      }
    }
  }
}
