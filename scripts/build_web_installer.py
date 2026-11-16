#!/usr/bin/env python3
"""Build a single ESP32-S3 browser-flashable image and GitHub Pages site.

Requires a successful PlatformIO build and esptool 4.x installed.
Does not modify the deployed keyboard firmware repository.
"""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENVIRONMENT = "lilygo-tdongle-s3"
FIRMWARE_VERSION = "0.3.0"
FLASH_BYTES = 16 * 1024 * 1024


def make_manifest(version=FIRMWARE_VERSION):
    return {
        "name": "ESP32-S3 Admin Toolkit",
        "version": version,
        "new_install_prompt_erase": True,
        "builds": [
            {
                "chipFamily": "ESP32-S3",
                "parts": [{"path": "admin-toolkit-merged.bin", "offset": 0}]
            }
        ]
    }


def build_site(output: Path):
    build = ROOT / "firmware" / ".pio" / "build" / ENVIRONMENT
    image_parts = {
        "0x0": build / "bootloader.bin",
        "0x8000": build / "partitions.bin",
        "0x10000": build / "firmware.bin",
    }
    boot_app0 = (
        Path.home() / ".platformio" / "packages" /
        "framework-arduinoespressif32" / "tools" / "partitions" / "boot_app0.bin"
    )
    image_parts["0xe000"] = boot_app0
    missing = [str(file) for file in image_parts.values() if not file.is_file()]
    if missing:
        raise FileNotFoundError("Required flash binaries missing: " + ", ".join(missing))

    if output.exists():
        shutil.rmtree(output)
    shutil.copytree(ROOT / "web", output)
    firmware_site = output / "firmware"
    firmware_site.mkdir(parents=True, exist_ok=True)
    merged = firmware_site / "admin-toolkit-merged.bin"

    # ESP32-S3 bootloader lives at 0x0; other offsets match partitions.csv.
    cmd = [
        sys.executable, "-m", "esptool", "--chip", "esp32s3", "merge_bin",
        "--flash_mode", "dio", "--flash_freq", "40m",
        "--flash_size", "16MB", "-o", str(merged),
    ]
    for offset, part in sorted(image_parts.items(), key=lambda item: int(item[0], 16)):
        cmd.extend([offset, str(part)])
    subprocess.run(cmd, check=True)

    if not merged.is_file() or not 65536 < merged.stat().st_size < FLASH_BYTES:
        raise RuntimeError("Merged firmware has an unexpected size or was not produced")
    with merged.open("rb") as image:
        if image.read(1) != b"\xe9":
            raise RuntimeError("Merged image does not start with ESP image magic 0xE9")
    (firmware_site / "manifest.json").write_text(
        json.dumps(make_manifest(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Staged {merged} ({merged.stat().st_size} bytes) and manifest")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "_site")
    args = parser.parse_args()
    build_site(args.output.resolve())


if __name__ == "__main__":
    main()
