"""Sandbox — unit tests.

Mirrors the TypeScript runtime's sandbox test suite.

Covers:
  - LocalSandbox: exec, python, sh, put/get, close idempotency.
  - Sandbox.as_tools: tool definitions route to python/sh.
  - DockerSandbox.build_run_args: --network none, --cpus, --memory defaults.
  - DockerSandbox.create: mount validation rejects paths outside cwd.
  - DockerSandbox lifecycle via fake-docker shim (no real docker required).
"""
from __future__ import annotations

import stat
from pathlib import Path

import pytest

from nookplot_runtime.sandbox import (
    DEFAULT_SANDBOX_IMAGE,
    DockerSandbox,
    LocalSandbox,
    Sandbox,
    SandboxMount,
    SandboxOptions,
    is_sandbox,
)


# ── LocalSandbox ─────────────────────────────────────────────


class TestLocalSandbox:
    @pytest.mark.asyncio
    async def test_exec_echo_returns_hi(self) -> None:
        sandbox = await LocalSandbox.create()
        out = await sandbox.exec(["echo", "hi"])
        assert out == "hi\n"
        await sandbox.close()

    @pytest.mark.asyncio
    async def test_python_via_stdin(self) -> None:
        sandbox = await LocalSandbox.create()
        out = await sandbox.python("print('hello from python')")
        assert out == "hello from python\n"
        await sandbox.close()

    @pytest.mark.asyncio
    async def test_sh_runs_through_sh_dash_c(self) -> None:
        sandbox = await LocalSandbox.create()
        out = await sandbox.sh("echo $((2 + 2))")
        assert out == "4\n"
        await sandbox.close()

    @pytest.mark.asyncio
    async def test_env_propagates_to_exec(self) -> None:
        sandbox = await LocalSandbox.create(SandboxOptions(env={"NK_TEST_VAR": "from-sandbox"}))
        out = await sandbox.sh('printf %s "$NK_TEST_VAR"')
        assert out == "from-sandbox"
        await sandbox.close()

    @pytest.mark.asyncio
    async def test_put_and_get_roundtrip(self, tmp_path: Path) -> None:
        src = tmp_path / "src.txt"
        in_sandbox = tmp_path / "sub" / "in-sandbox.txt"
        out = tmp_path / "out.txt"
        src.write_text("hello")

        sandbox = await LocalSandbox.create()
        await sandbox.put(str(src), str(in_sandbox))
        assert in_sandbox.read_text() == "hello"
        written = await sandbox.get(str(in_sandbox), str(out))
        assert written == str(out)
        assert out.read_text() == "hello"
        await sandbox.close()

    @pytest.mark.asyncio
    async def test_close_is_idempotent(self) -> None:
        sandbox = await LocalSandbox.create()
        await sandbox.close()
        await sandbox.close()  # must not raise

    @pytest.mark.asyncio
    async def test_exec_after_close_raises(self) -> None:
        sandbox = await LocalSandbox.create()
        await sandbox.close()
        with pytest.raises(RuntimeError, match="closed"):
            await sandbox.exec(["echo", "x"])

    @pytest.mark.asyncio
    async def test_endpoint_unsupported(self) -> None:
        sandbox = await LocalSandbox.create()
        with pytest.raises(RuntimeError, match="unsupported"):
            sandbox.endpoint(8080)
        await sandbox.close()

    @pytest.mark.asyncio
    async def test_nonzero_exit_includes_stderr(self) -> None:
        sandbox = await LocalSandbox.create()
        with pytest.raises(RuntimeError, match=r"exited 7.*boom"):
            await sandbox.sh("echo boom 1>&2; exit 7")
        await sandbox.close()


# ── as_tools ─────────────────────────────────────────────────


class TestAsTools:
    @pytest.mark.asyncio
    async def test_exposes_python_and_sh(self) -> None:
        sandbox = await LocalSandbox.create()
        tools = sandbox.as_tools()
        assert [t.name for t in tools] == ["python", "sh"]
        await sandbox.close()

    @pytest.mark.asyncio
    async def test_python_tool_dispatches(self) -> None:
        sandbox = await LocalSandbox.create()
        python_tool = sandbox.as_tools()[0]
        out = await python_tool.invoke({"script": "print(40 + 2)"})
        assert out == "42\n"
        await sandbox.close()

    @pytest.mark.asyncio
    async def test_sh_tool_dispatches(self) -> None:
        sandbox = await LocalSandbox.create()
        sh_tool = sandbox.as_tools()[1]
        out = await sh_tool.invoke({"command": "echo wired"})
        assert out == "wired\n"
        await sandbox.close()

    @pytest.mark.asyncio
    async def test_tools_carry_json_schema(self) -> None:
        sandbox = await LocalSandbox.create()
        for tool in sandbox.as_tools():
            assert tool.parameters["type"] == "object"
            assert "properties" in tool.parameters
        await sandbox.close()


# ── is_sandbox ───────────────────────────────────────────────


class TestIsSandbox:
    @pytest.mark.asyncio
    async def test_recognizes_sandbox_instance(self) -> None:
        sandbox = await LocalSandbox.create()
        assert is_sandbox(sandbox)
        assert isinstance(sandbox, Sandbox)
        await sandbox.close()

    def test_rejects_plain_objects(self) -> None:
        assert not is_sandbox({"exec": lambda: None})
        assert not is_sandbox(None)


# ── DockerSandbox.build_run_args (security defaults) ─────────


class TestDockerBuildRunArgs:
    def test_defaults_network_none_cpus_memory(self) -> None:
        args = DockerSandbox.build_run_args(SandboxOptions())
        assert "--network" in args
        assert "none" in args
        assert "--cpus" in args
        assert "1.0" in args
        assert "--memory" in args
        assert "512m" in args
        # Image + idle process at the tail — uses the pinned default.
        assert args[-3:] == [DEFAULT_SANDBOX_IMAGE, "sleep", "infinity"]
        # -d --rm at the head.
        assert args[:3] == ["run", "-d", "--rm"]

    def test_allow_network_drops_network_none(self) -> None:
        args = DockerSandbox.build_run_args(SandboxOptions(allow_network=True))
        assert "--network" not in args

    def test_custom_cpus_and_memory(self) -> None:
        args = DockerSandbox.build_run_args(SandboxOptions(cpus=2.5, memory="2g"))
        assert "2.5" in args
        assert "2g" in args

    def test_port_mapping(self) -> None:
        args = DockerSandbox.build_run_args(
            SandboxOptions(ports={8000: None, 9090: 49090}),
        )
        assert "-p" in args
        assert "8000" in args
        assert "49090:9090" in args

    def test_mounts_default_to_readonly(self) -> None:
        args = DockerSandbox.build_run_args(
            SandboxOptions(
                mounts=[
                    SandboxMount(host="./data", container="/data"),                      # default → ro
                    SandboxMount(host="./conf", container="/conf", readonly=True),       # explicit → ro
                    SandboxMount(host="./work", container="/work", readonly=False),      # opt-in → rw
                ],
                allow_any_mount=True,  # avoid validation here — separate test covers it
            ),
        )
        assert any(a.endswith(":/data:ro") for a in args)
        assert any(a.endswith(":/conf:ro") for a in args)
        assert any(a.endswith(":/work:rw") for a in args)
        # Sanity: default/explicit-ro mounts must not leak a `:rw` flag.
        assert not any(a.endswith(":/data:rw") for a in args)
        assert not any(a.endswith(":/conf:rw") for a in args)

    def test_env_vars_serialize(self) -> None:
        args = DockerSandbox.build_run_args(SandboxOptions(env={"FOO": "bar", "NUM": "42"}))
        assert "FOO=bar" in args
        assert "NUM=42" in args


# ── DockerSandbox mount validation (no docker required) ──────


class TestDockerMountValidation:
    """Pointed at a nonexistent docker bin so create() never reaches spawn."""

    NEVER_EXEC = "/nonexistent/docker-bin-does-not-exist"

    @pytest.mark.asyncio
    async def test_rejects_mounts_outside_cwd(self) -> None:
        with pytest.raises(RuntimeError, match="outside cwd"):
            await DockerSandbox.create(
                SandboxOptions(
                    docker_bin=self.NEVER_EXEC,
                    mounts=[SandboxMount(host="/etc", container="/etc")],
                ),
            )

    @pytest.mark.asyncio
    async def test_allow_any_mount_skips_validation(self) -> None:
        # Validation off -> we expect to fail on the docker spawn instead.
        with pytest.raises(Exception):
            await DockerSandbox.create(
                SandboxOptions(
                    docker_bin=self.NEVER_EXEC,
                    mounts=[SandboxMount(host="/etc", container="/etc")],
                    allow_any_mount=True,
                ),
            )

    @pytest.mark.asyncio
    async def test_allows_mounts_under_cwd(self) -> None:
        with pytest.raises(Exception):
            await DockerSandbox.create(
                SandboxOptions(
                    docker_bin=self.NEVER_EXEC,
                    mounts=[SandboxMount(host=".", container="/work")],
                ),
            )


# ── DockerSandbox argv validators ────────────────────────────


class TestDockerArgvValidators:
    def test_rejects_image_parsed_as_flag(self) -> None:
        with pytest.raises(RuntimeError, match="invalid image"):
            DockerSandbox.build_run_args(SandboxOptions(image="--privileged"))
        with pytest.raises(RuntimeError, match="invalid image"):
            DockerSandbox.build_run_args(SandboxOptions(image="-rm"))

    def test_rejects_image_with_shell_metacharacters(self) -> None:
        with pytest.raises(RuntimeError, match="invalid image"):
            DockerSandbox.build_run_args(SandboxOptions(image="python:3.12; rm -rf /"))
        with pytest.raises(RuntimeError, match="invalid image"):
            DockerSandbox.build_run_args(
                SandboxOptions(image="python:3.12 --cap-add=SYS_ADMIN"),
            )

    def test_accepts_well_formed_image(self) -> None:
        DockerSandbox.build_run_args(SandboxOptions(image="python:3.12"))
        DockerSandbox.build_run_args(
            SandboxOptions(image="registry.example.com:5000/org/repo:v1.2.3@sha256:abc"),
        )

    def test_rejects_env_keys_not_posix_identifiers(self) -> None:
        with pytest.raises(RuntimeError, match="invalid env key"):
            DockerSandbox.build_run_args(SandboxOptions(env={"bad key": "x"}))
        with pytest.raises(RuntimeError, match="invalid env key"):
            DockerSandbox.build_run_args(SandboxOptions(env={"1LEADING": "x"}))
        with pytest.raises(RuntimeError, match="invalid env key"):
            DockerSandbox.build_run_args(SandboxOptions(env={"K=Y": "x"}))

    def test_rejects_env_values_with_newline_or_nul(self) -> None:
        with pytest.raises(RuntimeError, match="newline or NUL"):
            DockerSandbox.build_run_args(
                SandboxOptions(env={"FOO": "bar\nBAZ=malicious"}),
            )
        with pytest.raises(RuntimeError, match="newline or NUL"):
            DockerSandbox.build_run_args(SandboxOptions(env={"FOO": "bar\x00baz"}))


# ── DockerSandbox lifecycle via fake docker shim ─────────────


@pytest.fixture(scope="module")
def fake_docker(tmp_path_factory: pytest.TempPathFactory) -> str:
    """Tiny shell shim that mimics enough of the docker CLI for lifecycle tests."""
    shim_dir = tmp_path_factory.mktemp("docker-shim")
    shim_bin = shim_dir / "docker"
    shim_bin.write_text(
        '#!/bin/sh\n'
        'case "$1" in\n'
        '  run) echo "fake-container-py-abc123"; exit 0 ;;\n'
        '  port) echo "0.0.0.0:54321"; exit 0 ;;\n'
        '  inspect) echo "true"; exit 0 ;;\n'
        '  rm) exit 0 ;;\n'
        '  exec)\n'
        '    shift\n'
        '    while [ "$1" = "-i" ] || [ "$1" = "-w" ] || [ "$1" = "-e" ]; do\n'
        '      if [ "$1" = "-w" ] || [ "$1" = "-e" ]; then shift; fi\n'
        '      shift\n'
        '    done\n'
        '    shift  # container id\n'
        '    exec "$@"\n'
        '    ;;\n'
        '  cp)\n'
        '    shift\n'
        '    src=${1#*:}\n'
        '    dst=${2#*:}\n'
        '    cp "$src" "$dst"\n'
        '    ;;\n'
        '  *) echo "shim: unknown $1" 1>&2; exit 2 ;;\n'
        'esac\n'
    )
    shim_bin.chmod(shim_bin.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return str(shim_bin)


class TestDockerLifecycle:
    @pytest.mark.asyncio
    async def test_create_sh_close_roundtrip(self, fake_docker: str) -> None:
        sandbox = await DockerSandbox.create(SandboxOptions(docker_bin=fake_docker))
        assert sandbox.container_id == "fake-container-py-abc123"
        out = await sandbox.sh("echo via-fake-docker")
        assert out == "via-fake-docker\n"
        await sandbox.close()

    @pytest.mark.asyncio
    async def test_close_is_idempotent(self, fake_docker: str) -> None:
        sandbox = await DockerSandbox.create(SandboxOptions(docker_bin=fake_docker))
        await sandbox.close()
        await sandbox.close()  # must not raise

    @pytest.mark.asyncio
    async def test_exec_after_close_raises(self, fake_docker: str) -> None:
        sandbox = await DockerSandbox.create(SandboxOptions(docker_bin=fake_docker))
        await sandbox.close()
        with pytest.raises(RuntimeError, match="closed"):
            await sandbox.exec(["echo", "x"])

    @pytest.mark.asyncio
    async def test_endpoint_returns_localhost_port(self, fake_docker: str) -> None:
        sandbox = await DockerSandbox.create(
            SandboxOptions(docker_bin=fake_docker, ports={8000: None}),
        )
        assert sandbox.endpoint(8000) == "localhost:54321"
        await sandbox.close()

    @pytest.mark.asyncio
    async def test_endpoint_unmapped_port_raises(self, fake_docker: str) -> None:
        sandbox = await DockerSandbox.create(SandboxOptions(docker_bin=fake_docker))
        with pytest.raises(RuntimeError, match="not mapped"):
            sandbox.endpoint(9999)
        await sandbox.close()

    @pytest.mark.asyncio
    async def test_connect_reattaches(self, fake_docker: str) -> None:
        sandbox = await DockerSandbox.connect(
            "fake-existing-id",
            SandboxOptions(docker_bin=fake_docker),
        )
        assert sandbox.container_id == "fake-existing-id"
        await sandbox.close()


# ── Default image pin ────────────────────────────────────────


class TestDefaultSandboxImage:
    def test_default_image_is_pinned_patch_slim(self) -> None:
        # Literal match — if the default is bumped, this test moves in
        # lockstep. Pinning prevents silent supply-chain drift.
        assert DEFAULT_SANDBOX_IMAGE == "python:3.12.7-slim"

    def test_default_image_passes_argv_validator(self) -> None:
        # Guards against accidentally regressing to an image that begins
        # with ``-`` and would be mis-parsed as a docker-run flag.
        args = DockerSandbox.build_run_args(
            SandboxOptions(image=DEFAULT_SANDBOX_IMAGE),
        )
        assert args[-3:] == [DEFAULT_SANDBOX_IMAGE, "sleep", "infinity"]

    def test_sandbox_options_default_uses_pinned_image(self) -> None:
        # Callers who don't override image get the pinned default.
        opts = SandboxOptions()
        assert opts.image == DEFAULT_SANDBOX_IMAGE


# ── LocalSandbox dev-only warning ────────────────────────────


class TestLocalSandboxWarning:
    @pytest.mark.asyncio
    async def test_silenced_under_node_env_test(
        self,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        monkeypatch.setenv("NODE_ENV", "test")
        monkeypatch.delenv("NOOKPLOT_LOCAL_SANDBOX_SILENCE", raising=False)
        with caplog.at_level("WARNING", logger="nookplot_runtime.sandbox"):
            sandbox = await LocalSandbox.create()
            await sandbox.close()
        assert not any("LocalSandbox" in r.message for r in caplog.records)

    @pytest.mark.asyncio
    async def test_warns_outside_test_env(
        self,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        monkeypatch.setenv("NODE_ENV", "production")
        monkeypatch.delenv("NOOKPLOT_LOCAL_SANDBOX_SILENCE", raising=False)
        with caplog.at_level("WARNING", logger="nookplot_runtime.sandbox"):
            sandbox = await LocalSandbox.create()
            await sandbox.close()
        msgs = [r.message for r in caplog.records if "LocalSandbox" in r.message]
        assert len(msgs) == 1
        # Message must steer callers toward the safe replacement.
        assert "DockerSandbox" in msgs[0] or "DockerSandbox" in caplog.text

    @pytest.mark.asyncio
    async def test_silence_env_var_suppresses_warning(
        self,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        monkeypatch.setenv("NODE_ENV", "production")
        monkeypatch.setenv("NOOKPLOT_LOCAL_SANDBOX_SILENCE", "1")
        with caplog.at_level("WARNING", logger="nookplot_runtime.sandbox"):
            sandbox = await LocalSandbox.create()
            await sandbox.close()
        assert not any("LocalSandbox" in r.message for r in caplog.records)
