"""Local-only JSON/EOF bridge. stdout is reserved for one UTF-8 response."""
import contextlib
import json
import math
import os
from pathlib import Path
import re
import stat
import sys
import uuid

MAX_INPUT = 2 * 1024 * 1024
MAX_US = 2**53 - 1


def fields(value, allowed, label):
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    unknown = set(value) - set(allowed)
    if unknown:
        raise ValueError(f"Unsupported fields in {label}: {', '.join(sorted(unknown))}")


def number(value, label, minimum=0, maximum=MAX_US / 1e6):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a finite number")
    if not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError(f"{label} must be finite and in {minimum}..{maximum}")
    return value


def micros(value, label, positive=False):
    result = round(number(value, label) * 1e6)
    if positive and result <= 0:
        raise ValueError(f"{label} must be positive (at least one microsecond)")
    return result


def local_path(value, directory=False):
    if not isinstance(value, str) or not value or '\x00' in value:
        raise ValueError("path must be a local absolute path")
    # Reject UNC, device paths, URLs and NTFS alternate data streams.
    if value.startswith(('\\\\', '//')) or '://' in value:
        raise ValueError("URLs and UNC/device paths are not supported")
    path = Path(value)
    if not path.is_absolute() or ':' in value[len(path.drive):]:
        raise ValueError("path must be a local absolute path without alternate streams")
    if os.name == 'nt':
        import ctypes
        if ctypes.windll.kernel32.GetDriveTypeW(path.anchor) not in (2, 3, 5, 6):
            raise ValueError("path must be on a local drive")
    # Do not silently follow symlinks/junctions in any component.
    for part in (path, *path.parents):
        info = part.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError(f"Symlink/reparse paths are not supported: {part}")
    if directory and not path.is_dir():
        raise ValueError("outputDir must be an existing ordinary directory")
    if not directory and not path.is_file():
        raise ValueError("media path must be an existing regular file")
    return str(path.resolve())


def media_number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) and result > 0 else None
    except (TypeError, ValueError, OverflowError):
        return None


def probe(value):
    path = local_path(value)
    from pymediainfo import MediaInfo
    if not MediaInfo.can_parse():
        raise ValueError("MediaInfo cannot parse: install a working local MediaInfo library")
    info = MediaInfo.parse(path, mediainfo_options={'File_TestContinuousFileNames': '0'})
    general_duration = next((media_number(t.duration) for t in info.tracks
                             if t.track_type == 'General'), None)
    tracks = []
    for track in info.tracks:
        if track.track_type == 'General':
            continue
        duration = media_number(getattr(track, 'duration', None)) or general_duration
        item = {'type': track.track_type.lower(), 'duration': (duration or 0) / 1000}
        for source, target in (('width', 'width'), ('height', 'height'), ('frame_rate', 'frameRate')):
            val = media_number(getattr(track, source, None))
            if val is not None:
                item[target] = val
        codec = getattr(track, 'codec_id', None) or getattr(track, 'format', None)
        if codec:
            item['codec'] = str(codec)
        tracks.append(item)
    has_video = any(t['type'] == 'video' and t['duration'] > 0 for t in tracks)
    has_audio = any(t['type'] == 'audio' and t['duration'] > 0 for t in tracks)
    if not has_video and not has_audio:
        raise ValueError("Not a supported timed video/audio media file")
    return {'ok': True, 'path': path, 'duration': (general_duration or 0) / 1000
            or max(t['duration'] for t in tracks), 'tracks': tracks,
            'hasVideo': has_video, 'hasAudio': has_audio}


def validate(timeline):
    fields(timeline, ('title', 'width', 'height', 'fps', 'clips', 'audio', 'texts'), 'timeline')
    title = timeline.get('title', 'Untitled')
    if (not isinstance(title, str) or not title.strip() or len(title) > 100
            or re.search(r'[\\/<>:"|?*\x00-\x1f]', title) or title.endswith(('.', ' '))
            or re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', title, re.I)):
        raise ValueError("title must be a safe nonempty filename (maximum 100 characters)")
    normalized = {'title': title}
    for key, default in (('width', 1080), ('height', 1920)):
        value = number(timeline.get(key, default), key, 16, 7680)
        if value % 2:
            raise ValueError(f"{key} must be an even integer")
        normalized[key] = int(value)
    fps = number(timeline.get('fps', 30), 'fps', 24, 60)
    if fps not in (24, 25, 30, 50, 60):
        raise ValueError("fps must be 24, 25, 30, 50 or 60")
    normalized['fps'] = int(fps)
    arrays = {key: timeline.get(key, []) for key in ('clips', 'audio', 'texts')}
    if any(not isinstance(value, list) for value in arrays.values()):
        raise ValueError("clips, audio and texts must be arrays")
    if not arrays['clips']:
        raise ValueError("At least one video clip is required")
    if sum(map(len, arrays.values())) > 500:
        raise ValueError("Maximum 500 timeline entries")
    cache = {}
    plan = {key: [] for key in arrays}
    total = 0
    text_length = 0
    for kind, entries in arrays.items():
        normalized[kind] = []
        for index, entry in enumerate(entries):
            label = f'{kind}[{index}]'
            allowed = {'clips': ('path', 'start', 'duration', 'speed', 'volume'),
                       'audio': ('path', 'start', 'duration', 'at', 'volume'),
                       'texts': ('text', 'start', 'duration', 'fontSize', 'color')}[kind]
            fields(entry, allowed, label)
            start = micros(entry.get('start'), f'{label}.start')
            duration = micros(entry.get('duration'), f'{label}.duration', positive=True)
            if start + duration > MAX_US:
                raise ValueError(f'{label} time range overflows')
            item = dict(entry)
            item.update(start=start / 1e6, duration=duration / 1e6)
            if kind in ('clips', 'audio'):
                path = local_path(entry.get('path'))
                if path not in cache:
                    cache[path] = probe(path)
                media = cache[path]
                track_type = 'video' if kind == 'clips' else 'audio'
                if kind == 'audio' and any(t['type'] == 'video' for t in media['tracks']):
                    raise ValueError(f'{label}: video cannot be BGM; extract audio first (请先提取音频)')
                available = next((t['duration'] for t in media['tracks'] if t['type'] == track_type), 0)
                if available <= 0:
                    raise ValueError(f'{label}: requires a real {track_type} track')
                available_us = round(available * 1e6)
                if start + duration > available_us + 1:
                    raise ValueError(f'{label}: source range exceeds media duration')
                # The library checks source bounds strictly; absorb <=1us rounding noise.
                duration = min(duration, available_us - start)
                if duration <= 0:
                    raise ValueError(f'{label}: no source duration remains')
                item.update(path=path, duration=duration / 1e6,
                            volume=number(entry.get('volume', 1), f'{label}.volume', 0, 4))
                if kind == 'clips':
                    speed = number(entry.get('speed', 1), f'{label}.speed', 0.1, 10)
                    target_duration = round(duration / speed)
                    if target_duration <= 0:
                        raise ValueError(f'{label}: target duration rounds to zero')
                    at = total
                    total += target_duration
                    if total > MAX_US:
                        raise ValueError('Timeline duration overflows')
                    item['speed'] = speed
                else:
                    at = micros(entry.get('at', 0), f'{label}.at')
                    item['at'] = at / 1e6
                    target_duration = duration
            else:
                text = entry.get('text')
                if not isinstance(text, str) or not 1 <= len(text) <= 5000:
                    raise ValueError(f'{label}.text must contain 1..5000 characters')
                text_length += len(text)
                if text_length > 100000:
                    raise ValueError('Maximum 100000 text characters')
                color = entry.get('color', '#FFFFFF')
                if not isinstance(color, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', color):
                    raise ValueError(f'{label}.color must be #RRGGBB')
                item.update(color=color, fontSize=number(entry.get('fontSize', 8), f'{label}.fontSize', 1, 200))
                at, target_duration = start, duration
            if kind != 'clips':
                if at + target_duration > total + 1:
                    raise ValueError(f'{label}: extends past the video end')
                target_duration = min(target_duration, total - at)
                if target_duration <= 0:
                    raise ValueError(f'{label}: starts at or past the video end')
                duration = target_duration
                item['duration'] = duration / 1e6
            normalized[kind].append(item)
            plan[kind].append({'item': item, 'source': start, 'duration': duration,
                               'at': at, 'target': target_duration})
    warnings = ['素材使用本地绝对路径引用；移动或删除素材会导致工程丢失媒体。',
                '剪映草稿格式随版本变化；请在本机剪映中检查兼容性，未保证可直接导入。']
    if any(Path(item['path']).suffix.lower() != '.mp4' for item in normalized['clips']):
        warnings.append('存在非MP4视频；若剪映不兼容，请先转换为MP4。')
    return normalized, plan, total, warnings


def verify_content(path, timeline, total):
    with path.open(encoding='utf-8') as handle:
        content = json.load(handle)
    if content.get('duration') != total:
        raise ValueError('Generated draft duration verification failed')
    tracks = content.get('tracks', [])
    for kind, key in (('video', 'clips'), ('audio', 'audio'), ('text', 'texts')):
        actual = [t for t in tracks if t.get('type') == kind]
        if sum(len(t.get('segments', [])) for t in actual) != len(timeline[key]):
            raise ValueError(f'Generated {kind} segment count verification failed')
        for track in actual:
            end = 0
            for segment in sorted(track['segments'], key=lambda s: s['target_timerange']['start']):
                timerange = segment['target_timerange']
                if timerange['start'] < end or timerange['duration'] <= 0:
                    raise ValueError('Generated track contains overlap or empty segment')
                end = timerange['start'] + timerange['duration']
                if end > total:
                    raise ValueError('Generated track exceeds video end')
    materials = content.get('materials', {})
    for kind, key in (('videos', 'clips'), ('audios', 'audio')):
        actual_paths = {m.get('path') for m in materials.get(kind, [])}
        if not {i['path'] for i in timeline[key]} <= actual_paths:
            raise ValueError('Generated absolute material paths verification failed')
    return content


def build(timeline, output_dir):
    normalized, plan, total, warnings = validate(timeline)
    root = Path(local_path(output_dir, directory=True))
    draft_dir = root / 'draft'
    if os.path.lexists(draft_dir):
        raise ValueError('draft already exists; refusing to overwrite')
    import pyJianYingDraft as draft
    script = draft.DraftFolder(str(root)).create_draft(
        'draft', normalized['width'], normalized['height'], fps=normalized['fps'], allow_replace=False)
    video_track = script.append_track(draft.TrackSpec(draft.TrackType.video, 'video'))
    for entry in plan['clips']:
        item = entry['item']
        segment = draft.VideoSegment(item['path'], draft.Timerange(entry['at'], entry['target']),
                                     source_timerange=draft.Timerange(entry['source'], entry['duration']),
                                     speed=item['speed'], volume=item['volume'])
        script.add_segment(segment, track=video_track)
    for kind in ('audio', 'texts'):
        lanes = []
        for entry in sorted(plan[kind], key=lambda e: e['at']):
            lane = next((lane for lane in lanes if lane['end'] <= entry['at']), None)
            if lane is None:
                track_type = draft.TrackType.audio if kind == 'audio' else draft.TrackType.text
                lane = {'end': 0, 'ref': script.append_track(draft.TrackSpec(track_type, f'{kind}_{len(lanes)}'))}
                lanes.append(lane)
            item = entry['item']
            timerange = draft.Timerange(entry['at'], entry['target'])
            if kind == 'audio':
                segment = draft.AudioSegment(item['path'], timerange,
                                             source_timerange=draft.Timerange(entry['source'], entry['duration']),
                                             volume=item['volume'])
            else:
                color = tuple(int(item['color'][i:i + 2], 16) / 255 for i in (1, 3, 5))
                segment = draft.TextSegment(item['text'], timerange,
                                            style=draft.TextStyle(size=item['fontSize'], color=color,
                                                                  align=1, auto_wrapping=True),
                                            clip_settings=draft.ClipSettings(transform_y=-0.8))
            script.add_segment(segment, track=lane['ref'])
            lane['end'] = entry['at'] + entry['target']
    script.save()
    verify_content(draft_dir / 'draft_content.json', normalized, total)
    # Read only the library-created metadata, never a caller-provided template.
    meta_path = draft_dir / 'draft_meta_info.json'
    with meta_path.open(encoding='utf-8') as handle:
        metadata = json.load(handle)
    metadata.update(draft_id=str(uuid.uuid4()).upper(), draft_name=normalized['title'],
                    draft_fold_path=str(draft_dir), draft_root_path=str(root), tm_duration=total)
    # The 0.3.0 template has cloud/removed timestamps only: preserve their zero/empty values.
    with meta_path.open('w', encoding='utf-8', newline='\n') as handle:
        json.dump(metadata, handle, ensure_ascii=False, indent=2, allow_nan=False)
    with meta_path.open(encoding='utf-8') as handle:
        saved = json.load(handle)
    if saved != metadata:
        raise ValueError('Generated metadata verification failed')
    return {'ok': True, 'draftDir': str(draft_dir), 'title': normalized['title'],
            'duration': total / 1e6, 'warnings': warnings}


def dispatch(request):
    fields(request, ('action', 'path', 'timeline', 'outputDir'), 'request')
    action = request.get('action')
    if action == 'probe':
        fields(request, ('action', 'path'), 'probe request')
        return probe(request.get('path'))
    if action == 'validate':
        fields(request, ('action', 'timeline'), 'validate request')
        timeline, _, total, warnings = validate(request.get('timeline'))
        return {'ok': True, 'timeline': timeline, 'title': timeline['title'],
                'duration': total / 1e6, 'warnings': warnings}
    if action == 'build':
        fields(request, ('action', 'timeline', 'outputDir'), 'build request')
        return build(request.get('timeline'), request.get('outputDir'))
    raise ValueError(f'Unknown action: {action!r}')


def reject_constant(value):
    raise ValueError(f'Nonfinite JSON number: {value}')


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f'Duplicate JSON field: {key}')
        result[key] = value
    return result


def main():
    sys.stdout.reconfigure(encoding='utf-8', errors='backslashreplace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    exit_code = 0
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            raise ValueError('stdin JSON exceeds 2MB')
        request = json.loads(raw.decode('utf-8-sig'), parse_constant=reject_constant,
                             object_pairs_hook=unique_object)
        with contextlib.redirect_stdout(sys.stderr):
            response = dispatch(request)
    except Exception as exc:
        message = f'{type(exc).__name__}: {exc}'
        print(message, file=sys.stderr)
        response = {'ok': False, 'error': message}
        exit_code = 1
    print(json.dumps(response, ensure_ascii=False, allow_nan=False))
    return exit_code


if __name__ == '__main__':
    raise SystemExit(main())
