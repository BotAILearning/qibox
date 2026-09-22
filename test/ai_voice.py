import importlib.util
import pathlib
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location('voice', pathlib.Path(__file__).resolve().parents[1] / 'server/ai-native-voice.py')
voice = importlib.util.module_from_spec(spec); spec.loader.exec_module(voice)

class VoiceMapping(unittest.TestCase):
    def test_native_conversion_uses_verified_bubble_and_result_only(self):
        layout = {'app':1, 'frame':2, 'message_list':3, 'label':'Fixture'}
        converted = [False]
        ins = Mock(); ins.locate.return_value = layout; ins.bounds.return_value = (0, 0, 800, 400)
        ins._visible_roots.return_value = []; ins.visible.return_value = True; ins.call.return_value = 9
        ins.tree.side_effect = lambda root, **kwargs: ([{'obj':5,'name':'转文字','role':'menu item'}] if root == 1 else
            [{'obj':10,'name':'[语音]','role':'push button','bounds':(60,60,120,40)}] +
            ([{'obj':11,'name':'周六三点可以吗？','role':'text','bounds':(60,110,120,40)}] if converted[0] else []))
        ins.press.side_effect = lambda obj: converted.__setitem__(0, True)
        frame = Mock(); frame.__enter__ = Mock(return_value=frame); frame.__exit__ = Mock(return_value=None)
        frame.direction.side_effect = lambda text, bounds: 'self' if text == '周六见' else 'other'
        adapter = SimpleNamespace(controls=ins, session_identity=True, verify_session=Mock(),
            render=SimpleNamespace(DesktopFrame=lambda _:frame), rows=lambda _:[('周六见',(0,0,800,50)),('[语音]',(0,50,800,60))])
        result = voice.convert(adapter, {'messageId':'b','messages':[
            {'id':'a','text':'周六见','direction':'self'}, {'id':'b','text':'[语音]','direction':'other','type':'voice'}]}, 'account', {'id':'contact','label':'Fixture'})
        self.assertEqual(result['text'], '周六三点可以吗？'); self.assertEqual(result['messageId'], 'b')
        ins.press.assert_called_once_with(5)
        self.assertGreater(adapter.verify_session.call_count, 2)
        self.assertEqual(ins.xtest.XTestFakeButtonEvent.call_args_list[0].args[1], 3)

    def test_matches_incoming_voice_to_unique_suffix(self):
        messages = [{'id':'a', 'direction':'self', 'text':'周六见'}, {'id':'b', 'direction':'other', 'text':'[语音]', 'type':'voice'}, {'id':'c', 'direction':'other', 'text':'[语音]', 'type':'voice'}]
        rows = [{'direction':'self', 'text':'周六见'}, {'direction':'other', 'text':'[语音] 3秒', 'type':'voice'}, {'direction':'other', 'text':'[语音] 5秒', 'type':'voice'}]
        self.assertEqual(voice.align(rows, messages, 'b'), 1)
        self.assertEqual(voice.align(rows, messages, 'c'), 2)
        for target in ['a', 'missing']:
            with self.assertRaises(ValueError): voice.align(rows, messages, target)
        with self.assertRaises(ValueError): voice.align(rows[1:], messages, 'b')
        rows[-1]['direction'] = 'self'
        with self.assertRaises(ValueError): voice.align(rows, messages, 'b')

    def test_unknown_and_failed_results_cannot_be_transcripts(self):
        for text in ['', '[语音]', '语音 3秒', '正在转换…', '转换失败，请重试', '无法识别', '重试', None]:
            self.assertIsNone(voice.transcript(text))
        self.assertEqual(voice.transcript('  周六下午三点？ '), '周六下午三点？')

if __name__ == '__main__': unittest.main()
