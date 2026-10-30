#!/usr/bin/env bash
# Builds the small LGPL-only FFmpeg that Viewer Studio uses for formats the WebView can't play (see src-tauri/src/convert.rs).
# Only the `ffmpeg` program, from the official sources, without GPL / non-free parts, network, devices or ffprobe:
# every decoder and container for reading, but only the encoders the app needs.
#
#   ffmpeg/build.sh <target> <out-dir>
#   targets: macos-arm64 | macos-x86_64 | linux-x86_64 | windows (run in an MSYS2 shell: MINGW64, MINGW32 or CLANGARM64)
#
# The result is <out-dir>/ffmpeg(.exe); the release workflow names it viewer-ffmpeg-<rust target triple>.
set -euo pipefail

VERSION=8.1.3
SHA256=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
OPUS=1.5.2
OPUS_SHA256=65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1
VPX=1.15.2
VPX_SHA256=26fcd3db88045dee380e581862a6ef106f49b74b6396ee95c2993a260b4636aa

target=${1:?target}
out=$(mkdir -p "${2:?out dir}" && cd "$2" && pwd)
work=$(mktemp -d)
cd "$work"
jobs=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)

fetch() {   # url sha256 file
  curl -sSfL "$1" -o "$3"
  echo "$2  $3" | sha256sum -c - 2>/dev/null || echo "$2  $3" | shasum -a 256 -c -
}

fetch "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz" "$SHA256" ffmpeg.tar.xz
# The signature of the FFmpeg release key, when gpg is there (CI on Linux).
if command -v gpg >/dev/null; then
  curl -sSfL "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz.asc" -o ffmpeg.tar.xz.asc
  curl -sSfL https://ffmpeg.org/ffmpeg-devel.asc | gpg --batch --import 2>/dev/null
  gpg --batch --verify ffmpeg.tar.xz.asc ffmpeg.tar.xz
fi
tar xf ffmpeg.tar.xz

common=(--disable-doc --disable-ffplay --disable-ffprobe --disable-network --disable-autodetect --disable-avdevice
  --disable-debug --enable-zlib --disable-encoders --disable-muxers --disable-protocols --enable-protocol=file,pipe
  --enable-muxer=mp4,mov,ipod,webm,matroska,image2,null,wav,mp3,flac,ogg,adts,webvtt --disable-indevs --disable-outdevs)
encoders=aac,png,mjpeg,pcm_s16le,webvtt
extra=()

case "$target" in
  macos-*)
    arch=${target#macos-}
    extra=(--enable-videotoolbox --enable-audiotoolbox --arch="$arch" --cc="clang -arch $arch" --extra-ldflags="-arch $arch"
      --extra-cflags="-mmacosx-version-min=11.0" --enable-cross-compile --target-os=darwin)
    encoders+=,h264_videotoolbox
    ;;
  linux-x86_64)
    # libvpx (VP8) and Opus — both BSD-licensed — built as static libraries, so the program needs only glibc.
    deps="$work/deps"
    fetch "https://downloads.xiph.org/releases/opus/opus-$OPUS.tar.gz" "$OPUS_SHA256" opus.tar.gz
    tar xf opus.tar.gz && (cd "opus-$OPUS" && ./configure --prefix="$deps" --disable-shared --enable-static --with-pic \
      --disable-doc --disable-extra-programs >/dev/null && make -j"$jobs" >/dev/null && make install >/dev/null)
    fetch "https://github.com/webmproject/libvpx/archive/refs/tags/v$VPX.tar.gz" "$VPX_SHA256" vpx.tar.gz
    tar xf vpx.tar.gz && (cd "libvpx-$VPX" && ./configure --prefix="$deps" --disable-shared --enable-static --enable-pic \
      --disable-examples --disable-tools --disable-docs --disable-unit-tests --disable-vp9 --enable-vp8 >/dev/null \
      && make -j"$jobs" >/dev/null && make install >/dev/null)
    export PKG_CONFIG_PATH="$deps/lib/pkgconfig"
    extra=(--enable-libvpx --enable-libopus --pkg-config-flags=--static --extra-ldflags="-static-libgcc")
    encoders+=,libvpx_vp8,libopus
    ;;
  windows)
    # MSYS2 (MINGW64 / MINGW32 / CLANGARM64): Media Foundation for H.264, Windows threads, everything linked statically.
    # (gfxcapture: screen capture in C++/WinRT — not needed, and FFmpeg's VERSION file clashes with <version> there.)
    extra=(--enable-mediafoundation --enable-d3d11va --enable-dxva2 --disable-filter=gfxcapture --enable-w32threads --extra-ldflags=-static --pkg-config-flags=--static)
    encoders+=,h264_mf
    command -v gcc >/dev/null || extra+=(--cc=clang --cxx=clang++)   # CLANGARM64 has only clang
    ;;
  *) echo "unknown target $target" >&2; exit 1 ;;
esac

cd "ffmpeg-$VERSION"
./configure --prefix="$work/prefix" "${common[@]}" --enable-encoder="$encoders" "${extra[@]}" | grep -E "^License|^Enabled encoders" -A2
# Stop if anything GPL or non-free got in.
grep -q '#define CONFIG_GPL 0' config.h && grep -q '#define CONFIG_NONFREE 0' config.h || { echo "not LGPL-only" >&2; exit 1; }
make -j"$jobs" >/dev/null
exe=ffmpeg; [ -f ffmpeg.exe ] && exe=ffmpeg.exe
strip "$exe" 2>/dev/null || true
cp "$exe" "$out/"
cp COPYING.LGPLv2.1 "$out/COPYING.LGPLv2.1"
"$out/$exe" -hide_banner -version | head -3
