"""Native send receipt boundaries; no WeChat, network or UI operations."""
import importlib.util
import pathlib
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('native_ai', pathlib.Path(__file__).resolve().parents[1] / 'server/ai-native.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

def msg(direction, text):
    return {'direction': direction, 'text': text}

class DataGuard(unittest.TestCase):
    def test_automatic_input_check_is_read_only_and_keeps_unverified_residue_protected(self):
        adapter = self.adapter()
        adapter.controls.locate.return_value = adapter.guard_snapshot.return_value[1]
        adapter.controls.bounds.return_value = (100, 100, 40, 30)
        request = {'action':'input-status', 'draft':{'label':'测试对象','text':'自动草稿'}}
        for text, safe in [('自动草稿',False), ('自动草稿新输入',False), ('我的新内容',True), ('',True)]:
            adapter.editor_text = Mock(return_value=text)
            self.assertEqual(adapter.execute(request)['safe'],safe)
        adapter.editor_text = Mock(return_value='自动草稿')
        self.assertTrue(adapter.execute({**request,'event':{'type':'pointer','x':20,'y':20}})['safe'])
        self.assertFalse(adapter.execute({**request,'event':{'type':'pointer','x':110,'y':110}})['safe'])
        adapter.resolve.assert_not_called()
        adapter.write_text.assert_not_called()
        adapter.controls.press.assert_not_called()

    def adapter(self):
        adapter = object.__new__(native.ChatAdapter)
        adapter.controls = Mock()
        adapter.controls.visible.return_value = True
        adapter.possibly_written = False
        adapter.resolve = Mock(return_value={'account': 'a', 'contact': {'id': 'b', 'label': '测试对象'}})
        layout = {'app': 1, 'frame': 2, 'header': 3, 'editor': 4, 'send': 5, 'label': '测试对象'}
        adapter.guard_snapshot = Mock(return_value=({'account': 'a', 'contact': 'b', 'revision': 'guard'}, layout))
        adapter.snapshot = Mock(side_effect=AssertionError('Data sends must not parse bubble colours or history'))
        adapter.editor_text = Mock(side_effect=['', '允许的文字', ''])
        adapter.write_text = Mock()
        return adapter

    def test_data_guard_dispatch_is_not_a_database_receipt(self):
        adapter = self.adapter()
        result = adapter.execute({'action': 'send-guard', 'revision': 'guard', 'text': '允许的文字'})
        self.assertEqual(result, {'status': 'submitted'})
        adapter.controls.press.assert_called_once_with(5)
        adapter.snapshot.assert_not_called()

    def test_changed_native_guard_cannot_insert_a_draft(self):
        adapter = self.adapter()
        self.assertEqual(adapter.execute({'action': 'send-guard', 'revision': 'old', 'text': '允许的文字'}), {'status': 'stale'})
        adapter.write_text.assert_not_called()
        adapter.controls.press.assert_not_called()

    def test_guard_change_after_draft_never_presses_send(self):
        adapter = self.adapter()
        value, layout = adapter.guard_snapshot.return_value
        adapter.guard_snapshot.side_effect = [(value, layout), ({**value, 'revision': 'changed'}, layout)]
        self.assertEqual(adapter.execute({'action': 'send-guard', 'revision': 'guard', 'text': '允许的文字'}), {'status': 'uncertain'})
        adapter.controls.press.assert_not_called()

    def test_only_post_send_row_changes_retry_observation_without_replaying_send(self):
        adapter = self.adapter()
        snapshot = adapter.guard_snapshot.return_value
        adapter.guard_snapshot.side_effect = [snapshot, snapshot, native.SnapshotChanged(), snapshot]
        with patch.object(native.time, 'sleep'):
            result = adapter.execute({'action': 'send-guard', 'revision': 'guard', 'text': '允许的文字'})
        self.assertEqual(result, {'status': 'submitted'})
        adapter.controls.press.assert_called_once_with(5)
        adapter.write_text.assert_called_once_with(4, '允许的文字')
        self.assertEqual(adapter.guard_snapshot.call_count, 4)

    def test_post_send_row_instability_is_bounded_and_identity_errors_are_not_retried(self):
        for failure in ('rows', 'identity'):
            with self.subTest(failure=failure):
                adapter = self.adapter()
                snapshot = adapter.guard_snapshot.return_value
                error = native.SnapshotChanged() if failure == 'rows' else ValueError('target changed')
                adapter.guard_snapshot.side_effect = [snapshot, snapshot] + [error] * 6
                with patch.object(native.time, 'sleep'):
                    if failure == 'rows':
                        self.assertEqual(adapter.execute({'action': 'send-guard', 'revision': 'guard', 'text': '允许的文字'}), {'status': 'uncertain'})
                        self.assertEqual(adapter.guard_snapshot.call_count, 8)
                    else:
                        with self.assertRaises(ValueError):
                            adapter.execute({'action': 'send-guard', 'revision': 'guard', 'text': '允许的文字'})
                        self.assertEqual(adapter.guard_snapshot.call_count, 3)
                adapter.controls.press.assert_called_once_with(5)
                adapter.write_text.assert_called_once_with(4, '允许的文字')

    def test_row_instability_before_send_does_not_retry_or_press_send(self):
        adapter = self.adapter()
        adapter.guard_snapshot.side_effect = [adapter.guard_snapshot.return_value, native.SnapshotChanged()]
        with patch.object(native.time, 'sleep'), self.assertRaises(native.SnapshotChanged):
            adapter.execute({'action': 'send-guard', 'revision': 'guard', 'text': '允许的文字'})
        adapter.controls.press.assert_not_called()
        self.assertEqual(adapter.guard_snapshot.call_count, 2)

    def test_prepared_send_requires_explicit_commit_after_native_identity_check(self):
        adapter = self.adapter()
        def commit(before):
            adapter.resolve.assert_called_once()
            adapter.write_text.assert_not_called()
            self.assertEqual(before, {'account': 'a', 'contact': 'b', 'revision': 'guard'})
            return {'action': 'commit', 'revision': before['revision'], 'text': '允许的文字'}
        self.assertEqual(adapter.execute({'action': 'prepare-send'}, commit=commit), {'status': 'submitted'})
        adapter.resolve.assert_called_once()
        adapter.controls.press.assert_called_once_with(5)

    def test_cancelled_commit_or_changed_native_chat_never_inserts_text(self):
        for change in ('cancel', 'guard', 'revision'):
            adapter = self.adapter()
            value, layout = adapter.guard_snapshot.return_value
            def commit(before):
                if change == 'guard': adapter.guard_snapshot.return_value = ({**value, 'revision': 'new'}, layout)
                return {'action': 'cancel'} if change == 'cancel' else {'action': 'commit', 'revision': 'old' if change == 'revision' else 'guard', 'text': '允许的文字'}
            self.assertEqual(adapter.execute({'action': 'prepare-send'}, commit=commit), {'status': 'stale'})
            adapter.write_text.assert_not_called(); adapter.controls.press.assert_not_called()


class GuardObservation(unittest.TestCase):
    def adapter(self):
        adapter = native.ChatAdapter.__new__(native.ChatAdapter)
        adapter.controls = Mock()
        layout = {'app': 1, 'frame': 2, 'header': 3, 'editor': 4, 'message_list': 5, 'label': '测试对象'}
        adapter.controls.locate.side_effect = [dict(layout), dict(layout)]
        adapter.controls._visible_roots.return_value = []
        adapter.controls.bounds.return_value = (10, 10, 300, 400)
        adapter.verify_session = Mock()
        adapter.rows = Mock(side_effect=[[('旧消息', (10, 10, 40, 20))], [('新消息', (10, 10, 40, 20))]])
        return adapter, layout

    def test_rows_are_retryable_only_after_live_identity_is_checked_again(self):
        adapter, _ = self.adapter()
        with self.assertRaises(native.SnapshotChanged):
            adapter.guard_snapshot('a', 'b', '测试对象')
        self.assertEqual(adapter.verify_session.call_count, 2)

    def test_identity_popup_geometry_and_control_changes_are_not_retryable_row_changes(self):
        for failure in ('identity', 'popup', 'viewport', 'app', 'frame', 'header', 'editor', 'message_list', 'label'):
            with self.subTest(failure=failure):
                adapter, layout = self.adapter()
                if failure == 'identity':
                    adapter.verify_session.side_effect = [None, ValueError('target changed')]
                elif failure == 'popup':
                    adapter.controls._visible_roots.side_effect = [[], [99]]
                elif failure == 'viewport':
                    adapter.controls.bounds.side_effect = [(10, 10, 300, 400), (10, 10, 301, 400)]
                else:
                    adapter.controls.locate.side_effect = [layout, {**layout, failure: 'changed'}]
                with self.assertRaises(ValueError) as raised:
                    adapter.guard_snapshot('a', 'b', '测试对象')
                self.assertNotIsInstance(raised.exception, native.SnapshotChanged)


class Receipt(unittest.TestCase):
    def test_confirmation_needs_new_outgoing_message(self):
        before = [msg('other','测试问题')]
        self.assertTrue(native.confirmed_append(before, before+[msg('self','测试答复')], '测试答复'))
        self.assertFalse(native.confirmed_append(before, before+[msg('other','测试答复')], '测试答复'))
        self.assertFalse(native.confirmed_append(before, before, '测试问题'))

    def test_timestamp_and_forward_window_are_allowed(self):
        before = [msg('other','旧'),msg('self','答'),msg('other','新')]
        after = before[1:]+[msg('system','12:30'),msg('self','回复')]
        self.assertTrue(native.confirmed_append(before, after, '回复'))

    def test_ambiguous_repeated_sequence_is_not_receipt(self):
        before = [msg('self','嗯'),msg('self','嗯')]
        self.assertFalse(native.confirmed_append(before,before+[msg('self','嗯')],'嗯'))

    def test_intervening_message_or_missing_overlap_is_uncertain(self):
        before = [msg('other','问题')]
        self.assertFalse(native.confirmed_append(before,before+[msg('other','变化'),msg('self','回复')],'回复'))
        self.assertFalse(native.confirmed_append(before,[msg('self','回复')],'回复'))

    def test_empty_chat_needs_single_send_after_optional_timestamp(self):
        self.assertTrue(native.confirmed_append([],[msg('system','10:30'),msg('self','你好')],'你好'))
        self.assertFalse(native.confirmed_append([],[msg('other','你好'),msg('self','你好')],'你好'))

    def test_identity_is_scoped_by_account(self):
        profile={'id':'a'*64}
        self.assertNotEqual(native.contact_key('one',profile),native.contact_key('two',profile))

    def test_revision_changes_with_direction_or_text(self):
        value=native.snapshot_revision([msg('other','同文')])
        self.assertNotEqual(value,native.snapshot_revision([msg('self','同文')]))
        self.assertNotEqual(value,native.snapshot_revision([msg('other','其他')]))


class BackgroundIdentity(unittest.TestCase):
    def adapter(self):
        adapter = native.ChatAdapter.__new__(native.ChatAdapter)
        adapter.controls = Mock()
        adapter.controls.pid = 123
        adapter.controls.locate.return_value = {'label': '同名对象'}
        request = {'action': 'prepare-send', 'account': 'a' * 64, 'contact': 'b' * 64,
                   'label': '同名对象', 'background': {'account': 'c' * 64, 'contact': 'd' * 64}}
        return adapter, request

    def test_matching_current_session_needs_no_profile_account_or_navigation(self):
        adapter, request = self.adapter()
        session = Mock(); session.matches.return_value = True
        with patch.object(native, 'module', return_value=Mock(SessionIdentity=Mock(return_value=session))), patch.dict(native.os.environ, {'HOME': '/owned'}):
            result = adapter.resolve(request)
        self.assertEqual(result['contact']['id'], request['contact'])
        adapter.controls.account.assert_not_called()
        adapter.controls.contact.assert_not_called()
        adapter.controls.navigate_background.assert_not_called()
        session.verify.assert_called_once_with(**request['background'])

    def test_same_label_wrong_identity_must_navigate_and_revalidate(self):
        adapter, request = self.adapter()
        session = Mock(); session.matches.return_value = False
        with patch.object(native, 'module', return_value=Mock(SessionIdentity=Mock(return_value=session))), patch.dict(native.os.environ, {'HOME': '/owned'}):
            adapter.resolve(request)
        adapter.controls.navigate_background.assert_called_once()
        session.verify.assert_called_once_with(**request['background'])
        adapter.controls.account.assert_not_called(); adapter.controls.contact.assert_not_called()

    def test_unknown_version_or_failed_reader_never_falls_back_to_profile(self):
        adapter, request = self.adapter()
        with patch.object(native, 'module', return_value=Mock(SessionIdentity=Mock(side_effect=ValueError('unsupported build')))), patch.dict(native.os.environ, {'HOME': '/owned'}):
            with self.assertRaises(ValueError): adapter.resolve(request)
        adapter.controls.account.assert_not_called(); adapter.controls.contact.assert_not_called()
        adapter.controls.press.assert_not_called()

    def test_identity_change_with_unchanged_text_and_label_blocks_send(self):
        adapter = DataGuard().adapter()
        adapter.session_identity = Mock()
        adapter.background_target = {'account': 'c' * 64, 'contact': 'd' * 64}
        adapter.session_identity.verify.side_effect = [None, ValueError('target changed')]
        with self.assertRaises(ValueError):
            adapter.execute({'action': 'send-guard', 'revision': 'guard', 'text': '允许的文字'})
        adapter.write_text.assert_called_once()
        adapter.controls.press.assert_not_called()

    def test_changed_session_before_input_leaves_draft_untouched(self):
        adapter = DataGuard().adapter()
        adapter.session_identity = Mock()
        adapter.background_target = {'account': 'c' * 64, 'contact': 'd' * 64}
        adapter.session_identity.verify.side_effect = ValueError('target changed')
        with self.assertRaises(ValueError):
            adapter.execute({'action': 'send-guard', 'revision': 'guard', 'text': '允许的文字'})
        adapter.write_text.assert_not_called(); adapter.controls.press.assert_not_called()

    def test_cleanup_cannot_clear_another_same_label_session(self):
        adapter, controls, draft = OwnedDraftCleanup().adapter()
        adapter.session_identity = Mock()
        adapter.background_target = {'account': 'c' * 64, 'contact': 'd' * 64}
        adapter.session_identity.verify.side_effect = ValueError('target changed')
        self.assertEqual(adapter.close(), 'blocked')
        adapter.write_text.assert_not_called()
        self.assertEqual(draft[0], '本轮自动草稿')


class ContactsRouting(unittest.TestCase):
    def adapter(self):
        adapter = native.ChatAdapter.__new__(native.ChatAdapter)
        adapter.controls = Mock()
        adapter.controls.account.return_value = 'a' * 64
        adapter.controls.contacts.return_value = [{'obj': i, 'label': '联系人' + str(i)} for i in range(75)]
        return adapter

    def test_listing_uses_contacts_without_requiring_a_current_chat(self):
        adapter = self.adapter()
        result = adapter.execute({'action': 'list'})
        self.assertEqual(result['source'], 'contacts')
        self.assertEqual(len(result['candidates']), 75)
        self.assertIsNone(result['current'])
        self.assertTrue(result['batchResolve'])
        adapter.controls.prepare_scan.assert_called_once()
        adapter.controls.locate.assert_not_called()
        adapter.controls.contact.assert_not_called()
        adapter.controls.scan.assert_not_called()

    def test_batched_profiles_are_account_scoped_and_missing_profiles_stay_unavailable(self):
        adapter = self.adapter()
        profile = {'id': 'b' * 64, 'label': '甲', 'kind': 'person'}
        adapter.controls.resolve_contacts.return_value = [profile, None]
        result = adapter.execute({'action': 'resolve-batch', 'account': 'a' * 64, 'labels': ['甲', '乙']})
        self.assertEqual(result['results'][0]['contact']['id'], native.contact_key('a' * 64, profile))
        self.assertEqual(result['results'][1], {'available': False, 'error': 'unsupported'})
        adapter.controls.resolve_contacts.assert_called_once_with(['甲', '乙'])
        adapter.controls.locate.assert_not_called()

    def test_batch_rejects_changed_account_duplicates_and_oversized_requests(self):
        adapter = self.adapter()
        changed = adapter.execute({'action': 'resolve-batch', 'account': 'c' * 64, 'labels': ['甲']})
        self.assertEqual(changed['error'], 'account-changed')
        for labels in [[], ['甲', '甲'], ['对象' + str(i) for i in range(11)], [None]]:
            with self.assertRaises(ValueError):
                adapter.execute({'action': 'resolve-batch', 'account': 'a' * 64, 'labels': labels})
        adapter.controls.resolve_contacts.assert_not_called()

    def test_directory_resolution_does_not_open_a_conversation(self):
        adapter = self.adapter()
        profile = {'id': 'b' * 64, 'label': '联系人', 'kind': 'person'}
        adapter.controls.directory_contact.return_value = profile
        result = adapter.resolve({'action': 'resolve', 'source': 'contacts', 'account': 'a' * 64, 'label': '联系人'})
        self.assertEqual(result['contact']['id'], native.contact_key('a' * 64, profile))
        adapter.controls.directory_contact.assert_called_once_with('联系人', open_chat=False, expected_contact=None, account='a' * 64)
        adapter.controls.navigate.assert_not_called()

    def test_read_reuses_current_chat_only_after_fresh_profile_verification(self):
        adapter = self.adapter()
        profile = {'id': 'b' * 64, 'label': '联系人', 'kind': 'person'}
        adapter.controls.locate.return_value = {'label': profile['label']}
        adapter.controls.contact.return_value = profile
        expected = native.contact_key('a' * 64, profile)
        result = adapter.resolve({'action': 'read', 'source': 'contacts', 'account': 'a' * 64, 'contact': expected, 'label': profile['label']})
        self.assertEqual(result['contact']['id'], expected)
        adapter.controls.contact.assert_called_once()
        adapter.controls.directory_contact.assert_not_called()
        changed = adapter.resolve({'action': 'read', 'source': 'contacts', 'account': 'a' * 64, 'contact': 'c' * 64, 'label': profile['label']})
        self.assertEqual(changed['error'], 'target-changed')


    def test_existing_chat_switch_still_requires_fresh_account_scoped_profile(self):
        adapter = self.adapter();profile = {'id':'b'*64,'label':'目标','kind':'person'}
        adapter.controls.locate.return_value = {'label':'当前会话'}
        adapter.controls.scan.return_value = [{'obj':12,'label':'目标'}]
        adapter.controls.visible.return_value = True
        adapter.controls.navigate.return_value = profile
        request = {'action':'prepare-send','source':'contacts','account':'a'*64,'contact':native.contact_key('a'*64,profile),'label':'目标'}
        self.assertEqual(adapter.resolve(request)['contact']['id'], request['contact'])
        adapter.controls.navigate.assert_called_once_with('目标')
        adapter.controls.directory_contact.assert_not_called()
        adapter.controls.navigate.return_value = {**profile,'id':'c'*64}
        self.assertEqual(adapter.resolve(request)['error'], 'target-changed')

    def test_missing_duplicate_or_hidden_recent_chat_uses_verified_directory(self):
        for rows,visible in (([],True),([{'obj':12,'label':'目标'},{'obj':13,'label':'目标'}],True),([{'obj':12,'label':'目标'}],False)):
            adapter = self.adapter();profile = {'id':'b'*64,'label':'目标','kind':'person'}
            adapter.controls.locate.return_value = {'label':'当前会话'}
            adapter.controls.scan.return_value = rows
            adapter.controls.visible.return_value = visible
            adapter.controls.directory_contact.return_value = profile
            request = {'action':'prepare-send','source':'contacts','account':'a'*64,'contact':native.contact_key('a'*64,profile),'label':'目标'}
            self.assertEqual(adapter.resolve(request)['contact']['id'],request['contact'])
            adapter.controls.navigate.assert_not_called()
            adapter.controls.directory_contact.assert_called_once()


class OwnedDraftCleanup(unittest.TestCase):
    def adapter(self, text='本轮自动草稿'):
        adapter = native.ChatAdapter.__new__(native.ChatAdapter)
        adapter.possibly_written, adapter.send_pressed, adapter.send_confirmed = True, False, False
        layout = {'app': 1, 'frame': 2, 'header': 3, 'editor': 4, 'label': '测试对象'}
        adapter.owned_draft = {**layout, 'text': '本轮自动草稿'}
        controls = Mock()
        controls.cancelled = True
        controls.locate.return_value = dict(layout)
        controls._visible_roots.return_value = []
        controls.string.return_value = layout['label']
        def budget(operation, seconds):
            self.assertEqual(seconds, 1.5)
            cancelled = controls.cancelled
            controls.cancelled = False
            try:
                operation()
            finally:
                controls.cancelled = cancelled
        controls._cleanup_budget.side_effect = budget
        adapter.controls = controls
        draft = [text]
        adapter.editor_text = Mock(side_effect=lambda _: draft[0])
        adapter.write_text = Mock(side_effect=lambda _, value: draft.__setitem__(0, value))
        return adapter, controls, draft

    def test_cancelled_send_clears_only_its_exact_owned_draft_before_controls_close(self):
        adapter, controls, draft = self.adapter()
        controls.close.side_effect = lambda: self.assertEqual(draft[0], '')
        self.assertEqual(adapter.close(), 'cleared')
        adapter.write_text.assert_called_once_with(4, '')
        self.assertTrue(controls.cancelled)
        controls.require_foreground.assert_called()

    def test_changed_editor_header_frame_application_or_label_never_gets_deleted(self):
        for key in ('app', 'frame', 'header', 'editor', 'label'):
            with self.subTest(key=key):
                adapter, controls, draft = self.adapter()
                controls.locate.return_value[key] = 'changed'
                self.assertEqual(adapter.close(), 'blocked')
                adapter.write_text.assert_not_called()
                self.assertEqual(draft[0], '本轮自动草稿')

    def test_user_changed_draft_is_preserved_and_requires_manual_review(self):
        adapter, _, draft = self.adapter('用户修改后的草稿')
        self.assertEqual(adapter.close(), 'blocked')
        adapter.write_text.assert_not_called()
        self.assertEqual(draft[0], '用户修改后的草稿')

    def test_changed_header_after_locate_is_rechecked_before_deleting(self):
        adapter, controls, _ = self.adapter()
        controls.string.return_value = '另一个对象'
        self.assertEqual(adapter.close(), 'blocked')
        adapter.write_text.assert_not_called()

    def test_changed_text_before_delete_is_preserved(self):
        adapter, _, _ = self.adapter()
        adapter.editor_text.side_effect = ['本轮自动草稿', '用户刚修改']
        self.assertEqual(adapter.close(), 'blocked')
        adapter.write_text.assert_not_called()

    def test_popup_or_missing_foreground_or_deadline_never_guesses_cleanup(self):
        for failure in ('popup', 'foreground', 'deadline'):
            with self.subTest(failure=failure):
                adapter, controls, _ = self.adapter()
                if failure == 'popup':
                    controls._visible_roots.return_value = [99]
                elif failure == 'foreground':
                    controls.require_foreground.side_effect = RuntimeError('foreground unavailable')
                else:
                    controls._cleanup_budget.side_effect = RuntimeError('deadline expired')
                self.assertEqual(adapter.close(), 'blocked')
                adapter.write_text.assert_not_called()

    def test_empty_draft_and_confirmed_send_need_no_deletion(self):
        adapter, _, _ = self.adapter('')
        self.assertEqual(adapter.close(), 'not-needed')
        adapter.write_text.assert_not_called()
        for field in ('send_confirmed', 'possibly_written'):
            adapter, controls, _ = self.adapter()
            setattr(adapter, field, field == 'send_confirmed')
            self.assertEqual(adapter.close(), 'not-needed')
            adapter.write_text.assert_not_called()
            controls.locate.assert_not_called()

    def test_send_click_without_receipt_is_never_cleaned_or_replayed(self):
        for text in ('本轮自动草稿', '用户修改后的草稿'):
            adapter, controls, draft = self.adapter(text)
            adapter.send_pressed = True
            adapter.session_identity = Mock()
            adapter.background_target = {'account': 'a' * 64, 'contact': 'b' * 64}
            self.assertEqual(adapter.close(), 'blocked')
            adapter.write_text.assert_not_called()
            controls.press.assert_not_called()
            self.assertEqual(draft[0], text)

    def post_send_adapter(self):
        adapter, controls, draft = self.adapter('')
        adapter.send_pressed = True
        adapter.session_identity = Mock()
        adapter.background_target = {'account': 'a' * 64, 'contact': 'b' * 64}
        return adapter, controls, draft

    def test_post_send_empty_owned_editor_is_read_only_safe_without_claiming_a_receipt(self):
        adapter, controls, _ = self.post_send_adapter()
        self.assertEqual(adapter.close(), 'not-needed')
        self.assertEqual(controls.locate.call_count, 2)
        self.assertEqual(adapter.editor_text.call_count, 2)
        self.assertEqual(adapter.session_identity.verify.call_count, 3)
        self.assertFalse(adapter.send_confirmed)
        adapter.write_text.assert_not_called()
        controls.press.assert_not_called()
        controls.account.assert_not_called()
        controls.contact.assert_not_called()

    def test_post_send_empty_check_blocks_missing_identity_and_either_failed_live_check(self):
        for failure in ('missing', 'initial', 'repeat', 'final'):
            with self.subTest(failure=failure):
                adapter, controls, _ = self.post_send_adapter()
                if failure == 'missing':
                    adapter.session_identity = None
                else:
                    before = {'initial': 0, 'repeat': 1, 'final': 2}[failure]
                    adapter.session_identity.verify.side_effect = [None] * before + [ValueError('target changed')]
                self.assertEqual(adapter.close(), 'blocked')
                adapter.write_text.assert_not_called()
                controls.press.assert_not_called()

    def test_post_send_second_observation_rejects_changed_controls_popup_label_or_draft(self):
        for failure in ('app', 'frame', 'header', 'editor', 'label', 'popup', 'header_text', 'draft', 'foreground'):
            with self.subTest(failure=failure):
                adapter, controls, _ = self.post_send_adapter()
                layout = dict(controls.locate.return_value)
                if failure in layout:
                    controls.locate.side_effect = [layout, {**layout, failure: 'changed'}]
                elif failure == 'popup':
                    controls._visible_roots.side_effect = [[], [99]]
                elif failure == 'header_text':
                    controls.string.return_value = '另一个对象'
                elif failure == 'draft':
                    adapter.editor_text.side_effect = ['', '用户刚输入的草稿']
                else:
                    controls.require_foreground.side_effect = [None, None, ValueError('foreground unavailable')]
                self.assertEqual(adapter.close(), 'blocked')
                adapter.write_text.assert_not_called()
                controls.press.assert_not_called()

    def test_failed_empty_confirmation_keeps_manual_input_blocked(self):
        adapter, _, _ = self.adapter()
        adapter.write_text.side_effect = None
        self.assertEqual(adapter.close(), 'blocked')
        adapter.write_text.assert_called_once_with(4, '')

if __name__ == '__main__':
    unittest.main()
