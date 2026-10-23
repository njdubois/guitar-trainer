#!/usr/bin/env python3
r"""Fine-tune a segmentation model on annotated guitar photos.

Example:
    python train_guitar.py --images dataset/images --labels dataset/labels \
        --output runs/first --device auto

Labels must be YOLO segmentation polygons; raw photos alone are insufficient.
See README.md for annotation instructions and dataset layout.
"""

from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
import random
import shutil
import sys


CLASSES = ("guitar", "fretboard", "fret", "string")
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp"}


class DatasetError(ValueError):
    """The dataset cannot safely be used for training."""


@dataclass(frozen=True)
class Sample:
    image: Path
    label: Path
    relative_path: Path
    classes: tuple[int, ...]
    digest: str


def read_label(path: Path) -> tuple[int, ...]:
    """Validate YOLO segmentation rows, preserving explicit negative images."""
    if not path.is_file():
        raise DatasetError(
            f"Missing annotation: {path}\n"
            "Annotate every image. Use an empty .txt file only for a reviewed "
            "image with none of the four target classes."
        )
    classes = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        fields = line.split()
        if not fields:
            continue
        context = f"{path}:{line_number}"
        if len(fields) < 7 or (len(fields) - 1) % 2:
            raise DatasetError(
                f"{context}: expected 'class x1 y1 x2 y2 x3 y3 ...' "
                "with at least 3 polygon points. Bounding boxes and lines need conversion."
            )
        try:
            class_id = int(fields[0])
            coordinates = [float(value) for value in fields[1:]]
        except ValueError as exc:
            raise DatasetError(f"{context}: class must be an integer and coordinates numeric.") from exc
        if not 0 <= class_id < len(CLASSES):
            raise DatasetError(f"{context}: class must be 0, 1, 2, or 3; got {class_id}.")
        if any(not math.isfinite(value) or not 0 <= value <= 1 for value in coordinates):
            raise DatasetError(f"{context}: coordinates must be finite and normalized to [0, 1].")
        points = list(zip(coordinates[::2], coordinates[1::2]))
        area_twice = abs(sum(
            a[0] * b[1] - b[0] * a[1]
            for a, b in zip(points, points[1:] + points[:1])
        ))
        if area_twice <= 1e-12:
            raise DatasetError(f"{context}: polygon has zero area. Trace a narrow outline, not a line.")
        classes.append(class_id)
    return tuple(classes)


def load_samples(images: Path, labels: Path) -> list[Sample]:
    """Read a folder recursively; labels mirror the image subdirectories."""
    from PIL import Image, UnidentifiedImageError

    if not images.is_dir():
        raise DatasetError(f"Image folder does not exist: {images}")
    if not labels.is_dir():
        raise DatasetError(f"Label folder does not exist: {labels}")
    paths = sorted(
        path for path in images.rglob("*")
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
        and not any(part.startswith(".") for part in path.relative_to(images).parts)
    )
    if not paths:
        raise DatasetError(f"No supported images found in {images}.")
    samples = []
    stems = set()
    for path in paths:
        relative = path.relative_to(images)
        stem = relative.with_suffix("").as_posix().casefold()
        if stem in stems:
            raise DatasetError(
                f"Ambiguous image name: {relative}. Images sharing a label filename "
                "(such as frame.jpg and frame.png) must be renamed."
            )
        stems.add(stem)
        label = labels / relative.with_suffix(".txt")
        classes = read_label(label)
        try:
            with Image.open(path) as image:
                if min(image.size) < 10:
                    raise DatasetError(f"Image is too small (minimum side is 10 pixels): {path}")
                image.verify()
        except (OSError, UnidentifiedImageError) as exc:
            raise DatasetError(f"Unreadable image: {path}: {exc}") from exc
        with path.open("rb") as handle:
            digest = hashlib.file_digest(handle, "sha256").hexdigest()
        samples.append(Sample(path, label, relative, classes, digest))
    return samples


def reject_duplicates(samples: list[Sample]) -> None:
    seen = {}
    for sample in samples:
        if sample.digest in seen:
            raise DatasetError(
                f"Duplicate image content: {sample.image} and {seen[sample.digest]}. "
                "Remove duplicates to avoid repeated samples or train/validation leakage."
            )
        seen[sample.digest] = sample.image


def class_counts(samples: list[Sample]) -> dict[str, int]:
    counts = Counter(class_id for sample in samples for class_id in sample.classes)
    return {name: counts[index] for index, name in enumerate(CLASSES)}


def require_classes(samples: list[Sample], split: str) -> None:
    missing = [name for name, count in class_counts(samples).items() if count == 0]
    if missing:
        raise DatasetError(
            f"{split} has no annotations for: {', '.join(missing)}. "
            "Each split needs examples of all four classes. Add labeled examples, "
            "adjust the split/seed, or supply a separate --val-images/--val-labels set."
        )


def split_samples(
    samples: list[Sample], val_fraction: float, seed: int, group_by: str,
) -> tuple[list[Sample], list[Sample]]:
    """Split entire session folders together when present; otherwise split images."""
    grouped = any(len(sample.relative_path.parts) > 1 for sample in samples)
    if group_by == "auto":
        group_by = "folder" if grouped else "image"
    groups: dict[str, list[Sample]] = {}
    for sample in samples:
        key = sample.relative_path.as_posix()
        if group_by == "folder":
            key = sample.relative_path.parts[0] if len(sample.relative_path.parts) > 1 else "."
        groups.setdefault(key, []).append(sample)
    if len(groups) < 2:
        raise DatasetError(
            "Need at least two independent images or session folders to create a holdout. "
            "For video frames, add another session folder or use --val-images. "
            "Use --group-by image only for independent photos."
        )
    keys = sorted(groups)
    random.Random(seed).shuffle(keys)
    n_val = min(len(keys) - 1, max(1, round(len(keys) * val_fraction)))
    val_keys = set(keys[:n_val])
    train = [sample for key in keys if key not in val_keys for sample in groups[key]]
    val = [sample for key in keys if key in val_keys for sample in groups[key]]
    print(f"Split by {group_by}: {len(keys) - n_val} train / {n_val} validation groups.")
    if group_by == "image":
        print("Use session subfolders for video frames; adjacent frames must stay in the same split.")
    return train, val


def prepare_dataset(args: argparse.Namespace) -> tuple[Path, dict]:
    images = args.images.expanduser().resolve()
    labels = (args.labels or args.images).expanduser().resolve()
    output = args.output.expanduser().resolve()
    roots = [images, labels]
    if args.val_images:
        roots.extend([
            args.val_images.expanduser().resolve(),
            (args.val_labels or args.val_images).expanduser().resolve(),
        ])
    if output.exists():
        raise DatasetError(f"Output already exists: {output}. Choose a new --output; no files were replaced.")
    for root in roots:
        if output.is_relative_to(root) or root.is_relative_to(output):
            raise DatasetError("Output and input folders must be separate, with neither containing the other.")

    samples = load_samples(images, labels)
    if args.val_images:
        train = samples
        val = load_samples(roots[2], roots[3])
    else:
        train, val = split_samples(samples, args.val_fraction, args.seed, args.group_by)
    reject_duplicates(train + val)
    require_classes(train, "Training set")
    require_classes(val, "Validation set")

    report = {
        "classes": dict(enumerate(CLASSES)),
        "seed": args.seed,
        "arguments": {key: str(value) if isinstance(value, Path) else value
                      for key, value in vars(args).items()},
        "splits": {},
    }
    dataset = output / "dataset"
    for split, members in (("train", train), ("val", val)):
        entries = []
        for sample in members:
            dest_image = dataset / "images" / split / sample.relative_path
            dest_label = dataset / "labels" / split / sample.relative_path.with_suffix(".txt")
            dest_image.parent.mkdir(parents=True, exist_ok=True)
            dest_label.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(sample.image, dest_image)
            shutil.copy2(sample.label, dest_label)
            entries.append({
                "image": str(sample.image), "label": str(sample.label),
                "sha256": sample.digest, "relative_path": sample.relative_path.as_posix(),
            })
        counts = class_counts(members)
        report["splits"][split] = {
            "images": len(members),
            "negative_images": sum(not member.classes for member in members),
            "instances": counts,
            "files": entries,
        }
        print(f"{split}: {len(members)} images; instances: {counts}")

    data_yaml = dataset / "data.yaml"
    names = "\n".join(f"  {index}: {name}" for index, name in enumerate(CLASSES))
    data_yaml.write_text(
        f"path: {json.dumps(str(dataset), ensure_ascii=True)}\n"
        f"train: images/train\nval: images/val\nnames:\n{names}\n",
        encoding="utf-8",
    )
    (output / "dataset_report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Prepared dataset: {data_yaml}")
    if len(train) < 100:
        print("Small dataset: useful for checking the pipeline; collect more varied examples to assess recognition.")
    return data_yaml, report


def select_device(requested: str) -> str:
    import torch

    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "0"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def train(args: argparse.Namespace, data_yaml: Path) -> None:
    from ultralytics import YOLO

    device = select_device(args.device)
    model = YOLO(args.model, task="segment")
    if model.task != "segment":
        raise DatasetError("Use a segmentation checkpoint, such as yolo11n-seg.pt.")
    print(f"Training on {device}; starting weights: {args.model}")
    model.train(
        data=str(data_yaml), epochs=args.epochs, imgsz=args.imgsz, batch=args.batch,
        device=device, workers=args.workers, project=str(args.output.expanduser().resolve()),
        name="training", exist_ok=False, seed=args.seed, patience=args.patience,
        # Nested guitar/fretboard/fret/string instances must retain their own masks.
        overlap_mask=False, mask_ratio=args.mask_ratio,
        # Avoid erasing tiny frets/strings with strong resizing or image mixing.
        mosaic=0.0, mixup=0.0, copy_paste=0.0, scale=0.15,
        degrees=10.0, perspective=0.0, flipud=0.0, fliplr=0.0,
        translate=0.05, amp=(device != "mps"), plots=True, save=True,
    )
    run_dir = Path(model.trainer.save_dir)
    best = run_dir / "weights" / "best.pt"
    if not best.is_file():
        raise RuntimeError(f"Training did not produce the expected checkpoint: {best}")
    print(f"\nBest model: {best}\nTraining/validation results: {run_dir / 'results.csv'}")
    print("Inspect validation masks in the run folder, especially the individual strings and frets.")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--images", type=Path, required=True, help="Input photo folder, searched recursively.")
    parser.add_argument("--labels", type=Path, help="YOLO polygon labels, mirroring images. Default: beside images.")
    parser.add_argument("--val-images", type=Path, help="Optional separate folder of held-out validation photos.")
    parser.add_argument("--val-labels", type=Path, help="Labels for --val-images. Default: beside validation images.")
    parser.add_argument("--output", type=Path, default=Path("runs/guitar"), help="New output folder; must not exist.")
    parser.add_argument("--model", default="yolo11n-seg.pt", help="Pretrained segmentation weights or local .pt checkpoint.")
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument("--imgsz", type=int, default=960, help="Input side length in pixels; divisible by 32.")
    parser.add_argument("--batch", type=int, default=4, help="Lower this if training runs out of memory.")
    parser.add_argument("--device", default="auto", help="auto, cpu, mps (Apple GPU), or CUDA device, e.g. 0.")
    parser.add_argument("--workers", type=int, default=0, help="Data loader workers (0 is portable on macOS/Windows).")
    parser.add_argument("--patience", type=int, default=20, help="Stop after this many epochs without improvement.")
    parser.add_argument("--mask-ratio", type=int, choices=[1, 2, 4], default=1, help="Training mask downsampling; 1 preserves thin labels.")
    parser.add_argument("--val-fraction", type=float, default=0.2, help="Fraction of groups reserved for validation.")
    parser.add_argument("--group-by", choices=["auto", "folder", "image"], default="auto", help="auto keeps top-level session folders together.")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--prepare-only", action="store_true", help="Validate/copy data and write reports without loading a model.")
    args = parser.parse_args(argv)
    if args.val_labels and not args.val_images:
        parser.error("--val-labels requires --val-images")
    for name in ("epochs", "imgsz", "batch", "patience"):
        if getattr(args, name) <= 0:
            parser.error(f"--{name} must be positive")
    if args.imgsz % 32:
        parser.error("--imgsz must be divisible by 32")
    if args.workers < 0:
        parser.error("--workers cannot be negative")
    if not 0 < args.val_fraction < 1:
        parser.error("--val-fraction must be between 0 and 1")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        data_yaml, _ = prepare_dataset(args)
        if not args.prepare_only:
            train(args, data_yaml)
    except ImportError as exc:
        print(f"Missing Python dependency: {exc}. Run: python -m pip install -r requirements.txt", file=sys.stderr)
        return 1
    except (DatasetError, OSError, UnicodeError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
