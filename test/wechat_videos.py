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


class VideoFrames(unittest.TestCase):
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
            md5 = hashlib.md5(source.read_bytes()).hexdigest()
            target = folder / (md5 + '.mp4')
            source.replace(target)
            timestamp = 1788307200
            frames = videos.read_video_frames(root, 'test-contact', md5, timestamp, lambda: None)
            self.assertEqual(len(frames), 3)
            self.assertTrue(all(item['data'].startswith('/9j/') for item in frames))
            self.assertIsNone(videos.read_video_frames(root, 'test-contact', '0' * 32, timestamp, lambda: None))
            self.assertEqual(videos.video_reference(f'<msg><videomsg md5="{md5}"/></msg>'), md5)


if __name__ == '__main__':
    unittest.main()
