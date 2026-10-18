# Bundled decoder fixtures

These synthetic clips contain twelve 96 × 64 test frames at 10 fps, with no audio or private media.
The release checks decode every frame using the target's bundled ffprobe, convert through the
bundled FFmpeg to H.264, then decode all twelve resulting frames. No system decoder can satisfy
that check. VP9 and AV1 each include MP4 and Matroska/WebM coverage. VP8 uses WebM. The 10-bit inputs exercise the software conversion path; they do not promise HDR.

Generated with FFmpeg 6.1.1 and its distro encoders:

```sh
ffmpeg -f lavfi -i testsrc2=size=96x64:rate=10 -frames:v 12 -an -c:v libvpx -deadline realtime -cpu-used 8 -pix_fmt yuv420p vp8.webm
ffmpeg -f lavfi -i testsrc2=size=96x64:rate=10 -frames:v 12 -an -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -lossless 1 -pix_fmt yuv420p10le vp9-10bit.mp4
ffmpeg -f lavfi -i testsrc2=size=96x64:rate=10 -frames:v 12 -an -c:v libaom-av1 -cpu-used 8 -crf 40 -b:v 0 -row-mt 1 -pix_fmt yuv420p10le av1-10bit.mkv
ffmpeg -i vp9-10bit.mp4 -map 0:v:0 -c copy vp9-10bit.webm
ffmpeg -i av1-10bit.mkv -map 0:v:0 -c copy av1-10bit.mp4
```

Container metadata and encoder revisions can change the bytes when regenerating. The check
asserts the codec, pixel format, dimensions and complete decoded frame count, not an encoder hash.
