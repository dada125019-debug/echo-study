import json
import os
import re
import sys
import tempfile
import urllib.request
from pathlib import Path

import yt_dlp


PROJECT_ROOT = Path(__file__).resolve().parents[1]
YOUTUBE_COOKIES_FILE = Path(os.environ.get("YOUTUBE_COOKIES_FILE", PROJECT_ROOT / "media-cache" / "youtube-cookies.txt"))
ARGOS_DIR = Path(os.environ.get("ARGOS_PACKAGES_DIR", Path(tempfile.gettempdir()) / "echo-study-argos"))
os.environ.setdefault("XDG_CONFIG_HOME", str(Path(tempfile.gettempdir()) / "echo-study-argos-config"))
os.environ.setdefault("XDG_DATA_HOME", str(Path(tempfile.gettempdir()) / "echo-study-argos-data"))
os.environ.setdefault("XDG_CACHE_HOME", str(Path(tempfile.gettempdir()) / "echo-study-argos-cache"))
os.environ.setdefault("ARGOS_PACKAGES_DIR", str(ARGOS_DIR))
os.environ.setdefault("ARGOS_CHUNK_TYPE", "MINISBD")


def emit(value):
    # ASCII-safe JSON avoids Windows console code-page failures while JSON
    # consumers still receive the original Unicode strings after parsing.
    print(json.dumps(value, ensure_ascii=True))


def clean_text(value):
    return re.sub(r"\s+", " ", (value or "").replace("\ufffd", "")).strip()


def fetch_json(url, headers=None):
    request = urllib.request.Request(url, headers=headers or {"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def youtube_options(options=None):
    merged = dict(options or {})
    if YOUTUBE_COOKIES_FILE.is_file():
        merged["cookiefile"] = str(YOUTUBE_COOKIES_FILE)
    else:
        # Anonymous path: mweb can use the local PO-token provider. The other
        # clients are useful fallbacks for videos that do not require a token.
        youtube_args = merged.setdefault("extractor_args", {}).setdefault("youtube", {})
        youtube_args.setdefault("player_client", ["mweb", "android_vr", "web_embedded"])
    user_agent = os.environ.get("YOUTUBE_USER_AGENT", "").strip()
    if user_agent:
        merged.setdefault("http_headers", {})["User-Agent"] = user_agent
    return merged


def choose_video(info):
    formats = [
        f for f in info.get("formats", [])
        if f.get("url") and f.get("vcodec") not in (None, "none")
        and f.get("acodec") not in (None, "none") and f.get("ext") == "mp4"
        and (f.get("height") or 0) <= 720
    ]
    if not formats:
        formats = [f for f in info.get("formats", []) if f.get("url") and f.get("vcodec") not in (None, "none") and f.get("acodec") not in (None, "none")]
    if not formats:
        raise RuntimeError("没有找到带声音的浏览器兼容视频流")
    formats.sort(key=lambda f: ((f.get("height") or 0), (f.get("tbr") or 0)))
    return formats[-1]


def track_to_cues(entry):
    if not entry:
        return []
    data = fetch_json(entry["url"])
    cues = []
    previous = None
    for event in data.get("events", []):
        segments = event.get("segs") or []
        text = clean_text("".join(seg.get("utf8", "") for seg in segments))
        if not text or text == previous:
            continue
        start = float(event.get("tStartMs", 0)) / 1000
        duration = float(event.get("dDurationMs", 3000)) / 1000
        cues.append({"start": start, "end": start + max(duration, 0.4), "text": text})
        previous = text
    return cues


def choose_json_track(tracks, languages):
    for language in languages:
        entry = next((item for item in tracks.get(language, []) if item.get("ext") == "json3"), None)
        if entry:
            return entry
    return None


def caption_cues(info):
    tracks = info.get("subtitles") or {}
    source = "manual"
    if not tracks:
        tracks = info.get("automatic_captions") or {}
        source = "youtube-asr"
    english_track = choose_json_track(tracks, ["en", "en-US", "en-GB"])
    chinese_track = choose_json_track(tracks, ["zh-Hans", "zh-CN", "zh"])
    if not english_track:
        return [], None
    english_cues = track_to_cues(english_track)
    try:
        chinese_cues = track_to_cues(chinese_track)
    except Exception:
        # YouTube frequently rate-limits translated caption tracks. English
        # captions must remain usable while local translation takes over.
        chinese_cues = []
    cues = []
    for index, english in enumerate(english_cues):
        translated = ""
        if index < len(chinese_cues):
            candidate = chinese_cues[index]
            if abs(candidate["start"] - english["start"]) < 2.5:
                translated = candidate["text"]
        if not translated and chinese_cues:
            candidate = min(chinese_cues, key=lambda item: abs(item["start"] - english["start"]))
            if abs(candidate["start"] - english["start"]) < 1.2:
                translated = candidate["text"]
        cues.append({"start": english["start"], "end": english["end"], "en": english["text"], "zh": translated})
    return cues, source


def ensure_argos_package():
    if any(ARGOS_DIR.glob("translate-en_zh-*")):
        return
    from argostranslate import package

    ARGOS_DIR.mkdir(parents=True, exist_ok=True)
    package.update_package_index()
    available = package.get_available_packages()
    english_chinese = next((item for item in available if item.from_code == "en" and item.to_code == "zh"), None)
    if english_chinese is None:
        raise RuntimeError("没有可用的英译中模型")
    package.install_from_path(english_chinese.download())


def translate_cues(input_path, output_path):
    ensure_argos_package()
    from argostranslate import translate

    source = json.loads(Path(input_path).read_text(encoding="utf-8"))
    output = Path(output_path)
    cached = []
    if output.exists():
        try:
            cached = json.loads(output.read_text(encoding="utf-8")).get("cues", [])
        except Exception:
            cached = []

    translator = translate.get_translation_from_codes("en", "zh")
    if translator is None:
        raise RuntimeError("本地英译中模型未安装")

    cues = []
    for index, cue in enumerate(source):
        item = {
            "start": cue.get("start", 0),
            "end": cue.get("end", 0),
            "en": clean_text(cue.get("en", "")),
            "zh": clean_text(cue.get("zh", "")),
        }
        if not item["zh"] and index < len(cached) and cached[index].get("en") == item["en"]:
            item["zh"] = clean_text(cached[index].get("zh", ""))
        if not item["zh"] and item["en"]:
            item["zh"] = clean_text(translator.translate(item["en"]))
        cues.append(item)
        if index and index % 25 == 0:
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps({"cues": cues}, ensure_ascii=False), encoding="utf-8")

    result = {"cues": cues, "source": "local-argos-en-zh"}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    return result


def inspect_video(url):
    options = youtube_options({"quiet": True, "no_warnings": True, "skip_download": True, "noplaylist": True})
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(url, download=False)
    video = choose_video(info)
    cues, subtitle_source = caption_cues(info)
    return {
        "id": info.get("id"),
        "title": info.get("title") or info.get("id"),
        "duration": info.get("duration"),
        "videoUrl": video["url"],
        "headers": video.get("http_headers") or {},
        "cues": cues,
        "subtitleSource": subtitle_source,
    }


def search_videos(query):
    options = youtube_options({
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": True,
        "noplaylist": False,
    })
    with yt_dlp.YoutubeDL(options) as ydl:
        result = ydl.extract_info(f"ytsearch12:{query}", download=False)
    items = []
    for entry in result.get("entries", []) or []:
        video_id = entry.get("id")
        if not video_id:
            continue
        thumbnails = entry.get("thumbnails") or []
        thumbnail = entry.get("thumbnail") or (thumbnails[-1].get("url") if thumbnails else "")
        items.append({
            "id": video_id,
            "provider": "youtube",
            "title": entry.get("title") or video_id,
            "creator": entry.get("channel") or entry.get("uploader") or "YouTube",
            "duration": entry.get("duration"),
            "thumb": thumbnail or f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
        })
    return {"items": items}


def transcribe(url, cache_root):
    from faster_whisper import WhisperModel

    cache_dir = Path(cache_root).resolve()
    cache_dir.mkdir(parents=True, exist_ok=True)
    options = youtube_options({
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "format": "bestaudio[ext=m4a]/bestaudio/best",
        "outtmpl": str(cache_dir / "audio.%(ext)s"),
    })
    existing = next(cache_dir.glob("audio.*"), None)
    if existing is None:
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=True)
            expected = Path(ydl.prepare_filename(info))
        existing = expected if expected.exists() else next(cache_dir.glob("audio.*"), None)
    if existing is None:
        raise RuntimeError("音频下载失败")

    model = WhisperModel("tiny.en", device="cpu", compute_type="int8")
    segments, _ = model.transcribe(str(existing), language="en", vad_filter=True, beam_size=5)
    cues = []
    for segment in segments:
        text = clean_text(segment.text)
        if text:
            cues.append({"start": segment.start, "end": segment.end, "en": text, "zh": ""})
    return {"cues": cues, "source": "local-whisper"}


def main():
    if len(sys.argv) < 3:
        raise RuntimeError("参数不足")
    command, url = sys.argv[1], sys.argv[2]
    if command == "inspect":
        emit(inspect_video(url))
    elif command == "search":
        emit(search_videos(url))
    elif command == "transcribe":
        if len(sys.argv) < 4:
            raise RuntimeError("缺少缓存目录")
        emit(transcribe(url, sys.argv[3]))
    elif command == "translate":
        if len(sys.argv) < 4:
            raise RuntimeError("缺少翻译输入或缓存路径")
        emit(translate_cues(url, sys.argv[3]))
    else:
        raise RuntimeError("未知命令")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=True))
        sys.exit(1)
