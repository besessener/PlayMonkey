// Preloaded with --import into a CLI child process: the message "SIGINT" over IPC is emitted as SIGINT. Windows cannot
// send SIGINT to another process (child.kill terminates it), but a console Ctrl+C reaches the same handlers.
process.on("message", (message) => {
  if (message === "SIGINT") process.emit("SIGINT", "SIGINT");
});
// The listener refs the channel; unref it so the child still exits on its own.
process.channel?.unref();
