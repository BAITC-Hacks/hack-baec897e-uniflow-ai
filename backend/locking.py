"""Lifetime OS lock: a second server must not recover a live worker's database."""
from pathlib import Path
import os


class ServerLock:
    def __init__(self, database: str | Path):
        self.path = Path(str(Path(database).resolve()) + ".server.lock")
        self._file = None

    def acquire(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = self.path.open("a+b")
        try:
            # Windows byte-range locking needs a byte. File existence is not the
            # lock: the OS releases ownership even after a crash or forced exit.
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            handle.close()
            raise RuntimeError(
                f"Another UniFlow server owns {self.path}. Use one server process per database."
            ) from exc
        self._file = handle
        return self

    def close(self):
        if self._file is not None:
            try:
                self._file.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(self._file.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self._file.fileno(), fcntl.LOCK_UN)
            finally:
                self._file.close()
                self._file = None
