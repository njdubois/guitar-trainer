# Guitar AR: first recognition model

Use the [React annotation tool](annotation-tool/README.md) to upload images,
draw the four label types, save your work, and export a dataset for this script.
It includes a password-protected Node backend and can run on your own server.

`train_guitar.py` reads annotated photos from a folder and fine-tunes a small
YOLO11 instance segmentation model. It learns four classes: `guitar`, `fretboard`,
`fret`, and `string`. Predictions contain a class, confidence, bounding box, and
outline for each instance.

This is the first recognition stage. Precise tab dots will also require string
ordering, fret numbering anchored to the nut or another known fret, fretboard
geometry, camera/display calibration, and tracking across frames. A generic
`fret` prediction does not identify its fret number. This script does not yet
render AR dots or establish real-time performance on glasses.

## Install

Use Python 3.11 or newer; Python 3.12 is a good starting environment.

```bash
cd /Users/nickdubois/www/PersonalProjects/new_guitar_ar
uv venv --python 3.12 .venv
source .venv/bin/activate
uv pip install -r requirements.txt
```

Without uv, create the environment using `python3 -m venv .venv` with Python
3.11 or newer, activate it, and install with
`python -m pip install -r requirements.txt`.
The first training run downloads the pretrained `yolo11n-seg.pt` weights.
For offline training, download the weights beforehand and pass `--model /path/to/yolo11n-seg.pt`.

## Supply images and annotations

**Photos alone are insufficient for this supervised training script.** A person
must first mark which pixels belong to each object. Use an annotation tool that
exports **YOLO instance segmentation polygons**, with the following exact class
order (also provided in `classes.txt`):

| ID | Class | What to outline |
| --- | --- | --- |
| 0 | `guitar` | The visible guitar silhouette, including neck and body when present. |
| 1 | `fretboard` | The visible fingerboard surface. |
| 2 | `fret` | Each visible metal fret wire as its own thin polygon. |
| 3 | `string` | Each visible string over the fretboard as its own narrow polygon. |

Overlapping class outlines are expected: a string lies inside a fretboard, and
the fretboard lies inside a guitar. The trainer keeps these masks independent.
Include partially cropped guitars and close views where only the neck is visible.
Annotate all four classes wherever visible. Do not mark fingers or guess hidden
wire paths. Use the same visible-region convention throughout the dataset. For
disconnected visible portions, use separate polygons consistently; this first
model does not preserve a string's identity across finger occlusions.

Strings and frets need polygons with nonzero width; two-point lines and ordinary
bounding boxes will be rejected. Follow the actual visible thickness as closely
as possible. Very thin strings may disappear when an image is resized; collect
close, sharp neck views, inspect the training previews, and consider a later
fretboard crop plus endpoint/keypoint model for more precise localization.

Put each recording session in its own top-level subfolder:

```text
dataset/
  images/
    session_01/
      frame_001.jpg
      frame_002.jpg
    session_02/
      frame_001.jpg
  labels/
    session_01/
      frame_001.txt
      frame_002.txt
    session_02/
      frame_001.txt
```

Every image needs a matching `.txt` label, with one object per line:

```text
class_id x1 y1 x2 y2 x3 y3 ...
```

Coordinates are normalized: `x / image_width`, `y / image_height`, in `[0, 1]`.
For example, this rectangle is a *single fretboard annotation*:

```text
1 0.20 0.30 0.85 0.35 0.82 0.55 0.18 0.50
```

The remaining objects need their own rows. Class IDs must match the table.
An empty label file explicitly means a reviewed negative image with none of
these classes. A missing label is an error, so unlabeled guitars cannot silently
become negative training examples. If labels sit beside the photos, omit `--labels`.

Start with a few hundred carefully annotated, varied photos as an initial
experiment; the amount needed for accuracy must be measured. Capture the view
looking down at a guitar being played: different hands, finger positions, neck
angles, partial crops, motion blur, lighting, backgrounds, guitar types, and
left- and right-handed players. Include some scenes without guitars. Keep an
entire session or guitar out of training to measure generalization. More frames
from one recording are not equivalent to more independent examples.

## Check the dataset, then train

Prepare a copy and report without downloading or loading a model:

```bash
python train_guitar.py \
  --images dataset/images \
  --labels dataset/labels \
  --output runs/data_check \
  --prepare-only
```

Train with a separate new output folder:

```bash
python train_guitar.py \
  --images dataset/images \
  --labels dataset/labels \
  --output runs/first \
  --epochs 100 \
  --imgsz 960 \
  --batch 4 \
  --device auto
```

`auto` chooses CUDA, then an Apple Metal GPU (`mps`), then CPU. You can explicitly
pass `--device cpu`, `--device mps`, or `--device 0`. CPU training can be slow.
If memory runs out, try `--batch 1` first. `--mask-ratio 2` uses less mask memory;
inspect whether the thinner labels survive. Higher input resolution costs more
memory and inference time. `--imgsz` must be divisible by 32.

By default, 20% of top-level session folders are held out. With just two folders,
one goes into validation. With flat folders, independent photos are split
instead. Nearby video frames must stay in one session folder. The seed makes
the split repeatable for an unchanged dataset; exact duplicate files are rejected.
Both splits must contain all four classes. Keep a third, independent test set
for final evaluation; validation is used during training to select the weights.

To designate your own validation set, add:

```text
--val-images held_out/images --val-labels held_out/labels
```

Every run requires a new `--output` folder and copies the dataset into that
folder. Originals are left intact. `--prepare-only` outputs are review copies;
the training command above prepares its own copy. To fine-tune already learned
weights on more images, pass `--model runs/first/training/weights/best.pt` and a new
output folder. This starts a new optimization run, rather than resuming an
interrupted optimizer state.

Outputs include:

```text
runs/first/
  dataset/data.yaml              # Prepared YOLO dataset
  dataset_report.json            # Counts, input paths, hashes, and split membership
  training/weights/best.pt        # Best checkpoint selected using validation
  training/weights/last.pt        # Last checkpoint
  training/results.csv           # Per-epoch losses and validation metrics
  training/                      # Training/validation preview images and plots
```

Inspect the preview masks before trusting scores. Confirm that individual
strings and fret wires are learned, and evaluate held-out playing videos later.
The pretrained checkpoint supplies general visual features; guitar-specific
recognition depends on your annotations and training results.

## Try a trained model

Save predictions on unseen photos:

```bash
yolo segment predict \
  model=runs/first/training/weights/best.pt \
  source=/path/to/unseen/photos \
  imgsz=960 conf=0.25 retina_masks=True save=True
```

For an initial webcam preview on the development computer:

```bash
yolo segment predict \
  model=runs/first/training/weights/best.pt \
  source=0 imgsz=960 conf=0.25 show=True
```

This preview is useful for assessing the model; latency and stability still need
measurement on the chosen glasses hardware. Ultralytics also provides exports
such as ONNX, Core ML, and TensorRT when a deployment target is chosen.

## Validation and references

Run the dataset preparation tests after installing the requirements:

```bash
python -m unittest discover -s tests -v
```

Reference documentation:
[segmentation models](https://docs.ultralytics.com/tasks/segment/),
[polygon dataset format](https://docs.ultralytics.com/datasets/segment/),
[training settings](https://docs.ultralytics.com/modes/train/),
[deployment/export](https://docs.ultralytics.com/modes/export/), and
[Ultralytics dependency licensing](https://www.ultralytics.com/license).
