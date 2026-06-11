"""Sandbox — abstract base for agent-local code execution.

Mirrors the TypeScript runtime's sandbox API. ``LocalSandbox`` runs
commands directly on the host (no isolation, dev only). ``DockerSandbox``
spawns a long-lived container and shells out to ``docker exec`` per call.

Sandboxes are AGENT-LOCAL — they are never registered in ``ACTION_CATALOG``
and never reachable over the network. ``as_tools()`` returns local tool specs
an agent can hand to its LLM, but the dispatch happens in-process.

Adversarial defaults (DockerSandbox)::

    --network none           (unless allow_network=True)
    --cpus 1                 (override via cpus=)
    --memory 512m            (override via memory=)
    mount paths under cwd    (unless allow_any_mount=True)
    mounts read-only         (unless readonly=False is set per-mount)
    image pinned to 3.12.7-slim (override with a digest for true immutability)
    close() idempotent + actually removes the container.

Example::

    sandbox = await LocalSandbox.create()
    out = await sandbox.python("print('hello')")
    await sandbox.close()
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional


# Default Docker image. Pinned to ``3.12.7-slim``:
#   - ``slim`` reduces attack surface (no build toolchain in the base layer).
#   - Specific patch resists the "tag re-publish" supply-chain vector where
#     a fresh push replaces the content behind ``python:3.12``.
#
# Callers running untrusted code at scale SHOULD override with a digest:
#   DockerSandbox.create(SandboxOptions(image="python@sha256:<digest>"))
DEFAULT_SANDBOX_IMAGE = "python:3.12.7-slim"

# Env var that silences the LocalSandbox warning. Production agents should
# never set this — use DockerSandbox. Test harnesses may set it to keep logs
# clean.
_LOCAL_SANDBOX_SILENCE_ENV = "NOOKPLOT_LOCAL_SANDBOX_SILENCE"

_logger = logging.getLogger(__name__)


# ── Argv-injection guards ────────────────────────────────────
#
# Defense-in-depth for the docker argv. Even though ``create_subprocess_exec``
# uses array-form (no shell), docker itself parses flags, and some fields
# (env values, image names) can be weaponized if callers ever pipe untrusted
# input through. All validators are caller-trusted-today, adversarial-input-
# tomorrow hardening — mirror the TypeScript side.

# POSIX env var name.
_ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# Docker image reference: letters/digits/``._/:@-``, must start with an
# alphanumeric so it never looks like a flag to ``docker run``.
_DOCKER_IMAGE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/:@-]*$")


def _assert_env_pair(key: str, value: str) -> None:
    if not _ENV_KEY_RE.match(key):
        raise RuntimeError(
            f"DockerSandbox: invalid env key '{key}' "
            f"(must match {_ENV_KEY_RE.pattern})"
        )
    if "\n" in value or "\x00" in value:
        raise RuntimeError(
            f"DockerSandbox: env value for '{key}' contains newline or NUL"
        )


def _assert_image(image: str) -> None:
    if not _DOCKER_IMAGE_RE.match(image):
        raise RuntimeError(
            f"DockerSandbox: invalid image '{image}' "
            f"(must match {_DOCKER_IMAGE_RE.pattern})"
        )


# ── Types ────────────────────────────────────────────────────


@dataclass
class SandboxMount:
    """Bind mount spec — host path mounted into the container.

    ``readonly`` defaults to ``True``. Pass ``readonly=False`` to enable
    writes. Read-only is the safer default because untrusted code inside the
    sandbox cannot use a writable mount to persist changes back to the host.
    """

    host: str
    container: str
    readonly: bool = True


@dataclass
class SandboxOptions:
    """Construction options shared by all sandbox kinds.

    Most fields are Docker-specific. ``LocalSandbox`` honors ``env`` only.
    """

    image: str = DEFAULT_SANDBOX_IMAGE
    """Container image. Ignored by ``LocalSandbox``. Defaults to a pinned
    slim variant; override with a digest for true immutability."""

    ports: dict[int, Optional[int]] = field(default_factory=dict)
    """Container port -> host port (None = random)."""

    env: dict[str, str] = field(default_factory=dict)
    """Env vars passed into the container / child env."""

    mounts: list[SandboxMount] = field(default_factory=list)
    """Bind mounts. Rejected if outside cwd unless ``allow_any_mount``."""

    allow_any_mount: bool = False
    allow_network: bool = False
    cpus: float = 1.0
    memory: str = "512m"
    docker_bin: str = "docker"


@dataclass
class SandboxToolDefinition:
    """Local tool spec returned by ``Sandbox.as_tools()``.

    Distinct from gateway action-registry tool definitions — the ``invoke``
    callable dispatches inside the runtime, never over the wire.
    """

    name: str
    description: str
    parameters: dict[str, Any]
    invoke: Callable[[dict[str, Any]], Awaitable[str]]


# ── Helpers ──────────────────────────────────────────────────


async def _run_process(
    bin_name: str,
    args: list[str],
    *,
    input_text: Optional[str] = None,
    cwd: Optional[str] = None,
    env: Optional[dict[str, str]] = None,
) -> str:
    """Spawn a process, capture stdout. Raises ``RuntimeError`` on non-zero exit.

    The error message includes stderr so callers can surface it.
    """
    process = await asyncio.create_subprocess_exec(
        bin_name,
        *args,
        stdin=asyncio.subprocess.PIPE if input_text is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
        env=env,
    )
    stdin_bytes = input_text.encode("utf-8") if input_text is not None else None
    stdout_bytes, stderr_bytes = await process.communicate(input=stdin_bytes)
    stdout = stdout_bytes.decode("utf-8")
    stderr = stderr_bytes.decode("utf-8")
    if process.returncode == 0:
        return stdout
    detail = stderr.strip() or stdout.strip() or "(no output)"
    raise RuntimeError(f"{bin_name} exited {process.returncode}: {detail}")


# ── Base ─────────────────────────────────────────────────────


class Sandbox(ABC):
    """Abstract base for agent-local sandboxes."""

    @abstractmethod
    async def exec(
        self,
        cmd: list[str],
        *,
        input: Optional[str] = None,
        cwd: Optional[str] = None,
        env: Optional[dict[str, str]] = None,
    ) -> str:
        """Run a command. Returns stdout. Raises on non-zero exit."""

    @abstractmethod
    async def put(self, local_path: str, sandbox_path: str) -> None:
        """Copy a local file into the sandbox."""

    @abstractmethod
    async def get(self, sandbox_path: str, local_path: str) -> str:
        """Copy a sandbox file out. Returns the local path written."""

    @abstractmethod
    def endpoint(self, port: int) -> str:
        """Map a container port to a reachable host endpoint string."""

    @abstractmethod
    async def close(self) -> None:
        """Idempotent. Safe to call multiple times."""

    async def python(self, script: str) -> str:
        """Run a Python 3 script via stdin."""
        return await self.exec(["python3", "-"], input=script)

    async def sh(self, command: str) -> str:
        """Run a shell command."""
        return await self.exec(["sh", "-c", command])

    def as_tools(self) -> list[SandboxToolDefinition]:
        """Return local tool specs callers can hand to their LLM tool list."""

        async def _python(args: dict[str, Any]) -> str:
            return await self.python(str(args.get("script", "")))

        async def _sh(args: dict[str, Any]) -> str:
            return await self.sh(str(args.get("command", "")))

        return [
            SandboxToolDefinition(
                name="python",
                description="Run a Python 3 script in the sandbox. Returns stdout.",
                parameters={
                    "type": "object",
                    "properties": {
                        "script": {"type": "string", "description": "Python source to execute."},
                    },
                    "required": ["script"],
                },
                invoke=_python,
            ),
            SandboxToolDefinition(
                name="sh",
                description="Run a shell command in the sandbox. Returns stdout.",
                parameters={
                    "type": "object",
                    "properties": {
                        "command": {"type": "string", "description": "Shell command line."},
                    },
                    "required": ["command"],
                },
                invoke=_sh,
            ),
        ]


# ── LocalSandbox (no isolation; dev / tests only) ────────────


def _emit_local_sandbox_warning() -> None:
    """Warn when ``LocalSandbox`` is created outside a test harness.

    Silenced under ``NODE_ENV=test`` (matches TS) or when
    ``NOOKPLOT_LOCAL_SANDBOX_SILENCE`` is truthy. Production agents should
    never hit this path — use ``DockerSandbox``.
    """

    env = os.environ
    if env.get("NODE_ENV") == "test":
        return
    if env.get(_LOCAL_SANDBOX_SILENCE_ENV):
        return
    _logger.warning(
        "[LocalSandbox] No process isolation — commands run directly on the "
        "host. Use DockerSandbox for untrusted code in production. "
        "Silence with %s=1.",
        _LOCAL_SANDBOX_SILENCE_ENV,
    )


class LocalSandbox(Sandbox):
    """Runs commands directly on the host. No isolation. Dev / tests only."""

    def __init__(self, opts: SandboxOptions) -> None:
        self._env: dict[str, str] = dict(opts.env)
        self._cwd = os.getcwd()
        self._closed = False

    @classmethod
    async def create(cls, opts: Optional[SandboxOptions] = None) -> "LocalSandbox":
        _emit_local_sandbox_warning()
        return cls(opts or SandboxOptions())

    async def exec(
        self,
        cmd: list[str],
        *,
        input: Optional[str] = None,
        cwd: Optional[str] = None,
        env: Optional[dict[str, str]] = None,
    ) -> str:
        if self._closed:
            raise RuntimeError("LocalSandbox: closed")
        if not cmd:
            raise ValueError("LocalSandbox: empty command")
        merged_env = {**os.environ, **self._env, **(env or {})}
        return await _run_process(
            cmd[0],
            cmd[1:],
            input_text=input,
            cwd=cwd or self._cwd,
            env=merged_env,
        )

    async def put(self, local_path: str, sandbox_path: str) -> None:
        if self._closed:
            raise RuntimeError("LocalSandbox: closed")
        Path(sandbox_path).parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(shutil.copyfile, local_path, sandbox_path)

    async def get(self, sandbox_path: str, local_path: str) -> str:
        if self._closed:
            raise RuntimeError("LocalSandbox: closed")
        Path(local_path).parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(shutil.copyfile, sandbox_path, local_path)
        return local_path

    def endpoint(self, port: int) -> str:
        raise RuntimeError("LocalSandbox: endpoint() unsupported (no port mapping)")

    async def close(self) -> None:
        self._closed = True


# ── DockerSandbox (production) ───────────────────────────────


class DockerSandbox(Sandbox):
    """Long-lived container; shells out to ``docker exec`` per call."""

    def __init__(
        self,
        opts: SandboxOptions,
        *,
        container_id: str,
        host_port_by_container: dict[int, int],
    ) -> None:
        self._opts = opts
        self._container_id = container_id
        self._host_port_by_container = host_port_by_container
        self._closed = False

    @classmethod
    async def create(cls, opts: Optional[SandboxOptions] = None) -> "DockerSandbox":
        opts = opts or SandboxOptions()
        cls._validate_mounts(opts.mounts, opts.allow_any_mount)
        args = cls.build_run_args(opts)
        raw = await _run_process(opts.docker_bin, args)
        container_id = raw.strip()
        if not container_id:
            raise RuntimeError("DockerSandbox: docker run returned empty container id")
        host_port_by_container = await cls._discover_ports(
            opts.docker_bin,
            container_id,
            list(opts.ports.keys()),
        )
        return cls(opts, container_id=container_id, host_port_by_container=host_port_by_container)

    @classmethod
    async def connect(
        cls,
        container_id: str,
        opts: Optional[SandboxOptions] = None,
    ) -> "DockerSandbox":
        opts = opts or SandboxOptions()
        inspect = await _run_process(
            opts.docker_bin,
            ["inspect", "--format", "{{.State.Running}}", container_id],
        )
        if inspect.strip() != "true":
            raise RuntimeError(f"DockerSandbox: container {container_id} is not running")
        host_port_by_container = await cls._discover_ports(
            opts.docker_bin,
            container_id,
            list(opts.ports.keys()),
        )
        return cls(opts, container_id=container_id, host_port_by_container=host_port_by_container)

    @staticmethod
    def build_run_args(opts: SandboxOptions) -> list[str]:
        """Visible for tests — does NOT execute docker."""
        _assert_image(opts.image)
        args: list[str] = [
            "run",
            "-d",
            "--rm",
            "--cpus",
            str(opts.cpus),
            "--memory",
            opts.memory,
        ]
        if not opts.allow_network:
            args += ["--network", "none"]
        for container_port, host_port in opts.ports.items():
            if host_port is None:
                args += ["-p", str(container_port)]
            else:
                args += ["-p", f"{host_port}:{container_port}"]
        for key, value in opts.env.items():
            _assert_env_pair(key, value)
            args += ["-e", f"{key}={value}"]
        for mount in opts.mounts:
            # Default is read-only (see ``SandboxMount``). Writes require
            # explicit ``readonly=False``. Closes the "untrusted code writes
            # back to the host" path by default.
            flag = "ro" if mount.readonly else "rw"
            args += ["-v", f"{os.path.abspath(mount.host)}:{mount.container}:{flag}"]
        # ``_assert_image`` above rejects leading-dash images, so the
        # positional image cannot be mis-parsed as a docker-run flag.
        args += [opts.image, "sleep", "infinity"]
        return args

    @staticmethod
    def _validate_mounts(mounts: list[SandboxMount], allow_any: bool) -> None:
        if allow_any:
            return
        cwd = os.path.realpath(os.getcwd())
        for mount in mounts:
            resolved = os.path.realpath(mount.host)
            if not resolved.startswith(cwd + os.sep) and resolved != cwd:
                raise RuntimeError(
                    f"DockerSandbox: mount '{mount.host}' resolves outside cwd; "
                    "pass allow_any_mount=True to override"
                )

    @staticmethod
    async def _discover_ports(
        docker_bin: str,
        container_id: str,
        requested: list[int],
    ) -> dict[int, int]:
        out: dict[int, int] = {}
        for container_port in requested:
            try:
                raw = await _run_process(
                    docker_bin,
                    ["port", container_id, str(container_port)],
                )
                first_line = raw.splitlines()[0].strip() if raw.strip() else ""
                if ":" in first_line:
                    out[container_port] = int(first_line.rsplit(":", 1)[1])
            except Exception:
                # Port not exposed — endpoint() will raise on lookup with a clear message.
                pass
        return out

    async def exec(
        self,
        cmd: list[str],
        *,
        input: Optional[str] = None,
        cwd: Optional[str] = None,
        env: Optional[dict[str, str]] = None,
    ) -> str:
        if self._closed:
            raise RuntimeError("DockerSandbox: closed")
        if not cmd:
            raise ValueError("DockerSandbox: empty command")
        args: list[str] = ["exec"]
        if input is not None:
            args.append("-i")
        if cwd:
            args += ["-w", cwd]
        for k, v in (env or {}).items():
            args += ["-e", f"{k}={v}"]
        args += [self._container_id, *cmd]
        return await _run_process(self._opts.docker_bin, args, input_text=input)

    async def put(self, local_path: str, sandbox_path: str) -> None:
        if self._closed:
            raise RuntimeError("DockerSandbox: closed")
        await _run_process(
            self._opts.docker_bin,
            ["cp", local_path, f"{self._container_id}:{sandbox_path}"],
        )

    async def get(self, sandbox_path: str, local_path: str) -> str:
        if self._closed:
            raise RuntimeError("DockerSandbox: closed")
        Path(local_path).parent.mkdir(parents=True, exist_ok=True)
        await _run_process(
            self._opts.docker_bin,
            ["cp", f"{self._container_id}:{sandbox_path}", local_path],
        )
        return local_path

    def endpoint(self, port: int) -> str:
        host_port = self._host_port_by_container.get(port)
        if host_port is None:
            raise RuntimeError(f"DockerSandbox: port {port} not mapped")
        return f"localhost:{host_port}"

    async def close(self) -> None:
        """Idempotent. Force-removes the container."""
        if self._closed:
            return
        self._closed = True
        try:
            await _run_process(
                self._opts.docker_bin,
                ["rm", "-f", self._container_id],
            )
        except Exception:
            # Container may already be gone (--rm fired). Closed flag is set,
            # so subsequent calls short-circuit. Failures here mean docker
            # itself is wedged — out of our control.
            pass

    @property
    def container_id(self) -> str:
        return self._container_id


# ── Sentinel + diagnostics ───────────────────────────────────


def is_sandbox(value: Any) -> bool:
    return isinstance(value, Sandbox)


async def is_docker_available(docker_bin: str = "docker") -> bool:
    """Used by tests to skip DockerSandbox suites when docker is missing."""
    try:
        await _run_process(docker_bin, ["version", "--format", "{{.Server.Version}}"])
        return True
    except Exception:
        return False


__all__ = [
    "DEFAULT_SANDBOX_IMAGE",
    "Sandbox",
    "LocalSandbox",
    "DockerSandbox",
    "SandboxOptions",
    "SandboxMount",
    "SandboxToolDefinition",
    "is_sandbox",
    "is_docker_available",
]
