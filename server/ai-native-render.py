"""Recognize the tested Linux WeChat light text layout from live pixels.

AT-SPI supplies each message's text and row, but this client supplies no sender
metadata. Require a matching text bubble, an avatar on that same side, and an
empty opposite avatar lane. Other themes, overlays and media are unsupported;
the caller must independently verify the foreground window and native controls.
Screen pixels live only in this process and are never exported or saved.
"""
import ctypes as c
import re
from collections import Counter

BACKGROUND = 0xFAFAFA
INCOMING = 0xEEEEF0
OUTGOING = 0x9DF29F
TIME_LABEL = re.compile(r'(?:(?:星期[一二三四五六日天]|昨天|今天|前天|周[一二三四五六日天])\s+|(?:\d{4}[年/-])?\d{1,2}[月/-]\d{1,2}日?\s+)?(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?')
MEDIA_LABEL = re.compile(r'\[(?:图片|动画表情|视频|语音|文件|位置|链接|聊天记录|小程序|视频号|转账|红包)\].*', re.S)


def classify_row(text, height, left, right, left_bubble, right_bubble):
    """Counters hold samples from native-row-relative lanes, never OCR text."""
    if not isinstance(text, str) or not text.strip() or len(text) > 20000 or MEDIA_LABEL.fullmatch(text.strip()):
        raise ValueError('unsupported message content')
    if type(height) is not int or height < 39:
        raise ValueError('clipped row')
    def fraction(colors, value):
        if not isinstance(colors, Counter) or any(type(color) is not int or not 0 <= color <= 0xffffff or type(count) is not int or count < 0 for color, count in colors.items()):
            raise ValueError('invalid pixel samples')
        total = sum(colors.values())
        if total < 50:
            raise ValueError('clipped row')
        return colors.get(value, 0) / total
    lb, rb = fraction(left, BACKGROUND), fraction(right, BACKGROUND)
    lbb, rbb = fraction(left_bubble, BACKGROUND), fraction(right_bubble, BACKGROUND)
    lbi, rbo = fraction(left_bubble, INCOMING), fraction(right_bubble, OUTGOING)
    if rb >= .98 and lb < .65 and lbi >= .20 and rbb >= .98:
        direction = 'other'
    elif lb >= .98 and rb < .65 and rbo >= .20 and lbb >= .98:
        direction = 'self'
    elif lb >= .98 and rb >= .98 and lbb >= .98 and rbb >= .98 and 39 <= height <= 43 and TIME_LABEL.fullmatch(text.strip()):
        return 'system'
    else:
        raise ValueError('unsupported message rendering')
    return direction


class DesktopFrame:
    def __init__(self, bounds):
        self.bounds = bounds
        self.xlib = c.CDLL('libX11.so.6')
        self.display = None
        self.image = None
        self.bind('XOpenDisplay', c.c_void_p, [c.c_char_p])
        self.bind('XDefaultRootWindow', c.c_ulong, [c.c_void_p])
        self.bind('XDefaultScreen', c.c_int, [c.c_void_p])
        self.bind('XDisplayWidth', c.c_int, [c.c_void_p, c.c_int])
        self.bind('XDisplayHeight', c.c_int, [c.c_void_p, c.c_int])
        self.bind('XGetImage', c.c_void_p, [c.c_void_p, c.c_ulong, c.c_int, c.c_int, c.c_uint, c.c_uint, c.c_ulong, c.c_int])
        self.bind('XGetPixel', c.c_ulong, [c.c_void_p, c.c_int, c.c_int])
        self.bind('XDestroyImage', c.c_int, [c.c_void_p])
        self.bind('XCloseDisplay', c.c_int, [c.c_void_p])
        try:
            self.display = self.xlib.XOpenDisplay(None)
            if not self.display:
                raise ValueError('display unavailable')
            screen = self.xlib.XDefaultScreen(self.display)
            sw, sh = self.xlib.XDisplayWidth(self.display, screen), self.xlib.XDisplayHeight(self.display, screen)
            x, y, w, h = bounds
            if x < 0 or y < 0 or w < 250 or h < 40 or x+w > sw or y+h > sh or w*h > 4000000:
                raise ValueError('unsupported viewport')
            self.image = self.xlib.XGetImage(self.display, self.xlib.XDefaultRootWindow(self.display), x, y, w, h, 0xffffffff, 2)
            if not self.image:
                raise ValueError('frame unavailable')
        except Exception:
            self.close()
            raise

    def bind(self, name, result, args):
        fn = getattr(self.xlib, name)
        fn.restype, fn.argtypes = result, args

    def pixel(self, x, y):
        return self.xlib.XGetPixel(self.image, x, y) & 0xffffff

    def direction(self, text, bounds):
        vx, vy, width, height = self.bounds
        x, y, w, h = bounds
        top = y - vy
        if any(type(value) is not int for value in bounds) or x != vx or w != width or h < 39 or top < 0 or top+h > height:
            raise ValueError('clipped or shifted message')
        # Lane coordinates belong to the tested 96 DPI layout. Require avatar,
        # bubble and empty opposite lanes; other layouts need separate evidence.
        def patch(start, end):
            return Counter(self.pixel(xx, yy) for yy in range(top+8, top+min(h, 42), 2) for xx in range(start, end, 2))
        return classify_row(text, h, patch(20,52), patch(width-52,width-20), patch(60,90), patch(width-90,width-60))

    def close(self):
        if self.image:
            self.xlib.XDestroyImage(self.image)
            self.image = None
        if self.display:
            self.xlib.XCloseDisplay(self.display)
            self.display = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
