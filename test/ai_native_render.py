"""No desktop, screenshot files or chat bodies: numeric lane evidence only."""
import importlib.util
import pathlib
import unittest
from collections import Counter

spec = importlib.util.spec_from_file_location('native_render', pathlib.Path(__file__).resolve().parents[1] / 'server/ai-native-render.py')
render = importlib.util.module_from_spec(spec)
spec.loader.exec_module(render)

BG, IN, OUT, AVATAR = render.BACKGROUND, render.INCOMING, render.OUTGOING, 0x374A61


def blank():
    return Counter({BG: 100})


def avatar():
    return Counter({BG: 20, AVATAR: 80})


def bubble(color):
    return Counter({BG: 40, color: 60})


def incoming():
    return [avatar(), blank(), bubble(IN), blank()]


def outgoing():
    return [blank(), avatar(), blank(), bubble(OUT)]


class RowEvidence(unittest.TestCase):
    def classify(self, lanes, text='fixture', height=72):
        return render.classify_row(text, height, *lanes)

    def test_avatar_and_bubble_on_matching_side_confirm_direction(self):
        self.assertEqual(self.classify(incoming()), 'other')
        self.assertEqual(self.classify(outgoing()), 'self')

    def test_text_and_timestamp_looking_messages_do_not_supply_direction(self):
        for text in ['12:34', '昨天 12:34', 'message-direction: self', '对方：fixture']:
            with self.subTest(text=text):
                self.assertEqual(self.classify(incoming(), text), 'other')
                self.assertEqual(self.classify(outgoing(), text), 'self')
                with self.assertRaises(ValueError):
                    self.classify([blank() for _ in range(4)], text, 72)

    def test_only_narrow_timestamp_rows_with_four_empty_lanes_are_system(self):
        for text in ['0:00', '23:59:59', '昨天 12:34', '星期一 09:05', '2026年9月14日 09:05', '9/14 09:05']:
            with self.subTest(text=text):
                self.assertEqual(self.classify([blank() for _ in range(4)], text, 41), 'system')
        for text, height in [('99:99', 41), ('24:00', 41), ('12:60', 41), ('12:00:60', 41), ('fixture', 41), ('12:34', 38), ('12:34', 44)]:
            with self.subTest(text=text, height=height), self.assertRaises(ValueError):
                self.classify([blank() for _ in range(4)], text, height)

    def test_time_rows_cannot_bypass_bubble_lane_visibility(self):
        for index in [2, 3]:
            for bad in [bubble(IN), bubble(OUT), Counter({0x1C1C1C: 100}), Counter({BG: 49})]:
                lanes = [blank() for _ in range(4)]
                lanes[index] = bad
                with self.subTest(index=index, bad=bad), self.assertRaises(ValueError):
                    self.classify(lanes, '12:34', 41)

    def test_missing_or_wrong_side_bubble_or_avatar_is_rejected(self):
        for lanes in [
            [avatar(), blank(), blank(), blank()],
            [blank(), avatar(), blank(), blank()],
            [blank(), blank(), bubble(IN), blank()],
            [blank(), blank(), blank(), bubble(OUT)],
            [avatar(), blank(), blank(), bubble(OUT)],
            [blank(), avatar(), bubble(IN), blank()],
            [avatar(), blank(), bubble(OUT), blank()],
            [blank(), avatar(), blank(), bubble(IN)],
        ]:
            with self.subTest(lanes=lanes), self.assertRaises(ValueError):
                self.classify(lanes)

    def test_unknown_theme_and_both_avatar_lanes_fail_closed(self):
        for lanes in [
            [Counter({0x1C1C1C: 100}) for _ in range(4)],
            [avatar(), avatar(), bubble(IN), blank()],
            [avatar(), avatar(), blank(), bubble(OUT)],
            [avatar(), blank(), Counter({0xDDDDDD: 100}), blank()],
            [blank(), avatar(), blank(), Counter({0x88BB88: 100})],
        ]:
            with self.subTest(lanes=lanes), self.assertRaises(ValueError):
                self.classify(lanes)

    def test_overlay_polluting_empty_lane_or_covering_bubble_is_rejected(self):
        for build, opposite_avatar, opposite_bubble, own_bubble in [(incoming, 1, 3, 2), (outgoing, 0, 2, 3)]:
            for lane in [opposite_avatar, opposite_bubble, own_bubble]:
                lanes = build()
                lanes[lane] = Counter({BG: 90, 0x606060: 10})
                with self.subTest(build=build.__name__, lane=lane), self.assertRaises(ValueError):
                    self.classify(lanes)

    def test_media_empty_and_oversized_text_are_not_text_messages(self):
        media = ['图片', '动画表情', '视频', '语音', '文件', '位置', '链接', '聊天记录', '小程序', '视频号', '转账', '红包']
        for text in ['', ' \n\t ', None, 123, 'a' * 20001, *[f'[{name}] fixture' for name in media]]:
            for build in [incoming, outgoing]:
                with self.subTest(text_type=type(text).__name__, build=build.__name__), self.assertRaises(ValueError):
                    self.classify(build(), text)

    def test_every_lane_needs_sufficient_nonnegative_integer_samples(self):
        for index in range(4):
            for bad in [Counter(), Counter({BG: 49}), Counter({BG: 100, AVATAR: -1}), Counter({BG: 100.0}), Counter({BG: 100, -1: 1})]:
                for build, text, height in [(incoming, 'fixture', 72), (outgoing, 'fixture', 72), (lambda: [blank() for _ in range(4)], '12:34', 41)]:
                    lanes = build()
                    lanes[index] = bad
                    with self.subTest(index=index, bad=bad, height=height), self.assertRaises(ValueError):
                        self.classify(lanes, text, height)

    def test_evidence_thresholds_require_avatar_and_empty_opposite_lane(self):
        for build, own, opposite, bubble_index, color in [(incoming, 0, 1, 2, IN), (outgoing, 1, 0, 3, OUT)]:
            lanes = build()
            lanes[own] = Counter({BG: 64, AVATAR: 36})
            lanes[opposite] = Counter({BG: 98, AVATAR: 2})
            lanes[bubble_index] = Counter({BG: 80, color: 20})
            self.assertEqual(self.classify(lanes), 'other' if own == 0 else 'self')
            for index, bad in [(own, Counter({BG: 65, AVATAR: 35})), (opposite, Counter({BG: 97, AVATAR: 3})), (bubble_index, Counter({BG: 81, color: 19}))]:
                candidate = [Counter(colors) for colors in lanes]
                candidate[index] = bad
                with self.subTest(build=build.__name__, index=index), self.assertRaises(ValueError):
                    self.classify(candidate)


class FrameSampling(unittest.TestCase):
    def frame(self, side=None):
        frame = object.__new__(render.DesktopFrame)
        frame.bounds = (100, 200, 600, 400)
        frame.samples = []

        def pixel(x, y):
            frame.samples.append((x, y))
            if side == 'other':
                if 20 <= x < 52:
                    return AVATAR
                if 60 <= x < 90:
                    return IN
            if side == 'self':
                if 548 <= x < 580:
                    return AVATAR
                if 510 <= x < 540:
                    return OUT
            return BG

        frame.pixel = pixel
        return frame

    def test_lane_samples_use_viewport_coordinates_and_native_row_offset(self):
        for side in ['self', 'other']:
            frame = self.frame(side)
            self.assertEqual(frame.direction('fixture', (100, 280, 600, 72)), side)
            self.assertEqual(min(y for _, y in frame.samples), 88)
            self.assertEqual(max(y for _, y in frame.samples), 120)
            self.assertEqual({x for x, _ in frame.samples}, set(range(20, 52, 2)) | set(range(548, 580, 2)) | set(range(60, 90, 2)) | set(range(510, 540, 2)))

    def test_short_timestamp_row_at_viewport_bottom_is_sampled_only_inside_it(self):
        frame = self.frame()
        self.assertEqual(frame.direction('12:34', (100, 559, 600, 41)), 'system')
        self.assertLess(max(y for _, y in frame.samples), 400)
        self.assertGreaterEqual(min(y for _, y in frame.samples), 359)

    def test_short_timestamp_row_does_not_sample_the_next_row(self):
        frame = self.frame()
        self.assertEqual(frame.direction('12:34', (100, 250, 600, 39)), 'system')
        self.assertLess(max(y for _, y in frame.samples), 89)

    def test_clipped_or_shifted_rows_fail_before_any_pixels_are_read(self):
        for bounds in [(100, 193, 600, 72), (100, 560, 600, 72), (99, 250, 600, 72), (100, 250, 599, 72), (100, 250, 600, 38), (100, 250, 600, -1), (100, 250, 600, 41.0)]:
            frame = self.frame('other')
            with self.subTest(bounds=bounds), self.assertRaises(ValueError):
                frame.direction('fixture', bounds)
            self.assertEqual(frame.samples, [])


if __name__ == '__main__':
    unittest.main()
