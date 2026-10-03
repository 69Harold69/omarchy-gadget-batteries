import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Services.UPower
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Bar widget listing the battery of connected gadgets. Sources:
//   - UPower: mice/keyboards on Logitech receivers (hidpp) and Bluetooth.
//   - headsetcontrol: USB/2.4 GHz headsets such as the Logitech G522.
//   - omarchy-buds status.json: Galaxy Buds through GalaxyBudsClient.
//   - sources/gfps-daemon (wraps gfps-reader): per-earbud battery over Google
//     Fast Pair (Sony, JBL, Jabra, Nothing, Soundcore, Pixel Buds, ...).
//   - collect + collectors.d/: one-shot scripts (AirPods BLE adverts, and any
//     script in ~/.config/omarchy/gadget-batteries/collectors.d/).
//   - external JSON file (theleif/omarchy-peripheral-batteries format).
// There is one widget per monitor; the background scripts lock so the work
// runs once and every widget reads the shared files in
// ~/.cache/omarchy-gadget-batteries.
// The widget hides itself when no gadget reports a battery.
Panel {
  id: root
  moduleName: "io.github.69harold69.gadget-batteries"
  ipcTarget: "io.github.69harold69.gadget-batteries"

  readonly property string lang: Model.languageFromLocale(Quickshell.env("LC_ALL")
    || Quickshell.env("LC_MESSAGES") || Quickshell.env("LANG"))
  readonly property bool showPercentage: setting("showPercentage", false) === true
  // 0 turns low-battery notifications (and the low highlight) off; anything
  // that is not a non-negative number falls back to 15.
  readonly property int lowThreshold: {
    var value = Number(setting("lowThreshold", 15))
    return isFinite(value) && value >= 0 ? value : 15
  }
  readonly property string budsStatusPath: (Quickshell.env("XDG_STATE_HOME")
    || Quickshell.env("HOME") + "/.local/state") + "/omarchy-buds/status.json"

  readonly property string externalPath: String(setting("externalPath", "")
    || (Quickshell.env("XDG_CACHE_HOME") || Quickshell.env("HOME") + "/.cache")
       + "/omarchy-accessories/external.json")
  readonly property string cacheDir: (Quickshell.env("XDG_CACHE_HOME")
    || Quickshell.env("HOME") + "/.cache") + "/omarchy-gadget-batteries"
  readonly property string pluginDir: String(Qt.resolvedUrl(".")).replace(/^file:\/\//, "")

  property var headsetDevices: []
  property var budsDevices: []
  property var collectorDevices: []
  property string externalText: ""
  property string gfpsText: ""
  // sysfs power_supply name -> false when the kernel says the device is out
  // of reach (a Logitech mouse switched off or moved to its cable). UPower
  // keeps such a device "present" with its last level, so filter it here.
  property var sysfsOnline: ({})
  // Ticks so external entries turn offline when their TTL runs out.
  property real nowSec: Date.now() / 1000

  readonly property var externalDevices: Model.fromExternal(externalText, nowSec)
  readonly property var gfpsDevices: Model.fromExternal(gfpsText, nowSec)

  // Re-evaluated whenever UPower adds/removes devices or a device changes.
  readonly property var upowerDevices: {
    var list = UPower.devices ? UPower.devices.values : []
    var out = []
    for (var i = 0; i < list.length; i++) {
      var d = list[i]
      // Touch the properties so the binding tracks them.
      var _ = [d.percentage, d.state, d.isPresent, d.model]
      if (root.sysfsOnline[d.nativePath] === false) continue
      var device = Model.fromUPower(d, UPowerDeviceType.toString(d.type), UPowerDeviceState.Charging,
        UPowerDeviceState.Unknown)
      if (device) out.push(device)
    }
    return out
  }

  readonly property var rawDevices: Model.mergeDevices([budsDevices, collectorDevices, gfpsDevices,
    headsetDevices, externalDevices, upowerDevices])
  property var devices: []
  readonly property bool hasDevices: devices.length > 0
  readonly property var lowest: {
    for (var i = 0; i < devices.length; i++) if (!devices[i].offline) return devices[i]
    return hasDevices ? devices[0] : null
  }

  PersistentProperties {
    id: persisted
    reloadableId: "gadget-batteries"
    property var notified: ({})
    property var trends: ({})
    property var fullNotified: ({})
  }

  function updateDevices() {
    var named = Model.applyNames(rawDevices, setting("names", {}))
    var result = Model.applyTrends(named, persisted.trends, Date.now() / 1000)
    persisted.trends = result.trends
    devices = result.devices
  }

  onRawDevicesChanged: updateDevices()
  Component.onCompleted: updateDevices()

  onDevicesChanged: checkLowBattery()
  onHasDevicesChanged: if (!hasDevices) close()

  visible: hasDevices
  implicitWidth: hasDevices ? button.implicitWidth : 0
  implicitHeight: hasDevices ? button.implicitHeight : 0

  function refreshHeadsets() {
    if (!headsetProc.running) headsetProc.running = true
  }


  function refreshCollectors() {
    if (collectorsProc.running) return
    // Set right before launching: a binding would still hold the old value
    // when this runs from onOpenedChanged. null removes the variable.
    collectorsProc.environment = { "GADGET_BATTERIES_PANEL_OPEN": opened ? "1" : null }
    collectorsProc.running = true
  }

  function checkLowBattery() {
    if (lowThreshold > 0) {
      var result = Model.lowBatteryAlerts(devices, lowThreshold, persisted.notified)
      persisted.notified = result.notified
      for (var i = 0; i < result.alerts.length; i++) {
        var d = result.alerts[i]
        Quickshell.execDetached([pluginDir + "notify-once", d.key,
          Model.tr(lang, "lowTitle", d.name), Model.tr(lang, "lowBody", d.level)])
      }
    } else {
      persisted.notified = {}
    }

    // Once per charge: notify at 100%, re-arm when it stops charging or drops.
    var full = {}
    for (var j = 0; j < devices.length; j++) {
      var g = devices[j]
      if (g.offline) continue
      var wasFull = persisted.fullNotified[g.key] === true
      if (g.charging && g.level >= 100 && !wasFull)
        Quickshell.execDetached([pluginDir + "notify-once", "full:" + g.key,
          Model.tr(lang, "fullTitle", g.name), Model.tr(lang, "fullBody"), "normal"])
      if ((g.charging || wasFull) && g.level >= 95) full[g.key] = g.level >= 100 || wasFull
    }
    persisted.fullNotified = full
  }

  // The vendor app behind a row, if there is one to open and it is installed.
  function appCommand(d) {
    var command = null
    if (d.key.indexOf("buds:") === 0) command = ["galaxybudsclient", "app", "--activate-window"]
    else if (/^solaar:|^upower:hidpp/.test(d.key) || /^logitech /i.test(d.name)) command = ["solaar"]
    return command && availableApps[command[0]] === true ? command : null
  }

  // Which vendor apps are installed, checked once at startup.
  property var availableApps: ({})

  Process {
    running: true
    command: ["sh", "-c", "for app in solaar galaxybudsclient; do command -v \"$app\" >/dev/null && echo \"$app\"; done"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var apps = {}
        String(text).split("\n").forEach(function(name) { if (name) apps[name] = true })
        root.availableApps = apps
      }
    }
  }

  readonly property string summaryText: {
    var lines = []
    for (var i = 0; i < devices.length; i++) {
      var d = devices[i]
      lines.push(d.name + ": " + (d.offline ? Model.tr(lang, "offline") : d.level + "%" + (d.charging ? " ⚡" : "")))
    }
    return lines.join("\n")
  }

  Process {
    id: headsetProc
    command: ["headsetcontrol", "-o", "json"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.headsetDevices = Model.fromHeadsetControl(text)
    }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      // headsetcontrol missing or no headset plugged in.
      if (exitCode !== 0 && exitCode !== 1) root.headsetDevices = []
    }
  }

  Timer {
    interval: root.opened ? 10000 : 60000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refreshHeadsets()
  }

  onOpenedChanged: if (opened) { refreshHeadsets(); refreshCollectors() }

  Process {
    id: onlineProc
    command: ["sh", "-c", "grep -H . /sys/class/power_supply/*/online 2>/dev/null"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var map = {}
        var lines = String(text).split("\n")
        for (var i = 0; i < lines.length; i++) {
          var m = lines[i].match(/power_supply\/([^/]+)\/online:(\d+)/)
          if (m) map[m[1]] = m[2] !== "0"
        }
        root.sysfsOnline = map
      }
    }
  }

  Timer {
    interval: 15000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: if (!onlineProc.running) onlineProc.running = true
  }

  Process {
    id: collectorsProc
    // environment is set by refreshCollectors(): GADGET_BATTERIES_PANEL_OPEN=1
    // while the panel is open lets the AirPods collector skip its 5-minute
    // scan cache.
    command: [root.pluginDir + "collect"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.collectorDevices = Model.fromExternal(text, Date.now() / 1000)
    }
    stderr: StdioCollector { waitForEnd: true }
  }

  Timer {
    interval: 60000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: {
      root.nowSec = Date.now() / 1000
      root.refreshCollectors()
      // Let estimated charging expire even when no level changes.
      root.updateDevices()
    }
  }

  // Every widget starts the daemon; all but one wait on its lock as standbys.
  Process {
    id: gfpsDaemon
    command: [root.pluginDir + "sources/gfps-daemon"]
    running: true
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: gfpsRestart.restart()
  }

  Timer {
    id: gfpsRestart
    interval: 30000
    onTriggered: gfpsDaemon.running = true
  }

  FileView {
    path: root.cacheDir + "/gfps.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.gfpsText = text()
    onTextChanged: root.gfpsText = text()
    onLoadFailed: root.gfpsText = ""
  }

  FileView {
    path: root.externalPath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.externalText = text()
    onTextChanged: root.externalText = text()
    onLoadFailed: root.externalText = ""
  }

  FileView {
    path: root.budsStatusPath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    // Atomic replacement can emit loaded before the text cache changes, so
    // also follow the text itself.
    onLoaded: root.budsDevices = Model.fromBudsStatus(text())
    onTextChanged: root.budsDevices = Model.fromBudsStatus(text())
    onLoadFailed: root.budsDevices = []
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: {
      if (!root.lowest) return ""
      // A fixed icon keeps the widget recognisable; "lowest" follows the
      // gadget with the least battery instead.
      var icon = root.setting("barIcon", "fixed") === "lowest"
        ? Model.kindIcon(root.lowest.kind) : Model.kindIcon("other")
      return root.showPercentage && !vertical ? icon + " " + root.lowest.level + "%" : icon
    }
    slotSize: Style.bar.iconSlot * (root.showPercentage && !vertical ? 2.4 : 1)
    active: root.lowThreshold > 0 && root.lowest !== null && !root.lowest.offline
      && !root.lowest.charging && root.lowest.level <= root.lowThreshold
    tooltipText: root.opened ? "" : root.summaryText
    onPressed: function(b) { root.toggle() }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened && root.hasDevices
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(340))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(14)

        Text {
          text: Model.tr(root.lang, "title")
          color: root.bar.foreground
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.title
          font.bold: true
        }

        Repeater {
          model: root.devices

          delegate: Item {
            id: row
            required property var modelData
            readonly property bool low: root.lowThreshold > 0 && !modelData.offline
              && !modelData.charging && modelData.level <= root.lowThreshold
            width: column.width
            implicitHeight: rowColumn.implicitHeight
            opacity: modelData.offline ? 0.45 : 1

            Column {
              id: rowColumn
              width: parent.width
              spacing: Style.space(6)

              Item {
                width: parent.width
                implicitHeight: Math.max(kindIcon.implicitHeight, labels.implicitHeight, percent.implicitHeight)

                Text {
                  id: kindIcon
                  textFormat: Text.PlainText
                  text: Model.kindIcon(modelData.kind)
                  color: root.bar.foreground
                  font.family: root.bar.fontFamily
                  font.pixelSize: Style.font.display
                  anchors.left: parent.left
                  anchors.verticalCenter: parent.verticalCenter
                }

                Column {
                  id: labels
                  anchors.left: kindIcon.right
                  anchors.leftMargin: Style.space(12)
                  anchors.right: percent.left
                  anchors.rightMargin: Style.space(10)
                  anchors.verticalCenter: parent.verticalCenter
                  spacing: Style.space(2)

                  Text {
                    textFormat: Text.PlainText
                    text: modelData.name
                    color: root.bar.foreground
                    font.family: root.bar.fontFamily
                    font.pixelSize: Style.font.body
                    font.bold: true
                    elide: Text.ElideRight
                    width: parent.width
                  }

                  Text {
                    textFormat: Text.PlainText
                    visible: text !== ""
                    text: {
                      var parts = []
                      if (modelData.chargingEstimated) parts.push(Model.tr(root.lang, "chargingEstimated"))
                      else if (modelData.charging) parts.push(Model.tr(root.lang, "charging"))
                      if (modelData.detail) parts.push(modelData.detail)
                      return parts.join(" · ")
                    }
                    color: Qt.darker(root.bar.foreground, 1.4)
                    font.family: root.bar.fontFamily
                    font.pixelSize: Style.font.caption
                    elide: Text.ElideRight
                    width: parent.width
                  }
                }

                Text {
                  id: percent
                  textFormat: Text.PlainText
                  text: modelData.offline ? Model.tr(root.lang, "offline")
                    : Model.batteryIcon(modelData.level, modelData.charging) + " " + modelData.level + "%"
                  color: low ? root.bar.urgent : root.bar.foreground
                  font.family: root.bar.fontFamily
                  font.pixelSize: Style.font.title
                  font.bold: true
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                }
              }

              Item {
                width: parent.width
                implicitHeight: Style.space(6)

                Rectangle {
                  anchors.fill: parent
                  radius: height / 2
                  color: Qt.rgba(root.bar.foreground.r, root.bar.foreground.g, root.bar.foreground.b, 0.12)
                }

                Rectangle {
                  width: parent.width * Math.max(0, Math.min(1, modelData.level / 100))
                  height: parent.height
                  radius: height / 2
                  color: low ? root.bar.urgent : root.bar.foreground
                }
              }
            }

            // Opens the vendor app (Solaar, GalaxyBudsClient) when there is one.
            MouseArea {
              anchors.fill: parent
              enabled: root.appCommand(row.modelData) !== null
              cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
              onClicked: {
                Quickshell.execDetached(root.appCommand(row.modelData))
                root.close()
              }
            }
          }
        }
      }
    }
  }
}
