#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence


def _ensure_docker_compose() -> str:
    binary = shutil.which("docker-compose")
    if not binary:
        raise RuntimeError("docker-compose is required")
    return binary


def _run(
    cmd: Sequence[str],
    *,
    stdin: bytes | None = None,
    check: bool = True,
    text: bool = False,
) -> subprocess.CompletedProcess:
    return subprocess.run(
        list(cmd),
        input=stdin,
        check=check,
        capture_output=True,
        text=text,
    )


def _compose_exec_prefix(compose_bin: str, compose_file: str, service: str) -> list[str]:
    return [compose_bin, "-f", compose_file, "exec", "-T", service]


def _compose_exec_bytes(
    compose_bin: str,
    compose_file: str,
    service: str,
    args: Sequence[str],
    *,
    stdin: bytes | None = None,
) -> bytes:
    cmd = _compose_exec_prefix(compose_bin, compose_file, service) + list(args)
    proc = _run(cmd, stdin=stdin)
    return proc.stdout


def _compose_exec_text(
    compose_bin: str,
    compose_file: str,
    service: str,
    args: Sequence[str],
    *,
    stdin: bytes | None = None,
) -> str:
    cmd = _compose_exec_prefix(compose_bin, compose_file, service) + list(args)
    proc = _run(cmd, stdin=stdin)
    return proc.stdout.decode("utf-8", errors="replace")


def _write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=True, indent=2), encoding="utf-8")


def backup(args: argparse.Namespace) -> None:
    compose_bin = _ensure_docker_compose()
    backup_root = Path(args.output).resolve()
    backup_root.mkdir(parents=True, exist_ok=True)

    meta = {
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "compose_file": str(Path(args.compose_file).resolve()),
        "postgres": {
            "service": args.pg_service,
            "db": args.pg_db,
            "user": args.pg_user,
            "dump_file": "postgres_dump.sql",
        },
        "clickhouse": {
            "service": args.ch_service,
            "db": args.ch_db,
            "user": args.ch_user,
            "password_set": bool(args.ch_password),
            "tables": [],
        },
    }

    print("[backup] dumping postgres...")
    pg_dump = _compose_exec_bytes(
        compose_bin,
        args.compose_file,
        args.pg_service,
        [
            "pg_dump",
            "-U",
            args.pg_user,
            "-d",
            args.pg_db,
            "--clean",
            "--if-exists",
            "--no-owner",
            "--no-privileges",
            "--format=plain",
        ],
    )
    (backup_root / "postgres_dump.sql").write_bytes(pg_dump)

    print("[backup] listing clickhouse tables...")
    ch_auth = ["--user", args.ch_user]
    if args.ch_password:
        ch_auth += ["--password", args.ch_password]
    tables_raw = _compose_exec_text(
        compose_bin,
        args.compose_file,
        args.ch_service,
        ch_auth
        + [
            "clickhouse-client",
            "--database",
            args.ch_db,
            "--query",
            "SHOW TABLES FORMAT TSVRaw",
        ],
    )
    tables = [line.strip() for line in tables_raw.splitlines() if line.strip()]

    schema_dir = backup_root / "clickhouse" / "schema"
    data_dir = backup_root / "clickhouse" / "data"
    schema_dir.mkdir(parents=True, exist_ok=True)
    data_dir.mkdir(parents=True, exist_ok=True)

    for table in tables:
        print(f"[backup] clickhouse table: {table}")
        create_stmt = _compose_exec_text(
            compose_bin,
            args.compose_file,
            args.ch_service,
            ch_auth
            + [
                "clickhouse-client",
                "--database",
                args.ch_db,
                "--query",
                f"SHOW CREATE TABLE `{args.ch_db}`.`{table}`",
            ],
        ).strip()
        (schema_dir / f"{table}.sql").write_text(create_stmt + ";\n", encoding="utf-8")

        table_data = _compose_exec_bytes(
            compose_bin,
            args.compose_file,
            args.ch_service,
            ch_auth
            + [
                "clickhouse-client",
                "--database",
                args.ch_db,
                "--query",
                f"SELECT * FROM `{args.ch_db}`.`{table}` FORMAT Native",
            ],
        )
        (data_dir / f"{table}.native").write_bytes(table_data)
        meta["clickhouse"]["tables"].append(table)

    _write_json(backup_root / "manifest.json", meta)
    print(f"[backup] done: {backup_root}")


def restore(args: argparse.Namespace) -> None:
    compose_bin = _ensure_docker_compose()
    backup_root = Path(args.input).resolve()
    manifest_path = backup_root / "manifest.json"
    if not manifest_path.exists():
        raise RuntimeError(f"manifest not found: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    pg_dump_path = backup_root / "postgres_dump.sql"
    if not pg_dump_path.exists():
        raise RuntimeError(f"postgres dump not found: {pg_dump_path}")

    print("[restore] restoring postgres...")
    _compose_exec_text(
        compose_bin,
        args.compose_file,
        args.pg_service,
        ["psql", "-U", args.pg_user, "-d", args.pg_db, "-v", "ON_ERROR_STOP=1"],
        stdin=pg_dump_path.read_bytes(),
    )

    ch_auth = ["--user", args.ch_user]
    if args.ch_password:
        ch_auth += ["--password", args.ch_password]

    tables: list[str] = list(manifest.get("clickhouse", {}).get("tables", []))
    schema_dir = backup_root / "clickhouse" / "schema"
    data_dir = backup_root / "clickhouse" / "data"

    for table in tables:
        schema_path = schema_dir / f"{table}.sql"
        data_path = data_dir / f"{table}.native"
        if not schema_path.exists():
            raise RuntimeError(f"clickhouse schema not found: {schema_path}")
        if not data_path.exists():
            raise RuntimeError(f"clickhouse data not found: {data_path}")

        print(f"[restore] clickhouse table: {table}")
        _compose_exec_text(
            compose_bin,
            args.compose_file,
            args.ch_service,
            ch_auth
            + [
                "clickhouse-client",
                "--database",
                args.ch_db,
                "--query",
                f"DROP TABLE IF EXISTS `{args.ch_db}`.`{table}`",
            ],
        )
        _compose_exec_text(
            compose_bin,
            args.compose_file,
            args.ch_service,
            ch_auth + ["clickhouse-client", "--database", args.ch_db],
            stdin=schema_path.read_bytes(),
        )
        if data_path.stat().st_size > 0:
            _compose_exec_text(
                compose_bin,
                args.compose_file,
                args.ch_service,
                ch_auth
                + [
                    "clickhouse-client",
                    "--database",
                    args.ch_db,
                    "--query",
                    f"INSERT INTO `{args.ch_db}`.`{table}` FORMAT Native",
                ],
                stdin=data_path.read_bytes(),
            )

    print(f"[restore] done: {backup_root}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Backup and restore Postgres + ClickHouse tables via docker-compose."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--compose-file",
        default=str((Path(__file__).resolve().parent.parent / "docker-compose.yml").resolve()),
        help="Path to docker-compose.yml",
    )
    common.add_argument("--pg-service", default="postgres")
    common.add_argument("--pg-db", default="avsp")
    common.add_argument("--pg-user", default="postgres")
    common.add_argument("--ch-service", default="clickhouse")
    common.add_argument("--ch-db", default="default")
    common.add_argument("--ch-user", default="default")
    common.add_argument("--ch-password", default="clickhouse")

    backup_cmd = sub.add_parser("backup", parents=[common], help="Create backup")
    backup_cmd.add_argument(
        "--output",
        default=str((Path.cwd() / "db-backup").resolve()),
        help="Output backup directory",
    )

    restore_cmd = sub.add_parser("restore", parents=[common], help="Restore backup")
    restore_cmd.add_argument(
        "--input",
        required=True,
        help="Backup directory path (contains manifest.json)",
    )
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if args.command == "backup":
        backup(args)
        return
    if args.command == "restore":
        restore(args)
        return
    parser.error(f"unsupported command: {args.command}")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.decode("utf-8", errors="replace") if isinstance(exc.stderr, (bytes, bytearray)) else str(exc.stderr or "")
        stdout = exc.stdout.decode("utf-8", errors="replace") if isinstance(exc.stdout, (bytes, bytearray)) else str(exc.stdout or "")
        print("[error] command failed", file=sys.stderr)
        print(f"  cmd: {' '.join(exc.cmd)}", file=sys.stderr)
        if stdout.strip():
            print(f"  stdout: {stdout.strip()}", file=sys.stderr)
        if stderr.strip():
            print(f"  stderr: {stderr.strip()}", file=sys.stderr)
        sys.exit(exc.returncode or 1)
    except Exception as exc:  # noqa: BLE001
        print(f"[error] {exc}", file=sys.stderr)
        sys.exit(1)
