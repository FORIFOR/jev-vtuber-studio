#!/usr/bin/env python3
"""Explicit, loopback-only launcher for the archived Supertonic 3 SDK.

Install the pinned upstream SDK [serve] extra before running. No weights are
bundled. Model downloads only occur with --download, at a fixed revision.
"""
from __future__ import annotations
import argparse
import sys
from pathlib import Path

MODEL_REPO = 'supertone-oss-archive/supertonic-3'
MODEL_REVISION = 'aafc6e32416a594460b32413efc49d7fe4ce6d46'


def arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-dir', type=Path, default=Path.home() / '.cache' / 'jvs-supertonic-3')
    parser.add_argument('--download', action='store_true', help='Explicitly download archived model weights; read OpenRAIL-M terms first.')
    parser.add_argument('--port', type=int, default=7788)
    parser.add_argument('--threads', type=int, default=4, help='CPU thread budget, not a performance guarantee (1-32).')
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error('--port must be 1-65535')
    if not 1 <= args.threads <= 32:
        parser.error('--threads must be 1-32')
    return args


def main(argv: list[str] | None = None) -> int:
    args = arguments(argv)
    model_dir = args.model_dir.expanduser().resolve()
    if args.download:
        from huggingface_hub import snapshot_download
        print('Downloading Supertonic 3 archive (network and disk usage). Review model license before use.')
        snapshot_download(repo_id=MODEL_REPO, revision=MODEL_REVISION, local_dir=str(model_dir))
    if not model_dir.is_dir() or not (model_dir / 'onnx').is_dir() or not (model_dir / 'voice_styles').is_dir():
        print('Model assets not found. Read docs/COMMENT_REPLY.md and run with --download, or select a complete --model-dir.', file=sys.stderr)
        return 2
    # Lazy imports keep --help and argument validation side-effect free.
    from supertonic import TTS
    from supertonic.server.app import ServerState, create_app
    import uvicorn
    tts = TTS(model='supertonic-3', model_dir=str(model_dir), auto_download=False,
              intra_op_num_threads=args.threads, inter_op_num_threads=1)
    state = ServerState(model='supertonic-3', tts=tts)
    app = create_app(state=state)
    print(f'JVS voice server: http://127.0.0.1:{args.port} (local only; do not expose via Tailscale/Funnel)')
    uvicorn.run(app, host='127.0.0.1', port=args.port, workers=1, access_log=False)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except ImportError as exc:
        print(f'Missing optional dependency: {exc.name}. Follow docs/COMMENT_REPLY.md in a Python virtual environment.', file=sys.stderr)
        raise SystemExit(2)
    except KeyboardInterrupt:
        raise SystemExit(0)
