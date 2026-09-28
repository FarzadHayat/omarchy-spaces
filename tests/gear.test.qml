import QtQuick
import QtQuick.Window
import QtTest
import Quickshell
Window {
  visible: true
  width: 900; height: 100
  Spaces {
    id: widget
    width: implicitWidth; height: implicitHeight
    settings: ({settingsButton: "hover", animations: false, persistentWorkspaces: 2})
  }
  TestCase {
    id: checks
    when: false
    function find(item, name) {
      if (item.objectName === name) return item
      for (var child of item.children) {
        var found = find(child, name)
        if (found) return found
      }
      return null
    }
    function run() {
      var gear = find(widget, "spacesSettingsGear")
      if (!gear) throw new Error("Missing settings gear")
      var x = gear.x, y = gear.y, width = gear.width
      mouseMove(widget, widget.width - 2, widget.height / 2)
      wait(100)
      widget.applySetting({persistentWorkspaces: 10, showApps: "all"})
      wait(100)
      if (gear.x !== x || gear.y !== y || gear.width !== width)
        throw new Error("Gear moved when workspaces expanded")
      mouseClick(gear, gear.width / 2, gear.height / 2)
      wait(100)
      if (!widget.opened) throw new Error("Gear did not open settings")
      widget.close()
      widget.applySetting({settingsButton: "never"})
      wait(50)
      if (gear.visible) throw new Error("Hidden gear still visible")
      console.log("PASS: stable gear position, click opens settings, hidden mode")
    }
  }
  Timer {
    interval: 500; running: true
    onTriggered: {
      try { checks.run(); Qt.quit() }
      catch(error) { console.error(error); Qt.exit(1) }
    }
  }
}
