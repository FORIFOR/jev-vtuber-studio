"""Launcher wiring tests with fake SDK modules; no model or TTS inference."""
import importlib.util
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('jvs_supertonic', Path(__file__).parents[1] / 'scripts' / 'supertonic-local.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class LauncherTests(unittest.TestCase):
    def test_missing_assets_does_not_load_or_download(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(module.main(['--model-dir', d]), 2)

    def test_pinned_opt_in_download_and_loopback_boot(self):
        calls = []
        def download(**kwargs):
            calls.append(('download', kwargs))
            for leaf in ['onnx','voice_styles']:
                (Path(kwargs['local_dir']) / leaf).mkdir(parents=True)
        def tts(**kwargs): calls.append(('tts', kwargs)); return object()
        def state(**kwargs): calls.append(('state', kwargs)); return object()
        def app(**kwargs): calls.append(('app', kwargs)); return object()
        def run(*args, **kwargs): calls.append(('run', kwargs))
        mods = {
            'huggingface_hub': types.SimpleNamespace(snapshot_download=download),
            'supertonic': types.SimpleNamespace(TTS=tts),
            'supertonic.server': types.ModuleType('supertonic.server'),
            'supertonic.server.app': types.SimpleNamespace(ServerState=state, create_app=app),
            'uvicorn': types.SimpleNamespace(run=run),
        }
        with tempfile.TemporaryDirectory() as d, patch.dict('sys.modules', mods):
            self.assertEqual(module.main(['--download','--model-dir',d,'--threads','3']),0)
        found=dict(calls)
        self.assertEqual(found['download']['revision'],module.MODEL_REVISION)
        self.assertEqual(found['tts']['model'],'supertonic-3')
        self.assertFalse(found['tts']['auto_download'])
        self.assertEqual(found['tts']['intra_op_num_threads'],3)
        self.assertEqual(found['run']['host'],'127.0.0.1')
        self.assertEqual(found['run']['workers'],1)

    def test_help_and_invalid_flags_do_not_import_sdk(self):
        with self.assertRaises(SystemExit) as e: module.main(['--help'])
        self.assertEqual(e.exception.code,0)
        with self.assertRaises(SystemExit) as e: module.main(['--threads','0'])
        self.assertEqual(e.exception.code,2)

if __name__ == '__main__': unittest.main()
