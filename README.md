# ClipWorld

A desktop video editor built on ffmpeg. Electron + TypeScript + React.

While I vow to keep this free forever, your support helps me create many things to help others out with whatever issues they may be dealing with, so if you'd like to donate to me, do so with the following link, it'll mean a lot: https://ko-fi.com/lorekeeper49

## Run it

```bash
npm install
npm run fetch-ffmpeg   # downloads a static ffmpeg 9 for this system (checksum-verified) into vendor/ffmpeg/<platform>-<arch>
npm run dev            # development, with hot reload
```

Needs Node.js 22 or newer. ffmpeg comes from gyan.dev on Windows and from FFmpeg-Builds (static GPL build, x64 or arm64) on Linux.

### Windows

`build.bat` builds `dist\win-unpacked\ClipWorld.exe` and starts it. `build.bat nolaunch` only builds, and `build.bat installer` makes the installer (bundles ffmpeg, registers `.vcws` files). The npm equivalents are `npm run package:dir` and `npm run package`.

### Linux

```bash
bash build.sh            # builds dist/linux-unpacked/clipworld and starts it
bash build.sh nolaunch   # build only
bash build.sh appimage   # ClipWorld-<version>.AppImage and clipworld-<version>.tar.gz in dist/
```

The npm equivalents are `npm run package:linux:dir` and `npm run package:linux`. Build Linux packages on Linux: Windows drops the files' execute permission and cannot make AppImages, so the Linux scripts refuse to run there. Fonts come from `fontconfig`, and hardware encoding (NVENC) is used when the NVIDIA driver supports it. On distributions that block unprivileged sandboxes (e.g. Ubuntu 24.04), an AppImage may need `--no-sandbox` to start; the `.tar.gz` build avoids that.

## Workspace

Six dockable panels. Drag tabs to rearrange, split, tab together or float them. **Window ▸ Reset layout** restores the default layout.

| Panel | What it does |
|---|---|
| **Media** | Import video, audio and images (GIFs included) by button or drag-and-drop. Each video's audio tracks are extracted automatically and listed under it. Deleting an item also removes every clip that uses it. MP4 plays most smoothly: any other video shows **Convert to MP4**, which writes an MP4 next to the original (streams copied without re-encoding when possible), switches the project to it and leaves the original untouched. |
| **Subtitles** | Create subtitle tracks (several per project, each with a name, language and style: font, size, colours, outline, background box, position, line width). Add a subtitle at the playhead with **Shift+T**, set its start/end to the playhead with **[** / **]**, edit times and text in the list. Import SRT, VTT, ASS/SSA, SBV, TTML, SAMI, MicroDVD and LRC files, or a subtitle track inside a video. Export any track to SRT, WebVTT, ASS, SSA, SBV, TTML, SAMI, MicroDVD, LRC or a text transcript. **Add to timeline** puts a track into the video as a clip that can be moved, split, stretched, transformed and given effects; tracks not on the timeline are not exported with the video. |
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

**Optional fast seeking.** If jumping around a video is slow or choppy, click **Optimize for fast seeking** on it in the Media panel. ClipWorld then builds a 720p preview copy with a keyframe every 0.5 s (roughly half a gigabyte per hour of video), in the background, at low priority, in 60-second chunks. The choice is saved in the project and can be stopped or turned off; videos the preview cannot decode at all get the copy automatically. Chunks around the playhead are built first, finished chunks are reused after a restart, and the preview switches to a chunk as soon as it exists. Export always reads the original file. The copy uses NVIDIA NVENC when the driver supports it, otherwise x264. On import, all of a video's audio tracks are extracted in one read of the file.

Each effect is defined once in `src/shared/effects.ts`. Colour filters use the CSS filter-spec maths on both sides, and text and gradient overlays are rasterised by the same canvas code for both, so the export matches the preview.

## Tests

```bash
npm test          # timeline ops, easing, and real-ffmpeg exports checked with ffprobe
npm run test:e2e  # launches the app and drives import → split → stretch → volume → text/effects → save → export
```
