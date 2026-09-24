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
    def test_incoming_skip_trigger_can_be_located(self):
        messages = [{'id': str(i), 'direction': 'other', 'text': text} for i, text in enumerate(['前文', '收到', '后文'])]
        self.assertEqual(locate.align(messages, messages, '1'), 1)
    def test_unknown_pixel_direction_needs_exact_unique_sequence_and_verified_anchor(self):
        messages = [
            {'id': 'target', 'direction': 'other', 'text': '入站目标'},
            {'id': 'anchor', 'direction': 'self', 'text': '唯一已发内容'},
            {'id': 'next', 'direction': 'other', 'text': '后续内容'},
        ]
        rows = [
            {'direction': 'unknown', 'text': '入站目标'},
            {'direction': 'self', 'text': '唯一已发内容'},
            {'direction': 'unknown', 'text': '后续内容'},
        ]
        self.assertEqual(locate.align(rows, messages, 'target'), 0)
        no_anchor = [{**row, 'direction': 'unknown'} for row in rows]
        self.assertIsNone(locate.align(no_anchor, messages, 'target'))
        self.assertIsNone(locate.align(rows, messages, 'foreign'))
        duplicate = messages + [
            {'id': 'target-copy', 'direction': 'other', 'text': '入站目标'},
            {'id': 'anchor-copy', 'direction': 'self', 'text': '唯一已发内容'},
            {'id': 'next-copy', 'direction': 'other', 'text': '后续内容'},
        ]
        self.assertIsNone(locate.align(rows, duplicate, 'target'))
    def test_known_media_gap_is_skipped_but_target_media_remains_locatable(self):
        messages = [
            {'id': 'before', 'direction': 'other', 'text': '前序'},
            {'id': 'media', 'direction': 'other', 'text': '[图片]'},
            {'id': 'target', 'direction': 'other', 'text': '目标'},
            {'id': 'anchor', 'direction': 'self', 'text': '唯一锚点'},
        ]
        rows = [
            {'direction': 'unknown', 'text': '前序'},
            {'direction': 'unknown', 'text': '目标'},
            {'direction': 'self', 'text': '唯一锚点'},
        ]
        self.assertEqual(locate.align(rows, messages, 'target'), 1)
        media_target = [
            {'id': 'before', 'direction': 'self', 'text': '前序'},
            {'id': 'target', 'direction': 'other', 'text': '[图片]'},
            {'id': 'after', 'direction': 'self', 'text': '后续'},
        ]
        media_rows = [
            {'direction': 'self', 'text': '前序'},
            {'direction': 'unknown', 'text': '[图片]'},
            {'direction': 'self', 'text': '后续'},
        ]
        self.assertEqual(locate.align(media_rows, media_target, 'target'), 1)
    def test_ordinary_missing_database_message_is_not_skipped(self):
        messages = [
            {'id': 'before', 'direction': 'other', 'text': '前序'},
            {'id': 'hidden', 'direction': 'self', 'text': '普通聊天内容'},
            {'id': 'target', 'direction': 'other', 'text': '目标'},
            {'id': 'anchor', 'direction': 'self', 'text': '唯一锚点'},
        ]
        rows = [
            {'direction': 'unknown', 'text': '前序'},
            {'direction': 'unknown', 'text': '目标'},
            {'direction': 'self', 'text': '唯一锚点'},
        ]
        self.assertIsNone(locate.align(rows, messages, 'target'))

if __name__ == '__main__': unittest.main()
