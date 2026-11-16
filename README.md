# ClipWorld

A desktop video editor built on ffmpeg. Electron + TypeScript + React.

## Run it

```bash
npm install
npm run fetch-ffmpeg   # downloads ffmpeg 9 (gyan.dev build, checksum-verified) into vendor/ffmpeg
npm run dev            # development, with hot reload
```

Build a Windows installer (bundles ffmpeg, registers `.vcws` files): `npm run package` → `dist/`.
`npm run package:dir` builds an unpacked app in `dist/win-unpacked/` without the installer.

## Workspace

Six dockable panels. Drag tabs to rearrange, split, tab together or float them. **Window ▸ Reset layout** restores the default layout.

| Panel | What it does |
|---|---|
| **Media** | Import video, audio and images (GIFs included) by button or drag-and-drop. Each video's audio tracks are extracted automatically and listed under it. Deleting an item also removes every clip that uses it. |
| **Preview** | Always fits the video frame. Transport controls and a 0–100% preview volume that never affects the export. |
| **Timeline** | Split at the playhead (**Split** button or Ctrl+K), copy/cut/paste/duplicate, snapping, Ctrl+wheel zoom. **Dragging a clip's edge changes its speed** so the clip fills the new length, audio included. Alt+drag an edge to trim instead. |
| **Tools** | Text (any installed font, size, bold/italic, fill, outline colour and width), zoom on video (start/end, focal point, easing), transform (position, scale, rotation, opacity, start/end with easing), clip speed, and stackable filters and effects. |
| **Metadata** | Export resolution and frame rate, applied live. Source-file details. |
| **Audio** | The audio tracks of the selected video, each with its own 0–500% volume, mute and level meter. |

**Filters & effects.** Video: brightness, contrast, saturation, hue, black & white, sepia, invert, colour tint, gradient, blur, sharpen, pixelate, vignette, film grain, drop shadow, chroma key, flip, fade in/out. Audio: pitch shift, distortion, bitcrusher, echo, reverb, low-pass, high-pass, bass, treble, tremolo, fade in/out. Stack as many as you like, reorder them and toggle each one.

## Files and export

- Projects save as `.vcws` (JSON). Media is stored by absolute path plus a path relative to the project, so a project moved together with its media still opens. Missing files can be relinked from the Media panel. Unsaved work is autosaved for crash recovery.
- **File ▸ Export…** or **Ctrl+Shift+E**: MP4, MKV, MOV, WebM, AVI, GIF, plus audio-only MP3, WAV, FLAC, Ogg and M4A. Codecs are H.264, H.265, VP9, AV1, ProRes and MPEG-4, with NVIDIA NVENC / Intel Quick Sync when the GPU supports them. Audio can be mixed into one track or kept as separate tracks.
- Every shortcut can be changed in **Edit ▸ Keyboard shortcuts…**.

## How it works

The project model (`src/shared/model.ts`) has two renderers:

- **Preview:** canvas compositor + Web Audio graph (`src/renderer/engine/`).
- **Export:** an ffmpeg `filter_complex` graph (`src/shared/filtergraph.ts`).

Each effect is defined once in `src/shared/effects.ts`. Colour filters use the CSS filter-spec maths on both sides, and text and gradient overlays are rasterised by the same canvas code for both, so the export matches the preview.

## Tests

```bash
npm test          # timeline ops, easing, and real-ffmpeg exports checked with ffprobe
npm run test:e2e  # launches the app and drives import → split → stretch → volume → text/effects → save → export
```
