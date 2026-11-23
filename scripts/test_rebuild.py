"""Exercise the rebuild launcher with real Compose parsing and intercepted mutations."""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class RebuildTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="librechat-rebuild-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.install = self.root / "installation with spaces"
        self.install.mkdir()
        self.source = self.root / "source checkout"
        self.source.mkdir()
        (self.source / "Dockerfile").write_text("FROM scratch\n")
        (self.source / "package.json").write_text('{"name":"synthetic-source"}\n')
        self.override = self.install / "docker-compose.override.yml"
        self.original = (
            "# Keep this operator configuration.\n"
            "services:\n"
            "  api:\n"
            "    ports: !override\n"
            "      - '127.0.0.1:${PORT}:3080'\n"
            "    environment:\n"
            "      KI_CHAT_BASE_URL: ${KI_CHAT_BASE_URL}\n"
            "      KI_API_TOKEN: ${KI_API_TOKEN}\n"
            "    volumes:\n"
            "      - ./librechat.yaml:/app/librechat.yaml:ro\n"
            "  admin-panel:\n"
            "    ports: !override\n"
            "      - '127.0.0.1:3081:3000'\n"
        )
        self.override.write_text(self.original)
        (self.install / ".env").write_text(
            "PORT=3080\nKI_CHAT_BASE_URL=http://synthetic-backend:8080\n"
            "KI_API_TOKEN=synthetic-file-token\n"
        )
        (self.install / "librechat.yaml").write_text("version: 1.3.5\n")
        (self.install / "docker-compose.yml").write_text(
            "services:\n"
            "  api:\n"
            "    image: synthetic/librechat:old\n"
            "    ports: ['3080:3080']\n"
            "  admin-panel:\n"
            "    image: synthetic/admin:unchanged\n"
            "    ports: ['3000:3000']\n"
            "  optional-service:\n"
            "    image: synthetic/optional:unchanged\n"
            "    profiles: [extra]\n"
        )
        self.docker = shutil.which("docker")
        self.assertIsNotNone(self.docker, "Docker Compose is required for these tests")
        self.events = self.root / "events.jsonl"
        executable = self.root / "bin"
        executable.mkdir()
        fake = executable / "docker"
        fake.write_text("""#!/usr/bin/env python3
import json, os, subprocess, sys
from pathlib import Path
args = sys.argv[1:]
with Path(os.environ["REBUILD_TEST_EVENTS"]).open("a") as file:
    file.write(json.dumps({"kind": "docker", "args": args}) + "\\n")
if args[0] == "compose":
    sys.exit(subprocess.run([os.environ["REBUILD_TEST_DOCKER"], *args]).returncode)
if args[0] == "build":
    print("synthetic-build-progress", flush=True)
    print("synthetic-build-diagnostic", file=sys.stderr)
    if os.environ.get("REBUILD_TEST_FAILURE") == "build":
        print("synthetic-build-error", file=sys.stderr)
        sys.exit(17)
    if os.environ.get("REBUILD_TEST_FAILURE") == "concurrent":
        with Path(os.environ["REBUILD_TEST_OVERRIDE"]).open("a") as file:
            file.write("# parallel operator change\\n")
elif args[:2] == ["image", "inspect"]:
    if os.environ.get("REBUILD_TEST_FAILURE") == "inspect":
        sys.exit(17)
    print("sha256:synthetic-built-image")
else:
    sys.exit(19)
""")
        fake.chmod(0o755)
        (self.install / "recreate.sh").write_text("""#!/usr/bin/env bash
exec python3 - "$@" <<'PY'
import json, os, sys
from pathlib import Path
with Path(os.environ["REBUILD_TEST_EVENTS"]).open("a") as file:
    file.write(json.dumps({"kind": "recreate", "args": sys.argv[1:],
        "profiles": os.environ.get("COMPOSE_PROFILES"),
        "inherited_token": os.environ.get("KI_API_TOKEN")}) + "\\n")
print("synthetic-recreated-all")
sys.exit(17 if os.environ.get("REBUILD_TEST_FAILURE") == "recreate" else 0)
PY
""")
        self.environment = {
            "PATH": str(executable)
            + os.pathsep
            + os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(self.root),
            "REBUILD_TEST_EVENTS": str(self.events),
            "REBUILD_TEST_DOCKER": self.docker,
            "REBUILD_TEST_OVERRIDE": str(self.override),
            "COMPOSE_PROFILES": "extra",
            "COMPOSE_PROJECT_NAME": "synthetic-rebuild",
            "KI_API_TOKEN": "synthetic-wrong-shell-token",
            "KI_CHAT_BASE_URL": "http://wrong-shell.invalid",
        }

    def run_script(self, *options, failure=None, separate_source=True):
        source_options = ["--source-dir", str(self.source)] if separate_source else []
        return subprocess.run(
            [
                "bash",
                str(ROOT / "rebuild.sh"),
                *source_options,
                "--install-dir",
                str(self.install),
                *options,
            ],
            cwd=self.root,
            check=False,
            env={**self.environment, "REBUILD_TEST_FAILURE": failure or ""},
            text=True,
            capture_output=True,
        )

    def calls(self):
        return (
            [json.loads(line) for line in self.events.read_text().splitlines()]
            if self.events.exists()
            else []
        )

    def backups(self):
        return list(
            (self.install / ".rebuild-backups").glob("*/docker-compose.override.yml")
        )

    def test_default_build_source_is_the_installation_directory(self):
        for name in ("Dockerfile", "package.json"):
            shutil.copy2(self.source / name, self.install / name)
        result = self.run_script(
            "--image", "bfe/librechat:same-directory", separate_source=False
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        build = next(
            call["args"]
            for call in self.calls()
            if call["kind"] == "docker" and call["args"][0] == "build"
        )
        self.assertEqual(build[-1], str(self.install))
        self.assertEqual(
            build[build.index("--file") + 1], str(self.install / "Dockerfile")
        )
        self.assertEqual(self.calls()[-1]["kind"], "recreate")
        self.assertIn(
            'image: "bfe/librechat:same-directory"', self.override.read_text()
        )

    def test_build_updates_image_preserves_override_and_recreates_all_profiles(self):
        result = self.run_script("--image", "bfe/librechat:test-build")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("synthetic-build-progress", result.stdout)
        self.assertIn("synthetic-build-diagnostic", result.stderr)
        updated = self.override.read_text()
        self.assertIn('    image: "bfe/librechat:test-build"\n', updated)
        self.assertEqual(
            updated.replace('    image: "bfe/librechat:test-build"\n', "").replace(
                "    pull_policy: never\n", ""
            ),
            self.original,
        )
        self.assertEqual(self.backups()[0].read_text(), self.original)
        calls = self.calls()
        build = next(
            call["args"]
            for call in calls
            if call["kind"] == "docker" and call["args"][0] == "build"
        )
        self.assertIn("--progress=plain", build)
        self.assertEqual(build[-1], str(self.source))
        self.assertEqual(
            calls[-1],
            {
                "kind": "recreate",
                "args": [],
                "profiles": "extra",
                "inherited_token": None,
            },
        )
        self.assertNotIn("synthetic-file-token", result.stdout + result.stderr)
        self.assertFalse(list(self.install.glob(".rebuild-override-*")))

    def test_replaces_existing_image_and_pull_policy_without_touching_nested_keys(self):
        self.override.write_text(
            self.original.replace(
                "  api:\n",
                "  api:\n    image: old/image:tag # operator comment\n    pull_policy: always\n",
            ).replace(
                "    environment:\n", "    environment:\n      image: nested-value\n"
            )
        )
        result = self.run_script("--image", "registry.example:5000/bfe/librechat:next")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(
            'image: "registry.example:5000/bfe/librechat:next" # operator comment',
            self.override.read_text(),
        )
        self.assertIn("      image: nested-value\n", self.override.read_text())
        self.assertNotIn("pull_policy: always", self.override.read_text())

    def test_check_is_read_only_and_does_not_build_or_recreate(self):
        result = self.run_script("--check")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout, r"bfe/librechat:local-\d{8}T\d+Z")
        self.assertEqual(self.override.read_text(), self.original)
        self.assertFalse(self.backups())
        self.assertTrue(all(call["args"][0] == "compose" for call in self.calls()))

    def test_build_or_inspect_failure_keeps_override_and_containers(self):
        for failure in ("build", "inspect"):
            with self.subTest(failure=failure):
                result = self.run_script(failure=failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.override.read_text(), self.original)
                self.assertFalse(self.backups())
                self.assertFalse(
                    any(call["kind"] == "recreate" for call in self.calls())
                )
                self.assertFalse(list(self.install.glob(".rebuild-override-*")))

    def test_parallel_override_change_is_not_overwritten(self):
        result = self.run_script(failure="concurrent")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("während des Builds geändert", result.stderr)
        self.assertEqual(
            self.override.read_text(), self.original + "# parallel operator change\n"
        )
        self.assertFalse(any(call["kind"] == "recreate" for call in self.calls()))

    def test_recreate_failure_retains_updated_config_and_original_backup(self):
        result = self.run_script("--image", "bfe/librechat:built", failure="recreate")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('image: "bfe/librechat:built"', self.override.read_text())
        self.assertEqual(self.backups()[0].read_text(), self.original)
        self.assertIn("Override-Sicherung:", result.stdout)
        self.assertNotIn("LibreChat erfolgreich", result.stdout)

    def test_missing_service_block_is_added_and_existing_services_are_preserved(self):
        for content in (
            "services:\n  admin-panel:\n    image: synthetic/admin:unchanged\n",
            "name: synthetic-rebuild\n",
        ):
            with self.subTest(content=content):
                self.override.write_text(content)
                result = self.run_script("--image", "bfe/librechat:new")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(content.strip(), self.override.read_text())

    def test_inline_service_mapping_is_rejected_before_build(self):
        self.override.write_text("services:\n  api: {image: synthetic/librechat:old}\n")
        original = self.override.read_text()
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("eingerückter YAML-Block", result.stderr)
        self.assertEqual(self.override.read_text(), original)
        self.assertFalse(self.calls())

    def test_invalid_compose_configuration_stops_before_build(self):
        self.override.write_text("services:\n  api:\n    ports: invalid-ports\n")
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(all(call["args"][0] == "compose" for call in self.calls()))
        self.assertFalse(self.backups())

    def test_invalid_image_is_rejected_before_docker(self):
        result = self.run_script("--image", "invalid image:tag")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.calls())

    def test_missing_source_stops_before_docker(self):
        (self.source / "Dockerfile").unlink()
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Erforderliche Datei fehlt", result.stderr)
        self.assertFalse(self.calls())

    def test_default_tag_and_build_metadata_identify_dirty_git_sources(self):
        subprocess.run(
            ["git", "init", "-q", "-b", "test-branch", str(self.source)], check=True
        )
        subprocess.run(["git", "-C", str(self.source), "add", "."], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(self.source),
                "-c",
                "user.name=Rebuild Test",
                "-c",
                "user.email=rebuild@example.invalid",
                "commit",
                "-q",
                "-m",
                "fixture",
            ],
            check=True,
        )
        commit = subprocess.check_output(
            ["git", "-C", str(self.source), "rev-parse", "HEAD"], text=True
        ).strip()
        (self.source / "Dockerfile").write_text("FROM scratch\n# local change\n")
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"bfe/librechat:{commit[:12]}-dirty-", self.override.read_text())
        build = next(
            call["args"]
            for call in self.calls()
            if call["kind"] == "docker" and call["args"][0] == "build"
        )
        self.assertIn("BUILD_COMMIT=" + commit, build)
        self.assertIn("BUILD_BRANCH=test-branch", build)


if __name__ == "__main__":
    unittest.main()
