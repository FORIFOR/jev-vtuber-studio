#!/usr/bin/env python3
"""Opt-in stdin -> NXBT bridge. Default is --dry-run (no NXBT import/pairing).
Use a persistent trusted pipe (SSH if remote), never expose this as a public API.
Absolute packet expiry rejects delayed commands; Pi/Mac clocks must agree.
"""
import argparse
import json
import math
import queue
import signal
import sys
import threading
import time

BUTTONS = frozenset(('A', 'B', 'X', 'Y', 'L', 'R', 'ZL', 'ZR'))
NEUTRAL = {'buttons': [], 'lx': 0, 'ly': 0, 'rx': 0, 'ry': 0}
MAX_LINE = 4096

def number(x):
    return type(x) in (int, float) and math.isfinite(x)

class InputGuard:
    def __init__(self):
        self.session = None
        self.seq = -1
        self.command = dict(NEUTRAL)
        self.deadline = 0.0

    def accept(self, p, wall_ms, monotonic):
        try:
            if not isinstance(p, dict) or p.get('version') != 1:
                raise ValueError('version')
            if not isinstance(p.get('session'), str) or not 1 <= len(p['session']) <= 128:
                raise ValueError('session')
            if self.session is not None and p['session'] != self.session:
                raise ValueError('new session requires process restart')
            if type(p.get('seq')) is not int or p['seq'] <= self.seq:
                raise ValueError('sequence')
            issued, expires = p.get('issuedAtMs'), p.get('expiresAtMs')
            if not number(issued) or not number(expires) or not 0 < expires-issued <= 200:
                raise ValueError('lifetime')
            # Never renew a stale packet by assigning a TTL at its arrival.
            if issued > wall_ms or expires <= wall_ms or wall_ms-issued > 200:
                raise ValueError('expired or unsynchronised clocks')
            c = p.get('command')
            if not isinstance(c, dict) or not isinstance(c.get('buttons'), list):
                raise ValueError('command')
            if any(not isinstance(b, str) or b not in BUTTONS for b in c['buttons']) or len(set(c['buttons'])) != len(c['buttons']):
                raise ValueError('buttons')
            if any(not number(c.get(k)) or abs(c[k]) > 1 for k in ('lx', 'ly', 'rx', 'ry')):
                raise ValueError('analog')
            self.command = {k: c[k] for k in NEUTRAL}
            self.deadline = monotonic + (expires-wall_ms)/1000
            self.seq, self.session = p['seq'], p['session']
            return True
        except (ValueError, TypeError, KeyError):
            self.command = dict(NEUTRAL)
            self.deadline = 0.0
            return False

    def current(self, monotonic):
        return self.command if monotonic < self.deadline else dict(NEUTRAL)

def make_nxbt_packet(nx, command):
    p = nx.create_input_packet()
    for b in command['buttons']:
        p[b] = True
    for name, x, y in [('L_STICK', 'lx', 'ly'), ('R_STICK', 'rx', 'ry')]:
        p[name]['X_VALUE'] = round(command[x]*100)
        p[name]['Y_VALUE'] = round(command[y]*100)
    return p

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--live', action='store_true', help='create and pair a real NXBT Pro Controller')
    mode.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    guard = InputGuard()
    if not args.live:
        count = 0
        while True:
            line = sys.stdin.buffer.readline(MAX_LINE+1)
            if not line:
                break
            if len(line) > MAX_LINE:
                print(json.dumps({'accepted': False, 'reason': 'oversized'})); return 2
            try:
                p = json.loads(line)
            except (ValueError, UnicodeError):
                p = None
            ok = guard.accept(p, time.time()*1000, time.monotonic())
            count += int(ok)
            print(json.dumps({'accepted': ok, 'dryRun': True}), flush=True)
        return 0
    # External Pi dependency only. No installation or pairing happens during tests.
    import nxbt
    nx, index = nxbt.Nxbt(), None
    stopped, events = threading.Event(), queue.Queue(maxsize=1)
    def shutdown(*_):
        stopped.set()
    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    def reader():
        while not stopped.is_set():
            raw = sys.stdin.buffer.readline(MAX_LINE+1)
            if not raw or len(raw) > MAX_LINE:
                stopped.set(); return
            try:
                item = json.loads(raw)
            except (ValueError, UnicodeError):
                stopped.set(); return
            # Latest only: never queue stale inputs behind slow processing.
            try:
                events.put_nowait(item)
            except queue.Full:
                try: events.get_nowait()
                except queue.Empty: pass
                try: events.put_nowait(item)
                except queue.Full: pass
    try:
        index = nx.create_controller(nxbt.PRO_CONTROLLER)
        # The caller must complete pairing in Switch's Change Grip/Order menu.
        # Do not persist Bluetooth identifiers or automatically reconnect a new session.
        threading.Thread(target=reader, daemon=True).start()
        next_tick = time.monotonic()
        while not stopped.is_set():
            try:
                item = events.get_nowait()
                if not guard.accept(item, time.time()*1000, time.monotonic()):
                    stopped.set()
            except queue.Empty:
                pass
            nx.set_controller_input(index, make_nxbt_packet(nx, guard.current(time.monotonic()) if not stopped.is_set() else NEUTRAL))
            next_tick += 1/120
            now = time.monotonic()
            if next_tick < now-1/120:
                next_tick = now
            stopped.wait(max(0, next_tick-now))
    finally:
        if index is not None:
            try:
                for _ in range(4):
                    nx.set_controller_input(index, make_nxbt_packet(nx, NEUTRAL))
                    time.sleep(1/120)
            finally:
                nx.remove_controller(index)
    return 0

if __name__ == '__main__':
    try:
        sys.exit(main())
    except ImportError:
        print('Live mode requires an independently installed, tested NXBT environment on the Pi.', file=sys.stderr)
        sys.exit(2)
