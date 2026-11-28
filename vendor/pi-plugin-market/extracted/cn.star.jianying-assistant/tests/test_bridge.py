"""Real ffmpeg + MediaInfo + pyJianYingDraft integration tests (scratch only)."""
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid

BRIDGE = Path(__file__).resolve().parents[1] / 'python' / 'bridge.py'


class BridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        scratch = os.environ.get('PI_SCRATCH_DIR')
        if not scratch or not Path(scratch).is_dir():
            raise RuntimeError('PI_SCRATCH_DIR must name an existing scratch directory')
        cls.root = Path(tempfile.mkdtemp(prefix='jy-bridge-中文-', dir=scratch))
        cls.addClassCleanup(shutil.rmtree, cls.root)
        cls.env = os.environ.copy()
        for key in ('TEMP', 'TMP', 'TMPDIR', 'PIP_CACHE_DIR', 'PYTHONPYCACHEPREFIX'):
            cls.env[key] = str(cls.root)
        cls.env.update(PYTHONIOENCODING='utf-8', PYTHONDONTWRITEBYTECODE='1')
        ffmpeg = shutil.which('ffmpeg')
        if not ffmpeg:
            raise RuntimeError('ffmpeg is required for real integration tests')
        cls.videos = [cls.root / '视频一.mp4', cls.root / '视频二.mp4']
        for index, path in enumerate(cls.videos):
            cls.ffmpeg(ffmpeg, '-f', 'lavfi', '-i', f'color=c={"red" if index == 0 else "blue"}:s=160x120:r=30',
                       '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
                       '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
                       '-c:a', 'aac', '-shortest', str(path))
        cls.wav = cls.root / '音乐.wav'
        cls.ffmpeg(ffmpeg, '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000',
                   '-t', '4', '-c:a', 'pcm_s16le', str(cls.wav))

    @classmethod
    def ffmpeg(cls, executable, *args):
        result = subprocess.run([executable, '-hide_banner', '-loglevel', 'error', '-nostdin', *args],
                                capture_output=True, env=cls.env, cwd=cls.root, timeout=30)
        if result.returncode:
            raise RuntimeError(result.stderr.decode('utf-8', errors='replace'))

    def timeline(self):
        return {'title': '中文演示', 'width': 160, 'height': 120, 'fps': 30,
                'clips': [{'path': str(self.videos[0]), 'start': 0.25, 'duration': 2, 'speed': 2, 'volume': 0.4},
                          {'path': str(self.videos[1]), 'start': 0.5, 'duration': 1, 'speed': 0.5, 'volume': 0.8}],
                'audio': [{'path': str(self.wav), 'start': 0.25, 'duration': 1.5, 'at': 0, 'volume': 0.3},
                          {'path': str(self.wav), 'start': 0, 'duration': 1, 'at': 0.5, 'volume': 0.7},
                          {'path': str(self.wav), 'start': 1, 'duration': 1, 'at': 2, 'volume': 1}],
                'texts': [{'text': '你好，剪映', 'start': 0, 'duration': 1.5, 'fontSize': 8, 'color': '#FF8040'},
                          {'text': '重叠字幕', 'start': 0.5, 'duration': 1, 'fontSize': 10, 'color': '#FFFFFF'},
                          {'text': '第三段', 'start': 2, 'duration': 1}]}

    def call(self, request=None, *, raw=None, ok=True):
        if raw is None:
            raw = json.dumps(request, ensure_ascii=False, indent=2).encode('utf-8')
        result = subprocess.run([sys.executable, '-B', str(BRIDGE)], input=raw, capture_output=True,
                                env=self.env, cwd=self.root, timeout=60)
        response = json.loads(result.stdout.decode('utf-8'))
        self.assertIsInstance(response, dict)
        self.assertEqual(result.returncode, 0 if ok else 1, result.stderr.decode('utf-8'))
        self.assertEqual(response['ok'], ok, response)
        if not ok:
            self.assertTrue(response.get('error'))
            self.assertTrue(result.stderr)
        return response

    def build(self, timeline=None, output=None):
        if output is None:
            output = self.root / str(uuid.uuid4())
            output.mkdir()
        response = self.call({'action': 'build', 'timeline': timeline or self.timeline(), 'outputDir': str(output)})
        draft = Path(response['draftDir'])
        self.assertEqual(draft, output / 'draft')
        content = json.loads((draft / 'draft_content.json').read_text(encoding='utf-8'))
        meta = json.loads((draft / 'draft_meta_info.json').read_text(encoding='utf-8'))
        return response, content, meta

    def invalid(self, timeline):
        return self.call({'action': 'validate', 'timeline': timeline}, ok=False)

    def test_probe_video_and_audio(self):
        for path in [*self.videos, self.wav]:
            with self.subTest(path=path.name):
                result = self.call({'action': 'probe', 'path': str(path)})
                self.assertEqual(result['path'], str(path))
                self.assertAlmostEqual(result['duration'], 4 if path == self.wav else 3, delta=0.1)
                self.assertEqual(result['hasVideo'], path != self.wav)
                self.assertTrue(result['hasAudio'])
                if result['hasVideo']:
                    track = next(t for t in result['tracks'] if t['type'] == 'video')
                    self.assertEqual((track['width'], track['height'], track['frameRate']), (160, 120, 30))
                    self.assertTrue(track['codec'])

    def test_validate(self):
        response = self.call({'action': 'validate', 'timeline': self.timeline()})
        self.assertEqual(response['duration'], 3)
        self.assertEqual(response['timeline']['texts'][2]['fontSize'], 8)

    def test_build_content(self):
        response, content, meta = self.build()
        self.assertEqual(response['duration'], 3)
        self.assertEqual(content['duration'], 3000000)
        self.assertEqual(content['canvas_config']['width'], 160)
        self.assertEqual(content['fps'], 30)
        tracks = content['tracks']
        video = next(t for t in tracks if t['type'] == 'video')['segments']
        self.assertEqual([s['source_timerange'] for s in video],
                         [{'start': 250000, 'duration': 2000000}, {'start': 500000, 'duration': 1000000}])
        self.assertEqual([s['target_timerange'] for s in video],
                         [{'start': 0, 'duration': 1000000}, {'start': 1000000, 'duration': 2000000}])
        self.assertEqual([s['speed'] for s in video], [2, 0.5])
        self.assertEqual([s['volume'] for s in video], [0.4, 0.8])
        for kind in ('audio', 'text'):
            selected = [t for t in tracks if t['type'] == kind]
            self.assertEqual(len(selected), 2, 'overlaps need two tracks; later entries must reuse lanes')
            self.assertEqual(sum(len(t['segments']) for t in selected), 3)
            for track in selected:
                end = 0
                for segment in track['segments']:
                    timing = segment['target_timerange']
                    self.assertGreaterEqual(timing['start'], end)
                    end = timing['start'] + timing['duration']
                    self.assertLessEqual(end, 3000000)
        audio = sorted([s for t in tracks if t['type'] == 'audio' for s in t['segments']],
                       key=lambda s: s['target_timerange']['start'])
        self.assertEqual([s['volume'] for s in audio], [0.3, 0.7, 1])
        self.assertEqual(audio[0]['source_timerange'], {'start': 250000, 'duration': 1500000})
        self.assertEqual(audio[1]['target_timerange'], {'start': 500000, 'duration': 1000000})
        materials = content['materials']
        self.assertEqual({m['path'] for m in materials['videos']}, set(map(str, self.videos)))
        self.assertEqual({m['path'] for m in materials['audios']}, {str(self.wav)})
        self.assertEqual({json.loads(m['content'])['text'] for m in materials['texts']},
                         {'你好，剪映', '重叠字幕', '第三段'})
        for track in tracks:
            if track['type'] == 'text':
                for segment in track['segments']:
                    self.assertEqual(segment['clip']['transform']['y'], -0.8)
        self.assertEqual(meta['draft_name'], '中文演示')
        self.assertEqual(meta['draft_fold_path'], response['draftDir'])
        self.assertEqual(meta['draft_root_path'], str(Path(response['draftDir']).parent))
        self.assertEqual(meta['tm_duration'], 3000000)
        self.assertEqual(meta['tm_draft_removed'], 0)
        self.assertEqual(uuid.UUID(meta['draft_id']).version, 4)
        self.assertGreaterEqual(len(response['warnings']), 2)

    def test_metadata_unique(self):
        first = self.build()[2]
        second = self.build()[2]
        self.assertNotEqual(first['draft_id'], second['draft_id'])
        self.assertNotEqual(first['draft_id'], 'BC69C7CD-7C5E-4185-B284-AF3E1047A664')

    def test_no_overwrite(self):
        response, _, _ = self.build()
        draft = Path(response['draftDir'])
        before = {p.name: p.read_bytes() for p in draft.iterdir() if p.is_file()}
        self.call({'action': 'build', 'timeline': self.timeline(), 'outputDir': str(draft.parent)}, ok=False)
        self.assertEqual(before, {p.name: p.read_bytes() for p in draft.iterdir() if p.is_file()})

    def test_missing_and_nonlocal_paths(self):
        for path in (str(self.root / 'missing.mp4'), 'relative.mp4', 'https://example.com/a.mp4',
                     r'\\server\share\a.mp4', str(self.root), str(self.videos[0]) + ':stream'):
            with self.subTest(path=path):
                self.call({'action': 'probe', 'path': path}, ok=False)

    def test_source_bounds(self):
        for kind in ('clips', 'audio'):
            timeline = self.timeline()
            timeline[kind][0].update(start=2.5, duration=2)
            self.assertIn('source range', self.invalid(timeline)['error'])

    def test_video_required_and_audio_type(self):
        timeline = self.timeline()
        timeline['clips'] = []
        self.invalid(timeline)
        timeline = self.timeline()
        timeline['clips'][0]['path'] = str(self.wav)
        self.assertIn('real video', self.invalid(timeline)['error'])
        timeline = self.timeline()
        timeline['audio'][0]['path'] = str(self.videos[0])
        self.assertIn('extract audio first', self.invalid(timeline)['error'])

    def test_image_is_not_video(self):
        image = self.root / 'still.bmp'
        # A valid tiny BMP; no image libraries or external fixtures required.
        import struct
        image.write_bytes(b'BM' + struct.pack('<IHHI', 70, 0, 0, 54)
                          + struct.pack('<IiiHHIIiiII', 40, 2, 2, 1, 24, 0, 16, 0, 0, 0, 0) + bytes(16))
        timeline = self.timeline()
        timeline['clips'][0]['path'] = str(image)
        self.invalid(timeline)

    def test_audio_and_text_past_end(self):
        for kind, key in (('audio', 'at'), ('texts', 'start')):
            timeline = self.timeline()
            timeline[kind][0][key] = 2.5
            self.assertIn('video end', self.invalid(timeline)['error'])

    def test_microsecond_end_tolerance(self):
        timeline = self.timeline()
        timeline['audio'] = [{'path': str(self.wav), 'start': 0, 'duration': 1.000001, 'at': 2}]
        timeline['texts'] = [{'text': '舍入', 'start': 2, 'duration': 1.000001}]
        self.assertEqual(self.build(timeline)[1]['duration'], 3000000)
        timeline['audio'][0]['duration'] = 1.000002
        self.invalid(timeline)

    def test_invalid_numbers(self):
        for field, value in (('speed', 0), ('speed', -1), ('duration', 0), ('start', -1),
                             ('duration', float('inf')), ('volume', float('nan')), ('speed', True)):
            with self.subTest(field=field, value=value):
                timeline = self.timeline()
                timeline['clips'][0][field] = value
                self.invalid(timeline)

    def test_unsupported_fields(self):
        for key in (None, 'clips', 'audio', 'texts'):
            with self.subTest(key=key):
                timeline = self.timeline()
                target = timeline if key is None else timeline[key][0]
                target['execute'] = 'not allowed'
                self.assertIn('Unsupported fields', self.invalid(timeline)['error'])
        self.call({'action': 'probe', 'path': str(self.wav), 'template': 'file.json'}, ok=False)

    def test_maximum_entries(self):
        timeline = self.timeline()
        timeline['clips'] = [copy.deepcopy(timeline['clips'][0]) for _ in range(501)]
        self.assertIn('500', self.invalid(timeline)['error'])

    def test_invalid_shapes_and_text(self):
        for update in ({'width': 161}, {'fps': 29}, {'title': '../escape'}, {'audio': {}}, {'clips': None}):
            timeline = self.timeline()
            timeline.update(update)
            self.invalid(timeline)
        for update in ({'text': ''}, {'color': 'white'}, {'fontSize': 0}):
            timeline = self.timeline()
            timeline['texts'][0].update(update)
            self.invalid(timeline)

    def test_bad_protocol(self):
        for raw in (b'{}', b'{', b'[]', b'{"action":"unknown"}', b'{}\n{}', b'\xff',
                    b'{"action":"probe","action":"build"}', b'{"\\ud800":0}',
                    b' ' * (2 * 1024 * 1024 + 1)):
            with self.subTest(length=len(raw)):
                self.call(raw=raw, ok=False)

    def test_output_directory_validation_and_no_partial_invalid_draft(self):
        for output in (self.root / 'not-created', self.wav):
            self.call({'action': 'build', 'timeline': self.timeline(), 'outputDir': str(output)}, ok=False)
        root = self.root / str(uuid.uuid4())
        root.mkdir()
        timeline = self.timeline()
        timeline['audio'][0]['at'] = 20
        self.call({'action': 'build', 'timeline': timeline, 'outputDir': str(root)}, ok=False)
        self.assertEqual(list(root.iterdir()), [])

    def test_reparse_directory_rejected(self):
        target = self.root / str(uuid.uuid4())
        target.mkdir()
        link = self.root / str(uuid.uuid4())
        if os.name == 'nt':
            result = subprocess.run(['cmd', '/d', '/c', 'mklink', '/J', str(link), str(target)],
                                    capture_output=True, env=self.env, cwd=self.root)
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            link.symlink_to(target, target_is_directory=True)
        try:
            response = self.call({'action': 'build', 'timeline': self.timeline(), 'outputDir': str(link)}, ok=False)
            self.assertIn('Symlink/reparse', response['error'])
            self.assertEqual(list(target.iterdir()), [])
        finally:
            if os.name == 'nt':
                link.rmdir()
            else:
                link.unlink()

    def test_non_mp4_warning(self):
        path = self.root / 'renamed.mov'
        shutil.copyfile(self.videos[0], path)
        timeline = self.timeline()
        timeline['clips'][0]['path'] = str(path)
        result = self.call({'action': 'validate', 'timeline': timeline})
        self.assertTrue(any('非MP4' in warning for warning in result['warnings']))


if __name__ == '__main__':
    unittest.main(verbosity=2)
