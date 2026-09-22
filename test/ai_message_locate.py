import importlib.util, pathlib, unittest
spec = importlib.util.spec_from_file_location('locate', pathlib.Path(__file__).parents[1] / 'server/ai-message-locate.py')
locate = importlib.util.module_from_spec(spec); spec.loader.exec_module(locate)

class MessageLocate(unittest.TestCase):
    def test_identity_uses_unique_sequence_and_requested_id(self):
        messages = [{'id': str(i), 'direction': 'self', 'text': text} for i, text in enumerate(['前文', '好的', '后文', '好的', '后续'])]
        self.assertEqual(locate.align(messages[:3], messages, '1'), 1)
        self.assertEqual(locate.align(messages[2:], messages, '3'), 1)
        self.assertIsNone(locate.align(messages[:3], messages, '3'))
        self.assertIsNone(locate.align(messages[:3], messages, 'foreign'))
        self.assertIsNone(locate.align(messages[1:2], messages, '1'))
    def test_repeated_context_and_direction_mismatch_never_select_a_message(self):
        messages = [{'id': str(i), 'direction': 'self', 'text': '重复'} for i in range(6)]
        self.assertIsNone(locate.align(messages[:3], messages, '1'))
        messages = [{'id': str(i), 'direction': 'self', 'text': str(i)} for i in range(3)]
        rows = [{**m, 'direction': 'other'} for m in messages]
        self.assertIsNone(locate.align(rows, messages, '1'))

if __name__ == '__main__': unittest.main()
