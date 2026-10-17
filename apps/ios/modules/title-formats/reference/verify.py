# Checks a reference run's renditions against the source with system ffprobe and ffmpeg. What
# each rendition must hold is worked out from the source and the stream the core says it carries,
# never from what was served:
#   - the picture: every source picture packet, in order, at exactly its time from the first cut;
#   - a sound rendition is checked against the source stream check.c recorded for it in
#     streams.txt, as the core reported it; a rendition with none fails. It must hold
#     every packet of that track from title time 0 on (one within half a frame of 0 may go either
#     way), in order, each within half a frame of its source time. Anything else it holds must be
#     one frame of silence, repeated, only where the source track has no packet within half a
#     frame, and decoding to zero after the first in a row;
#   - a rendition runs without gaps from within one frame of title time 0 to within one frame
#     past the picture's end. One without added silence may instead start or end up to 0.1 s
#     inside, and lack a segment the core refused, but only one where the source track, all of
#     its packets each sounding a frame, has a hole more than 0.1 s inside the title;
#   - each rendition decodes cleanly, AC-3 and E-AC-3 with their CRCs checked.
# A packed MP3 rendition's segments are read as an ID3 transport stream time and raw frames.
#   python3 -I verify.py <source.mkv> <out-folder>
import bisect, glob, hashlib, json, os, re, struct, subprocess, sys

source, folder = sys.argv[1], sys.argv[2]

def probe(args):
    return json.loads(subprocess.run(["ffprobe", "-v", "error", *args, "-of", "json", source],
                                     capture_output=True, text=True, check=True).stdout)

def boxes(b, o, e):
    while o + 8 <= e:
        size, kind = struct.unpack(">I4s", b[o:o + 8]); h = 8
        if size == 1: size = struct.unpack(">Q", b[o + 8:o + 16])[0]; h = 16
        yield kind.decode(), o + h, o + size
        o += size

def fragments(init, names):
    """(seconds, duration in seconds, payload) of every sample of an fMP4 rendition, from its
    boxes: tfdt, each sample's duration (trun, else tfhd's default), size and composition offset."""
    data = open(init, "rb").read(); i = data.find(b"mdhd"); v = data[i + 4]
    scale = struct.unpack(">I", data[i + (24 if v else 16):i + (28 if v else 20)])[0]
    out = []
    for name in names:
        b = open(name, "rb").read()
        for kind, s, e in boxes(b, 0, len(b)):
            if kind != "moof": continue
            for k2, s2, e2 in boxes(b, s, e):
                if k2 != "traf": continue
                ddur = dsize = None; dt = 0
                for k3, s3, e3 in boxes(b, s2, e2):
                    if k3 == "tfhd":
                        fl = int.from_bytes(b[s3 + 1:s3 + 4], "big"); p = s3 + 8
                        if fl & 1: p += 8
                        if fl & 2: p += 4
                        if fl & 8: ddur = struct.unpack(">I", b[p:p + 4])[0]; p += 4
                        if fl & 0x10: dsize = struct.unpack(">I", b[p:p + 4])[0]
                    if k3 == "tfdt":
                        dt = struct.unpack(">Q" if b[s3] else ">I", b[s3 + 4:s3 + (12 if b[s3] else 8)])[0]
                    if k3 == "trun":
                        ver = b[s3]; fl = int.from_bytes(b[s3 + 1:s3 + 4], "big")
                        n = struct.unpack(">I", b[s3 + 4:s3 + 8])[0]; p = s3 + 8; off = s - 8
                        if fl & 1: off += struct.unpack(">i", b[p:p + 4])[0]; p += 4
                        if fl & 4: p += 4
                        for _ in range(n):
                            d, z, c = ddur, dsize, 0
                            if fl & 0x100: d = struct.unpack(">I", b[p:p + 4])[0]; p += 4
                            if fl & 0x200: z = struct.unpack(">I", b[p:p + 4])[0]; p += 4
                            if fl & 0x400: p += 4
                            if fl & 0x800: c = struct.unpack(">i" if ver else ">I", b[p:p + 4])[0]; p += 4
                            out.append(((dt + c) / scale, d / scale, b[off:off + z])); dt += d; off += z
    return out

MP3_KBPS = {3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
            2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]}
MP3_RATES = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]}

def packed(names):
    """(seconds, duration in seconds, payload) of every frame of a packed MP3 rendition: each
    segment's ID3 PRIV transport stream time, then its Layer III frames by their headers."""
    owner = b"com.apple.streaming.transportStreamTimestamp\0"
    out = []
    for name in names:
        b = open(name, "rb").read()
        at = 10 + (b[6] << 21 | b[7] << 14 | b[8] << 7 | b[9]) if b[:3] == b"ID3" else 0
        i = b.find(owner)
        if not 0 < i < at: raise SystemExit(f"{name} has no ID3 transport stream time -> FAIL")
        t = struct.unpack(">Q", b[i + len(owner):i + len(owner) + 8])[0] / 90000
        while at < len(b):
            h = int.from_bytes(b[at:at + 4], "big")
            if h >> 21 != 0x7FF or (h >> 17 & 3) != 1: raise SystemExit(f"{name}: no Layer III frame at {at} -> FAIL")
            version = h >> 19 & 3
            rate = MP3_RATES[version][h >> 10 & 3]
            kbps = MP3_KBPS[3 if version == 3 else 2][h >> 12 & 15]
            length = (144 if version == 3 else 72) * kbps * 1000 // rate + (h >> 9 & 1)
            d = (1152 if version == 3 else 576) / rate
            out.append((t, d, b[at:at + length])); t += d; at += length
    return out

def segments(rendition, ext):
    names = glob.glob(f"{folder}/{rendition}{'-' if rendition != 'v' else ''}*.{ext}")
    return sorted(names, key=lambda n: int(re.findall(r"(\d+)\.\w+$", n)[0]))

def md5(b): return hashlib.md5(b).hexdigest()

def decode(rendition, samples, raw):
    """Decodes the rendition whole: its errors, and its PCM as one channel of 16-bit samples."""
    path = f"/tmp/verify-{os.getpid()}-{rendition}.{'mp3' if raw else 'mp4'}"
    with open(path, "wb") as f:
        if raw: f.write(b"".join(p for _, _, p in samples))
        else:
            f.write(open(f"{folder}/{rendition}.mp4", "rb").read())
            for name in segments(rendition, "m4s"): f.write(open(name, "rb").read())
    out = ["-f", "null", "-"] if rendition == "v" else ["-f", "s16le", "-ac", "1", "-"]
    run = subprocess.run(["ffmpeg", "-v", "error", "-err_detect", "crccheck", "-i", path, *out], capture_output=True)
    os.unlink(path)
    return run.stderr.decode().strip(), run.stdout

# How far inside the title a track that can't be filled may start or end: the core's EDGE_S.
EDGE_S = 0.1

def near(times, t, within):
    """Whether a sorted list of times has one within `within` of `t`."""
    i = bisect.bisect_left(times, t)
    return any(abs(times[j] - t) < within for j in (i - 1, i) if 0 <= j < len(times))

streams = probe(["-show_entries", "stream=index,codec_type,codec_name,profile,sample_rate"])["streams"]
packets = {}
for p in probe(["-show_entries", "packet=stream_index,pts_time,data_hash", "-show_data_hash", "MD5"])["packets"]:
    if p.get("pts_time") is not None:
        packets.setdefault(p["stream_index"], []).append((float(p["pts_time"]), p["data_hash"].split(":")[-1]))
master = open(f"{folder}/main.m3u8").read()
video = next(s for s in streams if s["codec_type"] == "video")
origin = min(t for t, _ in packets[video["index"]])  # the first keyframe: title time 0
ok = True

# The picture: all of it, in order, at exactly its time.
mine = fragments(f"{folder}/v.mp4", segments("v", "m4s"))
theirs = packets[video["index"]]
drift = max(abs(a - b) for a, b in zip(sorted(t for t, _, _ in mine), sorted(t - origin for t, _ in theirs)))
# The title's segments, from the picture's playlist: a refused sound segment's stretch.
lengths = [float(x) for x in re.findall(r"#EXTINF:([\d.]+)", open(f"{folder}/v.m3u8").read())]
cuts = [sum(lengths[:i]) for i in range(len(lengths) + 1)]
picture_end = cuts[-1]
errors, _ = decode("v", mine, False)
good = [md5(p) for _, _, p in mine] == [h for _, h in theirs] and drift <= 0.0005 and not errors
ok &= good
print(f"v {video['codec_name']}: {len(mine)} of {len(theirs)} packets, times within {drift * 1000:.2f} ms, "
      f"decode {'clean' if not errors else 'ERRORS ' + errors[:200]} -> {'ok' if good else 'FAIL'}")

# Which stream of the file each sound rendition carries, as the core reported it to check.c.
carries = {}
if os.path.exists(f"{folder}/streams.txt"):
    carries = {name: int(index) for name, index in (line.split() for line in open(f"{folder}/streams.txt") if line.strip())}
for rendition in re.findall(r'URI="(a\d+)\.m3u8"', master):
    playlist = open(f"{folder}/{rendition}.m3u8").read()
    raw = "#EXT-X-MAP" not in playlist
    listed = len(re.findall(r"#EXTINF", playlist))
    names = segments(rendition, "mp3" if raw else "m4s")
    mine = packed(names) if raw else fragments(f"{folder}/{rendition}.mp4", names)
    # The source track the core says this carries; without that, nothing is checked.
    track = next((s for s in streams if s["index"] == carries.get(rendition) and s["codec_type"] == "audio"), None)
    if not track:
        print(f"{rendition}: no source track known for it -> FAIL"); ok = False; continue
    codec, rate = track["codec_name"], int(track["sample_rate"])
    if not mine:
        print(f"{rendition}: serves no sound -> FAIL"); ok = False; continue
    # The source track's frame length, from its own packets' spacing; for a track of one packet,
    # its codec's frame at the stream's rate (MP3 has MPEG-1's 1152 samples from 32 kHz up).
    source = sorted(t - origin for t, _ in packets[track["index"]])
    steps = sorted(b - a for a, b in zip(source, source[1:]) if b > a)
    if steps:
        frame = steps[len(steps) // 2]
    else:
        he = "HE" in track.get("profile", "")
        samples = {"aac": 2048 if he else 1024, "ac3": 1536, "eac3": 1536,
                   "mp3": 1152 if rate >= 32000 else 576}[codec]
        frame = samples / rate
    half = frame / 2 + 0.0011  # half a frame, and Matroska's tick
    # Where the source track has no sound, from all its packets, each sounding one frame. A
    # segment may be refused only where such a hole lies more than EDGE_S inside the title: a
    # track may start or end that much inside without its segment being refused.
    holes, sounded = [], 0.0
    for t in source:
        if t - sounded > half: holes.append((sounded, t))
        sounded = max(sounded, t + frame)
    if picture_end - sounded > half: holes.append((sounded, picture_end))
    gappy = lambda k: any(max(a, cuts[k], EDGE_S) < min(b, cuts[k + 1], picture_end - EDGE_S) for a, b in holes)
    served = {int(re.findall(r"(\d+)\.\w+$", n)[0]) for n in names}
    refused = [k for k in range(listed) if k not in served]
    allowed = [k for k in refused if gappy(k)]
    # Expected: every packet from title time 0 on, but in segments legitimately refused; one
    # within half a frame of where those start or end may go either way.
    edges = [0.0] + [c for k in allowed for c in (cuts[k], cuts[k + 1])]
    inside = lambda t: t >= -half and not any(cuts[k] + half <= t < cuts[k + 1] - half for k in allowed)
    expected = [(t - origin, h) for t, h in packets[track["index"]] if inside(t - origin)]
    optional = {h for t, h in expected if any(abs(t - e) < half for e in edges)}
    problems, at, kept, added, drift = [], 0, 0, [], 0.0
    for t, d, p in mine:
        h = md5(p)
        while at < len(expected) and expected[at][1] != h and expected[at][1] in optional:
            at += 1
        if at < len(expected) and expected[at][1] == h:
            drift = max(drift, abs(t - expected[at][0])); at += 1; kept += 1
        else:
            added.append((t, d, h))
    missing = [t for t, h in expected[at:] if h not in optional]
    if missing: problems.append(f"{len(missing)} source packets missing, the first at {missing[0]:.3f} s")
    silent = {h for _, _, h in added}
    if len(silent) > 1: problems.append(f"{len(silent)} different added payloads")
    times = sorted(t for t, _ in expected)
    covering = [t for t, _, _ in added if near(times, t, half)]
    if covering: problems.append(f"{len(covering)} added frames where the source has a packet, the first at {covering[0]:.3f} s")
    if drift > half: problems.append(f"time off by {drift * 1000:.2f} ms")
    # Either silence fills every gap, or only a segment with a hole in the source is refused; a
    # track without silence may start or end EDGE_S inside the picture.
    edge = (EDGE_S + 2 * half) if not added else 2 * half
    if added and refused: problems.append("segments refused in a track it fills with silence")
    for k in refused:
        if k not in allowed: problems.append(f"segment {k} missing where the source has sound throughout")
    jumps = [(a[0] + a[1], b[0]) for a, b in zip(mine, mine[1:]) if abs(a[0] + a[1] - b[0]) >= 1e-5]
    unexplained = [a for a, b in jumps
                   if not any(a <= cuts[k] + half and b >= cuts[k + 1] - half for k in allowed)]
    runs = not jumps
    end = mine[-1][0] + mine[-1][1]
    if unexplained: problems.append(f"{len(unexplained)} gaps, the first at {unexplained[0]:.3f} s")
    if 0 not in allowed and mine[0][0] > edge: problems.append(f"starts at {mine[0][0]:.3f} s")
    if listed - 1 not in allowed and not picture_end - edge + 2 * half - 1e-5 <= end <= picture_end + 2 * half:
        problems.append(f"ends at {end:.3f} s, the picture at {picture_end:.3f} s")
    errors, pcm = decode(rendition, mine, raw)
    if errors: problems.append("decode " + errors[:200])
    # Zero PCM over each added frame after the first in a row.
    first, loud, checked = mine[0][0], 0, 0
    for (_, _, p0), (t1, d1, p1) in zip(mine, mine[1:]):
        if md5(p0) in silent and md5(p1) in silent:
            a = round((t1 - first) * rate) * 2
            checked += 1
            loud += any(pcm[a:a + round(d1 * rate) * 2])
    if loud: problems.append(f"{loud} of {checked} added frames decode to sound")
    ok &= not problems
    refused = f", {listed - len(names)} segments refused" if len(names) != listed else ""
    print(f"{rendition} {codec}{' packed' if raw else ''}: track {track['index']}, {kept} of {len(expected)} source packets"
          f" (time within {drift * 1000:.2f} ms), {len(added)} silent frames ({checked} decode to zero), "
          f"{'continuous' if runs else 'with gaps'} {mine[0][0]:.3f}-{end:.3f} s{refused}"
          f" -> {'ok' if not problems else 'FAIL: ' + '; '.join(problems)}")
sys.exit(0 if ok else 1)
