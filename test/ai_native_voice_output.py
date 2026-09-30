"""Native voice delivery/cancellation boundaries; no actual desktop operations."""
import importlib.util
import pathlib
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('voice_output', pathlib.Path(__file__).resolve().parents[1] / 'server/ai-native-voice-output.py')
voice = importlib.util.module_from_spec(spec); spec.loader.exec_module(voice)


class NativeVoiceOutput(unittest.TestCase):
    def test_audio_pipe_is_fully_drained_while_slow_reader_and_guards_run(self):
        data = b'pcm' * 300000
        program = 'import sys,time,hashlib;data=b""\nwhile True:\n chunk=sys.stdin.buffer.read(4096)\n if not chunk:break\n data+=chunk;time.sleep(.002)\nprint(hashlib.sha256(data).hexdigest())'
        child = subprocess.Popen([sys.executable, '-c', program], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        checks = Mock()
        result, _ = voice.communicate_checked(child, data, checks, 5)
        self.assertEqual(result.strip().decode(), voice.hashlib.sha256(data).hexdigest())
        self.assertGreater(checks.call_count, 1)

    def test_audio_cancellation_stops_owned_player_and_finishes_pipe_cleanup(self):
        child = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(30)'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        with self.assertRaisesRegex(RuntimeError, 'cancelled'):
            voice.communicate_checked(child, b'pcm' * 300000, Mock(side_effect=RuntimeError('cancelled')), 5)
        self.assertIsNotNone(child.poll())

    def fixture(self):
        adapter = Mock(); ins = adapter.controls
        adapter.send_pressed = False; adapter.send_confirmed = False; adapter.possibly_written = False
        adapter.editor_text.return_value = ''
        layout = {'app': 1, 'frame': 2, 'editor': 3, 'header': 4, 'label': '已验证目标'}
        state = {'submitted': False, 'cancelled': False}
        ins._visible_roots.return_value = []; ins.string.return_value = layout['label']
        ins.find.side_effect = lambda root, name, *args: {'发语音': 10, '取消': 11, '发送语音': 12}.get(name)
        ins.visible.side_effect = lambda obj: not state['submitted'] and not state['cancelled'] if obj in (11, 12) else True
        def press(obj):
            if obj == 12: state['submitted'] = True
            if obj == 11: state['cancelled'] = True
        ins.press.side_effect = press
        ins._cleanup_budget.side_effect = lambda callback, **kwargs: callback()
        pulse = Mock(); pulse.microphone.return_value = 2; pulse.recording.return_value = [{'index': 7}]
        pulse.play.side_effect = lambda pcm, check: check(True)
        return adapter, layout, state, pulse

    def run_send(self, adapter, layout, pulse):
        with patch.object(voice, 'read_media', return_value=b'generated'), patch.object(voice, 'decode_audio', return_value=b'pcm'), patch.object(voice, 'Pulse', return_value=pulse), patch.object(voice.time, 'sleep'):
            return voice.send(adapter, {}, layout)

    def test_submits_only_verified_native_voice_once_never_file_or_dictation(self):
        adapter, layout, state, pulse = self.fixture()
        self.assertEqual(self.run_send(adapter, layout, pulse), {'status': 'submitted'})
        self.assertTrue(adapter.send_pressed); self.assertTrue(adapter.send_confirmed)
        self.assertEqual([call.args[0] for call in adapter.controls.press.call_args_list], [10, 12])
        self.assertFalse(any(call.args[1] in ('发送文件', '语音输入文字') for call in adapter.controls.find.call_args_list))

    def test_cancelled_playback_cancels_only_own_recording_without_send(self):
        adapter, layout, state, pulse = self.fixture()
        pulse.play.side_effect = RuntimeError('cancelled')
        with self.assertRaises(RuntimeError): self.run_send(adapter, layout, pulse)
        self.assertFalse(adapter.send_pressed)
        with patch.object(voice.time, 'sleep'): self.assertEqual(voice.cleanup(adapter), 'cleared')
        self.assertEqual([call.args[0] for call in adapter.controls.press.call_args_list], [10, 11])

    def test_changed_target_or_popup_never_submits_or_cancels_foreign_recording(self):
        for change in ('target', 'popup'):
            adapter, layout, state, pulse = self.fixture()
            def playback(pcm, check):
                if change == 'target': adapter.controls.string.return_value = '其他目标'
                else: adapter.controls._visible_roots.return_value = [88]
                check(True)
            pulse.play.side_effect = playback
            with self.assertRaisesRegex(ValueError, 'voice recording changed'): self.run_send(adapter, layout, pulse)
            self.assertFalse(adapter.send_pressed)
            self.assertEqual(voice.cleanup(adapter), 'blocked')
            self.assertEqual([call.args[0] for call in adapter.controls.press.call_args_list], [10])

    def test_a_recording_stream_change_cannot_supply_audio_to_another_session(self):
        adapter, layout, state, pulse = self.fixture()
        pulse.recording.side_effect = [[{'index': 7}], [{'index': 9}]]
        with self.assertRaisesRegex(ValueError, 'voice audio unavailable'): self.run_send(adapter, layout, pulse)
        self.assertFalse(adapter.send_pressed)

    def test_a_post_submit_unknown_result_never_repeats_or_cancels_send(self):
        adapter, layout, state, pulse = self.fixture()
        adapter.controls.visible.return_value = True; adapter.controls.visible.side_effect = None
        self.assertEqual(self.run_send(adapter, layout, pulse), {'status': 'uncertain'})
        self.assertEqual(voice.cleanup(adapter), 'blocked')
        self.assertEqual([call.args[0] for call in adapter.controls.press.call_args_list], [10, 12])

    def test_invalid_source_descriptors_fail_before_audio_or_ui(self):
        for value in ({}, {'type': 'image/png'}, {'name': '../../other.mp3', 'type': 'audio/mpeg'}):
            with self.assertRaisesRegex(ValueError, 'invalid voice media'): voice.read_media(value)


if __name__ == '__main__': unittest.main()
