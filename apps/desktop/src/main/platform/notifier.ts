// The system's notifications for reminders, through Electron's Notification. Each is held by its
// reminder until the reminders service takes it down, so a click reaches it however long it
// waits in the system's list: Electron drops a notification nothing holds, and on Windows only
// the same object can take one out of the Action Center. A click brings the window forward first.
// Electron 44 says when the system couldn't show one (`failed`, on macOS and Windows), never
// whether the viewer turned notifications off, so neither is guessed here.
import { Notification } from "electron";
import type { Notifier } from "../services/reminders.ts";

/** Notifications that bring the window forward with `focus` when clicked. Once the app is ready. */
export function electronNotifier(focus: () => void): Notifier {
  const held = new Map<string, Notification>();
  return {
    supported: Notification.isSupported(),
    show(notice, events) {
      held.get(notice.id)?.close();
      const notification = new Notification({
        id: notice.id,
        title: notice.title,
        body: notice.body,
      });
      held.set(notice.id, notification);
      notification.on("show", () => events.shown());
      notification.on("click", () => {
        focus();
        events.clicked();
      });
      notification.on("failed", () => {
        if (held.get(notice.id) === notification) held.delete(notice.id);
        events.failed();
      });
      notification.show();
    },
    close(id) {
      const notification = held.get(id);
      held.delete(id);
      notification?.close();
    },
  };
}
