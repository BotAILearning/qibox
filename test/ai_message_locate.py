import importlib.util, pathlib, unittest
spec = importlib.util.spec_from_file_location('locate', pathlib.Path(__file__).parents[1] / 'server/ai-message-locate.py')
locate = importlib.util.module_from_spec(spec); spec.loader.exec_module(locate)

class MessageLocate(unittest.TestCase):
    def test_search_continues_past_eighteen_viewports_and_stops_on_exact_sequence(self):
        target_page = 5
        sequence = [
            {'id': 'before', 'direction': 'other', 'text': '唯一前序'},
            {'id': 'target', 'direction': 'other', 'text': '目标消息'},
            {'id': 'after', 'direction': 'self', 'text': '唯一后序'},
        ]
        class Frame:
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def direction(self, name, _bounds): return {'唯一前序': 'other', '目标消息': 'other', '唯一后序': 'self'}.get(name, 'unknown')
        class Render:
            MEDIA_LABEL = locate.MEDIA_LABEL
            DesktopFrame = lambda *_args: Frame()
        class Controls:
            def __init__(self): self.page = 30; self.moves = 0
            def check(self): pass
            def require_foreground(self, *_): pass
            def refresh(self, *_): pass
            def visible(self, *_): return True
            def string(self, *_): return '目标联系人'
            def locate(self): return {'label': '目标联系人', 'app': 1, 'frame': 2, 'header': 4, 'message_list': 3}
            def _visible_roots(self, *_): return []
            def bounds(self, _): return (0, 0, 200, 300)
            def move_pointer(self, *_): pass
            def scroll_directory(self, direction, *_args, **_kwargs):
                self.moves += 1
                self.page = min(30, self.page + 1) if direction == 'down' else max(0, self.page - 1)
        class Adapter:
            session_identity = True
            render = Render()
            def __init__(self): self.controls = Controls()
            def verify_session(self): self.controls.verifications = getattr(self.controls, 'verifications', 0) + 1
            def rows(self, _layout):
                if self.controls.page == target_page:
                    return [(item['text'], (0, 100 + i * 50, 200, 45)) for i, item in enumerate(sequence)]
                return [(f'viewport-{self.controls.page}-{i}', (0, 100 + i * 50, 200, 45)) for i in range(3)]
        adapter = Adapter()
        self.assertTrue(locate.locate(adapter, {'messages': sequence, 'messageId': 'target'}, '目标联系人'))
        self.assertGreater(adapter.controls.moves, 18)
        self.assertLess(adapter.controls.moves, 80)
        self.assertEqual(adapter.locate_pages, 26)

    def test_search_continues_past_sixty_pages_but_stops_at_verified_target(self):
        self.assertEqual(locate.MAX_SEARCH_PAGES, 180)
        target_page = 40
        sequence = [
            {'id': 'before', 'direction': 'other', 'text': '唯一前序锚点'},
            {'id': 'target', 'direction': 'other', 'text': '目标消息'},
            {'id': 'after', 'direction': 'self', 'text': '唯一后序锚点'},
        ]
        class Frame:
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def direction(self, name, _bounds): return {'唯一前序锚点': 'other', '目标消息': 'other', '唯一后序锚点': 'self'}.get(name, 'unknown')
        class Render:
            MEDIA_LABEL = locate.MEDIA_LABEL
            frames = 0
            def DesktopFrame(self, *_args):
                self.frames += 1
                return Frame()
        class Controls:
            def __init__(self): self.page = 130; self.moves = 0
            def check(self): pass
            def require_foreground(self, *_): pass
            def refresh(self, *_): pass
            def visible(self, *_): return True
            def string(self, *_): return '目标联系人'
            def locate(self): return {'label': '目标联系人', 'app': 1, 'frame': 2, 'header': 4, 'message_list': 3}
            def _visible_roots(self, *_): return []
            def bounds(self, _): return (0, 0, 200, 300)
            def move_pointer(self, *_): pass
            def scroll_directory(self, direction, *_args, **_kwargs):
                self.moves += 1
                self.page = min(130, self.page + 1) if direction == 'down' else max(0, self.page - 1)
        class Adapter:
            session_identity = True
            render = Render()
            def __init__(self): self.controls = Controls()
            def verify_session(self): self.controls.verifications = getattr(self.controls, 'verifications', 0) + 1
            def rows(self, _layout):
                if self.controls.page == target_page:
                    return [(item['text'], (0, 100 + i * 50, 200, 45)) for i, item in enumerate(sequence)]
                return [(f'viewport-{self.controls.page}-{i}', (0, 100 + i * 50, 200, 45)) for i in range(3)]
        adapter = Adapter()
        self.assertTrue(locate.locate(adapter, {'messages': sequence, 'messageId': 'target'}, '目标联系人'))
        self.assertGreater(adapter.controls.moves, 60)
        self.assertLess(adapter.controls.moves, 120)
        self.assertEqual(adapter.locate_pages, 91)
        self.assertEqual(adapter.render.frames, 1)
        self.assertGreaterEqual(adapter.controls.verifications, 11, '跨越多页时周期性完整复核会话身份')

    def test_search_can_find_exact_target_beyond_one_hundred_twenty_pages(self):
        self.assertEqual(locate.MAX_SEARCH_PAGES,180)
        target_page=10
        sequence=[{'id':'before','direction':'other','text':'深页前序锚点'},
                  {'id':'target','direction':'other','text':'深页定位目标'},
                  {'id':'after','direction':'self','text':'深页后序锚点'}]
        class Frame:
            def __enter__(self): return self
            def __exit__(self,*_): return False
            def direction(self,name,_bounds): return {'深页前序锚点':'other','深页定位目标':'other','深页后序锚点':'self'}.get(name,'unknown')
        class Render:
            MEDIA_LABEL=locate.MEDIA_LABEL
            def DesktopFrame(self,*_): return Frame()
        class Controls:
            def __init__(self): self.page=160;self.moves=0;self.pointers=0
            def check(self): pass
            def require_foreground(self,*_): pass
            def refresh(self,*_): pass
            def visible(self,*_): return True
            def string(self,*_): return '目标联系人'
            def locate(self): return {'label':'目标联系人','app':1,'frame':2,'header':4,'message_list':3}
            def _visible_roots(self,*_): return []
            def bounds(self,_): return (0,0,200,300)
            def move_pointer(self,*_): self.pointers+=1
            def scroll_directory(self,direction,*_args,**_kwargs):
                self.moves+=1;self.page=min(160,self.page+1) if direction=='down' else max(0,self.page-1)
        class Adapter:
            session_identity=True;render=Render()
            def __init__(self): self.controls=Controls()
            def verify_session(self): pass
            def rows(self,_):
                if self.controls.page==target_page:
                    return [(m['text'],(0,100+i*50,200,45)) for i,m in enumerate(sequence)]
                return [(f'deep-page-{self.controls.page}-{i}',(0,100+i*50,200,45)) for i in range(3)]
        adapter=Adapter()
        self.assertTrue(locate.locate(adapter,{'messages':sequence,'messageId':'target'},'目标联系人'))
        self.assertGreater(adapter.controls.moves,120)
        self.assertLess(adapter.controls.moves,180)
        self.assertEqual(adapter.controls.pointers,1)

    def test_periodic_identity_change_aborts_before_pointer_move(self):
        sequence = [
            {'id': 'before', 'direction': 'other', 'text': '前序唯一'},
            {'id': 'target', 'direction': 'other', 'text': '定位目标'},
            {'id': 'after', 'direction': 'self', 'text': '后序唯一'},
        ]
        class Frame:
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def direction(self, name, _bounds): return {'前序唯一':'other','定位目标':'other','后序唯一':'self'}.get(name,'unknown')
        class Render:
            MEDIA_LABEL = locate.MEDIA_LABEL
            def DesktopFrame(self, *_): return Frame()
        class Controls:
            def __init__(self): self.page=20; self.moves=0; self.pointers=0
            def check(self): pass
            def require_foreground(self,*_): pass
            def refresh(self,*_): pass
            def visible(self,*_): return True
            def string(self,*_): return '目标联系人'
            def locate(self): return {'label':'目标联系人','app':1,'frame':2,'header':4,'message_list':3}
            def _visible_roots(self,*_): return []
            def bounds(self,_): return (0,0,200,300)
            def move_pointer(self,*_): self.pointers+=1
            def scroll_directory(self,direction,*_args,**_kwargs):
                self.moves+=1; self.page=min(20,self.page+1) if direction=='down' else max(0,self.page-1)
        class Adapter:
            session_identity=True; render=Render()
            def __init__(self): self.controls=Controls(); self.full=0
            def verify_session(self):
                self.full+=1
                if self.full==2: raise ValueError('identity changed')
            def rows(self,_):
                if self.controls.page==0: return [(m['text'],(0,100+i*50,200,45)) for i,m in enumerate(sequence)]
                return [(f'page-{self.controls.page}-{i}',(0,100+i*50,200,45)) for i in range(3)]
        adapter=Adapter()
        with self.assertRaisesRegex(ValueError,'identity changed'):
            locate.locate(adapter,{'messages':sequence,'messageId':'target'},'目标联系人')
        self.assertEqual(adapter.controls.pointers,0)

    def test_cached_header_or_popup_change_fails_closed_before_pointer_move(self):
        sequence=[{'id':'b','direction':'other','text':'前序唯一'},
                  {'id':'target','direction':'other','text':'定位目标'},
                  {'id':'a','direction':'self','text':'后序唯一'}]
        for changed in ('header','popup'):
            with self.subTest(changed=changed):
                class Controls:
                    def __init__(self): self.page=20;self.moves=0;self.pointers=0
                    def check(self): pass
                    def require_foreground(self,*_): pass
                    def refresh(self,*_): pass
                    def visible(self,*_): return True
                    def string(self,*_): return '另一个聊天' if changed=='header' and self.moves else '目标联系人'
                    def locate(self): return {'label':'目标联系人','app':1,'frame':2,'header':4,'message_list':3}
                    def _visible_roots(self,*_): return ['popup'] if changed=='popup' and self.moves else []
                    def bounds(self,_): return (0,0,200,300)
                    def move_pointer(self,*_): self.pointers+=1
                    def scroll_directory(self,direction,*_args,**_kwargs): self.moves+=1
                class Adapter:
                    session_identity=True
                    render=None
                    def __init__(self): self.controls=Controls()
                    def verify_session(self): pass
                    def rows(self,_): return [('占位内容',(0,100,200,45))]*3
                adapter=Adapter()
                with self.assertRaisesRegex(ValueError,'header changed|popup changed'):
                    locate.locate(adapter,{'messages':sequence,'messageId':'target'},'目标联系人')
                self.assertEqual(adapter.controls.pointers,0)

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
