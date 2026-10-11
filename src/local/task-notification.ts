// Claude Code writes background task notifications as user-role transcript entries.
// Only a whole harness envelope (or an explicit origin) is a notification;
// prose that merely mentions the marker is still the person's message.
const TASK_NOTIFICATION = /^\s*<task-notification>[\s\S]*?<\/task-notification>\s*$/u;

export function isTaskNotification(content: string, origin?: { kind?: string }): boolean {
  return origin?.kind === "task-notification" || TASK_NOTIFICATION.test(content);
}
