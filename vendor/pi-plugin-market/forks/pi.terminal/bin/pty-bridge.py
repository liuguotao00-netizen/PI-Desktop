#!/usr/bin/env python3
"""pi.terminal PTY bridge.

Usage: pty-bridge.py ROWS COLS SHELL SLAVE_FILE
  stdin  (fd 0): user keystrokes -> pty master
  stdout (fd 1): pty master -> consumer (binary, flushed)
  fd 3    (extra): control lines, one per line:
      resize COLS ROWS   -> set pty winsize (kernel sends SIGWINCH)
  exit: when the shell exits or the master closes.
"""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def main():
    rows = int(sys.argv[1])
    cols = int(sys.argv[2])
    shell = sys.argv[3]
    slave_file = sys.argv[4] if len(sys.argv) > 4 else None

    pid, master = pty.fork()
    if pid == 0:  # child: slave pty is now stdin/stdout and the controlling tty
        try:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        except OSError:
            pass
        if slave_file:
            try:
                with open(slave_file, "w") as handle:
                    handle.write(os.ttyname(0))
            except OSError:
                pass
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLORTERM"] = "truecolor"
        try:
            os.execvp(shell, [shell, "-il"])
        except Exception:
            pass
        os._exit(127)

    os.set_blocking(0, False)
    os.set_blocking(master, False)

    def pump(to_fd, data):
        view = memoryview(data)
        while view:
            try:
                written = os.write(to_fd, view)
                view = view[written:]
            except OSError as exc:
                if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                    _, writable, _ = select.select([], [to_fd], [], 1.0)
                    if not writable:
                        return False
                    continue
                return False
        return True

    watch = [0, master]
    control_fd = None
    try:
        os.set_blocking(3, False)
        control_fd = 3
        watch.append(3)
    except OSError:
        pass

    alive = True
    while alive:
        try:
            ready, _, _ = select.select(watch, [], [], 1.0)
        except InterruptedError:
            continue
        except OSError:
            break

        for fd in ready:
            try:
                data = os.read(fd, 65536)
            except BlockingIOError:
                continue
            except OSError:
                data = b""
            if fd == 0:
                if not data:
                    # stdin closed: stop forwarding input, keep the shell alive
                    watch.remove(0)
                    continue
                if not pump(master, data):
                    alive = False
                    break
            elif fd == master:
                if not data:
                    alive = False
                    break
                if not pump(1, data):
                    alive = False
                    break
            elif fd == control_fd:
                if not data:
                    watch.remove(control_fd)
                    continue
                for line in data.decode("utf-8", "replace").splitlines():
                    parts = line.split()
                    if len(parts) == 3 and parts[0] == "resize":
                        try:
                            new_cols = max(2, min(500, int(parts[1])))
                            new_rows = max(2, min(300, int(parts[2])))
                            fcntl.ioctl(
                                master,
                                termios.TIOCSWINSZ,
                                struct.pack("HHHH", new_rows, new_cols, 0, 0),
                            )
                        except (OSError, ValueError):
                            pass

        if alive:
            try:
                waited, status = os.waitpid(pid, os.WNOHANG)
                if waited == pid:
                    alive = False
            except ChildProcessError:
                alive = False
            except OSError:
                pass

    # drain whatever the master still has before exiting
    try:
        while True:
            ready, _, _ = select.select([master], [], [], 0)
            if not ready:
                break
            data = os.read(master, 65536)
            if not data:
                break
            pump(1, data)
    except OSError:
        pass

    try:
        os.close(master)
    except OSError:
        pass


if __name__ == "__main__":
    main()
