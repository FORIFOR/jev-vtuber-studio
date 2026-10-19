# デザイン側の手順書（VRM_RENDERER.md）との対応状況

2026-10-02 時点。デザインプロジェクトの「3Dキャラクターのクオリティ改善提案」（A モデル制作 / B アプリ組み込み / C 本番確認）に対して、このリポジトリで実際に行ったことをまとめる。

## 結論
- 本線は **`release/rc6-voice` の `?avatar=vrm`**（`public/noa-vrm-avatar.mjs`、ソースは `browser/avatar-vrm/`）。手順書の `?renderer=vrm` + `vrm-adapter.mjs` は本線には入れていない。
- 理由：このブランチには手順書より前から、2D/3D 切り替え・着せ替え・承認済みモーション・失敗時の 2D 退避・three.js 同梱を備えた VRM 統合があり、同じ `stage.mjs` の分岐と `#noa-vrm` を使うため両立しない。
- 手順書どおりの実装（`?renderer=vrm`、`public/vrm-adapter.mjs`、`public/noa-avatar-vrm.mjs`、three r169 / three-vrm 3.1.6 同梱、`test/vrm-adapter.test.mjs`）は、参照用に **`claude/renderer-vrm-handover` ブランチ**（`main` 起点）に置いてある。

## 手順書との差分（本線）
| 手順書 | 本線での扱い |
|---|---|
| `?renderer=vrm` | `?avatar=vrm`（管理画面の「配信アバター 2D / 3D」でも切り替え） |
| `public/vrm-adapter.mjs`（パラメーター → ボーン・専用表情 7 種） | 未使用。`browser/avatar-vrm/controls.mjs` がリアクション名からモデルの表情（`happy` / `Surprised` / `worried` / `blush` / `laugh`）を選び、眉は VRoid 形状キー、口形は `aa/ih/ou/ee/oh` |
| モデル `public/models/noa/noa.vrm`、VRM 1.0、30MB 以下、専用表情 `browUp browTrouble eyeSmile eyeWide mouthSmile mouthFrown cheek` | `public/models/noa3d/Noa.vrm`、**VRM 0.x**、約 58MB、4.90 候補（AvatarSample_A ベース）。専用表情 7 種は**持っていない** |
| three r169 / three-vrm 3.1.x を `public/vendor/three/` に同梱し importmap | three 0.186.1 / three-vrm 3.5.5 を esbuild で 1 ファイルに同梱（`npm run build:avatar`）。importmap なし、CSP 変更なし |
| `kick` / `pulseLight` | なし。身振りは承認済み VRMA モーションで行う |
| 首の向きの反転 `mirror` | なし（VRM 0.x の向きは `VRMUtils.rotateVRM0` で処理） |

## 4.90 候補モデルについて
採用イラスト（白ジャケットと紺ストラップ、巻き毛、垂れストラップと月・猫の小物、厚底スニーカー、招きポーズ）に寄せたもの。制作は別リポジトリ（AIRoid_3D の Node ビルダー、VRoid Studio / Blender の手作業ではない）で、仕様書の数値（身長 1.52m・6.2 頭身・髪束の数・MToon 値・揺れものの表）には**合わせていない**。プロトタイプ（Noa VRM Prototype）に読み込むと、専用表情は「VRoid形状キー」か「代替」、頬染めは「なし」になる見込み（未確認）。

本線で追加したもの：待機中の軽い微笑み、採用イラストの招きポーズ（`noa-beckon.vrma`、「はしゃぐ」で再生）、垂れストラップの揺れ（揺れグループ `NoaStrap`）。詳細は `docs/VRM.md`。

## 未確認
OBS（1920×1080 / 1080×1920）での録画、音声との同期、実モデルでの 60fps・draw call 数。
