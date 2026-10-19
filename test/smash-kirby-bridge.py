import importlib.util
from pathlib import Path
import unittest
spec = importlib.util.spec_from_file_location('bridge', Path(__file__).resolve().parents[1] / 'scripts/smash-kirby-nxbt.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

def packet(seq=1):
    return {'version': 1, 'session': 'test', 'seq': seq, 'issuedAtMs': 1000, 'expiresAtMs': 1100,
            'command': {**bridge.NEUTRAL, 'buttons': ['X'], 'lx': 1}}

class BridgeTest(unittest.TestCase):
    def test_valid_packet(self):
        g = bridge.InputGuard(); self.assertTrue(g.accept(packet(), 1000, 10)); self.assertEqual(g.current(10)['buttons'], ['X'])
    def test_watchdog_releases(self):
        g = bridge.InputGuard(); g.accept(packet(), 1000, 10); self.assertEqual(g.current(10.11), bridge.NEUTRAL)
    def test_old_packet_does_not_get_new_ttl(self):
        self.assertFalse(bridge.InputGuard().accept(packet(), 1101, 10))
    def test_future_clock_is_rejected(self):
        self.assertFalse(bridge.InputGuard().accept(packet(), 999, 10))
    def test_out_of_order_and_duplicate(self):
        g = bridge.InputGuard(); g.accept(packet(2), 1000, 10); self.assertFalse(g.accept(packet(1), 1001, 10)); self.assertEqual(g.current(10), bridge.NEUTRAL)
    def test_new_session_requires_restart(self):
        g = bridge.InputGuard(); g.accept(packet(), 1000, 10); p = packet(2); p['session'] = 'new'; self.assertFalse(g.accept(p, 1000, 10))
    def test_home_nan_and_bool_analog_rejected(self):
        for key, value in [('buttons', ['HOME']), ('lx', float('nan')), ('ly', True)]:
            p = packet(); p['command'][key] = value; self.assertFalse(bridge.InputGuard().accept(p, 1000, 10))
    def test_nxbt_mapping_without_hardware(self):
        class Fake:
            def create_input_packet(self): return {'L_STICK': {}, 'R_STICK': {}}
        p = bridge.make_nxbt_packet(Fake(), packet()['command']); self.assertEqual(p['L_STICK']['X_VALUE'], 100); self.assertTrue(p['X'])

if __name__ == '__main__': unittest.main()
