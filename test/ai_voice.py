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
        ins.string.side_effect = lambda name, obj: '语音3秒' if name == 'get_name' and obj == 9 else ''
        ins.tree.side_effect = lambda root, **kwargs: ([{'obj':5,'name':'转文字','role':'menu item'}] if root == 1 else
            [{'obj':10,'name':'语音3秒','role':'push button','bounds':(60,60,120,40)}] +
            ([{'obj':11,'name':'周六三点可以吗？','role':'text','bounds':(60,110,120,40)}] if converted[0] else []))
        ins.press.side_effect = lambda obj: converted.__setitem__(0, True)
        frame = Mock(); frame.__enter__ = Mock(return_value=frame); frame.__exit__ = Mock(return_value=None)
        frame.direction.side_effect = lambda text, bounds: 'self' if text == '周六见' else 'other'
        adapter = SimpleNamespace(controls=ins, session_identity=True, verify_session=Mock(),
            render=SimpleNamespace(DesktopFrame=lambda _:frame),
            rows=lambda _:[('周六见',(0,0,800,50)),('语音3秒',(0,50,800,60))])
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

    def test_virtualized_voice_growth_allows_only_verified_head_truncation(self):
        baseline = [
            {'direction':'self', 'text':'较早内容', 'obj':0},
            {'direction':'system', 'text':'10:16', 'obj':1},
            {'direction':'other', 'text':'语音9"秒未播放', 'type':'voice', 'obj':2},
            {'direction':'self', 'text':'10:17', 'obj':3},
            {'direction':'other', 'text':'锚点消息', 'obj':4},
            {'direction':'other', 'text':'语音11"秒未播放', 'type':'voice', 'obj':5},
        ]
        intermediate = [
            ('语音9"秒',(301,300,978,93)),
            ('10:17',(301,350,978,50)),
            ('锚点消息',(301,400,978,50)),
            ('语音11"秒这是正确的长转写',(301,450,978,150)),
        ]
        self.assertEqual(voice.rebase_visible_rows(intermediate, baseline, 5, 81, [2,3,4,5]), 3)
        completed = [
            ('语音9"秒另一个完整转录',(301,300,978,120)),
            ('10:17',(301,350,978,50)),
            ('锚点消息',(301,400,978,50)),
            ('语音11"秒这是正确的长转写',(301,450,978,150)),
        ]
        self.assertEqual(voice.rebase_visible_rows(completed, baseline, 5, 81, [2,3,4,5]), 3)
        for changed in [
            ([('语音9"秒另一个完整转录',(301,300,978,50)), ('10:17',(301,350,978,50)), ('锚点消息',(301,400,978,50)), ('语音11"秒这是正确的长转写',(301,450,978,150))], [99,3,4,5]),
            ([('语音9"秒另一个完整转录',(301,300,978,50)), ('10:17',(301,350,978,50)), ('锚点消息',(301,400,978,50)), ('语音11"秒这是正确的长转写',(301,450,978,150))], [2,3,4,99]),
            ([('语音8"秒',(301,300,978,93)), ('10:17',(301,350,978,50)), ('锚点消息',(301,400,978,50)), ('语音11"秒这是正确的长转写',(301,450,978,150))], [2,3,4,5]),
            ([('语音9"秒另一个完整转录',(301,300,978,50)), ('10:18',(301,350,978,50)), ('锚点消息',(301,400,978,50)), ('语音11"秒这是正确的长转写',(301,450,978,150))], [2,3,4,5]),
            ([('10:16',(301,300,978,50)), ('语音3"秒另一条语音已转写',(301,350,978,50)), ('10:17',(301,400,978,50)), ('锚点消息',(301,450,978,50)), ('语音11"秒未播放',(301,500,978,57)), ('语音4"秒新消息',(301,557,978,57))], [1,2,3,4,5,9]),
            ([('较早内容',(301,250,978,50)), ('10:16',(301,300,978,50)), ('语音3"秒测试一下，测试一下。',(301,350,978,50)), ('语音11"秒未播放',(301,400,978,57)), ('10:17',(301,457,978,50)), ('锚点消息',(301,507,978,50))], [0,1,2,5,3,4]),
        ]:
            with self.assertRaises(ValueError):
                voice.rebase_visible_rows(changed[0], baseline, 5, 81, changed[1])
        converted_baseline = [dict(row) for row in baseline]
        converted_baseline[2]['text'] = '语音9"秒原始完整转录'
        rewritten = list(completed)
        rewritten[0] = ('语音9"秒被改写的另一段',(301,300,978,120))
        with self.assertRaises(ValueError):
            voice.rebase_visible_rows(rewritten, converted_baseline, 5, 81, [2,3,4,5])
        with self.assertRaises(ValueError):
            voice.rebase_visible_rows([('语音11"秒这是正确的长转写',(301,450,978,150))],
                                      [{'direction':'other','text':'语音11"秒未播放','type':'voice','obj':5}], 0, 81, [5])

    def test_unknown_and_failed_results_cannot_be_transcripts(self):
        for text in ['', '[语音]', '语音 3秒', '正在转换…', '转换失败，请重试', '无法识别', '未播放', '播放中', '重试', None]:
            self.assertIsNone(voice.transcript(text))
        self.assertTrue(voice.voice_row('语音11"秒未播放'))
        self.assertTrue(voice.voice_row('语音11"秒播放中'))
        self.assertFalse(voice.voice_row('未播放'))
        for text in ['语音3"秒', '语音3″秒', '语音3秒']:
            self.assertIsNone(voice.converted_transcript(text))
        self.assertEqual(voice.converted_transcript('语音3"秒秒'), '秒')
        self.assertEqual(voice.converted_transcript('语音3"秒他说“秒”，不是“分”'), '他说“秒”，不是“分”')
        self.assertEqual(voice.converted_transcript('语音3"秒测试一下，测试一下'), '测试一下，测试一下')
        self.assertEqual(voice.transcript('  周六下午三点？ '), '周六下午三点？')

    def test_row_only_bubble_uses_measured_incoming_pixels_and_row_name_result(self):
        layout = {'app':1, 'frame':2, 'message_list':3, 'label':'Fixture'}
        original = '语音11"秒未播放'; converted = [False]
        ins = Mock(); ins.locate.return_value = layout; ins.bounds.return_value = (301, 81, 978, 578)
        ins._visible_roots.return_value = []; ins.visible.return_value = True
        ins.string.side_effect = lambda name, obj: ('语音11"秒你好' if converted[0] else original) if name == 'get_name' and obj == 12 else ''
        ins.tree.side_effect = lambda root, **kwargs: ([{'obj':5,'name':'语音转文字','role':'menu item'}] if root == 1 else [])
        ins.press.side_effect = lambda obj: converted.__setitem__(0, True)
        frame = Mock(); frame.__enter__ = Mock(return_value=frame); frame.__exit__ = Mock(return_value=None)
        frame.bounds = (301, 81, 978, 578); frame.pixel.side_effect = lambda x, y: 0xeeeeF0 if 60 <= x <= 150 and 472 <= y <= 505 else 0
        frame.direction.side_effect = lambda text, bounds: 'self' if text == '较早内容' else 'other'
        initial_native = [('较早内容',(301,300,978,50)),('周六见',(301,400,978,50)),(original,(301,545,978,57))]
        native_after_conversion = [('周六见',(301,400,978,50)),('语音11"秒你好',(301,450,978,150))]
        current_rows = [initial_native]; current_objects = [10,11,12]
        ins.call.side_effect = lambda *args: current_objects[args[-1]]
        def press(obj):
            converted[0] = True
            current_rows[0] = native_after_conversion
            current_objects[:] = [11,12]
        ins.press.side_effect = press
        adapter = SimpleNamespace(controls=ins, session_identity=True, verify_session=Mock(),
            render=SimpleNamespace(DesktopFrame=lambda _:frame, INCOMING=0xeeeeF0),
            rows=lambda _ : current_rows[0])
        result = voice.convert(adapter, {'messageId':'b','messages':[
            {'id':'older','text':'较早内容','direction':'self'}, {'id':'a','text':'周六见','direction':'other'},
            {'id':'b','text':'[语音]','direction':'other','type':'voice'}]}, 'account', {'id':'contact','label':'Fixture'})
        self.assertEqual(result['text'], '你好')
        self.assertEqual(ins.move_pointer.call_args.args, (406, 570))
        ins.press.assert_called_once_with(5)

if __name__ == '__main__': unittest.main()
