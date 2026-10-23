"""Dataset correctness checks; these do not measure recognition accuracy."""

import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image
import yaml

from train_guitar import (
    DatasetError, load_samples, parse_args, prepare_dataset, read_label,
    reject_duplicates, split_samples,
)


ALL_CLASSES = "\n".join(
    f"{index} 0.1 0.1 0.9 0.1 0.9 0.9 0.1 0.9" for index in range(4)
) + "\n"


class DatasetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.images = self.root / "photos"
        self.labels = self.root / "annotations"
        self.images.mkdir()
        self.labels.mkdir()

    def photo(self, relative, color, text=ALL_CLASSES):
        image = self.images / relative
        label = self.labels / Path(relative).with_suffix(".txt")
        image.parent.mkdir(parents=True, exist_ok=True)
        label.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (64, 64), color).save(image)
        label.write_text(text, encoding="utf-8")
        return image, label

    def args(self, *extra):
        return parse_args([
            "--images", str(self.images), "--labels", str(self.labels),
            "--output", str(self.root / "run"), *extra,
        ])

    def test_preparation_preserves_annotations_and_writes_usable_yaml(self):
        self.photo("one.png", "red")
        self.photo("two.png", "blue")
        config, report = prepare_dataset(self.args("--prepare-only"))
        data = yaml.safe_load(config.read_text())
        self.assertEqual(data["names"], {0: "guitar", 1: "fretboard", 2: "fret", 3: "string"})
        self.assertEqual(Path(data["path"]), config.parent)
        for split in ("train", "val"):
            labels = list((config.parent / "labels" / split).rglob("*.txt"))
            self.assertEqual(len(labels), 1)
            self.assertEqual(labels[0].read_text(), ALL_CLASSES)
            self.assertEqual(report["splits"][split]["images"], 1)
        self.assertEqual(json.loads((self.root / "run/dataset_report.json").read_text())["seed"], 42)

    def test_missing_labels_fail_without_creating_output(self):
        _, label = self.photo("one.png", "red")
        label.unlink()
        with self.assertRaisesRegex(DatasetError, "Missing annotation"):
            prepare_dataset(self.args())
        self.assertFalse((self.root / "run").exists())

    def test_boxes_lines_invalid_classes_and_nonfinite_coordinates_are_rejected(self):
        _, label = self.photo("one.png", "red")
        invalid = [
            "0 0.5 0.5 0.2 0.2", "2 0.1 0.1 0.9 0.9",
            "4 0.1 0.1 0.9 0.1 0.9 0.9",
            "0 nan 0.1 0.9 0.1 0.9 0.9",
            "0 -0.1 0.1 0.9 0.1 0.9 0.9",
            "0 0.1 0.1 0.2 0.2 0.3 0.3",
        ]
        for row in invalid:
            with self.subTest(row=row):
                label.write_text(row)
                with self.assertRaises(DatasetError):
                    read_label(label)

    def test_empty_labels_are_explicit_negatives(self):
        _, label = self.photo("negative.png", "red", text="")
        self.assertEqual(read_label(label), ())

    def test_sessions_stay_together_and_split_is_repeatable(self):
        for index, color in enumerate(("red", "green", "blue", "yellow")):
            self.photo(f"session_{index // 2}/frame_{index}.png", color)
        samples = load_samples(self.images, self.labels)
        train, val = split_samples(samples, 0.2, 42, "auto")
        self.assertEqual(len(train), 2)
        self.assertEqual(len(val), 2)
        train_sessions = {s.relative_path.parts[0] for s in train}
        val_sessions = {s.relative_path.parts[0] for s in val}
        self.assertFalse(train_sessions & val_sessions)
        self.assertEqual((train, val), split_samples(samples, 0.2, 42, "auto"))

    def test_duplicate_images_cannot_leak_between_splits(self):
        self.photo("one.png", "red")
        self.photo("two.png", "red")
        with self.assertRaisesRegex(DatasetError, "Duplicate image content"):
            reject_duplicates(load_samples(self.images, self.labels))

    def test_same_stem_with_different_extension_is_rejected(self):
        self.photo("one.png", "red")
        self.photo("one.jpg", "blue")
        with self.assertRaisesRegex(DatasetError, "Ambiguous image name"):
            load_samples(self.images, self.labels)

    def test_invalid_image_fails_before_output_is_created(self):
        image, _ = self.photo("one.png", "red")
        image.write_text("not an image")
        with self.assertRaisesRegex(DatasetError, "Unreadable image"):
            prepare_dataset(self.args())
        self.assertFalse((self.root / "run").exists())

    def test_a_missing_class_fails_before_output_is_created(self):
        self.photo("one.png", "red", text=ALL_CLASSES.splitlines()[0])
        self.photo("two.png", "blue", text=ALL_CLASSES.splitlines()[0])
        with self.assertRaisesRegex(DatasetError, "no annotations for"):
            prepare_dataset(self.args())
        self.assertFalse((self.root / "run").exists())

    def test_existing_output_is_not_overwritten(self):
        output = self.root / "run"
        output.mkdir()
        marker = output / "keep.txt"
        marker.write_text("keep")
        with self.assertRaisesRegex(DatasetError, "Output already exists"):
            prepare_dataset(self.args())
        self.assertEqual(marker.read_text(), "keep")

    def test_explicit_validation_set_uses_its_own_labels(self):
        self.photo("one.png", "red")
        val_images = self.root / "held_out"
        val_images.mkdir()
        Image.new("RGB", (64, 64), "blue").save(val_images / "val.png")
        (val_images / "val.txt").write_text(ALL_CLASSES)
        _, report = prepare_dataset(self.args("--val-images", str(val_images)))
        self.assertEqual(report["splits"]["val"]["files"][0]["image"], str((val_images / "val.png").resolve()))


if __name__ == "__main__":
    unittest.main()
