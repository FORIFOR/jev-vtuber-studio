# 自分で用意する素材

公開リポジトリには、再配布の条件や出自を確認できていない素材を入れていません（オペレーター決定 2026-10-19）。どの素材がなくても Studio は動きます。使う場合だけ、自分で用意したものを次の場所に置いてください。素材の規約は、用意した人が確認してください。

| 素材 | 置き場所 | ないとき | 使うもの |
|---|---|---|---|
| 3D モデル（VRM） | `public/models/noa3d/Noa.vrm` | 2D アバター（既定）で動きます | アバターの表示方式「3D」 |
| 部屋の背景 | `public/models/room/nightroom.png`（1920×1080） | 画面テーマ「クラシック」（既定）で動きます | `STAGE_THEME=room` |
| リアクションのスタンプ | `public/models/room/react{anger,failure,sparkle,success,surprise,sweat,tears}.png` | スタンプは出ません | 同上 |
| 飲み配信の缶 | `public/models/room/noabeer.png` | 缶は出ません | `DRINK_MODE` |

**3D モデルについて**
- `public/models/noa3d/manifest.json` と `src/vrm-assets.mjs` は、元の配信で使っていたモデルの情報です。別のモデルを使う場合は、それに合わせて直してください。
- 元のモデルは VRoid の AvatarSample_A を改変したもので、`AVATAR-LICENSE.md` に記録があります。
- モーション（`motions/`）は出自の表記があるので、公開リポジトリにも入っています。

**テスト**
- 元のモデルそのものを検証するテスト（`test/vrm-assets`、`vrm-expression-state`、`vrm-face-fit`、`vrm-framing`、`vrm-outfits`）は、公開リポジトリには入っていません。
- 素材の有無を確かめるテストは、素材がなければ理由を付けて飛ばします。

公開リポジトリは `node scripts/export-public.mjs <出力先>` で書き出しています。外す素材とテストの一覧は、このスクリプトにあります。
