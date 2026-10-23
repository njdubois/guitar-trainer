# Fretboard Studio

A React frontend and Node/Express backend for annotating guitar AR training
images. Run it directly on your computer or a server with Node.js. No database
or container service is required.

## Run locally

Requires Node.js 22.12 or newer.

```bash
cd /Users/nickdubois/www/PersonalProjects/new_guitar_ar/annotation-tool
npm install
npm run dev
```

Open **http://localhost:3001**. Your browser asks for HTTP Basic credentials:

- Username: **annotator**
- Password: **guitar-ar**

Authentication is checked by the backend for the frontend, API, images, and
exports. The frontend and backend share one port. Vite provides React hot
reloading during development.

## Annotate images

1. Enter a recording session name, such as `session-01`. Keep photos from the
   same recording session together so training can hold out entire sessions.
2. Upload one or more JPG, PNG, or WebP images, or drop them into the editor.
   Uploads are limited to 20 MB and 50 megapixels per image. Duplicate images
   are rejected.
3. Choose a label, click points around its outline, then press **Enter** or
   **Finish polygon**. Zoom in to trace both sides of thin wires and strings.
4. Repeat for all visible target parts. Use separate polygons for visible
   sections separated by fingers or other occlusions. Overlapping class
   outlines are expected.
5. Choose **Select and edit points** or click a region in the right sidebar.
   Drag its points to refine it; the sidebar also supports relabeling and
   deleting the selected region.
6. Click **Save draft** to save work in progress. Click **Review & save** after
   checking all visible parts. An edit clears review status until reviewed again.
7. Click **Export dataset** to download reviewed images and matching labels.

| Training ID | Label | Outline |
| --- | --- | --- |
| 0 | `guitar` | The visible instrument silhouette, including its neck. |
| 1 | `fretboard` | The fingerboard surface. |
| 2 | `fret` | Each visible metal fret wire separately. |
| 3 | `string` | Each visible string over the fretboard separately. |

The number keys **1–4** select these labels; exported IDs are **0–3**. Fret
numbers and string identities are not assigned by this first model.

For a reviewed photo with no visible target parts, check **No guitar parts in
this image**, then review and save. It exports with an explicit empty label
file. Unfinished images are excluded from exports.

### Controls

| Action | Control |
| --- | --- |
| Select label | `1`, `2`, `3`, `4` |
| Draw polygon | `P` |
| Select / edit points | `V` |
| Pan | Hold `Space`, middle-drag, or choose `H` |
| Zoom | Mouse wheel or toolbar buttons |
| Fit image | `F` |
| Finish polygon | `Enter` |
| Cancel polygon / selection | `Escape` |
| Remove last unfinished point | `Backspace` |
| Delete selected polygon | `Delete` / `Backspace` |
| Undo / redo | `Ctrl/⌘ Z` / `Ctrl/⌘ Shift Z` |
| Save | `Ctrl/⌘ S` |
| Previous / next image | Left / right arrow |

Changes are saved explicitly. Navigating away from unsaved work asks before
discarding it. Revision checks prevent an older tab overwriting a newer save.

## Use the export with the Python trainer

The ZIP preserves session folders:

```text
images/session-01/<image-id>.png
labels/session-01/<image-id>.txt
classes.txt
annotations.json
README.txt
```

Each label file uses the exact YOLO segmentation format and class order expected
by `../train_guitar.py`. Images are stored at full resolution as lossless PNGs,
with camera orientation applied before annotation. The image used for labeling
is the same image included in the export. `annotations.json` also retains the
editor's region data and original filenames; JSON re-import is not implemented.

After extracting the ZIP, run from `new_guitar_ar`:

```bash
python train_guitar.py \
  --images /path/to/extracted/images \
  --labels /path/to/extracted/labels \
  --output runs/annotated-check \
  --prepare-only
```

Then train with a new output folder and omit `--prepare-only`. The trainer
requires at least two independent sessions for automatic folder splitting and
examples of all four classes in both training and validation. Use an explicitly
held-out validation folder if you organize your split yourself.

## Host on your server

For Ubuntu with Apache, run the deployment script from your server checkout:

```bash
sudo bash deploy.sh
```

It asks for a hostname and certificate email, builds the app, configures Apache
and systemd, and enables HTTPS. A new install generates a login password;
updates preserve your credentials and uploads. The hostname must already point
to the server, with incoming ports 80 and 443 allowed.

See [LINUX-SETUP.md](LINUX-SETUP.md) for options, file locations, and redeployment.
The following instructions are an alternative manual setup.

Deploy this entire `annotation-tool` directory to a server with Node.js, then:

```bash
npm ci
npm run build
cp .env.example .env
```

Edit `.env` with the username, password, port, and persistent storage path you
want. For example:

```dotenv
PORT=3001
HOST=127.0.0.1
BASIC_AUTH_USER=annotator
BASIC_AUTH_PASSWORD=your-password
DATA_DIR=/srv/guitar-annotations
```

Create the data directory and make it writable by the account running Node.
Then start the production app:

```bash
npm start
```

Use your hosting provider's process manager, systemd, or PM2 to keep that
command running. Set up an HTTPS domain that proxies to port 3001. Preserve the
original `Host` header and allow uploads of at least 20 MB. If Node is in a
different network environment from the proxy, set `HOST=0.0.0.0` as appropriate.
Use HTTPS for the public website so Basic credentials are encrypted in transit.

Enable Apache's `proxy`, `proxy_http`, `headers`, `ssl`, and `rewrite` modules.
A virtual host for a dedicated domain or subdomain can look like:

```apache
<VirtualHost *:80>
    ServerName annotations.yourdomain.com
    ProxyRequests Off
    ProxyPreserveHost On
    LimitRequestBody 22020096
    ProxyPass "/.well-known/acme-challenge/" "!"
    ProxyPass "/" "http://127.0.0.1:3001/"
    ProxyPassReverse "/" "http://127.0.0.1:3001/"
</VirtualHost>
```

Use Certbot's Apache integration to configure the HTTPS certificate and redirect.
The complete template is in `deploy/apache.conf`.

The app serves from the domain root. Serve the production build through Node;
the React build alone does not provide the upload and annotation API. Hosted
platforms can use `npm ci && npm run build` as their build command and `npm start`
as their start command, with a persistent disk mounted at `DATA_DIR`.

Run **one Node process** for this file-backed version. Multiple browser tabs
are supported, with conflicts reported explicitly; running multiple server
replicas against the same files is not supported.

## Storage and backups

By default the app writes to `annotation-tool/data/`. `DATA_DIR` can move this
outside the deployed source directory so redeployments preserve your work.

```text
data/
  images/       # Full-resolution, oriented PNG images
  thumbnails/   # Library previews
  records/      # Annotation JSON, sessions, review status, revisions
```

Back up this complete folder. Exporting downloads a dataset copy; it does not
remove stored images. Deleting an image from the UI removes its server copy
and its annotations after confirmation.

## Verification

```bash
npm test
npm run build
npm run test:browser
```

The eight API integration tests cover authentication, decoded uploads, camera
orientation, duplicate detection, explicit negatives, invalid polygons, save
conflicts, persistence, export contents, cross-site requests, and deletion.
Deployment tests also cover configuration preservation, storage migration,
Apache conflicts, build failures, service rollback, and HTTPS setup commands.

Browser verification covers upload, four labels, thin polygons, point dragging,
undo/redo, review, reload, zoom, export, keyboard guide dismissal, and mobile
layout. It uses installed Chrome on macOS when available. Otherwise install
the Playwright browser with `npx playwright install chromium`, or set
`PLAYWRIGHT_CHANNEL` to an installed browser channel. Screenshots go into
`test-results/browser/`.

To additionally check exported files with the Python trainer, set
`TRAINING_PYTHON` to the Python executable with the trainer's dependencies
installed when running `npm run test:browser`. Test uploads are synthetic and
isolated from the app's real data.
