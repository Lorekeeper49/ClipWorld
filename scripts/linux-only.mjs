// Linux packages must be built on Linux: Windows file systems drop the execute permission, so a Linux
// package made on Windows contains a launcher and ffmpeg that will not run, and the AppImage tools
// only run on Linux and macOS.
if (process.platform === 'win32') {
  console.error('Linux packages have to be built on Linux (or macOS). Copy the project there and run: bash build.sh appimage')
  process.exit(1)
}
