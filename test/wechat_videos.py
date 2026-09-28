import hashlib
import importlib.util
import pathlib
import shutil
import subprocess
import tempfile
import unittest

module_path = pathlib.Path(__file__).resolve().parents[1] / 'server' / 'wechat-videos.py'
spec = importlib.util.spec_from_file_location('qibox_test_videos', module_path)
videos = importlib.util.module_from_spec(spec)
spec.loader.exec_module(videos)
reader_spec = importlib.util.spec_from_file_location('qibox_test_wechat_data', module_path.with_name('wechat-data.py'))
reader = importlib.util.module_from_spec(reader_spec)
reader_spec.loader.exec_module(reader)


class VideoFrames(unittest.TestCase):
    def test_historical_media_uses_exact_message_second(self):
        self.assertEqual(reader.read_bounds({'action': 'read-video', 'timestamp': 1788307200})[0], (1788307200, 1788307201))
        self.assertEqual(reader.read_bounds({'action': 'read-image', 'timestamp': 1788307200})[0], (1788307200, 1788307201))
        self.assertIsNone(reader.read_bounds({'action': 'read-video'})[0])
        with self.assertRaises(ValueError):
            reader.read_bounds({'action': 'read-video', 'timestamp': '1788307200'})

    def test_message_hash_binds_local_file_and_extracts_three_frames(self):
        if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
            self.skipTest('local ffmpeg unavailable')
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            month = '2026-09'
            folder = root / 'msg' / 'video' / month
            folder.mkdir(parents=True)
            source = root / 'sample.mp4'
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=2', '-t', '3', '-c:v', 'mpeg4', str(source)], check=True, timeout=15)
            size = source.stat().st_size
            md5 = hashlib.md5(source.read_bytes()).hexdigest()
            target = folder / ('1' * 32 + '.mp4')
            source.replace(target)
            timestamp = 1788307200
            reference = videos.video_reference(f'<msg><videomsg md5="{md5}" length="{size}"/></msg>')
            frames = videos.read_video_frames(root, 'test-contact', reference, timestamp, lambda: None)
            self.assertEqual(len(frames), 3)
            self.assertTrue(all(item['data'].startswith('/9j/') for item in frames))
            self.assertIsNone(videos.read_video_frames(root, 'test-contact', [('0' * 32, size)], timestamp, lambda: None))
            self.assertIsNone(videos.read_video_frames(root, 'test-contact', [(md5, size + 1)], timestamp, lambda: None))
            self.assertEqual(reference, [(md5, size)])


if __name__ == '__main__':
    unittest.main()
