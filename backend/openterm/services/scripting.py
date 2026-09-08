"""Local Python script execution for the Scripts console.

HONESTY FIRST — THIS IS **NOT** A SANDBOX.

The previous incarnation of this file shipped a home-made "sandbox": a string
`_sanitize_code()` that stripped the literal text "exec(" and "__import__"
from user source (trivially bypassed by writing `"ex"+"ec("`), plus a builtins
allowlist that was computed into a variable and then never used. It also had
two outright NameErrors (`resource` and the f-string `{name}` loop) so nothing
it produced ever actually ran. In short: broken, and if it had worked, false
advertising.

What runs here instead is exactly what it says on the tin: your Python code,
executed by a **subprocess interpreter as your own user**, hardened with the
few things a subprocess can honestly get:

  * `-I` isolated interpreter: no PYTHON* env vars, no ~/.local packages
    (site-packages from the venv still resolve — that is the point).
  * Scrubbed environment: the child never inherits FINNHUB_API_KEY /
    APCA_API_SECRET_KEY / OANDA_TOKEN / etc. (The old code leaked the entire
    parent env — every provider key you have configured — straight into any
    script you pasted in.)
  * POSIX resource limits via preexec_fn: CPU seconds, address-space bytes,
    file size. See _apply_rlimits for the caveats.
  * Wall-clock timeout with process-group kill, because RLIMIT_CPU only counts
    CPU time — a script sleeping or stuck in a syscall would otherwise live
    forever, and a busy loop in a *thread* can outrun CPU limits on some kernels.

Threat model: this protects you from accidents and from a pasted snippet
helpfully `while True: pass`-ing your machine. It does NOT protect you from a
script that *wants* to read ~/.ssh — a normal user process can do that, and
this is a normal user process. The app binds 127.0.0.1 by default for exactly
this reason; anyone who can post to /api/scripts/run can run code as you.
"""
from __future__ import annotations

import asyncio
import logging
import os
import reprlib
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field

log = logging.getLogger("openterm.scripting")

# Wall-clock limit per run. RLIMIT_CPU is set to this +1 below so a pegged-CPU
# script gets SIGKILLed by the kernel even if our timeout race misses it.
SCRIPT_TIMEOUT = 5.0
# Hard caps on captured output — a script in a print() loop must not eat RAM.
MAX_OUTPUT = 100_000

# Address space cap for the child. 384 MB is generous for a plotting-less
# data snippet and stops "import numpy; x = np.zeros(10**12)" cold. It is
# deliberately NOT tight: RLIMIT_AS counts virtual reservation, and CPython +
# common C extensions like to reserve more than they touch.
_CHILD_MEM_LIMIT_MB = 384

# Env vars the child process may see. Allowlist, not denylist — "strip
# anything that smells like a secret" always misses one. Scripts get stdlib
# and nothing proprietary.
_ENV_ALLOWLIST = ("PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR")

# The child writes its result here as JSON; user prints go to the stdout pipe
# where they can't corrupt anything. (The old design smuggled the result
# through stdout's tail, so ANY user `print()` broke the protocol — and worse,
# a script that printed valid JSON could forge the result.)
_RUNNER = """
import json, sys, traceback, reprlib
_r = reprlib.Repr(); _r.max_string = 200; _r.max_list = 20; _r.max_dict = 20
_result = {"success": True, "error": "", "variables": {}}
try:
    _g = {"__name__": "__openterm_script__"}
    exec(compile(open(sys.argv[1]).read(), "<script>", "exec"), _g)
except BaseException:
    _result["success"] = False
    _result["error"] = traceback.format_exc(limit=8)[-2000:]
else:
    for _k, _v in _g.items():
        if not _k.startswith("__") and not callable(_v):
            try:
                _result["variables"][_k] = _r.repr(_v)
            except Exception:
                _result["variables"][_k] = "<unreprable>"
try:
    with open(sys.argv[2], "w") as _f:
        json.dump(_result, _f)
except OSError:
    pass
"""


@dataclass
class ScriptRunResult:
    """Outcome of one script run, as returned to the client."""
    success: bool
    output: str = ""
    error: str = ""
    exit_code: int = 0
    variables: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, object]:
        return {
            "success": self.success,
            "output": self.output,
            "error": self.error,
            "exit_code": self.exit_code,
            "variables": self.variables,
        }


def _apply_rlimits() -> None:
    """Runs between fork() and exec() in the child (preexec_fn). POSIX only.

    Known caveat, because I refuse to hide it: preexec_fn forks from a
    multithreaded parent, and fork-with-threads is technically unsafe (you can
    deadlock on a lock another thread held at fork time). In practice this
    does microseconds of setrlimit work — no allocation beyond what CPython
    pre-forks — and is the standard recipe for per-child rlimits without
    resorting to `prlimit` shenanigans. If you port this to Windows, rlimits
    do not exist; only the wall-clock timeout protects you there.
    """
    import resource

    cpu = int(SCRIPT_TIMEOUT) + 1
    mem = _CHILD_MEM_LIMIT_MB * 1024 * 1024
    for limit, value in (
        (resource.RLIMIT_CPU, (cpu, cpu + 1)),
        (resource.RLIMIT_AS, (mem, mem)),
        (resource.RLIMIT_FSIZE, (20 * 1024 * 1024, 20 * 1024 * 1024)),
    ):
        try:
            resource.setrlimit(limit, value)
        except (ValueError, OSError):
            # Some container kernels refuse to lower RLIMIT_AS. Failing here
            # must not fail the whole exec — timeout is our backstop.
            pass


class ScriptingService:
    """Executes scripts as isolated subprocesses. Stateless; cheap to own."""

    def __init__(self) -> None:
        # Serialize-ish rather than explode: at most 2 concurrent script
        # processes (each can burn one core under RLIMIT_CPU).
        self._sem = asyncio.Semaphore(2)

    async def run(
        self,
        code: str,
        symbols: list[str] | None = None,  # accepted for API compat, unused:
                                          # scripts were never given market data,
                                          # the old signature just pretended.
    ) -> ScriptRunResult:
        if symbols:
            log.debug("scripting: ignoring symbols=%r (never implemented)", symbols)
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._run_sync, code)

    async def close(self) -> None:
        """Nothing to tear down (no persistent pool); kept for shutdown symmetry."""
        return None

    async def reset(self) -> None:
        """Compatibility shim for /scripts/close. Nothing to tear down anymore."""
        return None

    def _run_sync(self, code: str) -> ScriptRunResult:
        # The semaphore must be awaited from async context ideally, but
        # run_in_executor lands us in a worker thread; we keep the thread-safe
        # classic semaphore discipline with a plain lock + count instead.
        with _GLOBAL_SLOTS:
            return self._spawn(code)

    def _spawn(self, code: str) -> ScriptRunResult:
        src_fd, src_path = tempfile.mkstemp(suffix=".py", prefix="openterm-script-")
        out_fd, out_path = tempfile.mkstemp(suffix=".json", prefix="openterm-result-")
        os.close(out_fd)  # runner opens it by name; we only need the path
        try:
            with os.fdopen(src_fd, "w") as fh:
                fh.write(code)
            env = {k: os.environ[k] for k in _ENV_ALLOWLIST if k in os.environ}
            cmd = [sys.executable, "-I", "-c", _RUNNER, src_path, out_path]
            # -I = "-E no PYTHON* env vars + -s no ~/.local site-packages".
            # Deliberately NOT -S: scripts legitimately import numpy/pandas,
            # and -S disables the site machinery entirely. Key protection
            # comes from the scrubbed env below, not from hiding packages.
            popen_kw: dict = dict(
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                text=True,
                start_new_session=True,
            )
            if hasattr(os, "setrlimit") and sys.platform.startswith(("linux", "darwin")):
                popen_kw["preexec_fn"] = _apply_rlimits
            try:
                proc = subprocess.Popen(cmd, **popen_kw)  # noqa: S603
            except OSError as exc:
                return ScriptRunResult(success=False, error=f"spawn failed: {exc}", exit_code=-1)

            try:
                stdout, stderr = proc.communicate(timeout=SCRIPT_TIMEOUT)
                exit_code = proc.returncode
            except subprocess.TimeoutExpired:
                # Kill the whole group: -I python can have spawned threads,
                # and an RLIMIT_CPU'd child might be parked in a syscall.
                try:
                    # start_new_session=True above makes the child its own
                    # process-group leader, so this cannot nuke our own group.
                    os.killpg(proc.pid, _SIGKILL_GROUP)
                except ProcessLookupError:
                    pass
                proc.kill()
                stdout, stderr = proc.communicate()
                return ScriptRunResult(
                    success=False,
                    output=(stdout or "")[:MAX_OUTPUT],
                    error=f"killed: exceeded {SCRIPT_TIMEOUT:.0f}s wall-clock limit",
                    exit_code=-1,
                )

            result = self._read_result(out_path, stdout, exit_code, stderr)
            return result
        finally:
            for p in (src_path, out_path):
                try:
                    os.unlink(p)
                except OSError:
                    pass

    @staticmethod
    def _read_result(
        out_path: str, stdout: str | None, exit_code: int, stderr: str | None
    ) -> ScriptRunResult:
        import json

        output = (stdout or "")[:MAX_OUTPUT]
        try:
            with open(out_path) as fh:
                payload = json.load(fh)
        except (OSError, ValueError):
            # No result file = the interpreter itself died (SyntaxError in the
            # runner is impossible here; rlimit/OOM death is not).
            return ScriptRunResult(
                success=False,
                output=output,
                error=(
                    f"script process died (exit {exit_code}): "
                    f"{(stderr or '')[:500] or 'possibly exceeded memory/CPU limits'}"
                ),
                exit_code=exit_code or -1,
            )
        return ScriptRunResult(
            success=bool(payload.get("success")) and exit_code == 0,
            output=output,
            error=str(payload.get("error") or "")[:2000],
            exit_code=exit_code,
            variables={str(k): str(v) for k, v in (payload.get("variables") or {}).items()},
        )


import threading

# At most 2 script subprocesses at a time — each may burn a full core under
# RLIMIT_CPU, and this is a hobby terminal, not a compute service.
_GLOBAL_SLOTS = threading.Semaphore(2)

# Resolved lazily to keep the module importable on Windows (no SIGKILL there);
# _spawn only uses it on posix paths anyway.
try:
    import signal as _signal

    _SIGKILL_GROUP = _signal.SIGKILL
except ImportError:  # pragma: no cover
    _SIGKILL_GROUP = 9
